// URL-synced graph state — lets a visitor share the current canvas (every
// node/edge added so far, plus which one is open) as a link. Hash-fragment
// based (never a custom path via pushState, and not a query string either):
// this is a static, backend-less app, and a fragment is never sent to the
// server on navigation, so a large shared graph can't run into a static
// host/CDN's request-line length limit (commonly ~8KB) the way a `?g=`
// query param could — only the browser's own (much larger) URL length cap
// applies.
// Deliberately NOT serialized: viewport pan/zoom, node x/y positions — the
// force layout in network.js resettles those from whatever starting
// positions restoreGraph() seeds, same as a fresh navigateFrom() spawn would.

const STATE_PARAM = "g";

function buildStateFromNetwork() {
  const indexOf = new Map(network.nodes.map((n, i) => [n, i]));
  return {
    nodes: network.nodes.map((n) => ({ iri: n.entity.id, s: n.entity.source ? n.entity.source.id : null })),
    edges: network.edges.map((e) => [indexOf.get(e.from), indexOf.get(e.to)]),
    open: network.openNode ? indexOf.get(network.openNode) : null,
  };
}

function syncUrlFromState() {
  const url = new URL(location.href);
  const params = new URLSearchParams(url.hash.slice(1));
  params.set(STATE_PARAM, JSON.stringify(buildStateFromNetwork()));
  url.hash = params.toString();
  history.replaceState(null, "", url);
}

function parseStateFromUrl() {
  const raw = new URLSearchParams(location.hash.slice(1)).get(STATE_PARAM);
  if (!raw) return null;

  let state;
  try {
    state = JSON.parse(raw);
  } catch (err) {
    console.warn(`Ignoring malformed "${STATE_PARAM}" URL param: ${err.message}`);
    return null;
  }

  if (!state || !Array.isArray(state.nodes) || !Array.isArray(state.edges)) {
    console.warn(`Ignoring "${STATE_PARAM}" URL param: unexpected shape.`);
    return null;
  }

  return state;
}

// Rebuilds `network` from a parsed state object. Fault-tolerant: an
// individual node whose entity fails to (re)fetch is skipped, along with any
// edges touching it, rather than aborting the whole restore.
async function restoreGraph(state) {
  const results = await Promise.allSettled(
    state.nodes.map(({ iri, s }) => getEntity(iri, s ? SOURCES.find((src) => src.id === s)?.baseUrl : undefined))
  );

  const entities = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.warn(`Skipping node ${state.nodes[i].iri} in shared graph link: ${r.reason?.message || r.reason}`);
    return null;
  });

  const adjacency = state.nodes.map(() => []);
  for (const [i, j] of state.edges) {
    if (entities[i] && entities[j]) {
      adjacency[i].push(j);
      adjacency[j].push(i);
    }
  }

  const center = toWorld(canvas.width / 2, canvas.height / 2);
  const placed = new Array(state.nodes.length).fill(null);
  const visited = new Array(state.nodes.length).fill(false);
  let firstComponent = true;

  const place = (i, x, y) => {
    visited[i] = true;
    placed[i] = new GraphNode(entities[i], x, y);
    network.addNode(placed[i]);
  };

  for (let i = 0; i < state.nodes.length; i++) {
    if (!entities[i] || visited[i]) continue;

    if (firstComponent) {
      place(i, center.wx, center.wy);
      firstComponent = false;
    } else {
      const angle = Math.random() * TWO_PI;
      place(i, center.wx + Math.cos(angle) * SPAWN_DISTANCE, center.wy + Math.sin(angle) * SPAWN_DISTANCE);
    }

    const queue = [i];
    while (queue.length) {
      const from = queue.shift();
      for (const to of adjacency[from]) {
        if (visited[to]) continue;
        const angle = Math.random() * TWO_PI;
        place(to, placed[from].x + Math.cos(angle) * SPAWN_DISTANCE, placed[from].y + Math.sin(angle) * SPAWN_DISTANCE);
        queue.push(to);
      }
    }
  }

  for (const [i, j] of state.edges) {
    if (placed[i] && placed[j]) network.addEdge(placed[i], placed[j]);
  }

  if (state.open != null && placed[state.open]) selectNode(placed[state.open]);
}
