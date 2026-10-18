import { compressGraphText, decompressGraphText } from "./graph-compression.js";

export const GRAPH_STORAGE_KEY = "ctg:graph:v2";
export const GRAPH_STORAGE_FORMAT = "session-graph-json-v1";
export const GRAPH_COMPRESSED_FORMAT = "session-graph-gzip-v1";
let decodedSnapshot = null;
let graphWriteTail = Promise.resolve();

function parseGraph(text) {
  const graph = JSON.parse(text);
  if (!graph || typeof graph !== "object" || !graph.nodes || typeof graph.nodes !== "object") {
    throw new Error("Invalid stored Session Graph snapshot");
  }
  return graph;
}

export function isEncodedGraph(value) {
  return value?.storageFormat === GRAPH_STORAGE_FORMAT || value?.storageFormat === GRAPH_COMPRESSED_FORMAT;
}

export function decodeStoredGraph(value) {
  if (value?.storageFormat === GRAPH_STORAGE_FORMAT) return parseGraph(value.data);
  if (value?.storageFormat) throw new Error("Encoded Session Graph requires decodeGraphSnapshot");
  return value;
}

export async function decodeGraphSnapshot(value) {
  if (value?.storageFormat !== GRAPH_COMPRESSED_FORMAT) return decodeStoredGraph(value);
  if (typeof value.data !== "string") throw new Error("Invalid compressed Session Graph snapshot");
  if (decodedSnapshot?.data !== value.data) {
    const entry = { data: value.data, text: decompressGraphText(value.data) };
    decodedSnapshot = entry;
    entry.text.catch(() => { if (decodedSnapshot === entry) decodedSnapshot = null; });
  }
  // Only immutable text is shared. Every caller owns its mutable graph.
  return parseGraph(await decodedSnapshot.text);
}

// Chrome's nested value conversion and change-event copies dominate large
// snapshots. Keep one atomic key, encoding the graph once instead of traversing
// tens of thousands of nested dictionaries across each extension context.
export function encodeStoredGraph(graph) {
  if (!graph || graph.storageFormat || Object.keys(graph.nodes || {}).length < 500) return graph;
  return {
    storageFormat: GRAPH_STORAGE_FORMAT,
    data: JSON.stringify(graph),
    // Small hot projections remain readable without decoding the entire graph.
    view: graph.view || {},
    replyChecks: graph.replyChecks || {},
    tabToConversation: graph.tabToConversation || {}
  };
}

export async function encodeGraphSnapshot(graph) {
  const encoded = encodeStoredGraph(graph);
  if (encoded?.storageFormat !== GRAPH_STORAGE_FORMAT || encoded.data.length < 1000000 ||
      typeof CompressionStream !== "function") return structuredClone(encoded);
  const projection = structuredClone({
    view: encoded.view, replyChecks: encoded.replyChecks, tabToConversation: encoded.tabToConversation
  });
  const data = await compressGraphText(encoded.data);
  if (data.length >= encoded.data.length * 0.9) return { ...encoded, ...projection };
  decodedSnapshot = { data, text: Promise.resolve(encoded.data) };
  return { storageFormat: GRAPH_COMPRESSED_FORMAT, data, ...projection };
}

export async function readLocal(keys) {
  const values = await chrome.storage.local.get(keys);
  if (Object.hasOwn(values, GRAPH_STORAGE_KEY)) {
    values[GRAPH_STORAGE_KEY] = await decodeGraphSnapshot(values[GRAPH_STORAGE_KEY]);
  }
  return values;
}

export function writeLocal(values) {
  if (!Object.hasOwn(values, GRAPH_STORAGE_KEY)) return chrome.storage.local.set(values);
  const { [GRAPH_STORAGE_KEY]: graph, ...other } = values;
  const extras = structuredClone(other);
  // Compression may complete out of order; durable commits must not. Capture
  // inputs now and recover the tail after failures so later writes can proceed.
  const operation = Promise.all([graphWriteTail, encodeGraphSnapshot(graph)]).then(([, encoded]) => {
    return chrome.storage.local.set({ ...extras, [GRAPH_STORAGE_KEY]: encoded });
  });
  graphWriteTail = operation.catch(() => {});
  return operation;
}
