// Force-directed network of donuts — plain JS port of the idea in
// example/public/javascripts/pjs/{graph,node,edge,resource}.pjs: every
// explored entity becomes its own node; navigating from the currently open
// node spawns a new node connected by an edge, instead of replacing the view.
// Only one node is "open" (full interactive ring) at a time; the rest render
// as small closed circles you can click to re-focus.

const OPEN_RADIUS = 130;
const CLOSED_RADIUS = 34;
const FOCUSED_LEAF_RADIUS = 44;
const HALO_PAD = 10;
const SPRING_LENGTH_CLOSED = 150;
const SPRING_LENGTH_OPEN = 260;
const SPRING_STRENGTH = 0.02;
const REPULSION = 26000;
const DAMPING = 0.82;
const CENTER_PULL = 0.0015;

const TYPE_COLORS = {
  Image: "#8DB5C8",
  Person: "#B16649",
  Fonds: "#A2C355",
  File: "#837F43",
  Concept: "#9DAF37",
};
const DEFAULT_NODE_COLOR = "#999";

class GraphNode {
  constructor(entity, x, y) {
    this.entity = entity;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.open = false;
    this.dragging = false;
    this.donut = buildDonut(entity, { x, y, radius: OPEN_RADIUS });
  }

  // A "dead end": nothing to expand into, so it never gets the full ring
  // treatment — just a (possibly focused) closed circle.
  get isLeaf() {
    return this.entity.segments.length === 0;
  }

  get radius() {
    if (!this.open) return CLOSED_RADIUS;
    return this.isLeaf ? FOCUSED_LEAF_RADIUS : OPEN_RADIUS;
  }

  get color() {
    return TYPE_COLORS[this.entity.typeLabel] || DEFAULT_NODE_COLOR;
  }

  syncDonutPosition() {
    this.donut.x = this.x;
    this.donut.y = this.y;
  }

  // Drag/select target: the whole circle for a closed node, but only the
  // small inner hole for an open ringed node — its ring is reserved for slice clicks.
  hitHub(mx, my) {
    const dx = mx - this.x;
    const dy = my - this.y;
    let hubRadius = CLOSED_RADIUS;
    if (this.open) hubRadius = this.isLeaf ? FOCUSED_LEAF_RADIUS + HALO_PAD : 70;
    return dx * dx + dy * dy <= hubRadius * hubRadius;
  }

  drawClosed(ctx) {
    const focused = this.open; // only true for a focused dead-end (isLeaf), see Network.draw
    const radius = focused ? FOCUSED_LEAF_RADIUS : CLOSED_RADIUS;

    ctx.save();
    if (focused) {
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(this.x, this.y, radius + HALO_PAD, 0, TWO_PI);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(this.x, this.y, radius, 0, TWO_PI);
    ctx.fill();

    ctx.strokeStyle = this.color;
    ctx.lineWidth = focused ? 8 : 6;
    ctx.beginPath();
    ctx.arc(this.x, this.y, radius, 0, TWO_PI);
    ctx.stroke();

    if (this.entity.typeLabel) {
      drawFittedLabel(ctx, this.entity.typeLabel.toUpperCase(), this.x, this.y, radius * 2 - 12, this.color);
    }
    ctx.restore();

    // A focused leaf's name/type/literals are shown by the HTML card that
    // hangs below it (see app.js's positionCenterLabel) — skip the canvas label.
    if (!focused) this.drawLabel(ctx, radius);
  }

  drawLabel(ctx, radiusOffset) {
    ctx.save();
    ctx.fillStyle = "#555";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(truncateLabel(this.entity.name, 26), this.x, this.y + radiusOffset + 16);
    ctx.restore();
  }
}

function truncateLabel(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Shrinks the font (down to a floor) to fit `text` within maxWidth, then
// truncates with an ellipsis as a last resort — used for the record-type
// label inside a closed node's circle, whose size varies (Fonds vs Organisation).
function drawFittedLabel(ctx, text, x, y, maxWidth, color) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;

  let size = 8;
  const minSize = 5.5;
  ctx.font = `bold ${size}px sans-serif`;
  while (size > minSize && ctx.measureText(text).width > maxWidth) {
    size -= 0.5;
    ctx.font = `bold ${size}px sans-serif`;
  }

  let label = text;
  while (label.length > 1 && ctx.measureText(label).width > maxWidth) {
    label = label.slice(0, -1);
  }
  if (label !== text) label = `${label.slice(0, -1)}…`;

  ctx.fillText(label, x, y);
}

class Edge {
  constructor(from, to) {
    this.from = from;
    this.to = to;
  }
}

class Network {
  constructor() {
    this.nodes = [];
    this.edges = [];
  }

  findNode(entityId) {
    return this.nodes.find((n) => n.entity.id === entityId) || null;
  }

  addNode(node) {
    this.nodes.push(node);
    return node;
  }

  addEdge(a, b) {
    const exists = this.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
    if (!exists) this.edges.push(new Edge(a, b));
  }

  select(node) {
    for (const n of this.nodes) n.open = n === node;
  }

  get openNode() {
    return this.nodes.find((n) => n.open) || null;
  }

  tick(width, height) {
    for (const n of this.nodes) {
      n.fx = 0;
      n.fy = 0;
    }

    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const a = this.nodes[i];
        const b = this.nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = Math.max(dx * dx + dy * dy, 25);
        const dist = Math.sqrt(distSq);
        const force = REPULSION / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.fx += fx;
        a.fy += fy;
        b.fx -= fx;
        b.fy -= fy;
      }
    }

    for (const e of this.edges) {
      const { from: a, to: b } = e;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const targetLength = a.open || b.open ? SPRING_LENGTH_OPEN : SPRING_LENGTH_CLOSED;
      const diff = dist - targetLength;
      const fx = (dx / dist) * diff * SPRING_STRENGTH;
      const fy = (dy / dist) * diff * SPRING_STRENGTH;
      a.fx += fx;
      a.fy += fy;
      b.fx -= fx;
      b.fy -= fy;
    }

    for (const n of this.nodes) {
      if (n.dragging) continue;
      n.fx += (width / 2 - n.x) * CENTER_PULL;
      n.fy += (height / 2 - n.y) * CENTER_PULL;
      n.vx = (n.vx + n.fx) * DAMPING;
      n.vy = (n.vy + n.fy) * DAMPING;
      n.x += n.vx;
      n.y += n.vy;
      n.syncDonutPosition();
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.lineWidth = 2;
    for (const e of this.edges) {
      ctx.beginPath();
      ctx.moveTo(e.from.x, e.from.y);
      ctx.lineTo(e.to.x, e.to.y);
      ctx.stroke();
    }
    ctx.restore();

    const open = this.openNode;
    for (const n of this.nodes) {
      if (n === open) continue;
      n.drawClosed(ctx);
    }
    if (open) {
      open.syncDonutPosition();
      if (open.isLeaf) {
        open.drawClosed(ctx); // dead end: no ring to expand into, just a focused circle
      } else {
        open.donut.draw(ctx);
        open.drawLabel(ctx, OPEN_RADIUS + 20);
      }
    }
  }
}
