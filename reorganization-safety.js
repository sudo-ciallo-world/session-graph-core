import { effectiveParentId } from "./graph-core.js";

export const REORGANIZATION_LIMITS = Object.freeze({
  maxBytes: 96 * 1024, maxNodes: 2048, maxEdges: 4096, maxTasks: 512,
});
export const REORGANIZATION_MAX_FAILURES = 3;

function oversized() {
  return Object.assign(new Error("重整快照超过安全上限；本次未发送模型请求。请缩小打开的任务范围后重试。"), {
    code: "REORGANIZATION_INPUT_TOO_LARGE", retryable: false,
  });
}
const text = (value, length) => String(value || "").slice(0, length);

// Keep every node/edge/task ID in the scope. Compress descriptive text and
// source previews, never silently drop topology or required task coverage.
export function boundReorganizationInput(input, limits = REORGANIZATION_LIMITS) {
  if (input.graph.nodes.length > limits.maxNodes || input.graph.edges.length > limits.maxEdges ||
      input.tasks.length > limits.maxTasks) throw oversized();
  const taskIds = new Set(input.tasks.map(t => t.id));
  for (const [summaryLimit, titleLimit, refLimit] of [[768, 160, 8], [256, 96, 4], [64, 64, 2], [0, 48, 0]]) {
    const nodes = input.graph.nodes.map(n => ({
      ...n, title: text(n.title, titleLimit), summary: text(n.summary, summaryLimit),
      message_refs: n.message_refs.slice(0, refLimit),
    }));
    const tasks = input.tasks.map(t => ({
      ...t, title: text(t.title, titleLimit), summary: text(t.summary, summaryLimit),
      project: text(t.project, titleLimit),
      previous_estimate: t.previous_estimate && {
        ...t.previous_estimate, estimate_basis: text(t.previous_estimate.estimate_basis, 120),
      },
    }));
    const previous = input.previous_priority || {};
    const items = Object.fromEntries(Object.entries(previous.items || {})
      .filter(([id]) => taskIds.has(id)).map(([id, item]) => [id, {
        rank: item.rank, decision: item.decision, importanceTier: item.importanceTier,
        urgencyTier: item.urgencyTier, waiting: item.waiting,
        estimatedMinutesP50: item.estimatedMinutesP50, estimatedMinutesP80: item.estimatedMinutesP80,
        estimateContextVersion: item.estimateContextVersion,
        reason: text(item.reason, 160), estimateBasis: text(item.estimateBasis, 120),
      }]));
    const bounded = { ...input, graph: { nodes, edges: input.graph.edges }, tasks,
      previous_priority: {
        ordered_task_ids: (previous.ordered_task_ids || []).filter(id => taskIds.has(id)),
        excluded_task_ids: (previous.excluded_task_ids || []).filter(id => taskIds.has(id)), items,
      },
      snapshot_budget: {
        max_bytes: limits.maxBytes, all_scope_ids_preserved: true,
        summary_char_limit: summaryLimit, title_char_limit: titleLimit,
        message_refs_per_node: refLimit, descriptions_and_refs_may_be_truncated: true,
      },
    };
    if (new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= limits.maxBytes) return bounded;
  }
  throw oversized();
}

// This runs twice per model request, not per UI render. Status, metrics and
// reply ACKs are excluded; topology, manual edits, bindings and priorities are not.
export function reorganizationVersion(graph, preferenceText = "") {
  return JSON.stringify({
    nodes: graph.nodes, edges: graph.edges, now: graph.now, view: graph.view,
    bindings: graph.bindings, tabToConversation: graph.tabToConversation,
    priority: { items: graph.priority?.items, ordered: graph.priority?.orderedTaskIds,
      excluded: graph.priority?.excludedTaskIds },
    preferenceText,
  });
}

export function assertFreshReorganization(graph, snapshot, preferenceText) {
  if (reorganizationVersion(graph, preferenceText) !== snapshot.version) {
    throw Object.assign(new Error("重整期间图或用户设置已变化，旧结果已丢弃，不会覆盖新修改。"), {
      code: "REORGANIZATION_STALE",
    });
  }
}

export function reorganizationRetryDelay(state, now = Date.now()) {
  if (!(Number(state?.pendingThreshold) > Number(state?.lastCompletedThreshold || 0)) ||
      state?.retryable === false || Number(state?.retryCount || 0) >= REORGANIZATION_MAX_FAILURES) return null;
  return Math.max(0, Number(state.nextRetryAt || 0) - now);
}
export function recordReorganizationFailure(state, threshold, error, now = Date.now()) {
  const retryCount = state.retryThreshold === threshold ? Number(state.retryCount || 0) + 1 : 1;
  return { ...state, retryThreshold: threshold, retryCount,
    retryable: error.retryable !== false,
    nextRetryAt: now + Math.min(120000, 30000 * (2 ** (retryCount - 1))) };
}

export function assertReorganizationScope(graph, result, context) {
  if (!context?.nodeIds) return;
  const existing = new Set(context.nodeIds);
  const allowed = new Set(existing);
  const edges = new Set(context.edgeIds || []);
  const fail = id => { throw Object.assign(new Error(`重整操作超出快照范围：${String(id)}`), {
    code: "REORGANIZATION_OUT_OF_SCOPE", retryable: false,
  }); };
  const requireNode = id => { if (!allowed.has(String(id))) fail(id); };
  const requireParent = id => { if (id != null && String(id) !== "") requireNode(id); };
  for (const split of result.splits || []) {
    if (!existing.has(String(split.source_id))) fail(split.source_id);
    for (const n of split.new_nodes || []) {
      const id = String(n.id || "");
      if (!id || graph.nodes[id] || allowed.has(id)) fail(id);
      allowed.add(id);
    }
  }
  const allowedRefs = context.messageRefs && new Set(context.messageRefs.map(r =>
    JSON.stringify([r.conversation_id, r.message_id])));
  const checkRefs = item => {
    if (!allowedRefs) return;
    for (const ref of item.source_message_refs || []) {
      if (!allowedRefs.has(JSON.stringify([ref.conversation_id, ref.message_id]))) fail("message_refs");
    }
  };
  const checkEdge = edge => {
    requireNode(edge.from); requireNode(edge.to);
    if (edge.id && graph.edges[edge.id] && !edges.has(String(edge.id))) fail(edge.id);
  };
  // Merge/split helpers also move children, rewrite incident edges and bindings.
  // Validate those implicit effects, not only the IDs returned by the model.
  const checkReplacement = source => {
    if (!existing.has(String(source))) fail(source);
    for (const n of Object.values(graph.nodes)) {
      if (effectiveParentId(n) === source && !existing.has(n.id)) fail(n.id);
    }
    for (const edge of Object.values(graph.edges)) {
      if ((edge.from === source || edge.to === source) &&
          (!edges.has(edge.id) || !existing.has(edge.from) || !existing.has(edge.to))) fail(edge.id);
    }
    if (context.conversationIds) {
      const conversations = new Set(context.conversationIds);
      for (const [id, binding] of Object.entries(graph.bindings)) {
        if (!conversations.has(id) && Object.values(binding).includes(source)) fail(id);
      }
    }
  };
  for (const id of result.remove_edge_ids || []) if (!edges.has(String(id))) fail(id);
  for (const merge of result.merges || []) {
    checkReplacement(String(merge.source_id)); requireNode(merge.target_id);
    if (!existing.has(String(merge.target_id))) fail(merge.target_id);
  }
  for (const split of result.splits || []) {
    checkReplacement(String(split.source_id));
    for (const n of split.new_nodes || []) {
      requireParent(n.parent_id ?? effectiveParentId(graph.nodes[split.source_id]));
      checkRefs(n);
      // The split helper generates this edge ID itself. It must not overwrite
      // an existing closed-scope relation even when the new node ID is unique.
      const generatedId = `reorg_parent_${n.id}`;
      if (graph.edges[generatedId]) fail(generatedId);
    }
    for (const assignment of split.child_assignments || []) {
      requireNode(assignment.child_id); requireNode(assignment.new_parent_id);
    }
    for (const edge of split.add_edges || []) checkEdge(edge);
  }
  for (const item of result.update_nodes || []) {
    requireNode(item.id); requireParent(item.parent_id); checkRefs(item);
  }
  for (const edge of result.add_edges || []) checkEdge(edge);
  for (const task of result.priority_review?.tasks || []) requireNode(task.id);
  return allowed;
}
