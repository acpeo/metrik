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
/// 星位上下文卡的选会话口径（2026-10-04 Leo 定案重设计）：这卡回答"谁的上下文
/// 快满了"，不回答"谁刚说话"——只有真实水位（estimatedPromptTokens > 0）的
/// 会话才按水位降序上卡。群会话不再无条件常驻（旧口径下任何产生过对话的
/// 群/主会话都占一行，多数渲染成"预 525k"占位）；没水位的收进卡头空闲汇总，
/// 全网关都没水位时整卡收掉（渲染层按 usageSessions.length 判定）。
/// 例外（Leo 2026-10-04 补的场景）：刚接活、思考中还没产出上下文的星位——
/// hasActiveRun 的会话无条件上卡并置顶，显示"启动中"，水位一产出当场接管，
/// 不然派活后的第一时间在卡上找不到干活的那颗星。
export function selectUsageSessions(sessions, { limit = 10 } = {}) {
  const withInfo = (sessions ?? []).filter(
    (session) =>
      session?.key
      && !session.key.includes(":cron:")
      && ((Number.isFinite(session.estimatedPromptTokens) && session.estimatedPromptTokens > 0)
        || Boolean(session.hasActiveRun)),
  );
  withInfo.sort(
    (a, b) =>
      Number(Boolean(b.hasActiveRun)) - Number(Boolean(a.hasActiveRun))
      || (b.estimatedPromptTokens ?? 0) - (a.estimatedPromptTokens ?? 0)
      || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  return withInfo.slice(0, limit);
}

/// 空闲会话清单：gateway 认识但没上卡的会话（cron 排除）——卡头计数点开后
/// 逐行展示用，数量口径与 countIdleSessions 完全一致。
export function listIdleSessions(sessions, shown) {
  const shownKeys = new Set((shown ?? []).map((session) => session?.key));
  return (sessions ?? []).filter(
    (session) => session?.key && !session.key.includes(":cron:") && !shownKeys.has(session.key),
  );
}

/// 卡头空闲汇总：gateway 认识但没上下文水位的会话数（cron 排除）。
/// 数量在场但不占行——"会话都在，只是没内容"的透明口径。
export function countIdleSessions(sessions, shown) {
  return listIdleSessions(sessions, shown).length;
}

/// 跳状态档：done / failed / skipped / pending / current 五色同语言，迷你行/
/// 胶片条/时间线三处组件共用——状态判定改一处即全生效，别再各自复制。
/// current = 正在跑的那个任务本身（链上同一时刻至多一个）。
/// skipped = 失败分诊（2026-10-04 六案②）判定的良性未跑：真机 27 条 failed
/// 里大半是心跳静默跳过/重启中止/手动取消，全染红会把真失败淹没——灰显
/// ◌ 档，不占失败区（排序计数都只认 failed）。
export function hopToneOf(hop, currentTaskId) {
  const done = hop?.status === "succeeded";
  const pending = hop?.status === "queued";
  const failedRaw = hop?.status === "failed" || hop?.status === "timed_out" || hop?.status === "lost";
  const cancelled = hop?.status === "cancelled";
  const benignError = failedRaw && failureClassOf(hop?.error) !== "real";
  const benign = cancelled || benignError;
  const failed = failedRaw && !benign;
  const current = hop?.taskId != null && hop.taskId === currentTaskId && !done && !failed && !benign;
  const tone = failed ? "failed" : benign ? "skipped" : done ? "done" : pending ? "pending" : "current";
  const state = done
    ? "已完成"
    : failed
      ? "失败"
      : benign
        ? benignStateOf(hop?.error, hop?.status)
        : pending
          ? "排队中"
          : "进行中";
  return { done, failed, pending, current, benign, tone, state };
}

/// 状态符：✓ 完成 / ✕ 失败 / ◌ 跳过 / ○ 待跑 / ● 进行中。
export function hopGlyphOf(tone) {
  return tone === "done"
    ? "✓"
    : tone === "failed"
      ? "✕"
      : tone === "skipped"
        ? "◌"
        : tone === "pending"
          ? "○"
          : "●";
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

/// openclaw 工具名 → 中文显示。台账保留原文，这里只管显示层；
/// 未知工具透传原名（新工具不加表也能用，只是显示英文）。
/// 2026-10-04 按 docs.openclaw.ai 内置工具表校准：官方换过名的双写兼容
/// （image→view_image、patch→apply_patch 进度里都可能出现）。
const TOOL_LABELS = {
  web_search: "联网搜索",
  x_search: "X 搜索",
  web_fetch: "网页抓取",
  exec: "执行命令",
  process: "进程管理",
  code_execution: "代码执行",
  sessions_send: "派发星位",
  sessions_history: "读会话记录",
  sessions_list: "列会话",
  session_status: "会话状态",
  sessions_spawn: "派生子任务",
  spawn: "派生子任务",
  subagents: "子任务编排",
  agents_list: "列星位",
  agents_wait: "等待星位",
  message: "发消息",
  write: "写文件",
  read: "读文件",
  edit: "改文件",
  apply_patch: "应用补丁",
  patch: "打补丁",
  automations: "定时任务",
  cron: "定时任务",
  browser: "浏览器操作",
  view_image: "识图",
  image: "识图",
  image_generate: "生成图片",
  memory_search: "记忆检索",
  memory_get: "读记忆",
  progress_card: "更新进度卡",
  ask_user: "向用户提问",
  gateway: "网关状态",
  nodes: "节点消息",
  plugins: "插件管理",
  tts: "语音合成",
  voice: "语音",
  tool_search: "搜索工具",
};

export function toolProgressLabel(name, translate = true) {
  if (!name) return "";
  return translate ? (TOOL_LABELS[name] ?? name) : name;
}

/// openclaw 的英文报错模板 → 中文。按真机出现频率配短表（Leo 2026-10-04：
/// "leo/gpt-6 request failed (provider internal error, HTTP 502)" 与
/// "LLM request timed out." 频发）；未命中透传原文，绝不吞信息。
export function sessionErrorText(raw, translate = true) {
  if (!raw) return "";
  const text = String(raw);
  if (!translate) return text;
  const http = text.match(/HTTP (\d{3})/i);
  const code = http ? `，HTTP ${http[1]}` : "";
  if (/provider internal error/i.test(text)) {
    return `模型请求失败（provider 内部错误${code}）——通常是临时的，稍后重试`;
  }
  if (/rate limit/i.test(text)) {
    return `触发限流${code}——稍等片刻再试`;
  }
  if (/timed? ?out/i.test(text)) {
    return `模型请求超时${code}`;
  }
  return text;
}

/// 失败分诊（2026-10-04 六案②）：网关 status=failed 的行里有大量"良性未跑"，
/// 词表按真机 18791 采集的话术（probe-fields）：heartbeat skipped: quiet-hours /
/// OPENCLAW_RESTART_ABORT / Cancelled by operator。返回 skip=静默跳过、
/// abort=重启中止、cancel=手动取消、real=真失败。词表外一律 real——
/// 宁可错杀不漏报，新话术见到再加。
export function failureClassOf(errorText) {
  const text = String(errorText ?? "");
  if (!text) return "real";
  if (/quiet[- ]hours|heartbeat skipped/i.test(text)) return "skip";
  if (/OPENCLAW_RESTART_ABORT|aborted for restart/i.test(text)) return "abort";
  if (/cancelled by operator/i.test(text)) return "cancel";
  return "real";
}

/// 良性未跑的人话标签（跳行/悬停卡/面板行共用）。
export function benignStateOf(errorText, status) {
  if (status === "cancelled") return "已取消";
  const kind = failureClassOf(errorText);
  if (kind === "skip") return "静默跳过";
  if (kind === "abort") return "重启中止";
  if (kind === "cancel") return "已取消";
  return "失败";
}

/// 单条会话 run → hop 形态（胶卷格与横条行悬停卡共用同一映射）。
export function sessionRunHop(run) {
  return {
    taskId: `session-run:${run.id ?? run.runId ?? run.sessionKey}`,
    agentId: run.agentId,
    status: sessionRunHopStatus(run.status),
    title: run.title ?? run.fallbackTitle ?? "",
    progressSummary: run.progressSummary ?? null,
    startedAtMs: run.startedAtMs ?? 0,
    endedAtMs: run.endedAtMs ?? null,
    error: run.error ?? null,
    // 成果速览（六案①）：收行时抓的最后一跳 assistant 原话。
    terminalSummary: run.terminalSummary ?? null,
  };
}

/// 子 agent 任务识别（真机 18791 验证）：星位 spawn 的子 agent，tasks.list 里
/// 对应任务行的 sessionKey / childSessionKey 落在 agent:<星位>:subagent:<uuid>
/// 会话（kind=cli，标题=spawn 上下文原文）。行上标「子」，跟新一轮派活、
/// 主会话活动区分开。
export function isSubagentTask(task) {
  const key = `${task?.sessionKey ?? ""}${task?.childSessionKey ?? ""}`;
  return key.includes(":subagent:");
}

/// 任务标题显示层清理：子 agent 任务的标题 = spawn 上下文原文
/// （"[Subagent Context] You are ..."），剥掉前缀再上屏；其余任务原样透传。
export function cleanTaskTitle(task) {
  return (task?.title ?? "").replace(/^\[Subagent Context\]\s*/i, "");
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

/// 定时任务看板（2026-10-04 六案③）的排程人话与下次运行估算。
/// 只覆盖北斗常用族，其余原样透传（不猜）：
///   "0 14 * * *"   → 每天 14:00
///   "*/30 * * * *" → 每 30 分钟
///   "0 */6 * * *"  → 每 6 小时
///   "0 9 * * 1-5"  → 工作日 09:00
export function cronScheduleText(expr) {
  const text = String(expr ?? "").trim();
  if (!text) return "";
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return text;
  const [m, h, dom, mon, dow] = fields;
  const pad = (n) => String(n).padStart(2, "0");
  const fixedClock = /^\d{1,2}$/.test(m) && /^\d{1,2}$/.test(h)
    ? `${pad(Number(h))}:${pad(Number(m))}`
    : null;
  if (fixedClock && dom === "*" && mon === "*") {
    if (dow === "1-5") return `工作日 ${fixedClock}`;
    if (dow === "*") return `每天 ${fixedClock}`;
  }
  const hourly = /^\*\/(\d{1,2})$/.exec(h);
  if (dom === "*" && mon === "*" && dow === "*" && /^\d{1,2}$/.test(m) && hourly) {
    return `每 ${Number(hourly[1])} 小时`;
  }
  const stepped = /^\*\/(\d{1,3})$/.exec(m);
  if (dom === "*" && mon === "*" && dow === "*" && h === "*" && stepped) {
    return `每 ${Number(stepped[1])} 分钟`;
  }
  return text;
}

/// cron 表达式 → 下次运行时刻（ms）。只算两族：每天/工作日 HH:MM 与
/// 每 N 分钟（*/N）；其余返回 null（看板显示"—"，不硬猜）。
export function cronNextRunMs(expr, now = Date.now()) {
  const text = String(expr ?? "").trim();
  if (!text) return null;
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return null;
  const [m, h, dom, mon, dow] = fields;
  const interval = /^\*\/(\d{1,3})$/.exec(m);
  if (dom === "*" && mon === "*" && dow === "*" && h === "*" && interval) {
    const step = Number(interval[1]) * 60_000;
    if (step <= 0) return null;
    return Math.ceil((now + 1000) / step) * step;
  }
  if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(h) || dom !== "*" || mon !== "*") return null;
  if (dow !== "*" && dow !== "1-5") return null;
  const minute = Number(m);
  const hour = Number(h);
  if (hour > 23 || minute > 59) return null;
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  const workday = dow === "1-5";
  for (let i = 0; i < 8; i++) {
    const day = new Date(candidate.getTime() + i * 86_400_000);
    if (workday) {
      const weekday = day.getDay();
      if (weekday === 0 || weekday === 6) continue;
    }
    if (day.getTime() > now) return day.getTime();
  }
  return null;
}

/// 活跃接力轮（2026-10-04 六案④链路全景）：activeRuns 里同一群聊只留
/// 最新一 run，用 sessionEpisodeHops 展开成完整轮次跳序。群聊键取
/// sessionKey 的 :group: 后段；单 run 轮（如心跳 cron）不成链，不进全景。
export function activeRelayEpisodes(runs, activeRuns, gapMs = EPISODE_HANDOFF_GAP_MS) {
  const chatIdOf = (key) => {
    const text = key || "";
    const marker = text.indexOf(":group:");
    return marker >= 0 ? text.slice(marker + 1) : text;
  };
  const seen = new Set();
  const episodes = [];
  const ordered = [...(activeRuns ?? [])].sort(
    (a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0),
  );
  for (const run of ordered) {
    const chatId = chatIdOf(run.sessionKey);
    if (!chatId || seen.has(chatId)) continue;
    seen.add(chatId);
    const hops = sessionEpisodeHops(runs, run, gapMs);
    if (hops.length >= 2) episodes.push({ chatId, hops });
  }
  return episodes;
}

/// 历史轮次分组（主窗"任务"页"历史轮次"卡）：与 sessionEpisodeHops 同一条
/// gap 链规则（交接沉默 ≤ gapMs 算同一轮），但从台账全量把 run 分成一段段
/// 完整轮次。返回按最近活动新→旧排的段；段内 run 旧→新（原生 run 对象，
/// 渲染层自己 map sessionRunHop）。
export function groupSessionEpisodes(runs, gapMs = EPISODE_HANDOFF_GAP_MS) {
  const chatIdOf = (key) => {
    const text = key || "";
    const marker = text.indexOf(":group:");
    return marker >= 0 ? text.slice(marker + 1) : text;
  };
  const byChat = new Map();
  for (const run of runs ?? []) {
    if (!run) continue;
    const chatId = chatIdOf(run.sessionKey);
    if (!byChat.has(chatId)) byChat.set(chatId, []);
    byChat.get(chatId).push(run);
  }
  const episodes = [];
  for (const chatRuns of byChat.values()) {
    const ordered = [...chatRuns].sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0));
    let current = [];
    for (const run of ordered) {
      if (current.length) {
        // 与 sessionEpisodeHops 同一比较：链内最旧一跳的开始 vs 候选（更旧）
        // 一跳的结束，沉默超限即切段。
        const chainOldest = current[current.length - 1];
        const chainStart = chainOldest.startedAtMs ?? 0;
        const runEnd = run.endedAtMs ?? run.startedAtMs ?? 0;
        if (chainStart - runEnd > gapMs) {
          episodes.push(current);
          current = [];
        }
      }
      current.push(run);
    }
    if (current.length) episodes.push(current);
  }
  return episodes
    .map((episodeRuns) => ({
      runs: [...episodeRuns].sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0)),
      startedAtMs: episodeRuns[episodeRuns.length - 1].startedAtMs ?? 0,
      lastActivityMs: episodeRuns[0].endedAtMs ?? episodeRuns[0].startedAtMs ?? 0,
    }))
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

// ---------------------------------------------------------------------------
// 自绘提醒角标的触发层（2026-10-04 六案 B·自绘壳，Leo 拍板）。
// 全部纯函数：输入台账 runs + 上一拍快照 + 配置，输出新产生的提醒。
// 快照由调用方持有（ref），本函数不碰 DOM、不发事件——策略可测、壳可换。
// ---------------------------------------------------------------------------

/// 免打扰判定：HH:MM 起止，支持跨午夜（23:00–08:00 = 夜里一段）。
/// start===end 视为全天静默；任一时间非法视为不在免打扰。
export function isQuietNow(quietOn, start, end, now = new Date()) {
  if (!quietOn) return false;
  const parse = (text) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  };
  const startMin = parse(start);
  const endMin = parse(end);
  if (startMin == null || endMin == null) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (startMin === endMin) return true;
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

const NOTIFY_FRESHNESS_MS = 15 * 60 * 1000;

/// 轮次提醒检测（B 案触发核心）：
/// - 失败：分诊词表外的真失败 run 新收行（本拍新见且结束时间在新鲜窗口内，
///   开机不回放历史）→ 立即提醒，不等整轮收尾（文案口径"已等补发"）。
///   同轮多条新失败并成一张卡（×N），跨轮多条合并成一张"失败聚合"卡。
/// - 完成：上一拍有运行中跳的轮、本拍全部收行且最新一跳 done → 提醒一次。
/// - 良性未跑（静默跳过/重启中止/手动取消）永不提醒。
/// - 免打扰时段内整批静默丢弃（不排队——时段过了不再响旧账）。
/// snapshot 结构（调用方持有并回传 next）：
///   { failedSeen: {runId:1}, rounds: {chatId:{running:n, doneNotifiedMs} } }
export function detectRoundNotifications(runs, snapshot, config, now = Date.now()) {
  const next = {
    failedSeen: { ...(snapshot?.failedSeen ?? {}) },
    rounds: { ...(snapshot?.rounds ?? {}) },
  };
  if (isQuietNow(config?.quietOn, config?.quietStart, config?.quietEnd, new Date(now))) {
    return { toasts: [], next };
  }
  const nameOf = (id) => config?.agentNames?.[id] || id || "";
  const gapMs = Math.max(5, config?.episodeGapMin ?? 60) * 60_000;
  const episodes = groupSessionEpisodes(runs ?? [], gapMs);
  const toasts = [];
  const failureBatch = [];
  for (const episode of episodes) {
    const chatId = episode.runs[0]
      ? chatKeyOf(episode.runs[0].sessionKey)
      : "";
    const running = episode.runs.filter((run) => run.status === "running").length;
    const prevRound = snapshot?.rounds?.[chatId] ?? { running: 0, doneNotifiedMs: 0 };
    // 失败检测：本拍新见的真失败 + 新鲜
    const freshFailures = episode.runs.filter((run) => {
      if (run.status !== "failed") return false;
      if (failureClassOf(run.error) !== "real") return false;
      if (next.failedSeen[run.id ?? run.sessionKey]) return false;
      const ended = run.endedAtMs ?? run.lastSeenMs ?? 0;
      return now - ended <= (config?.freshnessMs ?? NOTIFY_FRESHNESS_MS);
    });
    for (const run of freshFailures) next.failedSeen[run.id ?? run.sessionKey] = 1;
    if (freshFailures.length > 0) {
      const latest = freshFailures[freshFailures.length - 1];
      failureBatch.push({
        kind: "fail",
        chatId,
        title: "北斗接力 · 失败",
        body: `${nameOf(latest.agentId) ? `${nameOf(latest.agentId)} ` : ""}「${(latest.title ?? latest.fallbackTitle ?? "会话工作").slice(0, 40)}」—— ${sessionErrorText(latest.error, true) || "run 失败"}`,
        meta: freshFailures.length > 1 ? `本轮 ${freshFailures.length} 次失败` : "",
        count: freshFailures.length,
      });
    }
    // 完成检测：上一拍在跑、本拍全收、最新一跳 done、且这一收行是新鲜的
    if (
      prevRound.running > 0
      && running === 0
      && episode.runs.length > 0
      && episode.runs[episode.runs.length - 1].status === "done"
      && (prevRound.doneNotifiedMs ?? 0) < episode.lastActivityMs
      && now - episode.lastActivityMs <= (config?.freshnessMs ?? NOTIFY_FRESHNESS_MS)
    ) {
      const roundMs = episode.lastActivityMs - episode.startedAtMs;
      toasts.push({
        id: `ok:${chatId}:${episode.lastActivityMs}`,
        kind: "ok",
        title: "北斗接力 · 完成",
        body: `「${(episode.runs[episode.runs.length - 1].title ?? episode.runs[episode.runs.length - 1].fallbackTitle ?? "会话工作").slice(0, 44)}」全部跳收工`,
        meta: `整轮 ${Math.max(1, Math.round(roundMs / 60_000))} 分 · ${episode.runs.length} 跳`,
      });
      next.rounds[chatId] = { running: 0, doneNotifiedMs: episode.lastActivityMs };
      continue;
    }
    next.rounds[chatId] = { running, doneNotifiedMs: prevRound.doneNotifiedMs ?? 0 };
  }
  // 失败聚合：一批里只同轮并卡；跨轮 ≥2 → 合成一张"失败聚合"卡
  if (failureBatch.length > 1) {
    const count = failureBatch.reduce((sum, toast) => sum + toast.count, 0);
    toasts.push({
      id: `merge:${now}`,
      kind: "merge",
      title: "失败聚合",
      body: `检测到 ${failureBatch.length} 个轮次共 ${count} 次失败——provider 抖动可疑，详情看任务面板`,
      meta: "",
    });
  } else {
    toasts.push(...failureBatch.map((toast, index) => ({
      id: `fail:${toast.chatId}:${now}:${index}`,
      kind: "fail",
      title: toast.title,
      body: toast.body,
      meta: toast.meta,
    })));
  }
  return { toasts, next };
}

function chatKeyOf(sessionKey) {
  const text = sessionKey || "";
  const marker = text.indexOf(":group:");
  return marker >= 0 ? text.slice(marker + 1) : text;
}
