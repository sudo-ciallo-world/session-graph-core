export const EXECUTION_ROUTES = {
  defer: "暂不做", human: "自己做", assist: "人机协作", agent: "本地 Agent 做", web: "GPT 网页做",
};
export const EXECUTION_PHASES = {
  preparing: "准备 Prompt", ready: "Prompt 待确认", queued: "排队中",
  intent: "提交中", sending: "发送中", running: "执行中",
  waiting_input: "等你补充输入", completed: "成果待验收",
  needs_review: "需要核对", blocked: "执行受阻", failed: "执行失败",
  unknown: "提交状态待核对", closed: "会话已关闭 · 待核对", cancelled: "已取消",
  accepted: "已验收",
};
export function executionRoute(node) {
  return Object.hasOwn(EXECUTION_ROUTES, node?.user?.executionRoute) ? node.user.executionRoute : "assist";
}
export function executionNeedsAttention(phase) {
  return ["waiting_input", "completed", "needs_review", "blocked", "failed", "unknown", "closed"].includes(phase);
}
export function humanAttention(node) {
  return !node?.user?.accepted && !node?.user?.deleted && node?.user?.status !== "resolved" &&
    ["agent", "web"].includes(executionRoute(node)) &&
    executionNeedsAttention(node?.user?.executionPhase);
}
export function humanTimelineTask(node) {
  const route = executionRoute(node);
  return route !== "defer" && (!["agent", "web"].includes(route) || humanAttention(node));
}
