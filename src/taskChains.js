// 任务链路组装：OpenClaw 不会预告下一跳（agent 动态派生），链从两条真实数据边拼出：
// 1) 同一次触发共享 runId（cron 形如 cron:<id>:<fireMs>:<run>，exec 形如 exec:<词>）；
// 2) 父任务的 childSessionKey == 子任务的 sessionKey（subagent 接力）。
// 字段语义 2026-10-02 在北斗网关 tasks.list 实测确认（.openclaw/tmp/probe-chain.mjs）。

/// Agent 显示名映射：tasks.list 的 agentId 是短 id（如 tianshu），
/// agents.list 的是 gateway 前缀全 id（如 VPS-北斗:tianshu）——两种都注册。
export function buildAgentNameMap(agents) {
  const map = new Map();
  for (const agent of agents ?? []) {
    if (!agent?.agentId) continue;
    if (agent.name && !map.has(agent.agentId)) map.set(agent.agentId, agent.name);
    const suffix = agent.agentId.includes(":")
      ? agent.agentId.slice(agent.agentId.lastIndexOf(":") + 1)
      : agent.agentId;
    if (agent.name && suffix && !map.has(suffix)) map.set(suffix, agent.name);
  }
  return map;
}

export function agentDisplayName(map, agentId) {
  if (!agentId) return "";
  return map.get(agentId) || agentId;
}

function startedMsOf(task) {
  return task?.startedAtMs ?? task?.firstSeenMs ?? task?.createdAtMs ?? 0;
}

/// 一次性建索引：sessionKey 索引、父子边、runId 分组。每轮渲染调一次。
export function buildTaskChains(tasks) {
  const bySession = new Map();
  for (const task of tasks ?? []) {
    if (task?.sessionKey) bySession.set(task.sessionKey, task);
  }
  const childOf = new Map();
  const parentOf = new Map();
  for (const task of tasks ?? []) {
    if (!task?.childSessionKey) continue;
    const child = bySession.get(task.childSessionKey);
    if (child && child.taskId !== task.taskId) {
      childOf.set(task.taskId, child);
      parentOf.set(child.taskId, task);
    }
  }
  const groups = new Map();
  for (const task of tasks ?? []) {
    if (!task?.runId) continue;
    if (!groups.has(task.runId)) groups.set(task.runId, []);
    groups.get(task.runId).push(task);
  }
  return { bySession, childOf, parentOf, groups };
}

/// 某任务所在链的 hops：向上找到根，收根的 runId 组，再沿 childOf 向下延伸；
/// 按 started 时间排序去重。防御环与断链（缺边就少一跳，不炸）。
export function chainHopsFor(task, { childOf, parentOf, groups }) {
  if (!task) return [];
  const seen = new Set();
  const hops = [];
  const guard = new Set([task.taskId]);
  let root = task;
  while (true) {
    const parent = parentOf.get(root.taskId);
    if (!parent || guard.has(parent.taskId)) break;
    guard.add(parent.taskId);
    root = parent;
  }
  const group = root.runId ? groups.get(root.runId) ?? [root] : [root];
  for (const member of group) {
    if (seen.has(member.taskId)) continue;
    seen.add(member.taskId);
    hops.push(member);
  }
  let cursor = hops[hops.length - 1];
  while (cursor) {
    const child = childOf.get(cursor.taskId);
    if (!child || seen.has(child.taskId)) break;
    seen.add(child.taskId);
    hops.push(child);
    cursor = child;
  }
  hops.sort((a, b) => startedMsOf(a) - startedMsOf(b));
  return hops;
}

/// 星位上下文（B 链路）展示集：sessions.list 会话里挑出该给用户看的。
/// cron 会话（心跳/巡检）与无 updatedAt 的会话不进；按最近活动排序，最多 limit 条
/// （真机北斗 = 7 个群会话 + 每星位主会话，10 够用且留余量）。
export function selectUsageSessions(sessions, { limit = 10 } = {}) {
  const list = (sessions ?? []).filter(
    (session) =>
      session && session.key && !session.key.includes(":cron:") && session.updatedAt,
  );
  list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return list.slice(0, limit);
}
