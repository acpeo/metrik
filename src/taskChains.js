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
/// （真机北斗 = 7 个群会话 + 各星位主会话，10 够用且留余量）。
/// 群会话（接力跳名单）常驻；主会话只在带上下文估算或 24h 内活跃时出现——
/// 每个星位天生就有主会话，从没私聊过的是陈旧空壳，不上屏（私聊那一刻才会冒出来）。
export function selectUsageSessions(sessions, { limit = 10, nowMs = Date.now() } = {}) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const list = (sessions ?? []).filter((session) => {
    if (!session?.key || session.key.includes(":cron:") || !session.updatedAt) return false;
    if (session.isGroup) return true;
    return Boolean(session.estimatedPromptTokens) || nowMs - session.updatedAt < DAY_MS;
  });
  list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return list.slice(0, limit);
}

/// 跳状态档：done / failed / pending / current 四色同语言，迷你行/胶片条/时间线
/// 三处组件共用——状态判定改一处即全生效，别再各自复制。
/// current = 正在跑的那个任务本身（链上同一时刻至多一个）。
export function hopToneOf(hop, currentTaskId) {
  const done = hop?.status === "succeeded";
  const failed = hop?.status === "failed" || hop?.status === "timed_out" || hop?.status === "lost";
  const pending = hop?.status === "queued";
  const current = hop?.taskId != null && hop.taskId === currentTaskId && !done && !failed;
  const tone = failed ? "failed" : done ? "done" : pending ? "pending" : "current";
  const state = done ? "已完成" : failed ? "失败" : pending ? "排队中" : "进行中";
  return { done, failed, pending, current, tone, state };
}

/// 状态符：✓ 完成 / ✕ 失败 / ○ 待跑 / ● 进行中。
export function hopGlyphOf(tone) {
  return tone === "done" ? "✓" : tone === "failed" ? "✕" : tone === "pending" ? "○" : "●";
}

/// 活跃任务：运行中或排队。任务卡/任务窗/任务页共用同一条口径。
export function isActiveTask(task) {
  return task?.status === "running" || task?.status === "queued";
}

/// 会话 run 状态 → hop 状态语义（hopToneOf 的口径）：done→succeeded / failed→failed，
/// running 保持 running（当前跳脉冲）。
export function sessionRunHopStatus(status) {
  if (status === "done" || status === "succeeded") return "succeeded";
  if (status === "failed" || status === "timed_out" || status === "lost") return "failed";
  return "running";
}

/// 单条会话 run → hop 形态（胶卷格与横条行悬停卡共用同一映射）。
export function sessionRunHop(run) {
  return {
    taskId: `session-run:${run.id ?? run.runId ?? run.sessionKey}`,
    agentId: run.agentId,
    status: sessionRunHopStatus(run.status),
    title: run.title ?? "",
    progressSummary: run.progressSummary ?? null,
    startedAtMs: run.startedAtMs ?? 0,
    endedAtMs: run.endedAtMs ?? null,
    error: run.error ?? null,
  };
}

/// 同一轮派活的 run 序列（迷你竖条胶卷）：群聊接力没有跨星 runId，不硬造任务链——
/// 同一群聊（chat id 相同）里从当前 run 往回走链：上一棒的结束（缺省用开始）到
/// 下一棒开始，沉默 ≤ gapMs 就串成同一轮。锚"交接断档"而不是"离当前多久"——
/// 任务总时长不可预知（Leo 2026-10-04 拍板），长任务只要一直有交接就不断链；
/// 只有中途长时间沉默（如等 Leo 确认几小时）才切出新的一段。
/// gapMs 可在设置页"实时监控参数"里调（EPISODE_HANDOFF_GAP_MS 只是缺省值）。
/// runs = 会话工作台账行（camelCase，来自 session_run_list）；focus = 当前行。
const EPISODE_HANDOFF_GAP_MS = 60 * 60 * 1000;

export function sessionEpisodeHops(runs, focus, gapMs = EPISODE_HANDOFF_GAP_MS) {
  if (!focus) return [];
  const chatIdOf = (key) => {
    const text = key || "";
    const marker = text.indexOf(":group:");
    return marker >= 0 ? text.slice(marker + 1) : text;
  };
  const focusChat = chatIdOf(focus.sessionKey);
  const focusStart = focus.startedAtMs ?? 0;
  const sameChat = (runs ?? [])
    .filter((run) => {
      if (!run || chatIdOf(run.sessionKey) !== focusChat) return false;
      return (run.startedAtMs ?? 0) <= focusStart + 60_000;
    })
    .sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
  const episode = [];
  for (let i = sameChat.length - 1; i >= 0; i--) {
    const run = sameChat[i];
    if (episode.length > 0) {
      const chainStart = episode[0].startedAtMs ?? 0;
      const runEnd = run.endedAtMs ?? run.startedAtMs ?? 0;
      if (chainStart - runEnd > gapMs) break;
    }
    episode.unshift(run);
  }
  return episode.map(sessionRunHop);
}
