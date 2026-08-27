# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repo currently contains **no implementation of the actual product yet** — only two historical reference projects kept for inspiration. There is no build system, package manager config, or test suite at the repo root. Before assuming any tooling exists, check whether it has since been added.

## What this project is

A **JavaScript, frontend-only** tool for visually exploring linked data (RDF-style triples). Each entity renders as a circular "donut" node:
- The **inner ring** shows string-literal attributes of the entity.
- The **outer ring** shows URIs (links to other entities) and relations.
- Relations are discovered by POSTing to `/search/records`, searching for field `_link` with the entity's URI.

The intended data source is an external API such as https://id.archief.amsterdam/docs/openapi/. The base API URL is expected to be hardcoded in the frontend (no backend of its own).

## Reference material in this repo

### `example/` — ASK KEN™ (Ruby on Rails, ~2009)
A full historical Rails app (Rails 2.x-era: `ActionController::Routing::Routes.draw`, `config/environments`, `vendor/plugins/haml`) that browsed Freebase data as a node-link diagram. Relevant for understanding the original data/JSON shape, not for its Rails plumbing:
- `app/controllers/resources_controller.rb` — `show` action returns `{ data: resource_json(resource), details_html: ... }`; `details` returns a rendered HTML partial.
- `app/helpers/resources_helper.rb` — `resource_json` shows how a Freebase resource was flattened into `{ id, name, attributes: [{ id, name, values: [{id, name}] }] }`, filtering to only object-type properties with values, capped at ~20 values per attribute.
- Do not attempt to run this app (Rails 2.x, sqlite3 dev db, ancient dependencies) — read it as a spec reference only.

### `example_donut/` — DONUT™ Radial Navigator (Processing.js, 2009)
A standalone HTML5 canvas visualization (`donut.pjs`, run via `lib/processing.js`) that this project's "donut" node concept is directly modeled on. Open `index.html` in a browser to see it run (loads `lib/jquery-1.3.2.min.js` and `lib/processing.js` locally, no build step). Key concepts worth reading before implementing the new circular-node UI:
- `Donut` — top-level object holding `segments`, positioned at `(x, y)` with a `radius`; tracks `selectedSegment` / `selectedSlice`.
- `DonutSegment` — a labeled ring wedge holding `slices`; its angular `amount()` is proportional to its share of total slices weighted by `weight`; segments animate between collapsed/expanded stroke width via `Tween` (`fan`, `breadthTween`) on selection.
- `DonutSlice` — an individual item within a segment; `checkSelected()` does hit-testing against mouse position using polar coordinates (radius + angle) against the slice's angular range.
- Selection re-centers the donut by adjusting `angleOffset`/`angleAdjustment` so the selected slice's midpoint angle stays stable.

When building the real implementation, expect to port this angle/segment/slice/tween model from Processing.js to plain JS + Canvas/SVG, and to adapt `resource_json`'s attribute/value shape to whatever the target OpenAPI (id.archief.amsterdam) actually returns.
