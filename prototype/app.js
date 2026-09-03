const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");

const sourceSelectEl = document.getElementById("source-select");

const hintEl = document.getElementById("hint");
const segmentInfoEl = document.getElementById("segment-info");

const detailsEl = document.getElementById("details");
const detailNameEl = document.getElementById("detail-name");
const detailTypeEl = document.getElementById("detail-type");
const detailSourceLabelEl = document.getElementById("detail-source-label");
const detailSourceEl = document.getElementById("detail-source");
const detailLiteralsEl = document.getElementById("detail-literals");

const backlinksEl = document.getElementById("backlinks");
const backlinksSummaryEl = document.getElementById("backlinks-summary");
const backlinksFilterEl = document.getElementById("backlinks-filter");
const backlinksResultsEl = document.getElementById("backlinks-results");
const backlinksMoreEl = document.getElementById("backlinks-more");

const SPAWN_DISTANCE = 180;
const BACKLINKS_PER_PAGE = 12;
const BACKLINKS_DEBOUNCE_MS = 700;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.5;

const network = new Network();
const pendingFetches = new Map();
const viewport = { x: 0, y: 0, scale: 1 };

let dragNode = null;
let dragMoved = false;
let panning = false;
let panMoved = false;
let panStart = null;
let panOrigin = null;

let backlinksSeq = 0;
let backlinksState = { iri: null, baseUrl: null, keyword: "", page: 1 };
let backlinksDebounce = null;

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function randomSpawnPoint(x, y, distance = SPAWN_DISTANCE) {
  const angle = Math.random() * TWO_PI;
  return { x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance };
}

function getEntity(iri, baseUrl) {
  if (pendingFetches.has(iri)) return pendingFetches.get(iri);
  const promise = fetchEntity(iri, baseUrl).finally(() => pendingFetches.delete(iri));
  pendingFetches.set(iri, promise);
  return promise;
}

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
}

function toLocal(e) {
  const rect = canvas.getBoundingClientRect();
  return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
}

function toWorld(mx, my) {
  return { wx: (mx - viewport.x) / viewport.scale, wy: (my - viewport.y) / viewport.scale };
}

function selectNode(node) {
  network.select(node);
  updateEntityPanel(node.entity);
  updateSegmentInfo();
  backlinksFilterEl.value = "";
  if (node.entity.source) {
    loadBacklinks(node.entity.id, node.entity.source.baseUrl, "", 1);
  } else {
    loadCrossSourceBacklinks(node);
  }
  syncUrlFromState();
}

// For a genuinely external node (Wikidata/RKD/...) there's no "own source" to
// search backlinks within, but every configured source can still be searched
// for records that reference this same IRI — the same _link lookup
// loadBacklinks uses, just run against each source in turn. Feeds both the
// "Linked from elsewhere" panel and (once, from the unfiltered set) the
// donut ring via GraphNode.addCrossSourceSegment.
async function loadCrossSourceBacklinks(node, keyword = "") {
  const seq = ++backlinksSeq;
  backlinksEl.classList.remove("hidden");
  backlinksSummaryEl.textContent = "Searching…";
  backlinksMoreEl.classList.add("hidden");
  backlinksResultsEl.innerHTML = "";

  const matches = await findCrossSourceMatches(node.entity.id, keyword);
  if (seq !== backlinksSeq) return;

  if (network.openNode === node && !node.crossSourceChecked) {
    node.crossSourceChecked = true;
    for (const { source, rows } of matches) node.addCrossSourceSegment(source, rows);
  }

  const totalRows = matches.reduce((n, m) => n + m.rows.length, 0);
  backlinksSummaryEl.textContent = totalRows
    ? `${totalRows} record${totalRows === 1 ? "" : "s"} link here`
    : "No other records link here.";
  for (const { source, rows } of matches) {
    for (const row of rows) backlinksResultsEl.appendChild(renderBacklinkRow({ ...row, sourceLabel: source.label }));
  }
}

function deselectAll() {
  network.select(null);
  hintEl.textContent = "Click a node to bring it into focus.";
  segmentInfoEl.textContent = "";
  detailsEl.classList.add("hidden");
  backlinksEl.classList.add("hidden");
  backlinksFilterEl.value = "";
  backlinksSeq++; // invalidate any in-flight backlinks fetch so it can't repopulate the now-hidden panel
  syncUrlFromState();
}

function updateEntityPanel(entity) {
  hintEl.textContent = entity.segments.length
    ? "Hover the open node to inspect it, click a wedge to add a connected node. Click any node to bring it into focus; drag to rearrange."
    : "No linked records to explore from here. Click another node to bring it into focus.";

  detailsEl.classList.remove("hidden");
  detailNameEl.textContent = entity.name;
  detailTypeEl.textContent = entity.typeLabel || "";
  detailSourceLabelEl.textContent = entity.source ? entity.source.label : "External";
  detailSourceEl.href = entity.id;
  detailLiteralsEl.innerHTML = "";
  for (const lit of entity.literals) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="lit-name">${lit.name}</span><span class="lit-value">${lit.value}</span>`;
    detailLiteralsEl.appendChild(li);
  }
}

function updateSegmentInfo() {
  const open = network.openNode;
  const seg = open && open.donut.selectedSegment;
  segmentInfoEl.textContent = seg ? `${seg.id} (${seg.slices.length})` : "";
}

async function navigateFrom(fromNode, targetIri, baseUrl) {
  let target = network.findNode(targetIri);

  if (!target) {
    hintEl.textContent = "Loading…";
    let entity;
    try {
      entity = await getEntity(targetIri, baseUrl);
    } catch (err) {
      hintEl.textContent =
        err instanceof NotExplorableError
          ? "Nothing more to explore here — this resource has no browsable record."
          : `Failed to load that resource: ${err.message}`;
      return;
    }

    target = network.findNode(entity.id); // may have been added by another in-flight click while we awaited
    if (!target) {
      const spawn = randomSpawnPoint(fromNode.x, fromNode.y);
      target = new GraphNode(entity, spawn.x, spawn.y);
      network.addNode(target);
    }
  }

  if (target !== fromNode) network.addEdge(fromNode, target);
  selectNode(target);
}

// --- Reverse-link ("what else links here") explorer ---------------------

async function loadBacklinks(iri, baseUrl, keyword, page) {
  const seq = ++backlinksSeq;
  backlinksEl.classList.remove("hidden");
  backlinksSummaryEl.textContent = "Searching…";
  backlinksMoreEl.classList.add("hidden");
  if (page === 1) backlinksResultsEl.innerHTML = "";

  let result;
  try {
    result = await fetchBacklinks(iri, baseUrl, { keyword, page, perPage: BACKLINKS_PER_PAGE });
  } catch (err) {
    if (seq !== backlinksSeq) return;
    backlinksSummaryEl.textContent = `Search failed: ${err.message}`;
    return;
  }
  if (seq !== backlinksSeq) return;

  backlinksState = { iri, baseUrl, keyword, page };
  backlinksSummaryEl.textContent = result.total
    ? `${result.total.toLocaleString()} record${result.total === 1 ? "" : "s"} link here`
    : "No other records link here.";

  for (const row of result.rows) backlinksResultsEl.appendChild(renderBacklinkRow(row));
  backlinksMoreEl.classList.toggle("hidden", !result.hasMore);
}

function renderBacklinkRow(row) {
  const li = document.createElement("li");
  li.className = "backlink-row";

  if (row.thumbIri) {
    const img = document.createElement("img");
    img.className = "backlink-thumb";
    img.src = `${row.thumbIri}/full/60,/0/default.jpg`;
    img.alt = "";
    li.appendChild(img);
  } else {
    const placeholder = document.createElement("span");
    placeholder.className = "backlink-thumb backlink-thumb-empty";
    li.appendChild(placeholder);
  }

  const text = document.createElement("div");
  text.className = "backlink-text";

  if (row.sourceLabel) {
    const source = document.createElement("span");
    source.className = "backlink-source";
    source.textContent = row.sourceLabel;
    text.appendChild(source);
  }

  const title = document.createElement("span");
  title.className = "backlink-title";
  title.textContent = truncate(row.name, 60);
  title.title = row.name;
  text.appendChild(title);

  li.appendChild(text);

  li.addEventListener("click", () => {
    const open = network.openNode;
    if (open) navigateFrom(open, row.id, row.baseUrl);
  });

  return li;
}

backlinksFilterEl.addEventListener("input", () => {
  clearTimeout(backlinksDebounce);
  const keyword = backlinksFilterEl.value;
  backlinksDebounce = setTimeout(() => {
    const open = network.openNode;
    if (!open) return;
    if (open.entity.source) loadBacklinks(open.entity.id, open.entity.source.baseUrl, keyword, 1);
    else loadCrossSourceBacklinks(open, keyword);
  }, BACKLINKS_DEBOUNCE_MS);
});

backlinksMoreEl.addEventListener("click", () => {
  loadBacklinks(backlinksState.iri, backlinksState.baseUrl, backlinksState.keyword, backlinksState.page + 1);
});

// --- Canvas interaction: hover/click on the open ring, drag nodes, pan/zoom the view ---

canvas.addEventListener("mousedown", (e) => {
  const { mx, my } = toLocal(e);
  const { wx, wy } = toWorld(mx, my);

  const hit = network.nodes.find((n) => n.hitHub(wx, wy));
  if (hit) {
    dragNode = hit;
    dragNode.dragging = true;
    dragMoved = false;
    return;
  }

  const open = network.openNode;
  if (open && open.donut.hitTest(wx, wy)) return; // let the click handler navigate

  panning = true;
  panStart = { mx, my };
  panOrigin = { x: viewport.x, y: viewport.y };
});

canvas.addEventListener("mousemove", (e) => {
  const { mx, my } = toLocal(e);

  if (dragNode) {
    dragMoved = true;
    const { wx, wy } = toWorld(mx, my);
    dragNode.x = wx;
    dragNode.y = wy;
    dragNode.vx = 0;
    dragNode.vy = 0;
    canvas.style.cursor = "grabbing";
    return;
  }

  if (panning) {
    panMoved = true;
    viewport.x = panOrigin.x + (mx - panStart.mx);
    viewport.y = panOrigin.y + (my - panStart.my);
    canvas.style.cursor = "grabbing";
    return;
  }

  const { wx, wy } = toWorld(mx, my);
  const open = network.openNode;
  let cursor = "default";
  if (open) {
    const slice = open.donut.hitTest(wx, wy);
    open.donut.updateHover(slice);
    if (slice) cursor = "pointer";
    updateSegmentInfo();
  }
  if (cursor === "default" && network.nodes.some((n) => n.hitHub(wx, wy))) cursor = "pointer";
  canvas.style.cursor = cursor;
});

window.addEventListener("mouseup", () => {
  if (dragNode) {
    dragNode.dragging = false;
    if (!dragMoved) selectNode(dragNode);
    dragNode = null;
    return;
  }
  if (panning) {
    panning = false;
    canvas.style.cursor = "default";
  }
});

canvas.addEventListener("click", (e) => {
  if (dragMoved || panMoved) {
    dragMoved = false;
    panMoved = false;
    return;
  }
  const { mx, my } = toLocal(e);
  const { wx, wy } = toWorld(mx, my);

  const open = network.openNode;
  if (open) {
    const slice = open.donut.hitTest(wx, wy);
    if (slice) {
      navigateFrom(open, slice.id, slice.baseUrl || open.entity.source?.baseUrl);
      return;
    }
  }

  // Clicked empty canvas — not on any node's hub, not on the open ring — unfocus.
  const hitNode = network.nodes.some((n) => n.hitHub(wx, wy));
  if (!hitNode && open) deselectAll();
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const { mx, my } = toLocal(e);
    const { wx, wy } = toWorld(mx, my);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, viewport.scale * factor));
    viewport.x = mx - wx * newScale;
    viewport.y = my - wy * newScale;
    viewport.scale = newScale;
  },
  { passive: false }
);

window.addEventListener("resize", resizeCanvas);

function frame() {
  const center = toWorld(canvas.width / 2, canvas.height / 2);
  network.tick(center.wx, center.wy);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(viewport.x, viewport.y);
  ctx.scale(viewport.scale, viewport.scale);
  network.draw(ctx);
  ctx.restore();

  requestAnimationFrame(frame);
}

// Loads (or, if already present, just re-focuses) a source's starting
// record. Switching the collection dropdown does NOT reset the canvas —
// it adds the other collection's root alongside whatever's already there,
// so a shared Wikidata/RKD reference can later connect the two.
function findOrCreateSourceRoot(source) {
  const existing = network.findNode(source.defaultEntity);
  if (existing) {
    selectNode(existing);
    return;
  }

  hintEl.textContent = "Loading…";
  getEntity(source.defaultEntity, source.baseUrl)
    .then((entity) => {
      // The requested IRI can differ from the entity's own canonical id
      // (e.g. a REST-style /resources/records/{uuid} URL vs. its resolved
      // short @id) — re-check under the resolved id before adding a node,
      // same guard navigateFrom uses for the equivalent race.
      const alreadyThere = network.findNode(entity.id);
      if (alreadyThere) {
        selectNode(alreadyThere);
        return;
      }
      const center = toWorld(canvas.width / 2, canvas.height / 2);
      const dist = network.nodes.length ? SPAWN_DISTANCE : 0;
      const spawn = randomSpawnPoint(center.wx, center.wy, dist);
      const node = new GraphNode(entity, spawn.x, spawn.y);
      network.addNode(node);
      selectNode(node);
    })
    .catch((err) => {
      hintEl.textContent = `Failed to load ${source.label}: ${err.message}`;
    });
}

for (const source of SOURCES) {
  const option = document.createElement("option");
  option.value = source.id;
  option.textContent = source.label;
  sourceSelectEl.appendChild(option);
}

sourceSelectEl.addEventListener("change", () => {
  const source = SOURCES.find((s) => s.id === sourceSelectEl.value);
  findOrCreateSourceRoot(source);
});

function init() {
  resizeCanvas();

  const state = parseStateFromUrl();
  if (state && state.nodes.length > 0) {
    restoreGraph(state)
      .then(() => {
        if (network.nodes.length === 0) {
          console.warn("Shared graph link failed to load any nodes; falling back to default.");
          findOrCreateSourceRoot(SOURCES[0]);
        }
      })
      .catch((err) => {
        console.warn(`Failed to restore shared graph link, falling back to default: ${err.message}`);
        findOrCreateSourceRoot(SOURCES[0]);
      });
    return;
  }

  if (state) console.warn("Shared graph link was empty; falling back to default.");
  findOrCreateSourceRoot(SOURCES[0]);
}

init();
requestAnimationFrame(frame);
