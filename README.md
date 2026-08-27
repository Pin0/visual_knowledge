# Visual Knowledge Browser

**Live demo: https://pin0.github.io/visual_knowledge/**

A JavaScript, frontend-only tool for visually exploring linked data (RDF-style triples) from [id.archief.amsterdam](https://id.archief.amsterdam/docs/openapi/), Amsterdam's city archive. Every record, person, organisation, and concept is drawn as a circular node — click it open to see its attributes and follow its links, and the network grows around you as you explore.

## What it does

- **Donut nodes.** The currently open node renders as a ring: each wedge is a linked attribute (creator, part-of, depicted concept, ...), and clicking a wedge opens that linked record as a new node connected by an edge — so instead of navigating away, you build up a visual map of everything you've explored.
- **IIIF images.** Records that have a digitised image show it right inside the open node's ring.
- **Reverse links.** A sidebar panel lets you search for *other* records that link back to whatever's currently open (e.g. "what else is tagged with this concept"), with a keyword filter to narrow results before adding one to the graph.
- **Pan & zoom**, drag-to-rearrange nodes, and a details panel with the full record and a link back to the source.

## Project layout

- `prototype/` — the actual tool described above. Open `prototype/index.html` via a local static server (e.g. `python3 -m http.server` from that folder) or use the live demo link.
- `example/` and `example_donut/` — historical reference projects the visual design and interaction model are based on (see Credits below). They're kept for inspiration, not meant to be run.

## Credits

The circular node-link visualization here is directly inspired by **[ASK KEN™](http://askken.heroku.com)** and its extracted **[DONUT™ Radial Navigator](http://github.com/michael/donut)**, both created by **[Michael Aufreiter](http://twitter.com/simply_mql)** at **[Quasipartikel](http://quasipartikel.at)** (~2009), preserved here in `example/` and `example_donut/`. ASK KEN was a Node-Link diagram for browsing [Freebase](http://www.freebase.com) built with Rails and Processing.js; DONUT is its donut-chart rendering piece, published separately under the BSD license (see `example_donut/donut.pjs`). This project reimplements that same donut/network interaction model from scratch in plain JavaScript and canvas, pointed at a different (and still-running) linked-data API.

Color/layout help on the original ASK KEN was credited to Samo Korosec ([froodee.at](http://froodee.at/)); the DONUT page's HTML template was adapted from [orderedlist.com](http://orderedlist.com/demos/fancy-zoom-jquery/).
