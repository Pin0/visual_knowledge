// Client for Memorix Elements API instances (see /docs/openapi on either host)
// — fetches JSON-LD records/concepts and flattens them into the
// {id, name, literals, segments} shape donut.js/app.js consume (same shape as
// example/app/helpers/resources_helper.rb's resource_json, and prototype's
// former mock data.js). Supports more than one such instance at once — see
// SOURCES below — so cross-collection owl:sameAs references can be followed.

const SOURCES = [
  {
    id: "amsterdam",
    label: "Amsterdam",
    baseUrl: "https://id.archief.amsterdam",
    defaultEntity: "https://id.archief.amsterdam/02b5176c-8dec-7410-a81b-b87cd82537c2",
  },
  {
    id: "leiden",
    label: "Leiden",
    baseUrl: "https://data.erfgoedleiden.nl",
    defaultEntity: "https://data.erfgoedleiden.nl/50441b40-26be-11e3-893a-3cd92befe4f8",
  },
];

function sourceForIri(iri) {
  return SOURCES.find((s) => iri.startsWith(s.baseUrl)) || null;
}

const DC_TITLE = "http://purl.org/dc/terms/title";
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

const FRIENDLY_LABELS = {
  "rico:scopeAndContent": "Description",
  "saa:creationDate": "Creation date",
  "image:isAssociatedWithAddress": "Address",
  "rico:hasDocumentaryFormType": "Type",
  "saa:hasCreator": "Creator",
  "rico:isOrWasIncludedIn": "Part of",
  "saa:isOrWasAlsoIncludedIn": "Also part of",
  "schema:birthDate": "Born",
  "pnv:hasName": "Name",
};

class NotExplorableError extends Error {}

const cache = new Map();

async function fetchEntity(iri, baseUrl) {
  if (cache.has(iri)) return cache.get(iri);

  const entity = isConceptIri(iri) ? await fetchConcept(iri) : await fetchRecord(iri, baseUrl);

  cache.set(iri, entity);
  cache.set(entity.id, entity);
  return entity;
}

function isConceptIri(iri) {
  return iri.includes("/resources/vocabularies/concepts/");
}

function extractRecordUuid(iri) {
  const m = iri.match(UUID_RE);
  return m ? m[0] : null;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchRecord(iri, baseUrl) {
  const uuid = extractRecordUuid(iri);
  if (!uuid) throw new NotExplorableError(`Not a browsable record: ${iri}`);

  const data = await fetchJson(`${baseUrl}/resources/records/${uuid}`);
  const index = new Map((data["@graph"] || []).map((n) => [n["@id"], n]));

  const focusIri = `${baseUrl}/${uuid}`;
  const focus = index.get(focusIri);
  if (!focus) throw new Error(`Record ${uuid} had no matching node in its own graph`);

  return mapRecordNode(focus, uuid, index, baseUrl);
}

async function fetchConcept(iri) {
  const node = await fetchJson(iri);
  return conceptEntityFromNode(iri, node);
}

function conceptEntityFromNode(iri, node) {
  const literals = [];
  const note = firstOf(node["skos:scopeNote"]);
  if (note) literals.push({ name: "Note", value: note });

  const source = sourceForIri(iri);
  return {
    id: iri,
    name: firstOf(node["skos:prefLabel"]) || humanizeIri(iri),
    typeLabel: "Concept",
    literals,
    segments: [],
    image: null,
    source,
    external: !source,
  };
}

function resolvePrimaryImage(contextNode, index) {
  const docsList = contextNode?.["memorix:hasDigitalDocument"]?.["@list"] || [];
  if (!docsList.length) return null;

  const firstAsset = index.get(docsList[0]["@id"]);
  const iiifRef = firstAsset?.["memorix:iiif"];
  if (!iiifRef?.["@id"]) return null;

  return {
    iiifBase: iiifRef["@id"],
    width: Number(firstOf(firstAsset["schema:width"])) || null,
    height: Number(firstOf(firstAsset["schema:height"])) || null,
  };
}

// dc:title on a context node comes back either as the fully-expanded
// predicate IRI (id.archief.amsterdam) or as the compact "dc:title" CURIE
// (data.erfgoedleiden.nl) — same @context mapping, just serialized
// differently between the two instances — so check both forms.
function contextTitle(contextNode) {
  if (!contextNode) return undefined;
  return firstOf(contextNode[DC_TITLE] ?? contextNode["dc:title"]);
}

function mapRecordNode(focus, uuid, index, baseUrl) {
  const contextNode = index.get(`${baseUrl}/resources/records/${uuid}/context`);
  const name =
    contextTitle(contextNode) ||
    firstOf(focus["rico:title"]) ||
    firstOf(focus["rdfs:label"]) ||
    humanizeIri(focus["@id"]);

  const literalsMap = new Map();
  const segmentsMap = new Map();
  const seenTargets = new Set();
  const ctx = { literalsMap, segmentsMap, index, baseUrl, seenTargets };

  for (const [key, rawValue] of Object.entries(focus)) {
    if (key === "@id" || key === "@type" || key === "rico:title" || key === DC_TITLE || key === "dc:title") continue;
    for (const v of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      handleValue(key, v, ctx);
    }
  }

  const literals = [...literalsMap.entries()].map(([key, values]) => ({
    name: labelFor(key),
    value: values.join("; "),
  }));
  const segments = [...segmentsMap.values()].filter((s) => s.values.length);
  const image = resolvePrimaryImage(contextNode, index);

  return {
    id: focus["@id"],
    name,
    typeLabel: typeLabelFrom(focus["@type"]),
    literals,
    segments,
    image,
    source: sourceForIri(focus["@id"]),
    external: false,
  };
}

function handleValue(key, value, ctx) {
  if (typeof value === "string") {
    addLiteral(ctx, key, value);
    return;
  }
  if (!value || typeof value !== "object") return;

  if ("@value" in value) {
    addLiteral(ctx, key, formatTypedLiteral(value));
  } else if ("@list" in value) {
    for (const item of value["@list"]) handleValue(key, item, ctx);
  } else if ("@id" in value) {
    const targetIri = value["@id"];
    if (targetIri.startsWith("_:")) {
      handleBlankNode(key, ctx.index.get(targetIri), ctx);
    } else {
      addReference(ctx, key, targetIri);
    }
  }
}

function handleBlankNode(key, bnode, ctx) {
  if (!bnode) return;
  const type = normalizeType(bnode["@type"]);

  if (type === "rico:DateRange") {
    const text = bnode["rico:textualValue"] || formatDateRange(bnode);
    if (text) addLiteral(ctx, key, text);
    return;
  }

  if (type === "image:Address") {
    const text = formatAddress(bnode, ctx.index);
    if (text) addLiteral(ctx, key, text);
    return;
  }

  if (type === "pnv:PersonName") {
    const text = [bnode["pnv:givenName"], bnode["pnv:surnamePrefix"], bnode["pnv:baseSurname"]]
      .filter(Boolean)
      .join(" ");
    if (text) addLiteral(ctx, key, text);
    return;
  }

  if (type === "saa:RelatedAgent") {
    const agentRef = bnode["saa:hasAgent"];
    if (!agentRef || !agentRef["@id"]) return;
    const targetIri = agentRef["@id"];
    let name = resolveDisplayName(targetIri, ctx.index, ctx.baseUrl);
    const roleRef = bnode["saa:hasRole"];
    if (roleRef && roleRef["@id"]) name = `${name} (${resolveDisplayName(roleRef["@id"], ctx.index, ctx.baseUrl)})`;
    addReference(ctx, key, targetIri, name);
    return;
  }

  // Unknown blank node type: surface any @id references it holds as their own
  // segments — keyed by their own predicate, since one wrapper can hold more
  // than one (e.g. erfgoedleiden.nl's image:Creator wraps rico:hasCreator,
  // image:DepictedLocation wraps schema:addressLocality) — and fall back to
  // concatenating whatever literal-ish properties are left. Nested blank
  // nodes (schema:geo's lat/long here) are left as-is, not recursed into.
  const parts = [];
  for (const [k, v] of Object.entries(bnode)) {
    if (k === "@id" || k === "@type") continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object" && "@value" in item) parts.push(formatTypedLiteral(item));
      else if (item && typeof item === "object" && "@id" in item && !item["@id"].startsWith("_:")) {
        addReference(ctx, k, item["@id"]);
      }
    }
  }
  if (parts.length) addLiteral(ctx, key, parts.join(", "));
}

function addLiteral(ctx, key, text) {
  if (!ctx.literalsMap.has(key)) ctx.literalsMap.set(key, []);
  ctx.literalsMap.get(key).push(text);
}

function addReference(ctx, key, targetIri, name) {
  // Some sources repeat the exact same target across multiple fields/rows —
  // e.g. erfgoedleiden.nl's schema:contentLocation is an array of per-house
  // "depicted location" blank nodes that all point at the same street/city
  // concept. One wedge for a given target per record is enough.
  if (ctx.seenTargets.has(targetIri)) return;
  ctx.seenTargets.add(targetIri);

  if (!ctx.segmentsMap.has(key)) ctx.segmentsMap.set(key, { id: key, name: labelFor(key), values: [] });
  ctx.segmentsMap.get(key).values.push({ id: targetIri, name: name || resolveDisplayName(targetIri, ctx.index, ctx.baseUrl) });
  cacheEmbeddedConcept(targetIri, ctx.index);
}

// id.archief.amsterdam embeds a skos:Concept "shim" node — @id + skos:prefLabel,
// nothing else — for every owl:sameAs-style target in the same @graph response,
// including ones pointing at external sites like Wikidata or RKD. Caching it now
// means fetchEntity resolves that target instantly later with no further fetch —
// which matters most for external IRIs, since there's no archief.amsterdam
// record/concept endpoint to ask for them.
function cacheEmbeddedConcept(iri, index) {
  if (cache.has(iri)) return;
  const node = index.get(iri);
  if (node && normalizeType(node["@type"]) === "skos:Concept") {
    cache.set(iri, conceptEntityFromNode(iri, node));
  }
}

// Looks up an already-resolved entity without attempting a network fetch.
// External (owl:sameAs) targets have no record/concept endpoint of their own
// — they only ever become resolvable via cacheEmbeddedConcept, as a side
// effect of fetching the record that embeds them — so state.js uses this to
// pick them up once that fetch has happened, instead of calling fetchEntity
// (which would throw NotExplorableError).
function peekCachedEntity(iri) {
  return cache.get(iri) || null;
}

function resolveDisplayName(iri, index, baseUrl) {
  const node = index.get(iri);
  if (node && normalizeType(node["@type"]) === "skos:Concept") {
    return firstOf(node["skos:prefLabel"]) || humanizeIri(iri);
  }

  const uuid = extractRecordUuid(iri);
  if (uuid) {
    const contextNode = index.get(`${baseUrl}/resources/records/${uuid}/context`);
    const title = contextTitle(contextNode);
    if (title) return title;

    const focus = index.get(iri);
    const focusTitle = focus && (firstOf(focus["rico:title"]) || firstOf(focus["rdfs:label"]));
    if (focusTitle) return focusTitle;
  }

  return humanizeIri(iri);
}

function firstOf(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) return firstOf(value[0]);
  if (typeof value === "object") return "@value" in value ? value["@value"] : undefined;
  return value;
}

function formatTypedLiteral(value) {
  const raw = value["@value"];
  if (value["@type"] === "xsd:boolean") return raw === "true" ? "Yes" : "No";
  return String(raw);
}

function formatDateRange(bnode) {
  const start = firstOf(bnode["rico:hasBeginningDate"]);
  const end = firstOf(bnode["rico:hasEndDate"]);
  if (start && end) return start === end ? start : `${start} – ${end}`;
  return start || end || "";
}

function formatAddress(bnode, index) {
  const streetRef = bnode["image:street"];
  const streetNode = streetRef && streetRef["@id"] && index.get(streetRef["@id"]);
  const street = streetNode && firstOf(streetNode["skos:prefLabel"]);
  const start = bnode["image:houseNumberBegin"];
  const end = bnode["image:houseNumberEnd"];
  const houseNumber = start && end && start !== end ? `${start}-${end}` : start || end || "";
  return [street, houseNumber].filter(Boolean).join(" ");
}

function normalizeType(type) {
  return Array.isArray(type) ? type[0] : type;
}

function typeLabelFrom(type) {
  const arr = Array.isArray(type) ? type : [type];
  const main = arr.find((t) => t && !t.startsWith("memorix:")) || arr[0];
  if (!main) return "";
  return main.includes(":") ? main.split(":").pop() : main;
}

function humanizeIri(iri) {
  const last = iri.split("/").filter(Boolean).pop() || iri;
  if (UUID_RE.test(last) && last.length < 40) return last.slice(0, 8) + "…";
  return decodeURIComponent(last).replace(/[-_]/g, " ");
}

function labelFor(key) {
  if (FRIENDLY_LABELS[key]) return FRIENDLY_LABELS[key];
  const stripped = key.includes(":") ? key.split(":").pop() : key.split("/").pop();
  const spaced = stripped.replace(/^has/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  const label = spaced || stripped;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Escapes Lucene wildcard syntax (`*`, `?`, `\`) so a keyword the user typed
// is matched literally rather than as a pattern.
function escapeWildcard(text) {
  return text.replace(/[\\*?]/g, "\\$&");
}

// Generic reverse-link lookup: every record referencing `iri` from ANY of its
// own fields, regardless of record type or property — see /search/records'
// `_link` field. Optionally narrowed by a keyword matched anywhere inside the
// title (not just whole words — `title`'s `wildcard` operator, confirmed live
// against the API, is what makes "kerk" match "Nieuwe Kerkstraat"). Needed
// since a popular concept/person can be linked from hundreds of thousands of
// records.
async function fetchBacklinks(iri, baseUrl, { keyword = "", page = 1, perPage = 12 } = {}) {
  const linkQuery = { type: "FieldQuery", operator: "equals", field: "_link", value: iri };
  const trimmed = keyword.trim();
  // A 1-character wildcard (*a*) is an extremely broad, expensive query for
  // little benefit, so only narrow once there's something meaningful to match.
  const query =
    trimmed.length >= 2
      ? {
          type: "AndQuery",
          queries: [linkQuery, { type: "FieldQuery", operator: "wildcard", field: "title", value: `*${escapeWildcard(trimmed)}*` }],
        }
      : linkQuery;

  const res = await fetch(`${baseUrl}/search/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pagination: { page, perPage }, query }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();

  return {
    total: data.total,
    page,
    perPage,
    hasMore: page * perPage < data.total,
    rows: data.rows.map((r) => ({
      id: `${baseUrl}/${r.id}`,
      name: r.title,
      typeLabel: r.data?.recordType?.title || r.data?.recordType?.id || "",
      thumbIri: r.media?.rows?.[0]?.iiif || null,
      baseUrl,
    })),
  };
}

// For a genuinely external reference (Wikidata/RKD/...), check every OTHER
// configured source's own reverse-link index for the same IRI — the same
// `_link` lookup fetchBacklinks already does for "linked from elsewhere",
// just run against a different source's API. A hit means that source also
// has a record pointing at this same external entity.
async function findCrossSourceMatches(iri, keyword = "") {
  const hits = await Promise.all(
    SOURCES.map(async (source) => {
      try {
        const { rows } = await fetchBacklinks(iri, source.baseUrl, { keyword, perPage: 20 });
        return { source, rows };
      } catch {
        return { source, rows: [] };
      }
    })
  );
  return hits.filter((h) => h.rows.length > 0);
}
