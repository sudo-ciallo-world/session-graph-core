import { EXECUTION_ROUTES, EXECUTION_PHASES, humanTimelineTask, humanAttention } from "./task-routing-core.js";
import { decodeStoredGraph } from "./graph-storage.js";

export const NODE_TYPES = [
  "Project",
  "Goal",
  "Task",
  "Branch",
  "Question",
  "Hypothesis",
  "Decision",
  "Conclusion",
  "NextAction",
  "Parked"
];

export const EDGE_TYPES = [
  "parent_of",
  "derived_from",
  "supports",
  "contradicts",
  "resolves",
  "related_to"
];

export const NODE_STATUSES = [
  "active",
  "normal",
  "parked",
  "resolved",
  "merged"
];

// A priority the user set by hand. Empty means "not assigned": the AI review
// decides the order on its own. A non-empty value is a user instruction, so the
// review may reorder that Task but must never exclude it.
export const USER_PRIORITIES = ["low", "medium", "high"];
export const ESTIMATE_MINUTE_BUCKETS = [15, 30, 60, 90, 120, 180, 240, 360];

export function normalizeUserPriority(value) {
  const priority = String(value || "");
  return USER_PRIORITIES.includes(priority) ? priority : "";
}

const NOW_SLOTS = {
  activeProjectId: "Project",
  activeGoalId: "Goal",
  activeTaskId: "Task",
  activeBranchId: "Branch",
  currentConclusionId: "Conclusion",
  currentQuestionId: "Question",
  nextActionId: "NextAction"
};

const PATCH_NOW_FIELDS = {
  active_project_id: "activeProjectId",
  active_goal_id: "activeGoalId",
  active_task_id: "activeTaskId",
  active_branch_id: "activeBranchId",
  current_conclusion_id: "currentConclusionId",
  current_unresolved_question_id: "currentQuestionId",
  next_action_id: "nextActionId"
};

export function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function emptyGraph() {
  return {
    version: 3,
    conversationIds: [],
    tabToConversation: {},
    bindings: {},
    nodes: {},
    edges: {},
    now: {
      activeProjectId: null,
      activeGoalId: null,
      activeTaskId: null,
      activeBranchId: null,
      currentConclusionId: null,
      currentQuestionId: null,
      nextActionId: null
    },
    view: {
      autoFocusNodeId: null,
      userFocusNodeId: null
    },
    semantic: {
      status: "idle",
      lastRunAt: null,
      lastError: "",
      metrics: {
        activeCalls: 0,
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalDurationMs: 0,
        lastDurationMs: 0,
        lastStartedAt: null,
        lastCompletedAt: null,
        intervalCount: 0,
        totalIntervalMs: 0,
        recent: []
      }
    },
    priority: {
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
    },
    reorganization: {
      status: "idle",
      startedAt: null,
      replyCount: 0,
      lastScheduledThreshold: 0,
      lastCompletedThreshold: 0,
      pendingThreshold: 0,
      countedAssistantMessageIds: {},
      lastRunAt: null,
      lastError: "",
      lastModel: ""
    }
  };
}

export function normalizeGraph(value) {
  value = decodeStoredGraph(value);
  const graph = value && typeof value === "object" ? value : emptyGraph();
  const defaults = emptyGraph();
  graph.version = 3;
  graph.conversationIds = Array.isArray(graph.conversationIds)
    ? graph.conversationIds
    : [];
  graph.tabToConversation = graph.tabToConversation || {};
  graph.bindings = graph.bindings || {};
  graph.nodes = graph.nodes || {};
  graph.edges = graph.edges || {};
  graph.now = { ...defaults.now, ...(graph.now || {}) };
  graph.view = { ...defaults.view, ...(graph.view || {}) };
  graph.semantic = { ...defaults.semantic, ...(graph.semantic || {}) };
  graph.semantic.metrics = {
    ...defaults.semantic.metrics,
    ...(graph.semantic.metrics || {})
  };
  graph.semantic.metrics.recent = Array.isArray(
    graph.semantic.metrics.recent
  )
    ? graph.semantic.metrics.recent.slice(0, 20)
    : [];
  graph.priority = { ...defaults.priority, ...(graph.priority || {}) };
  graph.priority.orderedTaskIds = Array.isArray(graph.priority.orderedTaskIds)
    ? graph.priority.orderedTaskIds
    : [];
  graph.priority.excludedTaskIds = Array.isArray(graph.priority.excludedTaskIds)
    ? graph.priority.excludedTaskIds
    : [];
  graph.priority.items =
    graph.priority.items && typeof graph.priority.items === "object"
      ? graph.priority.items
      : {};
  graph.priority.changes = Array.isArray(graph.priority.changes)
    ? graph.priority.changes.slice(0, 40)
    : [];
  graph.priority.questions = Array.isArray(graph.priority.questions)
    ? graph.priority.questions
    : [];
  graph.reorganization = {
    ...defaults.reorganization,
    ...(graph.reorganization || {})
  };
  graph.reorganization.countedAssistantMessageIds =
    graph.reorganization.countedAssistantMessageIds &&
    typeof graph.reorganization.countedAssistantMessageIds === "object"
      ? graph.reorganization.countedAssistantMessageIds
      : {};

  for (const node of Object.values(graph.nodes)) {
    node.source = node.source || {};
    node.auto = node.auto || {};
    node.user = node.user || {};
    node.user.lockedFields = node.user.lockedFields || {};
    node.auto.messageRefs = Array.isArray(node.auto.messageRefs)
      ? node.auto.messageRefs
      : [];
    node.user.messageRefs = Array.isArray(node.user.messageRefs)
      ? node.user.messageRefs
      : [];
  }

  return graph;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

export function effectiveTitle(node) {
  return (
    cleanText(node?.user?.title) ||
    cleanText(node?.auto?.title) ||
    "未命名节点"
  );
}

export function effectiveType(node) {
  return NODE_TYPES.includes(node?.user?.type) ? node.user.type : node?.type;
}

export function effectiveSummary(node) {
  return cleanText(node?.user?.summary) || cleanText(node?.auto?.summary);
}

export function effectiveStatus(node) {
  return node?.user?.status || node?.auto?.status || "normal";
}

// A manual "waiting for someone/something" flag. It never changes the node
// status, parentage, children or order; it only marks the task for the
// waiting summaries on both surfaces.
export function isNodeWaiting(node) {
  return node?.user?.waiting === true;
}

// The user's own priority for a Task, or "" when they never assigned one.
export function effectiveUserPriority(node) {
  return normalizeUserPriority(node?.user?.priority);
}

// Explicit "this Task stays" instruction, set when the user restores a Task the
// review wanted to exclude. It keeps the Task in the list without pretending the
// user assigned a priority tier.
export function isUserKept(node) {
  return node?.user?.keep === true;
}

// The list slot the user placed this Task in by dragging it in the priority
// rail. null means the user never placed it, so the AI orders it freely. A
// number is a user instruction: the Task keeps that slot while the review
// orders everything around it.
export function effectivePriorityRank(node) {
  const raw = node?.user?.priorityRank;
  if (raw === null || raw === undefined || raw === "") return null;
  const rank = Number(raw);
  return Number.isInteger(rank) && rank >= 0 ? rank : null;
}
export function hasWaitingProjectAncestor(graph, node) {
  const seen = new Set();
  let parent = graph?.nodes?.[effectiveParentId(node)];
  while (parent && !seen.has(parent.id)) {
    if (effectiveType(parent) === "Project" && isNodeWaiting(parent)) return true;
    seen.add(parent.id); parent = graph.nodes[effectiveParentId(parent)];
  }
  return false;
}

export function isNodeInWaitingScope(graph, node) {
  const seen = new Set();
  let current = node;
  while (current && !seen.has(current.id)) {
    if (isNodeWaiting(current)) return true;
    seen.add(current.id);
    current = graph?.nodes?.[effectiveParentId(current)];
  }
  return false;
}

// Waiting tasks that still deserve a reminder: unfinished, not accepted and
// not sitting under a hidden, accepted or resolved Task ancestor.
export function waitingTaskNodes(graph) {
  const result = [];
  for (const node of Object.values(graph?.nodes || {})) {
    if (!isNodeWaiting(node) || isNodeHidden(node)) continue;
    if (!["Task", "Project"].includes(effectiveType(node))) continue;
    if (isNodeInActiveTaskScope(graph, node)) result.push(node);
  }
  return result.sort(
    (a, b) =>
      (Number(a.user?.waitingAt) || 0) - (Number(b.user?.waitingAt) || 0) ||
      effectiveOrder(a) - effectiveOrder(b) ||
      effectiveTitle(a).localeCompare(effectiveTitle(b), "zh-CN")
  );
}

// A Task the surfaces can still push forward: inside the open projection,
// unfinished and not blocked on someone else. Waiting is a manual block, so a
// waiting task never becomes the next thing to work on.
export function isActionableTask(graph, node, openIds = openConversationNodeIds(graph)) {
  return Boolean(
    graph?.nodes?.[node?.id] === node &&
      !graph.priority?.excludedTaskIds?.includes(node.id) &&
      graph.priority?.items?.[node.id]?.decision !== "exclude" &&
      !isNodeHidden(node) &&
      effectiveType(node) === "Task" &&
      !node.user?.accepted &&
      (!isNodeWaiting(node) || humanAttention(node)) &&
      isNodeInFocusScope(graph, node) &&
      !hasWaitingProjectAncestor(graph, node) &&
      effectiveStatus(node) !== "resolved" &&
      openIds.has(node.id) &&
      isNodeInActiveTaskScope(graph, node)
  );
}

// The next focus target after a task stops being actionable: the highest ranked
// review order first, then the earliest manual order as a fallback.
export function nextActionableTaskId(graph) {
  const openIds = openConversationNodeIds(graph);
  const ordered = Array.isArray(graph?.priority?.orderedTaskIds)
    ? graph.priority.orderedTaskIds
    : [];
  for (const taskId of ordered) {
    const node = graph?.nodes?.[taskId];
    if (node && isActionableTask(graph, node, openIds)) return taskId;
  }
  const fallback = Object.values(graph?.nodes || {})
    .filter((node) => isActionableTask(graph, node, openIds))
    .sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
  return fallback[0]?.id || null;
}

export function effectiveParentId(node) {
  if (hasOwn(node?.user, "parentId")) {
    return node.user.parentId || null;
  }
  return node?.auto?.parentId || null;
}

export function effectiveOrder(node) {
  return Number.isFinite(node?.user?.order)
    ? node.user.order
    : Number.isFinite(node?.auto?.order)
      ? node.auto.order
      : 0;
}
export function isNodeHidden(node) {
  return Boolean(
    node?.user?.deleted ||
      node?.user?.mergedInto ||
      node?.auto?.mergedInto ||
      node?.auto?.replaced
  );
}


export function effectiveMessageRefs(node) {
  const refs = [
    ...(node?.auto?.messageRefs || []),
    ...(node?.user?.messageRefs || []),
    ...(node?.source?.createdBy === "inbox" && node.source.inboxId
      ? [{ conversationId: "ctg-inbox", messageId: node.source.inboxId }] : [])
  ];
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref?.conversationId || ""}:${ref?.messageId || ""}`;
    if (!ref?.conversationId || !ref?.messageId || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// Membership does not require materializing or deduplicating every source ref.
export function hasConversationRef(node, conversation) {
  const matches = typeof conversation === "string"
    ? id => id === conversation : id => conversation.has(id);
  if (node?.source?.createdBy === "inbox" && node.source.inboxId && matches("ctg-inbox")) return true;
  for (const refs of [node?.auto?.messageRefs, node?.user?.messageRefs]) {
    for (const ref of refs || []) {
      if (ref?.conversationId && ref.messageId && matches(ref.conversationId)) return true;
    }
  }
  return false;
}

// Inbox is a persistent conversation source. Project its owning Tasks and full
// branches without changing completion, parentage or manual order.
export function inboxConversationNodeIds(graph, { includeCompleted = true } = {}) {
  const nodes = graph?.nodes || {}, included = new Set(), seeds = new Set(), children = new Map();
  for (const node of Object.values(nodes)) {
    if (isNodeHidden(node)) continue;
    const parent = effectiveParentId(node);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node.id);
  }
  for (const source of Object.values(nodes)) {
    if (!hasConversationRef(source, "ctg-inbox")) continue;
    let node = source;
    const seen = new Set();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      const merged = node.user?.mergedInto || node.auto?.mergedInto;
      if (merged) { node = nodes[merged]; continue; }
      if (isNodeHidden(node)) break;
      included.add(node.id);
      if (effectiveType(node) === "Task") { seeds.add(node.id); break; }
      node = nodes[effectiveParentId(node)];
    }
  }
  const queue = [...seeds], expanded = new Set();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (expanded.has(id)) continue;
    expanded.add(id); included.add(id);
    queue.push(...(children.get(id) || []));
  }
  for (const id of [...included]) {
    let node = nodes[id];
    const seen = new Set();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      if (isNodeHidden(node)) break;
      included.add(node.id);
      node = nodes[effectiveParentId(node)];
    }
  }
  if (!includeCompleted) for (const id of [...included]) {
    let node = nodes[id];
    const seen = new Set();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      if (node.user?.accepted ||
          (["Task", "Project"].includes(effectiveType(node)) && node.user?.status === "resolved")) {
        included.delete(id); break;
      }
      node = nodes[effectiveParentId(node)];
    }
  }
  return included;
}

export function currentConversationIds(graph) {
  return new Set([...Object.values(graph?.tabToConversation || {}), "ctg-inbox"]);
}

export function openConversationNodeIds(graph, { includeAccepted = false } = {}) {
  const openConversationIds = new Set(
    [...Object.values(graph?.tabToConversation || {}), "ctg-inbox"]
  );
  const included = new Set();

  for (const conversationId of openConversationIds) {
    const binding = graph?.bindings?.[conversationId] || {};
    for (const nodeId of [
      binding.projectId,
      binding.taskId,
      binding.branchId
    ]) {
      const node = graph?.nodes?.[nodeId];
      if (node && !isNodeHidden(node)) included.add(nodeId);
    }
  }

  for (const node of Object.values(graph?.nodes || {})) {
    if (
      !isNodeHidden(node) &&
      hasConversationRef(node, openConversationIds)
    ) {
      included.add(node.id);
    }
  }

  for (const nodeId of [...included]) {
    let current = graph.nodes[nodeId];
    const seen = new Set();
    while (current) {
      const parentId = effectiveParentId(current);
      if (!parentId || seen.has(parentId)) break;
      const parent = graph.nodes[parentId];
      if (!parent || isNodeHidden(parent)) break;
      included.add(parentId);
      seen.add(parentId);
      current = parent;
    }
  }

  if (!includeAccepted) for (const nodeId of [...included]) {
    let current = graph.nodes[nodeId];
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      if (current.user?.accepted) {
        included.delete(nodeId);
        break;
      }
      seen.add(current.id);
      current = graph.nodes[effectiveParentId(current)];
    }
  }

  // Completed Inbox branches live in history. Keep their identities available
  // for explicit recovery/show-accepted views without mixing them into work.
  const inboxIds = inboxConversationNodeIds(graph);
  const currentInboxIds = includeAccepted ? inboxIds
    : inboxConversationNodeIds(graph, { includeCompleted: false });
  for (const id of inboxIds) if (!currentInboxIds.has(id)) included.delete(id);
  for (const id of currentInboxIds) included.add(id);
  return included;
}

function nodeDepth(graph, node) {
  let depth = 0;
  let current = node;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = graph?.nodes?.[effectiveParentId(current)];
    if (!parent || isNodeHidden(parent)) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

function conversationProjectionSeeds(graph, conversationId) {
  const binding = graph?.bindings?.[conversationId] || {};
  for (const nodeId of [binding.branchId, binding.taskId, binding.projectId]) {
    const node = graph?.nodes?.[nodeId];
    if (node && !isNodeHidden(node)) return [node];
  }
  return Object.values(graph?.nodes || {})
    .filter((node) =>
      !isNodeHidden(node) &&
      hasConversationRef(node, conversationId)
    )
    .sort((a, b) => nodeDepth(graph, b) - nodeDepth(graph, a));
}

function projectionRootForNode(graph, seed) {
  let current = seed;
  let highestProject = null;
  let highestTask = null;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const type = effectiveType(current);
    if (type === "Project") highestProject = current;
    if (type === "Task") highestTask = current;
    const parent = graph?.nodes?.[effectiveParentId(current)];
    if (!parent || isNodeHidden(parent)) break;
    current = parent;
  }
  return highestProject || highestTask;
}

function isNodeInOpenProjectionScope(graph, node) {
  const seen = new Set();
  let current = node;
  while (current && !seen.has(current.id)) {
    if (
      isNodeHidden(current) ||
      current.user?.accepted ||
      (["Task", "Project"].includes(effectiveType(current)) &&
        current.user?.status === "resolved")
    ) {
      return false;
    }
    seen.add(current.id);
    current = graph?.nodes?.[effectiveParentId(current)];
  }
  return true;
}

// Visible Inbox history must not become active work. AI status alone is not
// an explicit completion; user completion, acceptance and exclusion apply to
// the entire branch, including a manually focused descendant.
export function isNodeInFocusScope(graph, node) {
  if (!node || !isNodeInOpenProjectionScope(graph, node)) return false;
  const seen = new Set();
  let current = node;
  while (current && !seen.has(current.id)) {
    if (!humanTimelineTask(current) || (isNodeWaiting(current) && !humanAttention(current)) ||
        graph?.priority?.excludedTaskIds?.includes(current.id) ||
        graph?.priority?.items?.[current.id]?.decision === "exclude") return false;
    seen.add(current.id);
    current = graph?.nodes?.[effectiveParentId(current)];
  }
  return true;
}

// FocusFlow receives one execution entry per currently open ChatGPT
// conversation, collapsed to its highest Project (or highest Task when no
// Project exists). Message references are only a fallback when a conversation
// has no explicit binding; they must never fan one tab out into every Task it
// mentioned over time.
export function openConversationRootNodes(graph) {
  const conversationIds = new Set(
    Object.values(graph?.tabToConversation || {}).filter(Boolean)
  );
  const roots = new Map();
  for (const conversationId of conversationIds) {
    for (const seed of conversationProjectionSeeds(graph, conversationId)) {
      if (
        !isNodeInOpenProjectionScope(graph, seed) ||
        isNodeInWaitingScope(graph, seed)
      ) {
        continue;
      }
      const root = projectionRootForNode(graph, seed);
      if (
        !root ||
        isNodeHidden(root) ||
        root.user?.accepted ||
        isNodeInWaitingScope(graph, root) ||
        root.user?.status === "resolved"
      ) {
        continue;
      }
      roots.set(root.id, root);
      break;
    }
  }
  return [...roots.values()];
}

function isDescendantOf(graph, node, ancestorId) {
  let current = node;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    if (current.id === ancestorId) return true;
    seen.add(current.id);
    current = graph?.nodes?.[effectiveParentId(current)];
  }
  return false;
}

function directNodeEstimate(graph, node) {
  const manualP50 = Number(node?.user?.estimatedMinutesP50) || 0;
  const manualP80 = Number(node?.user?.estimatedMinutesP80) || 0;
  if (manualP50 > 0 && manualP80 >= manualP50) {
    return {
      estimatedMinutesP50: manualP50,
      estimatedMinutesP80: manualP80,
      estimateModel: "manual",
      estimateBasis: "用户手动设置",
      estimateConfidence: "high",
      estimatedAt: String(node?.user?.estimateUpdatedAt || ""),
      estimateContextVersion: "manual",
      aggregateTaskCount: 1,
    };
  }
  const item = graph?.priority?.items?.[node?.id] || {};
  const p50 = Number(item.estimatedMinutesP50) || 0;
  const p80 = Number(item.estimatedMinutesP80) || 0;
  if (p50 <= 0 || p80 <= 0) return null;
  return {
    estimatedMinutesP50: p50,
    estimatedMinutesP80: Math.max(p50, p80),
    estimateModel: String(item.estimateModel || ""),
    estimateBasis: String(item.estimateBasis || ""),
    estimateConfidence: String(item.estimateConfidence || ""),
    estimatedAt: String(item.estimatedAt || ""),
    estimateContextVersion: String(item.estimateContextVersion || ""),
    aggregateTaskCount: 1,
  };
}

// Reuse task ancestry within a projection instead of scanning every node per card.
export function createTaskProjectionIndex(graph) {
  const nodes = Object.values(graph?.nodes || {}), tasksByAncestor = new Map();
  for (const node of nodes) {
    if (effectiveType(node) !== "Task") continue;
    let current = node;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (!tasksByAncestor.has(current.id)) tasksByAncestor.set(current.id, []);
      tasksByAncestor.get(current.id).push(node);
      current = graph?.nodes?.[effectiveParentId(current)];
    }
  }
  return { nodes, tasksByAncestor, openIds: openConversationNodeIds(graph) };
}

// Projects sum actionable Tasks in the open projection unless directly estimated.
export function nodeEstimateSnapshot(graph, node, projection) {
  const direct = directNodeEstimate(graph, node);
  if (direct) return direct;
  if (effectiveType(node) !== "Project") {
    return {
      estimatedMinutesP50: 0,
      estimatedMinutesP80: 0,
      estimateModel: "",
      estimateBasis: "",
      estimateConfidence: "",
      estimatedAt: "",
      estimateContextVersion: "",
      aggregateTaskCount: 0,
    };
  }
  const openIds = projection?.openIds || openConversationNodeIds(graph);
  const estimates = (projection?.tasksByAncestor?.get(node.id) || (projection ? [] : Object.values(graph?.nodes || {})))
    .filter((candidate) =>
      effectiveType(candidate) === "Task" &&
      openIds.has(candidate.id) &&
      !isNodeHidden(candidate) &&
      !candidate.user?.accepted &&
      candidate.user?.status !== "resolved" &&
      !isNodeInWaitingScope(graph, candidate) &&
      isNodeInOpenProjectionScope(graph, candidate) &&
      isDescendantOf(graph, candidate, node.id)
    )
    .map((candidate) => directNodeEstimate(graph, candidate))
    .filter(Boolean);
  if (!estimates.length) return directNodeEstimate(graph, node) || {
    estimatedMinutesP50: 0,
    estimatedMinutesP80: 0,
    estimateModel: "",
    estimateBasis: "",
    estimateConfidence: "",
    estimatedAt: "",
    estimateContextVersion: "",
    aggregateTaskCount: 0,
  };
  const confidenceRank = { low: 0, medium: 1, high: 2 };
  const confidence = estimates.reduce(
    (lowest, item) =>
      (confidenceRank[item.estimateConfidence] ?? 0) <
      (confidenceRank[lowest] ?? 0)
        ? item.estimateConfidence
        : lowest,
    estimates[0].estimateConfidence || "low"
  );
  const models = new Set(estimates.map((item) => item.estimateModel).filter(Boolean));
  return {
    estimatedMinutesP50: estimates.reduce(
      (total, item) => total + item.estimatedMinutesP50,
      0
    ),
    estimatedMinutesP80: estimates.reduce(
      (total, item) => total + item.estimatedMinutesP80,
      0
    ),
    estimateModel: models.size === 1 ? [...models][0] : "aggregate",
    estimateBasis: `汇总当前打开分支中的 ${estimates.length} 个任务`,
    estimateConfidence: confidence || "low",
    estimatedAt: estimates
      .map((item) => item.estimatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || "",
    estimateContextVersion: `project-aggregate:${estimates
      .map((item) => item.estimateContextVersion)
      .join("|")}`,
    aggregateTaskCount: estimates.length,
  };
}

export function isNodeInActiveTaskScope(graph, node) {
  const seen = new Set();
  while (node && !seen.has(node.id)) {
    if (
      isNodeHidden(node) ||
      node.user?.accepted ||
      (["Task", "Project"].includes(effectiveType(node)) && effectiveStatus(node) === "resolved")
    ) {
      return false;
    }
    seen.add(node.id);
    node = graph.nodes[effectiveParentId(node)];
  }
  return true;
}

export function effectiveFocusNodeId(graph) {
  const candidates = [
    graph?.view?.userFocusNodeId,
    graph?.view?.autoFocusNodeId,
    graph?.now?.activeBranchId,
    graph?.now?.activeTaskId,
    graph?.now?.activeGoalId,
    graph?.now?.activeProjectId
  ];
  return (
    candidates.find((id) => {
      const node = graph?.nodes?.[id];
      return node && !isNodeHidden(node);
    }) || null
  );
}

function nextId(type) {
  const prefix = type.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    .replace(/^_/, "");
  const suffix = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().slice(0, 12)
    : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${suffix}`;
}

function safePatchId(value) {
  const id = cleanText(value);
  return /^[A-Za-z0-9_-]{3,120}$/.test(id) ? id : "";
}

function normalizeMessageRefs(messageIds, conversationId) {
  if (!conversationId || !Array.isArray(messageIds)) {
    return [];
  }
  return messageIds
    .map(cleanText)
    .filter(Boolean)
    .map((messageId) => ({ conversationId, messageId }));
}

function mergeMessageRefs(existing, incoming) {
  const refs = [...(existing || []), ...(incoming || [])];
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref?.conversationId || ""}:${ref?.messageId || ""}`;
    if (!ref?.conversationId || !ref?.messageId || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function isUserParentLocked(node) {
  // A manual sibling order belongs to its parent group. Moving just that
  // sibling automatically would also undo the user's structural edit.
  return Boolean(
    node.user?.locked ||
    node.user?.lockedFields?.parentId ||
    node.user?.lockedFields?.order ||
    hasOwn(node.user, "parentId") ||
    hasOwn(node.user, "order")
  );
}

// True when the user placed this node's slot themselves (drag / ←→). The canvas
// must then keep that slot instead of re-sorting the row by AI priority rank;
// otherwise a manual drag looks like it did nothing.
export function hasUserOrder(node) {
  if (typeof node?.user?.manualOrder === "boolean") return node.user.manualOrder;
  return node?.source?.createdBy !== "user" &&
    (hasOwn(node?.user, "order") || Boolean(node?.user?.lockedFields?.order));
}

function autoFieldMutable(node, field) {
  return (
    !node.user?.locked &&
    !isNodeHidden(node) &&
    !(field === "parentId" && isUserParentLocked(node)) &&
    !node.user?.lockedFields?.[field]
  );
}

function applyAutoNodeFields(node, patchNode, conversationId) {
  const title = cleanText(patchNode.title);
  if (title && autoFieldMutable(node, "title")) {
    node.auto.title = title;
  }

  if (patchNode.summary != null && autoFieldMutable(node, "summary")) {
    node.auto.summary = cleanText(patchNode.summary);
  }

  if (
    NODE_STATUSES.includes(patchNode.status) &&
    autoFieldMutable(node, "status")
  ) {
    node.auto.status = patchNode.status;
  }

  if (patchNode.parent_id != null && autoFieldMutable(node, "parentId")) {
    node.auto.parentId = cleanText(patchNode.parent_id) || null;
  }
  if (patchNode.order != null && autoFieldMutable(node, "order")) {
    const order = Number(patchNode.order);
    if (Number.isFinite(order)) node.auto.order = order;
  }

  const messageRefs = normalizeMessageRefs(
    patchNode.source_message_ids,
    conversationId
  );
  if (messageRefs.length) {
    node.auto.messageRefs = mergeMessageRefs(node.auto.messageRefs, messageRefs);
  }

  node.auto.updatedAt = Date.now();
}

function resolvePatchId(idMap, value) {
  const id = safePatchId(value);
  return idMap[id] || id;
}

function findAncestor(graph, nodeId, type) {
  let current = graph.nodes[nodeId];
  const seen = new Set();

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (effectiveType(current) === type) {
      return current;
    }
    current = graph.nodes[effectiveParentId(current)];
  }

  return null;
}

function snapshotTask(graph, task) {
  const conclusion = graph.nodes[graph.now.currentConclusionId];
  const question = graph.nodes[graph.now.currentQuestionId];
  const nextAction = graph.nodes[graph.now.nextActionId];
  const summaryNode = conclusion || question || nextAction || task;

  task.auto.resume = {
    summary: effectiveTitle(summaryNode),
    conclusionId: conclusion?.id || null,
    questionId: question?.id || null,
    nextActionId: nextAction?.id || null,
    branchId: graph.now.activeBranchId || null,
    savedAt: Date.now()
  };
}

function deriveTaskContext(graph, task) {
  const goal = findAncestor(graph, task.id, "Goal");
  const project = findAncestor(graph, task.id, "Project");
  graph.now.activeGoalId = goal?.id || null;
  graph.now.activeProjectId = project?.id || null;
}

export function activateTask(graph, taskId) {
  const task = graph.nodes[taskId];
  if (
    !task ||
    effectiveType(task) !== "Task" ||
    isNodeHidden(task)
  ) {
    return false;
  }

  const previous = graph.nodes[graph.now.activeTaskId];
  if (
    previous &&
    previous.id !== task.id &&
    effectiveType(previous) === "Task"
  ) {
    snapshotTask(graph, previous);
    if (autoFieldMutable(previous, "status")) {
      previous.auto.status = "parked";
      previous.auto.updatedAt = Date.now();
    }
  }

  graph.now.activeTaskId = task.id;
  deriveTaskContext(graph, task);
  if (autoFieldMutable(task, "status")) {
    task.auto.status = "active";
    task.auto.updatedAt = Date.now();
  }

  const resume = task.auto.resume || {};
  graph.now.activeBranchId = resume.branchId || null;
  graph.now.currentConclusionId = resume.conclusionId || null;
  graph.now.currentQuestionId = resume.questionId || null;
  graph.now.nextActionId = resume.nextActionId || null;
  return true;
}

function applyActiveNode(graph, nodeId) {
  const node = graph.nodes[nodeId];
  if (!node || isNodeHidden(node)) {
    return;
  }

  const type = effectiveType(node);
  if (type === "Project") graph.now.activeProjectId = node.id;
  if (type === "Goal") graph.now.activeGoalId = node.id;
  if (type === "Branch") graph.now.activeBranchId = node.id;
  if (type === "Conclusion") graph.now.currentConclusionId = node.id;
  if (type === "Question") graph.now.currentQuestionId = node.id;
  if (type === "NextAction") graph.now.nextActionId = node.id;
}

function setNowField(graph, field, nodeId) {
  const expectedType = NOW_SLOTS[field];
  const node = graph.nodes[nodeId];
  if (!nodeId) {
    graph.now[field] = null;
    return;
  }
  if (
    effectiveType(node) === expectedType &&
    !isNodeHidden(node)
  ) {
    graph.now[field] = node.id;
  }
}

function addEdge(graph, edgeInput, idMap, conversationId) {
  const from = resolvePatchId(idMap, edgeInput.from);
  const to = resolvePatchId(idMap, edgeInput.to);
  const type = cleanText(edgeInput.type);
  if (
    !graph.nodes[from] ||
    !graph.nodes[to] ||
    isNodeHidden(graph.nodes[from]) ||
    isNodeHidden(graph.nodes[to]) ||
    !EDGE_TYPES.includes(type)
  ) {
    return false;
  }

  const duplicate = Object.values(graph.edges).find(
    (edge) => edge.from === from && edge.to === to && edge.type === type
  );
  const messageRefs = normalizeMessageRefs(
    edgeInput.source_message_ids,
    conversationId
  );

  if (duplicate) {
    duplicate.auto = duplicate.auto || {};
    duplicate.auto.messageRefs = mergeMessageRefs(
      duplicate.auto.messageRefs,
      messageRefs
    );
    duplicate.auto.updatedAt = Date.now();
  } else {
    const id = nextId("edge");
    graph.edges[id] = {
      id,
      from,
      to,
      type,
      source: { createdAt: Date.now() },
      auto: {
        messageRefs,
        updatedAt: Date.now()
      },
      user: {}
    };
  }

  if (type === "parent_of") {
    const child = graph.nodes[to];
    if (autoFieldMutable(child, "parentId")) {
      child.auto.parentId = from;
      child.auto.updatedAt = Date.now();
    }
  }
  return true;
}

export function applySemanticPatch(graphValue, patchValue, context = {}) {
  const graph = normalizeGraph(graphValue);
  const patch = patchValue && typeof patchValue === "object" ? patchValue : {};
  const conversationId = cleanText(context.conversationId);
  const idMap = {};
  let addedNodes = 0;
  let updatedNodes = 0;
  let addedEdges = 0;

  for (const item of Array.isArray(patch.add_nodes) ? patch.add_nodes : []) {
    if (!NODE_TYPES.includes(item?.type)) {
      continue;
    }

    const requestedId = safePatchId(item.id);
    let id = requestedId || nextId(item.type);
    if (graph.nodes[id] && effectiveType(graph.nodes[id]) !== item.type) {
      id = nextId(item.type);
    }
    if (requestedId) {
      idMap[requestedId] = id;
    }

    let node = graph.nodes[id];
    if (isNodeHidden(node)) {
      continue;
    }
    if (!node) {
      node = {
        id,
        type: item.type,
        source: { createdAt: Date.now() },
        auto: {
          status: item.type === "Parked" ? "parked" : "normal",
          order: Object.keys(graph.nodes).length,
          messageRefs: []
        },
        user: { lockedFields: {}, messageRefs: [] }
      };
      graph.nodes[id] = node;
      addedNodes += 1;
    }
    applyAutoNodeFields(node, item, conversationId);
  }

  for (const item of Array.isArray(patch.update_nodes) ? patch.update_nodes : []) {
    const id = resolvePatchId(idMap, item?.id);
    const node = graph.nodes[id];
    if (!node || isNodeHidden(node)) {
      continue;
    }
    applyAutoNodeFields(node, item, conversationId);
    updatedNodes += 1;
  }

  for (const edge of Array.isArray(patch.add_edges) ? patch.add_edges : []) {
    if (addEdge(graph, edge || {}, idMap, conversationId)) {
      addedEdges += 1;
    }
  }

  const requestedTaskId = resolvePatchId(
    idMap,
    patch.now?.active_task_id || ""
  );
  const activeNodeId = resolvePatchId(idMap, patch.active_node);
  const activeNode = graph.nodes[activeNodeId];
  const activeNodeTask =
    effectiveType(activeNode) === "Task"
      ? activeNode
      : activeNode
        ? findAncestor(graph, activeNode.id, "Task")
        : null;
  const taskToActivate = requestedTaskId || activeNodeTask?.id || "";
  if (taskToActivate) activateTask(graph, taskToActivate);

  if (activeNodeId) {
    applyActiveNode(graph, activeNodeId);
  }

  const autoFocusNodeId =
    graph.now.activeBranchId || graph.now.activeTaskId || activeNodeId;
  if (
    autoFocusNodeId &&
    graph.nodes[autoFocusNodeId] &&
    !isNodeHidden(graph.nodes[autoFocusNodeId])
  ) {
    graph.view.autoFocusNodeId = autoFocusNodeId;
  }

  for (const [patchField, graphField] of Object.entries(PATCH_NOW_FIELDS)) {
    if (patch.now?.[patchField] == null || graphField === "activeTaskId") {
      continue;
    }
    setNowField(
      graph,
      graphField,
      resolvePatchId(idMap, patch.now[patchField])
    );
  }

  if (conversationId) {
    const current = graph.bindings[conversationId] || {};
    const binding = patch.conversation_binding || {};
    const projectId = resolvePatchId(idMap, binding.project_id);
    const taskId = resolvePatchId(idMap, binding.task_id);
    const branchId = resolvePatchId(idMap, binding.branch_id);
    if (projectId || taskId || branchId || taskToActivate) {
      graph.bindings[conversationId] = {
        ...current,
        projectId:
          projectId ||
          current.projectId ||
          (taskToActivate ? graph.now.activeProjectId : null),
        taskId: taskId || current.taskId || taskToActivate || null,
        branchId:
          branchId ||
          current.branchId ||
          (taskToActivate ? graph.now.activeBranchId : null),
        updatedAt: Date.now()
      };
    }
  }

  return { graph, addedNodes, updatedNodes, addedEdges };
}

export function patchUserNode(graphValue, nodeId, patch = {}) {
  const graph = normalizeGraph(graphValue);
  const node = graph.nodes[nodeId];
  if (!node) {
    throw new Error("语义节点不存在");
  }

  node.user = node.user || { lockedFields: {}, messageRefs: [] };
  node.user.lockedFields = node.user.lockedFields || {};

  if (hasOwn(patch, "executionRoute")) {
    if (!Object.hasOwn(EXECUTION_ROUTES, patch.executionRoute)) throw new Error("执行方式无效");
    node.user.executionRoute = patch.executionRoute;
    node.user.executionRouteAt = Date.now();
    delete node.user.executionReceiptId;
    node.user.keep = patch.executionRoute !== "defer";
  }
  if (hasOwn(patch, "executionReceiptId")) {
    node.user.executionReceiptId = String(patch.executionReceiptId || "");
  }
  if (hasOwn(patch, "executionPhase")) {
    if (patch.executionPhase && !Object.hasOwn(EXECUTION_PHASES, patch.executionPhase)) throw new Error("执行状态无效");
    node.user.executionPhase = patch.executionPhase || "";
  }

  if (hasOwn(patch, "title")) {
    const title = cleanText(patch.title);
    if (title) {
      node.user.title = title;
      node.user.lockedFields.title = true;
    } else {
      delete node.user.title;
      delete node.user.lockedFields.title;
    }
  }

  if (hasOwn(patch, "summary")) {
    const summary = cleanText(patch.summary);
    if (summary) {
      node.user.summary = summary;
      node.user.lockedFields.summary = true;
    } else {
      delete node.user.summary;
      delete node.user.lockedFields.summary;
    }
  }

  if (hasOwn(patch, "type")) {
    if (!NODE_TYPES.includes(patch.type)) {
      throw new Error("节点类型无效");
    }
    node.user.type = patch.type;
    node.user.lockedFields.type = true;
  }

  if (hasOwn(patch, "status")) {
    if (NODE_STATUSES.includes(patch.status)) {
      node.user.status = patch.status;
      node.user.lockedFields.status = true;
    } else {
      delete node.user.status;
      delete node.user.lockedFields.status;
    }
  }

  if (hasOwn(patch, "parentId")) {
    const parentId = cleanText(patch.parentId);
    if (parentId && !graph.nodes[parentId]) {
      throw new Error("父节点不存在");
    }
    if (parentId && wouldCreateCycle(graph, nodeId, parentId)) {
      throw new Error("不能把节点移动到自己的子树中");
    }
    node.user.parentId = parentId || null;
    node.user.lockedFields.parentId = true;
  }

  if (hasOwn(patch, "order")) {
    const order = Number(patch.order);
    if (!Number.isFinite(order)) {
      throw new Error("节点顺序无效");
    }
    node.user.order = order;
    node.user.manualOrder = true;
    node.user.lockedFields.order = true;
  }

  if (hasOwn(patch, "locked")) {
    node.user.locked = Boolean(patch.locked);
  }

  if (hasOwn(patch, "waiting")) {
    if (patch.waiting) {
      node.user.waiting = true;
      node.user.waitingAt = Date.now();
    } else {
      delete node.user.waiting;
      delete node.user.waitingAt;
    }
  }

  if (hasOwn(patch, "focusflowTimeline")) {
    node.user.focusflowTimeline = Boolean(patch.focusflowTimeline);
  }

  if (hasOwn(patch, "priority")) {
    const priority = normalizeUserPriority(patch.priority);
    if (priority) {
      node.user.priority = priority;
      node.user.prioritySetAt = Date.now();
    } else {
      delete node.user.priority;
      delete node.user.prioritySetAt;
    }
  }

  if (
    hasOwn(patch, "estimatedMinutesP50") ||
    hasOwn(patch, "estimatedMinutesP80")
  ) {
    const currentP50 = Number(node.user.estimatedMinutesP50) || 0;
    const currentP80 = Number(node.user.estimatedMinutesP80) || 0;
    const rawP50 = hasOwn(patch, "estimatedMinutesP50")
      ? patch.estimatedMinutesP50
      : currentP50;
    const rawP80 = hasOwn(patch, "estimatedMinutesP80")
      ? patch.estimatedMinutesP80
      : currentP80;
    const cleared =
      rawP50 === null || rawP50 === undefined || rawP50 === "" ||
      rawP80 === null || rawP80 === undefined || rawP80 === "";
    if (cleared) {
      delete node.user.estimatedMinutesP50;
      delete node.user.estimatedMinutesP80;
      delete node.user.estimateUpdatedAt;
    } else {
      const p50 = Number(rawP50);
      const p80 = Number(rawP80);
      if (
        !ESTIMATE_MINUTE_BUCKETS.includes(p50) ||
        !ESTIMATE_MINUTE_BUCKETS.includes(p80)
      ) {
        throw new Error("预计时长必须使用预设档位");
      }
      if (p80 < p50) {
        throw new Error("保守预计 P80 不能短于常规预计 P50");
      }
      node.user.estimatedMinutesP50 = p50;
      node.user.estimatedMinutesP80 = p80;
      node.user.estimateUpdatedAt = Date.now();
    }
  }

  if (hasOwn(patch, "keep")) {
    if (patch.keep) {
      node.user.keep = true;
      node.user.keepAt = Date.now();
    } else {
      delete node.user.keep;
      delete node.user.keepAt;
    }
  }

  // A manual priority-list slot, set by dragging a task in the priority rail.
  // null clears the pin so the AI orders that task freely again.
  if (hasOwn(patch, "priorityRank")) {
    const raw = patch.priorityRank;
    // Number(null) is 0, which would silently pin a released task to slot 0.
    const cleared = raw === null || raw === undefined || raw === "";
    const rank = Number(raw);
    if (!cleared && Number.isInteger(rank) && rank >= 0) {
      node.user.priorityRank = rank;
      node.user.priorityRankSetAt = Date.now();
    } else {
      delete node.user.priorityRank;
      delete node.user.priorityRankSetAt;
    }
  }

  if (hasOwn(patch, "accepted")) {
    node.user.accepted = Boolean(patch.accepted);
  }

  node.user.updatedAt = Date.now();
  return graph;
}

function liveNodes(graph) {
  return Object.values(graph.nodes).filter(
    (node) => !isNodeHidden(node)
  );
}

function wouldCreateCycle(graph, nodeId, parentId) {
  let currentId = parentId;
  const seen = new Set();
  while (currentId && !seen.has(currentId)) {
    if (currentId === nodeId) return true;
    seen.add(currentId);
    currentId = effectiveParentId(graph.nodes[currentId]);
  }
  return false;
}

function setUserOrder(node, order, manual = true) {
  node.user = node.user || {};
  node.user.manualOrder = manual || hasUserOrder(node);
  node.user.lockedFields = node.user.lockedFields || {};
  node.user.order = order;
  node.user.lockedFields.order = true;
  node.user.updatedAt = Date.now();
}

function reorderAt(graph, nodeId, parentId, index, manual = true) {
  const node = graph.nodes[nodeId];
  const siblings = liveNodes(graph)
    .filter(
      (item) =>
        item.id !== nodeId && effectiveParentId(item) === (parentId || null)
    )
    .sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
  const insertAt = Math.max(0, Math.min(Number(index), siblings.length));
  siblings.splice(insertAt, 0, node);
  siblings.forEach((item, order) => setUserOrder(item, order, manual));
}

export function createUserNode(graphValue, input = {}) {
  const graph = normalizeGraph(graphValue);
  const type = NODE_TYPES.includes(input.type) ? input.type : "Task";
  const parentId = cleanText(input.parentId);
  if (parentId && !graph.nodes[parentId]) {
    throw new Error("父节点不存在");
  }

  const id = nextId(type);
  const title = cleanText(input.title) || "新节点";
  const summary = cleanText(input.summary);
  const hasUserStatus =
    hasOwn(input, "status") && NODE_STATUSES.includes(input.status);
  const userPriority = normalizeUserPriority(input.priority);
  const hasUserLocked = hasOwn(input, "locked");
  const siblings = liveNodes(graph).filter(
    (node) => effectiveParentId(node) === (parentId || null)
  );
  const order =
    Number.isFinite(Number(input.order))
      ? Number(input.order)
      : siblings.length;

  graph.nodes[id] = {
    id,
    type,
    source: { createdAt: Date.now(), createdBy: "user" },
    auto: { status: "normal", messageRefs: [] },
    user: {
      type,
      title,
      summary,
      parentId: parentId || null,
      order,
      manualOrder: false,
      lockedFields: {
        type: true,
        title: true,
        summary: true,
        parentId: true,
        order: true
      },
      messageRefs: [],
      updatedAt: Date.now()
    }
  };
  if (hasUserStatus) {
    graph.nodes[id].user.status = input.status;
    graph.nodes[id].user.lockedFields.status = true;
  }
  if (userPriority) {
    graph.nodes[id].user.priority = userPriority;
    graph.nodes[id].user.prioritySetAt = Date.now();
  }
  if (hasUserLocked) {
    graph.nodes[id].user.locked = Boolean(input.locked);
  }
  if (type === "Task" && input.waiting === true) {
    graph.nodes[id].user.waiting = true;
    graph.nodes[id].user.waitingAt =
      Number.isFinite(Number(input.waitingAt)) && Number(input.waitingAt) > 0
        ? Number(input.waitingAt)
        : Date.now();
  }
  reorderAt(graph, id, parentId || null, order, false);
  return { graph, nodeId: id };
}

export function reparentUserNode(graphValue, nodeId, parentIdValue, index) {
  const graph = normalizeGraph(graphValue);
  const node = graph.nodes[nodeId];
  const parentId = cleanText(parentIdValue) || null;
  if (!node || isNodeHidden(node)) {
    throw new Error("语义节点不存在");
  }
  if (parentId && !graph.nodes[parentId]) {
    throw new Error("父节点不存在");
  }
  if (parentId && wouldCreateCycle(graph, nodeId, parentId)) {
    throw new Error("不能把节点移动到自己的子树中");
  }

  node.user = node.user || {};
  node.user.lockedFields = node.user.lockedFields || {};
  node.user.parentId = parentId;
  node.user.lockedFields.parentId = true;
  node.user.updatedAt = Date.now();
  const targetSiblings = liveNodes(graph).filter(
    (item) =>
      item.id !== nodeId && effectiveParentId(item) === (parentId || null)
  );
  reorderAt(
    graph,
    nodeId,
    parentId,
    Number.isFinite(Number(index)) ? Number(index) : targetSiblings.length
  );
  return graph;
}

// Apply a drag by target identity instead of trusting a numeric index captured
// from an older render. orderedSiblingIds is accepted only when it still covers
// the complete live row; otherwise the target-relative fallback preserves any
// sibling that appeared while the drag request was in flight.
export function applyUserNodeDrop(graphValue, input = {}) {
  let graph = normalizeGraph(graphValue);
  const nodeId = String(input.nodeId || "");
  const targetId = String(input.targetId || "");
  const position = ["before", "after", "inside"].includes(input.position)
    ? input.position
    : "";
  const node = graph.nodes[nodeId];
  const target = graph.nodes[targetId];
  if (!node || isNodeHidden(node) || !target || isNodeHidden(target)) {
    throw new Error("拖动节点不存在");
  }
  if (nodeId === targetId) {
    throw new Error("不能把节点移动到自身");
  }
  if (!position) {
    throw new Error("拖动位置无效");
  }

  const parentId =
    position === "inside" ? targetId : effectiveParentId(target) || null;
  const siblings = liveNodes(graph)
    .filter(
      (item) =>
        item.id !== nodeId &&
        effectiveParentId(item) === (parentId || null)
    )
    .sort(
      (a, b) =>
        effectiveOrder(a) - effectiveOrder(b) ||
        String(a.id).localeCompare(String(b.id))
    );
  const targetIndex = siblings.findIndex((item) => item.id === targetId);
  const index =
    position === "inside"
      ? siblings.length
      : targetIndex + (position === "after" ? 1 : 0);
  graph = reparentUserNode(graph, nodeId, parentId, index);

  let row = liveNodes(graph)
    .filter((item) => effectiveParentId(item) === (parentId || null))
    .sort(
      (a, b) =>
        effectiveOrder(a) - effectiveOrder(b) ||
        String(a.id).localeCompare(String(b.id))
    );
  if (position !== "inside" && Array.isArray(input.orderedSiblingIds)) {
    const requested = [...new Set(input.orderedSiblingIds.map(String))];
    const actual = new Set(row.map((item) => item.id));
    if (
      requested.length === row.length &&
      requested.every((id) => actual.has(id)) &&
      requested.includes(nodeId) &&
      requested.includes(targetId)
    ) {
      row = requested.map((id) => graph.nodes[id]);
      row.forEach((item, order) => setUserOrder(item, order));
    }
  }

  return {
    graph,
    parentId,
    changedNodeIds: row.map((item) => item.id)
  };
}

export function moveUserNode(graphValue, nodeId, direction) {
  const graph = normalizeGraph(graphValue);
  const node = graph.nodes[nodeId];
  if (!node) {
    throw new Error("语义节点不存在");
  }

  const parentId = effectiveParentId(node);
  const siblings = liveNodes(graph)
    .filter(
      (item) => effectiveParentId(item) === parentId
    )
    .sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
  const index = siblings.findIndex((item) => item.id === nodeId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= siblings.length) {
    return graph;
  }

  const [moving] = siblings.splice(index, 1);
  siblings.splice(target, 0, moving);
  siblings.forEach((item, order) => setUserOrder(item, order));
  return graph;
}

export function deleteUserNode(graphValue, nodeId) {
  const graph = normalizeGraph(graphValue);
  const node = graph.nodes[nodeId];
  if (!node || isNodeHidden(node)) {
    throw new Error("语义节点不存在");
  }

  const parentId = effectiveParentId(node);
  const siblings = liveNodes(graph)
    .filter(
      (item) =>
        item.id !== nodeId && effectiveParentId(item) === (parentId || null)
    )
    .sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
  const promoted = liveNodes(graph)
    .filter((item) => effectiveParentId(item) === nodeId)
    .sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
  const insertAt = Math.max(
    0,
    Math.min(
      siblings.length,
      liveNodes(graph)
        .filter(
          (item) => effectiveParentId(item) === (parentId || null)
        )
        .sort((a, b) => effectiveOrder(a) - effectiveOrder(b))
        .findIndex((item) => item.id === nodeId)
    )
  );

  promoted.forEach((child) => {
    child.user = child.user || {};
    child.user.lockedFields = child.user.lockedFields || {};
    child.user.parentId = parentId || null;
    child.user.lockedFields.parentId = true;
    child.user.updatedAt = Date.now();
  });
  siblings.splice(insertAt, 0, ...promoted);
  siblings.forEach((item, order) => setUserOrder(item, order, false));

  node.user = node.user || {};
  node.user.deleted = true;
  node.user.locked = true;
  node.user.lockedFields = Object.fromEntries(
    ["type", "title", "summary", "status", "parentId", "order"].map(
      (field) => [field, true]
    )
  );
  node.user.updatedAt = Date.now();

  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    if (edge.from === nodeId || edge.to === nodeId) {
      delete graph.edges[edgeId];
    }
  }
  for (const [field, value] of Object.entries(graph.now)) {
    if (value === nodeId) graph.now[field] = null;
  }
  if (graph.view.userFocusNodeId === nodeId) {
    graph.view.userFocusNodeId = parentId || null;
  }
  if (graph.view.autoFocusNodeId === nodeId) {
    graph.view.autoFocusNodeId = parentId || null;
  }
  for (const binding of Object.values(graph.bindings)) {
    if (binding.projectId === nodeId) binding.projectId = null;
    if (binding.taskId === nodeId) binding.taskId = null;
    if (binding.branchId === nodeId) binding.branchId = null;
  }
  return graph;
}

export function captureDeleteUndo(graphValue, nodeId) {
  const graph = normalizeGraph(graphValue);
  const node = graph.nodes[nodeId];
  if (!node || isNodeHidden(node)) {
    throw new Error("语义节点不存在");
  }

  const promotedChildren = liveNodes(graph)
    .filter((item) => effectiveParentId(item) === nodeId)
    .map((item) => ({ id: item.id }));

  const edges = Object.values(graph.edges)
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .map((edge) => JSON.parse(JSON.stringify(edge)));

  const nowSlots = Object.entries(graph.now)
    .filter(([, value]) => value === nodeId)
    .map(([field]) => field);

  const bindings = Object.entries(graph.bindings)
    .filter(
      ([, binding]) =>
        binding.projectId === nodeId ||
        binding.taskId === nodeId ||
        binding.branchId === nodeId
    )
    .map(([conversationId, binding]) => ({
      conversationId,
      binding: JSON.parse(JSON.stringify(binding))
    }));

  return {
    nodeId,
    node: JSON.parse(JSON.stringify(node)),
    edges,
    promotedChildren,
    nowSlots,
    userFocusWasNode: graph.view?.userFocusNodeId === nodeId,
    autoFocusWasNode: graph.view?.autoFocusNodeId === nodeId,
    bindings
  };
}

export function restoreDeletedNode(graphValue, undo) {
  const graph = normalizeGraph(graphValue);
  if (!undo?.nodeId || !undo?.node?.id) {
    throw new Error("撤回信息无效");
  }
  const existing = graph.nodes[undo.nodeId];
  if (existing && !isNodeHidden(existing)) {
    return graph;
  }

  graph.nodes[undo.nodeId] = JSON.parse(JSON.stringify(undo.node));

  for (const edge of undo.edges || []) {
    if (!graph.edges[edge.id]) {
      graph.edges[edge.id] = JSON.parse(JSON.stringify(edge));
    }
  }

  for (const child of undo.promotedChildren || []) {
    const childNode = graph.nodes[child.id];
    if (!childNode || isNodeHidden(childNode)) continue;
    childNode.user = childNode.user || {};
    childNode.user.lockedFields = childNode.user.lockedFields || {};
    childNode.user.parentId = undo.nodeId;
    childNode.user.lockedFields.parentId = true;
    childNode.user.updatedAt = Date.now();
  }

  for (const field of undo.nowSlots || []) {
    if (!graph.now[field]) graph.now[field] = undo.nodeId;
  }

  if (undo.userFocusWasNode) {
    graph.view.userFocusNodeId = undo.nodeId;
  }
  if (undo.autoFocusWasNode) {
    graph.view.autoFocusNodeId = undo.nodeId;
  }

  for (const item of undo.bindings || []) {
    const current = graph.bindings[item.conversationId] || {};
    graph.bindings[item.conversationId] = {
      ...current,
      projectId: current.projectId || item.binding.projectId || null,
      taskId: current.taskId || item.binding.taskId || null,
      branchId: current.branchId || item.binding.branchId || null
    };
  }

  return graph;
}

export function setFocusNode(graphValue, nodeIdValue) {
  const graph = normalizeGraph(graphValue);
  const nodeId = cleanText(nodeIdValue);
  if (!nodeId) {
    graph.view.userFocusNodeId = null;
    return graph;
  }
  const node = graph.nodes[nodeId];
  if (!node || isNodeHidden(node)) {
    throw new Error("语义节点不存在");
  }
  graph.view.userFocusNodeId = nodeId;
  return graph;
}

export function mergeUserNodes(graphValue, sourceId, targetId) {
  const graph = normalizeGraph(graphValue);
  const source = graph.nodes[sourceId];
  const target = graph.nodes[targetId];
  if (!source || !target || sourceId === targetId) {
    throw new Error("请选择两个不同的有效节点");
  }

  target.user = target.user || {};
  target.user.messageRefs = mergeMessageRefs(
    target.user.messageRefs,
    effectiveMessageRefs(source)
  );
  target.user.updatedAt = Date.now();

  source.user = source.user || {};
  source.user.mergedInto = targetId;
  source.user.locked = true;
  source.user.status = "merged";
  source.user.lockedFields = {
    title: true,
    summary: true,
    status: true,
    parentId: true,
    order: true
  };
  source.user.updatedAt = Date.now();

  const replacements = [];
  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    if (edge.from !== sourceId && edge.to !== sourceId) {
      continue;
    }
    replacements.push({
      from: edge.from === sourceId ? targetId : edge.from,
      to: edge.to === sourceId ? targetId : edge.to,
      type: edge.type
    });
    delete graph.edges[edgeId];
  }
  replacements
    .filter((edge) => edge.from !== edge.to)
    .forEach((edge) => addEdge(graph, edge, {}, ""));

  for (const [field, value] of Object.entries(graph.now)) {
    if (value === sourceId) {
      graph.now[field] = targetId;
    }
  }
  for (const binding of Object.values(graph.bindings)) {
    if (binding.projectId === sourceId) binding.projectId = targetId;
    if (binding.taskId === sourceId) binding.taskId = targetId;
    if (binding.branchId === sourceId) binding.branchId = targetId;
  }

  return graph;
}

export function activeNowIds(graph) {
  return new Set(Object.values(graph?.now || {}).filter(Boolean));
}
