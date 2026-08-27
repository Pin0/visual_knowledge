const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const centerLabelEl = document.getElementById("center-label");
const nameEl = document.getElementById("entity-name");
const typeEl = document.getElementById("entity-type");
const literalsEl = document.getElementById("entity-literals");
const hintEl = document.getElementById("hint");
const segmentInfoEl = document.getElementById("segment-info");

const DEFAULT_ENTITY_IRI = "https://id.archief.amsterdam/resources/records/02b5176c-8dec-7410-a81b-b87cd82537c2";
const SPAWN_DISTANCE = 180;

const network = new Network();
const pendingFetches = new Map();

let dragNode = null;
let dragMoved = false;

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

function selectNode(node) {
  network.select(node);
  updateEntityPanel(node.entity);
  updateSegmentInfo();
}

function updateEntityPanel(entity) {
  nameEl.textContent = entity.name;
  typeEl.textContent = entity.typeLabel || "";
  literalsEl.innerHTML = "";
  for (const lit of entity.literals) {
    const li = document.createElement("li");
    li.title = lit.value;
    li.innerHTML = `<span class="lit-name">${lit.name}</span><span class="lit-value">${truncate(lit.value, 90)}</span>`;
    literalsEl.appendChild(li);
  }
  hintEl.textContent = entity.segments.length
    ? "Hover the open node to inspect it, click a wedge to add a connected node. Click any node to bring it into focus; drag to rearrange."
    : "No linked records to explore from here. Click another node to bring it into focus.";
}

// Keeps the entity-details card glued to the currently open node — inside
// its ring's hole while it has one, or hanging below it when it's a leaf
// (dead-end) node that's just a small focused circle.
function positionCenterLabel() {
  const open = network.openNode;
  if (!open) {
    centerLabelEl.classList.add("hidden");
    return;
  }
  centerLabelEl.classList.remove("hidden");
  centerLabelEl.classList.toggle("below", open.isLeaf);
  centerLabelEl.style.left = `${open.x}px`;
  centerLabelEl.style.top = open.isLeaf ? `${open.y + FOCUSED_LEAF_RADIUS + HALO_PAD + 24}px` : `${open.y}px`;
}

function updateSegmentInfo() {
  const open = network.openNode;
  const seg = open && open.donut.selectedSegment;
  segmentInfoEl.textContent = seg ? `${seg.label} (${seg.slices.length})` : "";
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

canvas.addEventListener("mousedown", (e) => {
  const { mx, my } = toLocal(e);
  const hit = network.nodes.find((n) => n.hitHub(mx, my));
  if (!hit) return;
  dragNode = hit;
  dragNode.dragging = true;
  dragMoved = false;
});

canvas.addEventListener("mousemove", (e) => {
  const { mx, my } = toLocal(e);

  if (dragNode) {
    dragMoved = true;
    dragNode.x = mx;
    dragNode.y = my;
    dragNode.vx = 0;
    dragNode.vy = 0;
    canvas.style.cursor = "grabbing";
    return;
  }

  const open = network.openNode;
  let cursor = "default";
  if (open) {
    const slice = open.donut.hitTest(mx, my);
    open.donut.updateHover(slice);
    if (slice) cursor = "pointer";
    updateSegmentInfo();
  }
  if (cursor === "default" && network.nodes.some((n) => n.hitHub(mx, my))) cursor = "pointer";
  canvas.style.cursor = cursor;
});

window.addEventListener("mouseup", () => {
  if (!dragNode) return;
  dragNode.dragging = false;
  if (!dragMoved) selectNode(dragNode);
  dragNode = null;
});

canvas.addEventListener("click", (e) => {
  if (dragMoved) {
    dragMoved = false;
    return;
  }
  const open = network.openNode;
  if (!open) return;
  const { mx, my } = toLocal(e);
  const slice = open.donut.hitTest(mx, my);
  if (slice) navigateFrom(open, slice.id);
});

window.addEventListener("resize", resizeCanvas);

function frame() {
  network.tick(canvas.width, canvas.height);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  network.draw(ctx);
  positionCenterLabel();
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
