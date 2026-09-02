const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");

const hintEl = document.getElementById("hint");
const segmentInfoEl = document.getElementById("segment-info");

const detailsEl = document.getElementById("details");
const detailNameEl = document.getElementById("detail-name");
const detailTypeEl = document.getElementById("detail-type");
const detailSourceEl = document.getElementById("detail-source");
const detailLiteralsEl = document.getElementById("detail-literals");

const backlinksEl = document.getElementById("backlinks");
const backlinksSummaryEl = document.getElementById("backlinks-summary");
const backlinksFilterEl = document.getElementById("backlinks-filter");
const backlinksResultsEl = document.getElementById("backlinks-results");
const backlinksMoreEl = document.getElementById("backlinks-more");

const DEFAULT_ENTITY_IRI = "https://id.archief.amsterdam/resources/records/02b5176c-8dec-7410-a81b-b87cd82537c2";
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
let backlinksState = { iri: null, keyword: "", page: 1 };
let backlinksDebounce = null;

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function getEntity(iri) {
  if (pendingFetches.has(iri)) return pendingFetches.get(iri);
  const promise = fetchEntity(iri).finally(() => pendingFetches.delete(iri));
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
  loadBacklinks(node.entity.id, "", 1);
}

function deselectAll() {
  network.select(null);
  hintEl.textContent = "Click a node to bring it into focus.";
  segmentInfoEl.textContent = "";
  detailsEl.classList.add("hidden");
  backlinksEl.classList.add("hidden");
  backlinksFilterEl.value = "";
  backlinksSeq++; // invalidate any in-flight backlinks fetch so it can't repopulate the now-hidden panel
}

function updateEntityPanel(entity) {
  hintEl.textContent = entity.segments.length
    ? "Hover the open node to inspect it, click a wedge to add a connected node. Click any node to bring it into focus; drag to rearrange."
    : "No linked records to explore from here. Click another node to bring it into focus.";

  detailsEl.classList.remove("hidden");
  detailNameEl.textContent = entity.name;
  detailTypeEl.textContent = entity.typeLabel || "";
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

async function navigateFrom(fromNode, targetIri) {
  let target = network.findNode(targetIri);

  if (!target) {
    hintEl.textContent = "Loading…";
    let entity;
    try {
      entity = await getEntity(targetIri);
    } catch (err) {
      hintEl.textContent =
        err instanceof NotExplorableError
          ? "Nothing more to explore here — this resource has no browsable record."
          : `Failed to load that resource: ${err.message}`;
      return;
    }

    target = network.findNode(entity.id); // may have been added by another in-flight click while we awaited
    if (!target) {
      const angle = Math.random() * TWO_PI;
      target = new GraphNode(
        entity,
        fromNode.x + Math.cos(angle) * SPAWN_DISTANCE,
        fromNode.y + Math.sin(angle) * SPAWN_DISTANCE
      );
      network.addNode(target);
    }
  }

  if (target !== fromNode) network.addEdge(fromNode, target);
  selectNode(target);
}

// --- Reverse-link ("what else links here") explorer ---------------------

async function loadBacklinks(iri, keyword, page) {
  const seq = ++backlinksSeq;
  backlinksEl.classList.remove("hidden");
  backlinksSummaryEl.textContent = "Searching…";
  backlinksMoreEl.classList.add("hidden");
  if (page === 1) backlinksResultsEl.innerHTML = "";

  let result;
  try {
    result = await fetchBacklinks(iri, { keyword, page, perPage: BACKLINKS_PER_PAGE });
  } catch (err) {
    if (seq !== backlinksSeq) return;
    backlinksSummaryEl.textContent = `Search failed: ${err.message}`;
    return;
  }
  if (seq !== backlinksSeq) return;

  backlinksState = { iri, keyword, page };
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

  const title = document.createElement("span");
  title.className = "backlink-title";
  title.textContent = truncate(row.name, 60);
  title.title = row.name;
  li.appendChild(title);

  li.addEventListener("click", () => {
    const open = network.openNode;
    if (open) navigateFrom(open, row.id);
  });

  return li;
}

backlinksFilterEl.addEventListener("input", () => {
  clearTimeout(backlinksDebounce);
  const keyword = backlinksFilterEl.value;
  backlinksDebounce = setTimeout(() => {
    const iri = network.openNode?.entity.id;
    if (iri) loadBacklinks(iri, keyword, 1);
  }, BACKLINKS_DEBOUNCE_MS);
});

backlinksMoreEl.addEventListener("click", () => {
  loadBacklinks(backlinksState.iri, backlinksState.keyword, backlinksState.page + 1);
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
      navigateFrom(open, slice.id);
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

async function init() {
  resizeCanvas();
  hintEl.textContent = "Loading…";
  let entity;
  try {
    entity = await getEntity(DEFAULT_ENTITY_IRI);
  } catch (err) {
    hintEl.textContent = `Failed to load the starting record: ${err.message}`;
    requestAnimationFrame(frame);
    return;
  }
  const root = new GraphNode(entity, canvas.width / 2, canvas.height / 2);
  network.addNode(root);
  selectNode(root);
}

init();
requestAnimationFrame(frame);
