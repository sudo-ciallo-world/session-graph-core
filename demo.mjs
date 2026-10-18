import assert from "node:assert/strict";
import {
  normalizeGraph, reparentUserNode, applySemanticPatch, effectiveParentId, effectiveOrder,
} from "./graph-core.js";
import { applyReorganization } from "./priority-core.js";
import fixture from "./fixtures/task-graph.json" with { type: "json" };

let graph = normalizeGraph(structuredClone(fixture));
graph = reparentUserNode(graph, "task", "chosen", 0);
graph = normalizeGraph(JSON.parse(JSON.stringify(graph)));
const update = [{ id: "task", parent_id: "original", order: 99, summary: "Synthetic new evidence" }];
graph = applySemanticPatch(graph, { update_nodes: update }).graph;
graph = applyReorganization(graph, { update_nodes: update });
assert.equal(effectiveParentId(graph.nodes.task), "chosen");
assert.equal(effectiveOrder(graph.nodes.task), 0);
console.log(JSON.stringify({
  fixture: "SYNTHETIC ONLY",
  manualParent: effectiveParentId(graph.nodes.task),
  manualOrder: effectiveOrder(graph.nodes.task),
  refreshedSummary: graph.nodes.task.auto.summary,
  manualStructurePreserved: true,
}, null, 2));
