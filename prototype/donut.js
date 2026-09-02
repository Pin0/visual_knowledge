// Donut radial navigator — plain JS/Canvas port of the segment/slice/tween
// model from example_donut/donut.pjs, driving entities shaped like
// example/app/helpers/resources_helper.rb's resource_json.

const TWO_PI = Math.PI * 2;

const SEGMENT_COLORS = [
  "#ABC731",
  "#A2C355",
  "#9ABF7B",
  "#93BAA1",
  "#8DB5C8",
  "#867CA2",
  "#B16649",
  "#837F43",
  "#9DAF37",
  "#4E9AA6",
  "#C77A3B",
];

const STROKE_COLLAPSED = 46;
const STROKE_EXPANDED = 60;
const OUTER_BORDER = 4;
const TWEEN_MS = 350;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

class Tween {
  constructor(from, to, duration = TWEEN_MS) {
    this.from = from;
    this.to = to;
    this.start = performance.now();
    this.duration = duration;
  }
  continueTo(to, duration = TWEEN_MS) {
    this.from = this.value();
    this.to = to;
    this.start = performance.now();
    this.duration = duration;
  }
  value(now = performance.now()) {
    const t = Math.min(1, (now - this.start) / this.duration);
    return this.from + (this.to - this.from) * easeInOutCubic(t);
  }
  done(now = performance.now()) {
    return now - this.start >= this.duration;
  }
}

class DonutSlice {
  constructor(id, name, segment, baseUrl = null) {
    this.id = id;
    this.name = name;
    this.segment = segment;
    this.baseUrl = baseUrl;
    this.angleStart = 0;
    this.angleStop = 0;
    this.hovering = false;
  }

  containsPoint(r, angle) {
    const donut = this.segment.donut;
    const breadth = this.segment.breadth.value();
    if (r < donut.radius - breadth / 2 || r > donut.radius + breadth / 2) return false;
    if (this.angleStop - this.angleStart >= TWO_PI - 1e-6) return true; // sole slice spans the full ring
    const start = this.angleStart % TWO_PI;
    const stop = this.angleStop % TWO_PI;
    if (start <= stop) return angle >= start && angle < stop;
    return angle >= start || angle < stop; // wraps past 0
  }

  draw(ctx) {
    const donut = this.segment.donut;
    const breadth = this.segment.breadth.value();

    if (this.hovering) {
      ctx.save();
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.lineWidth = breadth;
      ctx.beginPath();
      ctx.arc(donut.x, donut.y, donut.radius, this.angleStart, this.angleStop);
      ctx.stroke();
      ctx.restore();
    }

    // divider line between slices
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    const inner = donut.radius - breadth / 2;
    const outer = donut.radius + breadth / 2;
    ctx.beginPath();
    ctx.moveTo(donut.x + Math.cos(this.angleStop) * inner, donut.y + Math.sin(this.angleStop) * inner);
    ctx.lineTo(donut.x + Math.cos(this.angleStop) * outer, donut.y + Math.sin(this.angleStop) * outer);
    ctx.stroke();
    ctx.restore();

    if (donut.selectedSegment === this.segment) {
      this.drawLabel(ctx, breadth);
    }
  }

  drawLabel(ctx, breadth) {
    const donut = this.segment.donut;
    const mid = (this.angleStart + this.angleStop) / 2;
    const flip = Math.cos(mid) < 0;

    ctx.save();
    ctx.translate(donut.x, donut.y);
    ctx.rotate(mid);
    ctx.translate(donut.radius + breadth / 2 + 10, 0);
    if (flip) ctx.rotate(Math.PI);

    ctx.fillStyle = this.hovering ? "#222" : "#666";
    ctx.font = this.hovering ? "bold 12px sans-serif" : "12px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = flip ? "right" : "left";
    const label = this.name.length > 34 ? `${this.name.slice(0, 33)}…` : this.name;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
}

class DonutSegment {
  constructor(id, label, donut) {
    this.id = id;
    this.label = label;
    this.donut = donut;
    this.slices = [];
    this.weight = new Tween(1, 1);
    this.breadth = new Tween(STROKE_COLLAPSED, STROKE_COLLAPSED);
    this.color = "#999";
    this.angleStart = 0;
    this.angleStop = 0;
  }

  addSlice(slice) {
    this.slices.push(slice);
  }

  share() {
    return this.slices.length / this.donut.totalSlices();
  }

  weightedShare() {
    return (this.share() * this.weight.value()) / this.donut.totalWeight();
  }

  amount() {
    return TWO_PI * this.weightedShare();
  }

  layout(angleOffset) {
    this.angleStart = angleOffset;
    const amount = this.amount();
    let cursor = this.angleStart;
    const step = amount / this.slices.length;
    for (const slice of this.slices) {
      slice.angleStart = cursor;
      cursor += step;
      slice.angleStop = cursor;
    }
    this.angleStop = angleOffset + amount;
    return this.angleStop;
  }

  expand() {
    this.weight.continueTo(2.4);
    this.breadth.continueTo(STROKE_EXPANDED);
  }

  contract() {
    this.weight.continueTo(1);
    this.breadth.continueTo(STROKE_COLLAPSED);
  }

  draw(ctx) {
    const donut = this.donut;
    const breadth = this.breadth.value();

    ctx.save();
    ctx.strokeStyle = this.color;
    ctx.lineWidth = breadth;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.arc(donut.x, donut.y, donut.radius, this.angleStart, this.angleStop);
    ctx.stroke();
    ctx.restore();

    for (const slice of this.slices) slice.draw(ctx);
  }
}

class Donut {
  constructor(x, y, radius) {
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.segments = [];
    this.selectedSegment = null;
    this.selectedSlice = null;
  }

  addSegment(segment) {
    segment.color = SEGMENT_COLORS[this.segments.length % SEGMENT_COLORS.length];
    this.segments.push(segment);
    if (!this.selectedSegment) this.select(segment, segment.slices[0]);
  }

  totalSlices() {
    return this.segments.reduce((sum, s) => sum + s.slices.length, 0);
  }

  totalWeight() {
    return this.segments.reduce((sum, s) => sum + s.weight.value() * s.share(), 0);
  }

  select(segment, slice) {
    if (this.selectedSegment && this.selectedSegment !== segment) {
      this.selectedSegment.contract();
    }
    this.selectedSegment = segment;
    this.selectedSlice = slice || null;
    segment.expand();
  }

  layout() {
    let angleOffset = 0;
    for (const segment of this.segments) {
      angleOffset = segment.layout(angleOffset);
    }
  }

  hitTest(mx, my) {
    const dx = mx - this.x;
    const dy = my - this.y;
    const r = Math.sqrt(dx * dx + dy * dy);
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += TWO_PI;

    for (const segment of this.segments) {
      for (const slice of segment.slices) {
        if (slice.containsPoint(r, angle)) return slice;
      }
    }
    return null;
  }

  updateHover(hoveredSlice) {
    for (const segment of this.segments) {
      for (const slice of segment.slices) {
        slice.hovering = slice === hoveredSlice;
      }
    }
    if (hoveredSlice) this.select(hoveredSlice.segment, hoveredSlice);
  }

  draw(ctx) {
    this.layout();
    for (const segment of this.segments) segment.draw(ctx);
  }
}

function buildDonut(entity, { x, y, radius }) {
  const donut = new Donut(x, y, radius);
  for (const seg of entity.segments) {
    const segment = new DonutSegment(seg.id, seg.name, donut);
    for (const v of seg.values) {
      segment.addSlice(new DonutSlice(v.id, v.name, segment, v.baseUrl));
    }
    if (segment.slices.length) donut.addSegment(segment);
  }
  return donut;
}
