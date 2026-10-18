import {
  EDGE_TYPES,
  NODE_STATUSES,
  NODE_TYPES,
  applyUserNodeDrop,
  applySemanticPatch,
  effectiveMessageRefs,
  effectiveOrder,
  effectiveParentId,
  effectiveStatus,
  effectiveSummary,
  effectiveUserPriority,
  isNodeHidden,
  isNodeWaiting,
  isUserKept,
  effectivePriorityRank,
  isUserParentLocked,
  effectiveTitle,
  effectiveType,
  isNodeInActiveTaskScope,
  normalizeGraph,
  normalizeUserPriority,
  patchUserNode
} from "./graph-core.js";
import { assertReorganizationScope } from "./reorganization-safety.js";

export const PRIORITY_SETTINGS_KEY = "ctg:priority-settings:v1";

export const DEFAULT_PRIORITY_PREFERENCES = `目标：在有限时间内，优先完成最能改变现实状态的下一步行动。

优先级层：
P0 硬约束：明确的重大现实损失、不可逆损失或硬截止；普通早截止不自动进入 P0。
P1 赚钱与市场验证：申请、触达、演示、报价、成交、收款、交付和低成本市场实验。
P2 真实 AI 闭环：真实输入 → AI 处理 → 工具/API/数据 → 人工验证 → 可用输出 → 实际使用 → 反馈。
P3 当前瓶颈学习：只有不知道它会让 P0/P1/P2 无法继续时才学习，学完立即应用。
P4 探索研究：研究必须对应近期决策；不能说明研究后要决定什么，就进入队列后部。
P5 优化整理：只有已经成为 P0/P1/P2 明确瓶颈时才提升。

硬过滤：没有明确输出、不能改变现实状态、只是减少不确定感、重复已有任务或只是优化已经能用的东西时降级或排除。能用低成本真实行动验证时，不先做长研究。

同层评分（0–5）：结果影响×6，信息价值×5，瓶颈解除×4，反馈速度×3，个人适配×2，可复用资产×1。纯研究、无决策、无真实来源、重复、切换方向、长时间低反馈 debug、提前通用学习都扣分。

排序：优先级层 → 是否解除瓶颈 → 综合得分 → 更短反馈周期。重要性与紧急性同时判断；等待中的任务保留并标明等待原因，不把等待误判为低价值。当前只突出 1–3 个任务。

AI 生成任务必须包含：任务、现在为什么做、完成标准、预计时间、对应目标、下一步动作。`;

export const ESTIMATE_BUCKETS = [15, 30, 60, 90, 120, 180, 240, 360];

export function emptyPriorityState() {
  return {
    status: "idle",
    lastRunAt: null,
    lastError: "",
    lastModel: "",
    orderedTaskIds: [],
    excludedTaskIds: [],
    items: {},
    changes: [],
    questions: [],
    pendingPreferenceDiff: null,
    reviewCount: 0
  };
}

export function normalizePriorityState(value) {
  const defaults = emptyPriorityState();
  const state = {
    ...defaults,
    ...(value && typeof value === "object" ? value : {})
  };
  state.orderedTaskIds = Array.isArray(state.orderedTaskIds)
    ? state.orderedTaskIds.map(String)
    : [];
  state.excludedTaskIds = Array.isArray(state.excludedTaskIds)
    ? state.excludedTaskIds.map(String)
    : [];
  state.items = state.items && typeof state.items === "object" ? state.items : {};
  state.changes = Array.isArray(state.changes) ? state.changes.slice(0, 40) : [];
  state.questions = Array.isArray(state.questions) ? state.questions : [];
  if (
    !state.pendingPreferenceDiff ||
    typeof state.pendingPreferenceDiff !== "object"
  ) {
    state.pendingPreferenceDiff = null;
  }
  return state;
}

export function normalizePrioritySettings(value) {
  const text =
    typeof value?.preferenceText === "string" && value.preferenceText.length
      ? value.preferenceText
      : DEFAULT_PRIORITY_PREFERENCES;
  return { preferenceText: text };
}

function tier(value) {
  return ["high", "medium", "low"].includes(value) ? value : "low";
}

function layer(value) {
  return /^P[0-5]$/.test(String(value || "")) ? String(value) : "P5";
}

function decision(value) {
  return value === "exclude" ? "exclude" : "keep";
}

function urgency(value) {
  return ["high", "medium", "low"].includes(value) ? value : "low";
}

// A user tier replaces the AI tier; the AI rank orders Tasks within that tier.
function priorityTierRank(value) {
  return { high: 3, medium: 2, low: 1 }[tier(value)];
}

function orderPriorityItems(items, taskIds) {
  const ranked = taskIds.map((id, index) => ({ id, item: items[id], index }));
  const kept = ranked.filter(({ item }) => item?.decision !== "exclude");
  const pinned = kept
    .filter(({ item }) => item?.userRank != null)
    .sort((a, b) => a.item.userRank - b.item.userRank || a.index - b.index);
  const free = kept
    .filter(({ item }) => item?.userRank == null)
    .sort(
      (a, b) =>
        priorityTierRank(b.item?.importanceTier) - priorityTierRank(a.item?.importanceTier) ||
        safeRank(a.item?.rank, Number.POSITIVE_INFINITY) - safeRank(b.item?.rank, Number.POSITIVE_INFINITY) ||
        a.index - b.index
    );
  const slots = new Array(kept.length).fill(null);
  let lastSlot = -1;
  for (let index = 0; index < pinned.length; index += 1) {
    const entry = pinned[index];
    // Reserve room for later pins: collisions and out-of-range ranks cannot
    // wrap a later row ahead of an earlier one or write outside the array.
    const slot = Math.max(
      lastSlot + 1,
      Math.min(entry.item.userRank, slots.length - (pinned.length - index))
    );
    slots[slot] = entry.id;
    lastSlot = slot;
  }
  let cursor = 0;
  for (const entry of free) {
    while (slots[cursor] !== null) cursor += 1;
    slots[cursor] = entry.id;
  }
  return slots;
}

// Reuse the last AI assessment immediately after a manual edit, without
// waiting for another model request. Node metadata is always authoritative.
export function recomputePriorityOrder(graphValue) {
  const graph = normalizeGraph(graphValue);
  const priority = normalizePriorityState(graph.priority);
  for (const [id, item] of Object.entries(priority.items)) {
    const node = graph.nodes[id];
    if (!node || !item) continue;
    item.aiImportanceTier = tier(item.aiImportanceTier || item.importanceTier);
    item.userPriority = effectiveUserPriority(node);
    item.userKept = isUserKept(node);
    item.userRank = effectivePriorityRank(node);
    item.waiting = isNodeWaiting(node);
    item.importanceTier = item.userPriority || item.aiImportanceTier;
    if (node.user?.executionRoute === "defer") {
      item.decision = "exclude";
    } else if ((item.userPriority || item.userKept) && item.decision === "exclude") {
      item.decision = "keep";
      item.decisionOverride = "exclude";
    }
  }
  const taskIds = [...new Set([
    ...priority.orderedTaskIds,
    ...Object.keys(priority.items)
  ])];
  priority.orderedTaskIds = orderPriorityItems(priority.items, taskIds);
  priority.excludedTaskIds = [...new Set([
    ...priority.excludedTaskIds.filter((id) => !priority.items[id] && !isUserKept(graph.nodes[id])),
    ...Object.values(graph.nodes).filter(node => node.user?.executionRoute === "defer").map(node => node.id),
    ...taskIds.filter((id) => priority.items[id]?.decision === "exclude")
  ])];
  graph.priority = priority;
  return graph;
}

// A left/right canvas drop is both a structural instruction and, for reviewed
// sibling Tasks, a priority instruction. Only the slots already occupied by
// that sibling row are rewritten; unrelated Projects and filtered Tasks keep
// their existing global positions.
export function applyManualNodeDrop(graphValue, input = {}) {
  const dropped = applyUserNodeDrop(graphValue, input);
  let graph = dropped.graph;
  const source = graph.nodes[String(input.nodeId || "")];
  const target = graph.nodes[String(input.targetId || "")];
  const changedNodeIds = new Set(dropped.changedNodeIds);
  let priorityChanged = false;

  if (
    input.position !== "inside" &&
    effectiveType(source) === "Task" &&
    effectiveType(target) === "Task"
  ) {
    graph = recomputePriorityOrder(graph);
    const priority = normalizePriorityState(graph.priority);
    const currentOrder = priority.orderedTaskIds.filter(
      (id) => priority.items[id]?.decision !== "exclude"
    );
    const currentSet = new Set(currentOrder);
    const rowTaskIds = Object.values(graph.nodes)
      .filter(
        (node) =>
          !isNodeHidden(node) &&
          effectiveType(node) === "Task" &&
          effectiveParentId(node) === (dropped.parentId || null) &&
          currentSet.has(node.id) &&
          isNodeInActiveTaskScope(graph, node)
      )
      .sort(
        (a, b) =>
          effectiveOrder(a) - effectiveOrder(b) ||
          String(a.id).localeCompare(String(b.id))
      )
      .map((node) => node.id);
    const rowSet = new Set(rowTaskIds);
    const slots = currentOrder
      .map((id, index) => (rowSet.has(id) ? index : -1))
      .filter((index) => index >= 0);

    if (
      rowTaskIds.length > 1 &&
      rowTaskIds.includes(source.id) &&
      rowTaskIds.includes(target.id) &&
      slots.length === rowTaskIds.length
    ) {
      rowTaskIds.forEach((id, index) => {
        patchUserNode(graph, id, { priorityRank: slots[index] });
        changedNodeIds.add(id);
      });
      graph = recomputePriorityOrder(graph);
      priorityChanged = true;
    }
  }

  return {
    graph,
    parentId: dropped.parentId,
    changedNodeIds: [...changedNodeIds],
    priorityChanged
  };
}

function safeRank(value, fallback) {
  const rank = Number(value);
  return Number.isFinite(rank) ? rank : fallback;
}

function ancestor(graph, nodeId, expectedType) {
  let current = graph.nodes[nodeId];
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId = effectiveParentId(current);
    if (!parentId) return null;
    current = graph.nodes[parentId];
    if (effectiveType(current) === expectedType) return current;
  }
  return null;
}

function estimateBucket(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return ESTIMATE_BUCKETS.find((minutes) => minutes >= numeric) ||
    ESTIMATE_BUCKETS[ESTIMATE_BUCKETS.length - 1];
}

function estimateConfidence(value) {
  return ["low", "medium", "high"].includes(value) ? value : "low";
}

function estimateContextParts(graph, taskNode) {
  return Object.values(graph.nodes)
    .filter((node) => {
      if (!node || node.id === taskNode.id || isNodeHidden(node)) return false;
      return ancestor(graph, node.id, "Task")?.id === taskNode.id;
    })
    .sort((a, b) =>
      effectiveOrder(a) - effectiveOrder(b) ||
      String(a.id).localeCompare(String(b.id))
    )
    .slice(0, 40)
    .map((node) => [
      effectiveType(node),
      effectiveTitle(node),
      effectiveSummary(node),
      effectiveStatus(node)
    ]);
}

function shortStableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function taskEstimateContextVersion(graph, node) {
  const project = projectLabel(graph, node.id);
  const context = JSON.stringify({
    title: effectiveTitle(node),
    summary: effectiveSummary(node),
    project: project ? effectiveTitle(project) : "",
    parts: estimateContextParts(graph, node)
  });
  return `estimate-v1-${shortStableHash(context)}`;
}

function changeReason(item) {
  return String(item.reason || "本轮优先级评审重新判断了该任务");
}

function assertPriorityReviewCoverage(graph, review, taskIds) {
  const expected = taskIds.map(String);
  const expectedSet = new Set(expected);
  if (expectedSet.size !== expected.length) {
    throw new Error("优先级评审输入包含重复 Task ID");
  }
  for (const id of expected) {
    const node = graph.nodes[id];
    if (!node || isNodeHidden(node) || effectiveType(node) !== "Task") {
      throw new Error(`优先级评审输入包含非活动 Task：${id}`);
    }
  }
  const provided = Array.isArray(review?.tasks)
    ? review.tasks.map((item) => String(item?.id || ""))
    : [];
  const providedSet = new Set(provided);
  if (
    providedSet.size !== provided.length ||
    providedSet.size !== expectedSet.size ||
    provided.some((id) => !expectedSet.has(id)) ||
    expected.some((id) => !providedSet.has(id))
  ) {
    throw new Error("优先级评审未完整覆盖最终活动 Task");
  }
}

export function applyPriorityReview(graphValue, reviewValue, context = {}) {
  const graph = normalizeGraph(graphValue);
  const previous = normalizePriorityState(graph.priority);
  const review = reviewValue && typeof reviewValue === "object" ? reviewValue : {};
  const taskIds = Array.isArray(context.taskIds)
    ? context.taskIds.map(String)
    : [];
  assertPriorityReviewCoverage(graph, review, taskIds);
  const sourceTasks = Array.isArray(review.tasks) ? review.tasks : [];
  const byId = new Map(sourceTasks.map((item) => [String(item?.id || ""), item]));
  const items = {};

  const ranked = taskIds.map((id, index) => {
    const source = byId.get(id) || {};
    const meta = taskMetaFromGraph(graph, graph.nodes[id]);
    const previousItem = previous.items[id] || {};
    // A priority the user assigned by hand is an explicit instruction, not a
    // suggestion: it can move a Task up or down, but it can never be the reason
    // a Task silently leaves the list. Restoring an excluded Task records the
    // same kind of instruction through node.user.keep. The AI decision is
    // recorded separately so the review log can show the override.
    const userPriority = normalizeUserPriority(meta.user_priority);
    const userKept = Boolean(meta.user_keep);
    // A slot the user dragged the Task into. It outranks the AI rank: the user
    // said where this Task belongs, and the review's job is to order everything
    // they did not place by hand.
    const pinnedRank = effectivePriorityRank(graph.nodes[id]);
    const aiDecision = decision(source.decision);
    const overridden =
      (Boolean(userPriority) || userKept) && aiDecision === "exclude";
    const currentEstimateVersion = meta.estimate_context_version;
    const previousEstimateIsCurrent =
      previousItem.estimateContextVersion === currentEstimateVersion &&
      Number(previousItem.estimatedMinutesP50) > 0 &&
      Number(previousItem.estimatedMinutesP80) > 0;
    const modelEstimateIsCurrent =
      String(source.estimate_context_version || "") === currentEstimateVersion;
    const estimatedMinutesP50 = previousEstimateIsCurrent
      ? estimateBucket(previousItem.estimatedMinutesP50, 30)
      : modelEstimateIsCurrent
        ? estimateBucket(source.estimated_minutes_p50, 30)
        : 30;
    const estimatedMinutesP80 = Math.max(
      estimatedMinutesP50,
      previousEstimateIsCurrent
        ? estimateBucket(previousItem.estimatedMinutesP80, 60)
        : modelEstimateIsCurrent
          ? estimateBucket(source.estimated_minutes_p80, 60)
          : 60
    );
    const item = {
      id,
      title: String(meta.title || source.title || id),
      project: String(meta.project || source.project || "未归属 Project"),
      rank: safeRank(source.rank, index + 1),
      priorityLayer: layer(source.priority_layer),
      aiImportanceTier: tier(source.importance_tier),
      importanceTier: userPriority || tier(source.importance_tier),
      urgencyTier: urgency(source.urgency_tier),
      decision: graph.nodes[id]?.user?.executionRoute === "defer" ? "exclude" : overridden ? "keep" : aiDecision,
      suggestedRoute: ["defer", "human", "assist", "agent", "web"].includes(source.suggested_route) ? source.suggested_route : "assist",
      executionPlan: String(source.execution_plan || "").slice(0, 16000),
      decisionOverride: overridden ? aiDecision : "",
      userPriority,
      userKept,
      userRank: pinnedRank,
      waiting: Boolean(source.waiting),
      reason: changeReason(source),
      estimatedMinutesP50,
      estimatedMinutesP80,
      estimateBasis: previousEstimateIsCurrent
        ? String(previousItem.estimateBasis || "")
        : modelEstimateIsCurrent
          ? String(source.estimate_basis || "")
          : "缺少可用模型估算，使用 FocusFlow 冷启动兜底档位",
      estimateConfidence: previousEstimateIsCurrent
        ? estimateConfidence(previousItem.estimateConfidence)
        : modelEstimateIsCurrent
          ? estimateConfidence(source.estimate_confidence)
          : "low",
      estimateModel: previousEstimateIsCurrent
        ? String(previousItem.estimateModel || "")
        : String(context.model || ""),
      estimatedAt: previousEstimateIsCurrent
        ? previousItem.estimatedAt
        : new Date().toISOString(),
      estimateContextVersion: currentEstimateVersion,
      updatedAt: Date.now()
    };
    items[id] = item;
    return { id, item, index };
  });

  const orderedTaskIds = orderPriorityItems(items, taskIds);
  const excludedTaskIds = ranked
    .filter(({ item }) => item.decision === "exclude")
    .map(({ id }) => id);
  const previousPositions = new Map(
    previous.orderedTaskIds.map((id, index) => [id, index + 1])
  );
  const nextPositions = new Map(
    orderedTaskIds.map((id, index) => [id, index + 1])
  );
  const changes = [];
  for (const id of taskIds) {
    const from = previousPositions.get(id) || null;
    const to = nextPositions.get(id) || null;
    if (from === to) continue;
    const item = items[id];
    changes.push({
      taskId: id,
      title: item.title,
      project: item.project,
      from,
      to,
      reason:
        to === null
          ? `${changeReason(item)}；AI 将其移出当前任务列表`
          : item.decisionOverride
            ? `${changeReason(item)}；AI 建议排除，但你已手动保留，仍在列表中`
            : item.userRank != null
              ? `你手动拖动把它固定在第 ${item.userRank + 1} 位，本轮保持不变`
              : changeReason(item),
      capturedAt: Date.now()
    });
  }

  const oldQuestions = new Map(
    previous.questions.map((question) => [String(question.id || ""), question])
  );
  const questions = (Array.isArray(review.questions) ? review.questions : [])
    .filter((question) => question && String(question.question || "").trim())
    .map((question, index) => {
      const id = String(question.id || `priority-question-${Date.now()}-${index}`);
      const old = oldQuestions.get(id);
      return {
        id,
        question: String(question.question),
        recommendation: String(question.recommendation || ""),
        answer: old?.answer || "",
        createdAt: old?.createdAt || Date.now()
      };
    });

  let pendingPreferenceDiff = previous.pendingPreferenceDiff;
  const proposed = review.preference_diff;
  const currentText = String(context.preferenceText || "");
  const replacementText =
    typeof proposed?.replacement_text === "string"
      ? proposed.replacement_text
      : "";
  if (
    !pendingPreferenceDiff &&
    replacementText &&
    replacementText !== currentText
  ) {
    pendingPreferenceDiff = {
      id: `priority-diff-${Date.now()}`,
      before: currentText,
      after: replacementText,
      summary: String(proposed.summary || "更新优先级偏好"),
      reason: String(proposed.reason || "AI 发现当前偏好未覆盖本轮判断"),
      createdAt: Date.now()
    };
  }

  graph.priority = {
    ...previous,
    status: "idle",
    lastRunAt: Date.now(),
    lastError: "",
    lastModel: String(context.model || ""),
    orderedTaskIds,
    excludedTaskIds,
    items,
    changes: changes.length ? changes : [{
      taskId: "",
      title: "本轮排序",
      project: "",
      from: null,
      to: null,
      reason: "本轮任务顺序没有变化",
      capturedAt: Date.now()
    }],
    questions,
    pendingPreferenceDiff,
    reviewCount: previous.reviewCount + 1
  };
  return graph;
}

export function applyPriorityQuestionAnswer(graphValue, questionId, answer) {
  const graph = normalizeGraph(graphValue);
  const priority = normalizePriorityState(graph.priority);
  const id = String(questionId || "");
  const text = String(answer || "");
  if (!id || !text.length) throw new Error("问题回答不能为空");
  priority.questions = priority.questions.map((question) =>
    String(question.id) === id ? { ...question, answer: text } : question
  );
  priority.status = "queued";
  graph.priority = priority;
  return graph;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function reorganizationId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{3,120}$/.test(id)) {
    throw new Error(`重整结果包含无效节点 ID：${id || "空"}`);
  }
  return id;
}

function liveReorganizationNode(graph, id) {
  const node = graph.nodes[id];
  return node && !isNodeHidden(node) ? node : null;
}

function mergeMessageRefs(existing, incoming) {
  const refs = [...(existing || []), ...(incoming || [])];
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref?.conversationId || ""}:${ref?.messageId || ""}`;
    if (!ref?.conversationId || !ref?.messageId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

}
function sourceMessageRefs(value, allowedRefs = null) {
  if (!Array.isArray(value)) return [];
  const refs = value
    .filter((ref) => ref && ref.conversation_id && ref.message_id)
    .map((ref) => ({
      conversationId: String(ref.conversation_id),
      messageId: String(ref.message_id)
    }));
  if (!allowedRefs) return refs;
  const allowed = new Set(
    allowedRefs.map((ref) => `${ref.conversationId}:${ref.messageId}`)
  );
  return refs.filter((ref) => allowed.has(`${ref.conversationId}:${ref.messageId}`));
}

function assertMutableParent(node, message) {
  if (isUserParentLocked(node)) {
    throw new Error(message);
  }
}

function hasUserStructureOverride(node) {
  const user = node.user || {};
  return Boolean(
    user.locked ||
      user.accepted ||
      // A hand-set priority or a manual restore is an instruction about this
      // Task's own identity. Rewriting it structurally would silently move or
      // discard that instruction, so the Task is only editable by the user.
      effectiveUserPriority(node) ||
      isUserKept(node) ||
      effectivePriorityRank(node) != null ||
      Object.keys(user.lockedFields || {}).length ||
      ["type", "title", "summary", "status", "parentId", "order"].some(
        (field) => hasOwn(user, field)
      )
  );
}

function assertReorganizationNode(node, message) {
  if (hasUserStructureOverride(node)) throw new Error(message);
}
function replaceNodeEdges(
  graph,
  sourceId,
  replacementId,
  childParents = null,
  dropIncomingParent = false
) {
  for (const edge of Object.values(graph.edges)) {
    if (edge.from !== sourceId && edge.to !== sourceId) continue;
    const wasEffectiveParent = edge.type === "parent_of" &&
      effectiveParentId(graph.nodes[edge.to]) === edge.from;
    if (edge.user?.locked) {
      throw new Error(`重整不能改动锁定关系：${edge.id}`);
    }
    if (dropIncomingParent && edge.type === "parent_of" && edge.to === sourceId) {
      delete graph.edges[edge.id];
      continue;
    }
    let from = edge.from === sourceId ? replacementId : edge.from;
    let to = edge.to === sourceId ? replacementId : edge.to;
    if (childParents && edge.type === "parent_of" && edge.from === sourceId) {
      from = childParents.get(edge.to) || replacementId;
    }
    if (from === to) {
      delete graph.edges[edge.id];
      continue;
    }
    const duplicate = Object.values(graph.edges).find(
      (candidate) =>
        candidate !== edge &&
        candidate.from === from &&
        candidate.to === to &&
        candidate.type === edge.type
    );
    if (duplicate) {
      delete graph.edges[edge.id];
      continue;
    }
    edge.from = from;
    edge.to = to;
    if (wasEffectiveParent) {
      const child = graph.nodes[to];
      if (child) {
        assertMutableParent(child, `重整不能改动锁定父节点：${child.id}`);
        child.auto.parentId = from;
        child.auto.updatedAt = Date.now();
      }
    }
  }
}

function updateNowReferences(graph, sourceId, targetId) {
  for (const [field, value] of Object.entries(graph.now)) {
    if (value === sourceId) graph.now[field] = targetId;
  }
  if (graph.view.userFocusNodeId === sourceId) {
    graph.view.userFocusNodeId = targetId;
  }
  if (graph.view.autoFocusNodeId === sourceId) {
    graph.view.autoFocusNodeId = targetId;
  }
  for (const binding of Object.values(graph.bindings)) {
    if (binding.projectId === sourceId) binding.projectId = targetId;
    if (binding.taskId === sourceId) binding.taskId = targetId;
    if (binding.branchId === sourceId) binding.branchId = targetId;
  }
}

function isDescendant(graph, sourceId, targetId) {
  let current = graph.nodes[targetId];
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId = effectiveParentId(current);
    if (parentId === sourceId) return true;
    current = graph.nodes[parentId];
  }
  return false;
}

function mergeReorganizationNode(graph, operation) {
  const sourceId = reorganizationId(operation?.source_id);
  const targetId = reorganizationId(operation?.target_id);
  const source = liveReorganizationNode(graph, sourceId);
  const target = liveReorganizationNode(graph, targetId);
  if (!source || !target || sourceId === targetId) {
    throw new Error(`重整合并节点不存在：${sourceId} → ${targetId}`);
  }
  if (effectiveType(source) !== effectiveType(target)) {
    throw new Error(`重整不能合并不同类型节点：${sourceId} → ${targetId}`);
  }
  assertReorganizationNode(
    source,
    `重整不能合并含用户覆盖的节点：${sourceId}`
  );
  assertReorganizationNode(
    target,
    `重整不能合并到含用户覆盖的节点：${targetId}`
  );
  if (isDescendant(graph, sourceId, targetId)) {
    throw new Error(`重整不能把节点合并到自己的子树：${sourceId} → ${targetId}`);
  }
  // Dragging changes user.parentId without rewriting the source evidence
  // edges. Check the actual tree, including children that have no edge.
  const sourceChildren = Object.values(graph.nodes).filter(
    (node) => !isNodeHidden(node) && effectiveParentId(node) === sourceId
  );
  for (const child of sourceChildren) {
    assertMutableParent(child, `重整不能移动锁定子节点：${child.id}`);
  }
  target.auto = target.auto || {};
  target.auto.messageRefs = mergeMessageRefs(
    target.auto.messageRefs,
    effectiveMessageRefs(source)
  );
  target.auto.updatedAt = Date.now();
  replaceNodeEdges(graph, sourceId, targetId, null, true);
  for (const child of sourceChildren) {
    child.auto.parentId = targetId;
    child.auto.updatedAt = Date.now();
  }
  source.auto = source.auto || {};
  source.auto.mergedInto = targetId;
  source.auto.status = "merged";
  source.auto.updatedAt = Date.now();
  updateNowReferences(graph, sourceId, targetId);
}

function assertSplitParents(parentIds, newIds) {
  for (const id of newIds) {
    const seen = new Set();
    let current = id;
    while (current && newIds.includes(current)) {
      if (seen.has(current)) throw new Error("重整拆分结果包含父子循环");
      seen.add(current);
      current = parentIds.get(current) || "";
    }
  }
}

function splitReorganizationNode(graph, operation) {
  const sourceId = reorganizationId(operation?.source_id);
  const source = liveReorganizationNode(graph, sourceId);
  const newNodes = Array.isArray(operation?.new_nodes)
    ? operation.new_nodes
    : [];
  if (!source || newNodes.length < 2) {
    throw new Error(`重整拆分结果无效：${sourceId}`);
  }
  assertReorganizationNode(
    source,
    `重整不能拆分含用户覆盖的节点：${sourceId}`
  );
  const ids = newNodes.map((item) => reorganizationId(item?.id));
  if (new Set(ids).size !== ids.length || ids.includes(sourceId)) {
    throw new Error(`重整拆分 ID 重复或覆盖原节点：${sourceId}`);
  }
  if (ids.some((id) => graph.nodes[id])) {
    throw new Error(`重整拆分使用了已有节点 ID：${sourceId}`);
  }
  const sourceParent = effectiveParentId(source);
  const parentIds = new Map();
  for (const [index, item] of newNodes.entries()) {
    const parentId = String(item.parent_id ?? sourceParent ?? "").trim();
    if (
      parentId === sourceId ||
      (parentId && !liveReorganizationNode(graph, parentId) && !ids.includes(parentId))
    ) {
      throw new Error(`重整拆分父节点不存在：${parentId}`);
    }
    parentIds.set(ids[index], parentId);
  }
  assertSplitParents(parentIds, ids);

  const childParents = new Map();
  const sourceChildren = Object.values(graph.nodes).filter(
    (node) =>
      liveReorganizationNode(graph, node.id) &&
      effectiveParentId(node) === sourceId
  );
  for (const child of sourceChildren) {
    assertMutableParent(child, `重整不能移动锁定子节点：${child.id}`);
    childParents.set(child.id, ids[0]);
  }
  for (const assignment of Array.isArray(operation.child_assignments)
    ? operation.child_assignments
    : []) {
    const childId = reorganizationId(assignment?.child_id);
    const parentId = reorganizationId(assignment?.new_parent_id);
    if (!childParents.has(childId) || !ids.includes(parentId)) {
      throw new Error(`重整拆分子节点分配无效：${childId}`);
    }
    childParents.set(childId, parentId);
  }

  const sourceRefs = effectiveMessageRefs(source);
  for (const [index, item] of newNodes.entries()) {
    const id = ids[index];
    const type = String(item.type || "");
    const status = String(
      item.status || (type === "Parked" ? "parked" : "normal")
    );
    if (!NODE_TYPES.includes(type) || !NODE_STATUSES.includes(status) || status === "merged") {
      throw new Error(`重整拆分节点类型或状态无效：${id}`);
    }
    graph.nodes[id] = {
      id,
      type,
      source: { createdAt: Date.now(), createdBy: "reorganization" },
      auto: {
        title: String(item.title || "").trim(),
        summary: String(item.summary || "").trim(),
        status,
        parentId: parentIds.get(id) || null,
        order: item.order != null && Number.isFinite(Number(item.order))
          ? Number(item.order)
          : Object.keys(graph.nodes).length,
        messageRefs: sourceMessageRefs(item.source_message_refs, sourceRefs),
        updatedAt: Date.now()
      },
      user: { lockedFields: {}, messageRefs: [] }
    };
  }
  for (const child of sourceChildren) {
    child.auto.parentId = childParents.get(child.id);
    child.auto.updatedAt = Date.now();
  }
  replaceNodeEdges(graph, sourceId, ids[0], childParents);
  for (const [id, parentId] of parentIds) {
    if (!parentId) continue;
    const exists = Object.values(graph.edges).some(
      (edge) => edge.from === parentId && edge.to === id && edge.type === "parent_of"
    );
    if (exists) continue;
    const edgeId = `reorg_parent_${id}`;
    graph.edges[edgeId] = {
      id: edgeId,
      from: parentId,
      to: id,
      type: "parent_of",
      source: { createdAt: Date.now(), createdBy: "reorganization" },
      auto: { messageRefs: [], updatedAt: Date.now() },
      user: {}
    };
  }
  for (const edge of Array.isArray(operation.add_edges) ? operation.add_edges : []) {
    const from = reorganizationId(edge?.from);
    const to = reorganizationId(edge?.to);
    const type = String(edge?.type || "");
    if (!EDGE_TYPES.includes(type) || !liveReorganizationNode(graph, from) || !liveReorganizationNode(graph, to)) {
      throw new Error(`重整拆分关系无效：${from} → ${to}`);
    }
    if (type === "parent_of") {
      assertMutableParent(graph.nodes[to], `重整不能改动锁定父节点：${to}`);
    }
  }
  applySemanticPatch(graph, {
    add_nodes: [],
    update_nodes: [],
    add_edges: Array.isArray(operation.add_edges) ? operation.add_edges : [],
    active_node: "",
    now: {},
    conversation_binding: {}
  });
  source.auto = source.auto || {};
  source.auto.replaced = true;
  source.auto.splitInto = ids;
  source.auto.status = "merged";
  source.auto.updatedAt = Date.now();
  updateNowReferences(graph, sourceId, ids[0]);
}

export function applyReorganization(graphValue, resultValue, context = {}) {
  const graph = normalizeGraph(structuredClone(graphValue));
  const result = resultValue && typeof resultValue === "object" ? resultValue : {};
  assertReorganizationScope(graph, result, context);
  for (const edgeId of Array.isArray(result.remove_edge_ids) ? result.remove_edge_ids : []) {
    const edge = graph.edges[String(edgeId)];
    if (edge && !edge.user?.locked) delete graph.edges[String(edgeId)];
  }
  for (const operation of Array.isArray(result.merges) ? result.merges : []) {
    mergeReorganizationNode(graph, operation);
  }
  for (const operation of Array.isArray(result.splits) ? result.splits : []) {
    splitReorganizationNode(graph, operation);
  }
  const patch = {
    add_nodes: [],
    update_nodes: Array.isArray(result.update_nodes) ? result.update_nodes : [],
    add_edges: Array.isArray(result.add_edges) ? result.add_edges : [],
    active_node: "",
    now: {},
    conversation_binding: {}
  };
  return applySemanticPatch(graph, patch).graph;
}

export function projectLabel(graph, nodeId) {
  return ancestor(graph, nodeId, "Project");
}

export function taskMetaFromGraph(graph, node) {
  const project = projectLabel(graph, node.id);
  const userPriority = effectiveUserPriority(node);
  const estimateContextVersion = taskEstimateContextVersion(graph, node);
  const previousEstimate = graph.priority?.items?.[node.id] || {};
  const hasCurrentEstimate =
    previousEstimate.estimateContextVersion === estimateContextVersion &&
    Number(previousEstimate.estimatedMinutesP50) > 0 &&
    Number(previousEstimate.estimatedMinutesP80) > 0;
  return {
    id: node.id,
    title: effectiveTitle(node),
    summary: effectiveSummary(node),
    status: effectiveStatus(node),
    parent_id: effectiveParentId(node) || "",
    order: effectiveOrder(node),
    project: project ? effectiveTitle(project) : "未归属 Project",
    user_locked: Boolean(node.user?.locked),
    execution_route: node.user?.executionRoute || "",
    user_priority: userPriority,
    user_keep: isUserKept(node),
    user_priority_rank: effectivePriorityRank(node),
    estimate_required: !hasCurrentEstimate,
    estimate_context_version: estimateContextVersion,
    previous_estimate: hasCurrentEstimate ? {
      estimated_minutes_p50: previousEstimate.estimatedMinutesP50,
      estimated_minutes_p80: previousEstimate.estimatedMinutesP80,
      estimate_basis: previousEstimate.estimateBasis || "",
      estimate_confidence: previousEstimate.estimateConfidence || "low",
      estimate_context_version: estimateContextVersion
    } : null
  };
}
