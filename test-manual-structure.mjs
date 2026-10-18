import test from "node:test";
import assert from "node:assert/strict";
import {
  applySemanticPatch, effectiveParentId, effectiveOrder, normalizeGraph,
  reparentUserNode
} from "./graph-core.js";
import { applyReorganization } from "./priority-core.js";

function fixture() {
  const node = (id, parentId, order = 0) => ({
    id, type: "Branch", auto: { title: id, parentId, order }, user: {}
  });
  return normalizeGraph({
    nodes: {
      old: node("old", null), target: node("target", null),
      other: node("other", null), child: node("child", "old"),
      sibling: node("sibling", "target")
    },
    // Dragging changes user.parentId, not the old semantic source edge.
    edges: { oldEdge: { id: "oldEdge", from: "old", to: "child", type: "parent_of", user: {} } }
  });
}

test("manual parent and sibling order survive ordinary and full organization after reload", () => {
  let graph = reparentUserNode(fixture(), "child", "target", 0);
  graph = normalizeGraph(JSON.parse(JSON.stringify(graph)));
  const updates = [
    { id: "child", parent_id: "old", order: 99, summary: "new evidence" },
    { id: "sibling", parent_id: "other", order: -1 }
  ];
  graph = applySemanticPatch(graph, {
    update_nodes: updates,
    add_edges: [{ from: "old", to: "child", type: "parent_of" }]
  }).graph;
  graph = applyReorganization(graph, { update_nodes: updates });
  assert.equal(effectiveParentId(graph.nodes.child), "target");
  assert.equal(effectiveParentId(graph.nodes.sibling), "target");
  assert.equal(effectiveOrder(graph.nodes.child), 0);
  assert.equal(effectiveOrder(graph.nodes.sibling), 1);
  assert.equal(graph.nodes.child.auto.summary, "new evidence");
});

test("reorganization cannot merge or split the manually moved node or its effective parent", () => {
  const graph = reparentUserNode(fixture(), "child", "target", 0);
  const before = structuredClone(graph);
  for (const source of ["child", "target"]) {
    assert.throws(() => applyReorganization(graph, {
      merges: [{ source_id: source, target_id: "other" }]
    }), /锁定|用户覆盖/);
    assert.throws(() => applyReorganization(graph, {
      splits: [{ source_id: source, new_nodes: [
        { id: "split_one", type: "Branch" }, { id: "split_two", type: "Branch" }
      ] }]
    }), /锁定|用户覆盖/);
  }
  assert.deepEqual(graph, before, "rejected organization must be atomic");
});

test("unlocked field-only children follow a merged parent; stale edges do not move a dragged child", () => {
  let graph = fixture();
  graph.nodes.loose = { id: "loose", type: "Branch", auto: { parentId: "old" }, user: {} };
  graph = reparentUserNode(graph, "child", "target", 0);
  graph = applyReorganization(graph, { merges: [{ source_id: "old", target_id: "other" }] });
  assert.equal(effectiveParentId(graph.nodes.child), "target");
  assert.equal(effectiveParentId(graph.nodes.loose), "other");
});

test("another explicit user drag can revise an already locked structure", () => {
  let graph = reparentUserNode(fixture(), "child", "target", 0);
  graph = reparentUserNode(graph, "child", null, 0);
  assert.equal(effectiveParentId(graph.nodes.child), null);
  graph = applySemanticPatch(graph, { update_nodes: [{ id: "child", parent_id: "old", order: 99 }] }).graph;
  assert.equal(effectiveParentId(graph.nodes.child), null);
  assert.equal(effectiveOrder(graph.nodes.child), 0);
});
