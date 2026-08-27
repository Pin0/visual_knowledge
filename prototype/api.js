// Client for https://id.archief.amsterdam (see /docs/openapi) — fetches JSON-LD
// records/concepts and flattens them into the {id, name, literals, segments}
// shape donut.js/app.js consume (same shape as example/app/helpers/resources_helper.rb's
// resource_json, and prototype's former mock data.js).

const API_BASE = "https://id.archief.amsterdam";
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

async function fetchEntity(iri) {
  if (cache.has(iri)) return cache.get(iri);

  const entity = isConceptIri(iri) ? await fetchConcept(iri) : await fetchRecord(iri);

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

async function fetchRecord(iri) {
  const uuid = extractRecordUuid(iri);
  if (!uuid) throw new NotExplorableError(`Not a browsable record: ${iri}`);

  const data = await fetchJson(`${API_BASE}/resources/records/${uuid}`);
  const index = new Map((data["@graph"] || []).map((n) => [n["@id"], n]));

  const focusIri = `${API_BASE}/${uuid}`;
  const focus = index.get(focusIri);
  if (!focus) throw new Error(`Record ${uuid} had no matching node in its own graph`);

  return mapRecordNode(focus, uuid, index);
}

async function fetchConcept(iri) {
  const node = await fetchJson(iri);
  const literals = [];
  const note = firstOf(node["skos:scopeNote"]);
  if (note) literals.push({ name: "Note", value: note });

  return { id: iri, name: firstOf(node["skos:prefLabel"]) || humanizeIri(iri), typeLabel: "Concept", literals, segments: [] };
}

function mapRecordNode(focus, uuid, index) {
  const contextNode = index.get(`${API_BASE}/resources/records/${uuid}/context`);
  const name =
    firstOf(contextNode && contextNode[DC_TITLE]) ||
    firstOf(focus["rico:title"]) ||
    firstOf(focus["rdfs:label"]) ||
    humanizeIri(focus["@id"]);

  const literalsMap = new Map();
  const segmentsMap = new Map();
  const ctx = { literalsMap, segmentsMap, index };

  for (const [key, rawValue] of Object.entries(focus)) {
    if (key === "@id" || key === "@type" || key === "rico:title" || key === DC_TITLE) continue;
    for (const v of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      handleValue(key, v, ctx);
    }
  }

  const literals = [...literalsMap.entries()].map(([key, values]) => ({
    name: labelFor(key),
    value: values.join("; "),
  }));
  const segments = [...segmentsMap.values()].filter((s) => s.values.length);

  return { id: focus["@id"], name, typeLabel: typeLabelFrom(focus["@type"]), literals, segments };
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
    let name = resolveDisplayName(targetIri, ctx.index);
    const roleRef = bnode["saa:hasRole"];
    if (roleRef && roleRef["@id"]) name = `${name} (${resolveDisplayName(roleRef["@id"], ctx.index)})`;
    addReference(ctx, key, targetIri, name);
    return;
  }

  // Unknown blank node type: fall back to concatenating its own literal-ish properties.
  const parts = [];
  for (const [k, v] of Object.entries(bnode)) {
    if (k === "@id" || k === "@type") continue;
    if (typeof v === "string") parts.push(v);
    else if (v && typeof v === "object" && "@value" in v) parts.push(formatTypedLiteral(v));
  }
  if (parts.length) addLiteral(ctx, key, parts.join(", "));
}

function addLiteral(ctx, key, text) {
  if (!ctx.literalsMap.has(key)) ctx.literalsMap.set(key, []);
  ctx.literalsMap.get(key).push(text);
}

function addReference(ctx, key, targetIri, name) {
  if (!ctx.segmentsMap.has(key)) ctx.segmentsMap.set(key, { id: key, name: labelFor(key), values: [] });
  ctx.segmentsMap.get(key).values.push({ id: targetIri, name: name || resolveDisplayName(targetIri, ctx.index) });
}

function resolveDisplayName(iri, index) {
  if (isConceptIri(iri)) {
    const node = index.get(iri);
    return (node && firstOf(node["skos:prefLabel"])) || humanizeIri(iri);
  }

  const uuid = extractRecordUuid(iri);
  if (uuid) {
    const contextNode = index.get(`${API_BASE}/resources/records/${uuid}/context`);
    const title = contextNode && firstOf(contextNode[DC_TITLE]);
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
