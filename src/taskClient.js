// Gateway 任务页数据客户端：连接 Metrik 后端（Tauri命令）或浏览器演示数据。
// 口径：与 usageClient.js 同构——浏览器预览走演示数据，Tauri 走真实命令。

import { invoke } from "@tauri-apps/api/core";

function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export { isTauriRuntime };

/// 读任务列表：Tauri 下走 gateway_task_list；浏览器演示给空——北斗的真实形态里
/// 登记任务（cron/exec）几乎常闲，主力工作全在会话接力（loadSessionRuns 演示），
/// 假任务堆数只会误导对 +N 角标和面板密度的判断。
export async function loadGatewayTasks(status) {
  if (!isTauriRuntime()) {
    return { demo: true, tasks: [] };
  }
  try {
    const tasks = await invoke("gateway_task_list", { status: status ?? null, limit: 300 });
    return { demo: false, tasks };
  } catch (error) {
    return { demo: false, tasks: [], loadError: String(error) };
  }
}

/// 触发一次拉取（gateway_task_snapshot）。gateways 配置来自设置。
export async function refreshGatewayTasks(gateways) {
  if (!isTauriRuntime()) {
    return { demo: true, results: gateways.map((gateway) => ({ gateway: gateway.label, ok: true, taskCount: 0, error: null })) };
  }
  try {
    const results = await invoke("gateway_task_snapshot", { gateways });
    return { demo: false, results };
  } catch (error) {
    return { demo: false, results: [], loadError: String(error) };
  }
}

/// 读会话工作台账：群聊派活等会话 run 的结构化记录（session_run 表）。
/// 浏览器预览走演示数据：形态 = 北斗的一轮真实接力（Leo 派活天枢 → 天璇研究 →
/// 天权初审 → 天玑 502 失败补发中），外加一个并行定时任务——这才是 +N 角标
/// 在真实链路里的典型读数（通常 0~1，不会是堆出来的 +10）。
export async function loadSessionRuns() {
  if (!isTauriRuntime()) {
    const now = Date.now();
    const min = 60_000;
    const run = (overrides) => ({
      gateway: "vps",
      model: "gpt-6",
      progressSummary: null,
      error: null,
      endedAtMs: null,
      ...overrides,
    });
    return {
      demo: true,
      runs: [
        // ── 一轮接力：同一群聊（chatId 相同），按真实时序一格格长出来 ──
        run({
          id: 1,
          sessionKey: "agent:tianshu:feishu:group:oc_demo_relay",
          agentId: "tianshu",
          status: "done",
          title: "「热点选题测试-20261003」完整走一遍北斗链路，从天璇开始",
          terminalSummary: "链路已跑通：研究 → 初审 → 创作三段接力派给天璇/天权/天玑，验收点写进各卡，成稿回传共享盘。",
          startedAtMs: now - 26 * min,
          endedAtMs: now - 24 * min,
          firstSeenMs: now - 26 * min,
          lastSeenMs: now - 24 * min,
        }),
        run({
          id: 2,
          sessionKey: "agent:tianxuan:feishu:group:oc_demo_relay",
          agentId: "tianxuan",
          status: "done",
          title: "天璇，选题研究：OpenAI 智能体越权，产出研究 md 到 /tmp",
          terminalSummary: "研究完成：md 已落 /tmp/research-openai-agent-authz.md，要点 7 条、风险 3 处、引用 12 篇。",
          startedAtMs: now - 24 * min,
          endedAtMs: now - 18 * min,
          firstSeenMs: now - 24 * min,
          lastSeenMs: now - 18 * min,
        }),
        run({
          id: 3,
          sessionKey: "agent:tianquan:feishu:group:oc_demo_relay",
          agentId: "tianquan",
          status: "done",
          title: "天权，初审天璇的研究报告，给 PASS/FAIL 结论和强制约束",
          terminalSummary: "初审 PASS。三条强制约束：直接动笔不重读文档、字数下限 1200、引用必须带原文链接。",
          startedAtMs: now - 17 * min,
          endedAtMs: now - 13 * min,
          firstSeenMs: now - 17 * min,
          lastSeenMs: now - 13 * min,
        }),
        run({
          id: 4,
          sessionKey: "agent:tianji:feishu:group:oc_demo_relay",
          agentId: "tianji",
          status: "failed",
          title: "天玑，按定稿标题直接动笔创作",
          error: "provider 502，未产出即回",
          startedAtMs: now - 9 * min,
          endedAtMs: now - 8.5 * min,
          firstSeenMs: now - 9 * min,
          lastSeenMs: now - 8.5 * min,
        }),
        run({
          id: 5,
          sessionKey: "agent:tianji:feishu:group:oc_demo_relay",
          agentId: "tianji",
          status: "running",
          title: "【补发·第1次】天玑，按定稿标题直接动笔创作，不要重读文档",
          progressSummary: "write",
          startedAtMs: now - 3 * min,
          firstSeenMs: now - 3 * min,
          lastSeenMs: now - 2_000,
        }),
        // ── 3 小时前已收尾的一轮小接力（gap 链自然切段）：历史轮次的样例 ──
        run({
          id: 7,
          sessionKey: "agent:tianshu:feishu:group:oc_demo_relay",
          agentId: "tianshu",
          status: "done",
          title: "把昨天的调研纪要整理成周报草稿",
          terminalSummary: "周报草稿已写入 /tmp/weekly-draft.md（5 节），待终稿校对。",
          startedAtMs: now - 180 * min,
          endedAtMs: now - 176 * min,
          firstSeenMs: now - 180 * min,
          lastSeenMs: now - 176 * min,
        }),
        // ── 良性未跑样例（失败分诊六案②）：心跳在免打扰时段被跳过——
        // 网关记 failed，但不是真失败，UI 灰显「跳过」不占失败区 ──
        run({
          id: 9,
          sessionKey: "agent:yuheng:cron:demo-heartbeat",
          agentId: "yuheng",
          status: "failed",
          title: "heartbeat-yuheng",
          error: "heartbeat skipped: quiet-hours",
          startedAtMs: now - 42 * min,
          endedAtMs: now - 42 * min + 300,
          firstSeenMs: now - 42 * min,
          lastSeenMs: now - 42 * min + 300,
        }),
        run({
          id: 8,
          sessionKey: "agent:tianxuan:feishu:group:oc_demo_relay",
          agentId: "tianxuan",
          status: "done",
          title: "周报终稿校对并写入共享盘",
          startedAtMs: now - 175 * min,
          endedAtMs: now - 171 * min,
          firstSeenMs: now - 175 * min,
          lastSeenMs: now - 171 * min,
        }),
        // ── 接力之外：并行定时任务（无 :group: 前缀，不进这段胶卷）→ +1 ──
        run({
          id: 6,
          sessionKey: "agent:yuheng:cron:demo-review",
          agentId: "yuheng",
          status: "running",
          title: "定时任务：skill-collection-review",
          progressSummary: "exec",
          startedAtMs: now - 20 * min,
          firstSeenMs: now - 20 * min,
          lastSeenMs: now - 2_000,
        }),
      ],
    };
  }
  try {
    const runs = await invoke("session_run_list", { limit: 300 });
    return { demo: false, runs: Array.isArray(runs) ? runs : [] };
  } catch (error) {
    return { demo: false, runs: [], loadError: String(error) };
  }
}

/// 定时任务看板（六案③）：cron.list 的本地镜像读回 + 触发拉取。
/// 镜像在 Rust 侧 60 秒节流，前端每拍调用也只真连一次每分钟。
/// 演示数据 = 北斗真实形态三例（巡检/心跳/停用的记忆整理），并自带
/// lastRunStatus/lastRunAtMs 演示字段——真机不走这两个字段，看板用
/// 任务账本（sourceId 对账）拼"上次结果"，这里只为了浏览器预览完整。
export async function loadCronJobs() {
  if (!isTauriRuntime()) {
    const now = Date.now();
    const min = 60_000;
    return {
      demo: true,
      jobs: [
        {
          id: "cron-demo-patrol",
          gateway: "vps",
          name: "北斗巡检-OpenAI安全黑洞任务",
          description: "每日巡检 OpenAI 安全动态并汇报北斗矩阵群",
          enabled: true,
          scheduleExpr: "0 14 * * *",
          updatedAtMs: now,
          lastRunStatus: "completed",
          lastRunAtMs: now - 5 * 3_600_000 - 52 * min,
        },
        {
          id: "cron-demo-heartbeat",
          gateway: "vps",
          name: "heartbeat-tianshu",
          description: "天枢心跳保活",
          enabled: true,
          scheduleExpr: "*/30 * * * *",
          updatedAtMs: now,
          lastRunStatus: "failed",
          lastRunError: "heartbeat skipped: quiet-hours",
          lastRunAtMs: now - 42 * min,
        },
        {
          id: "cron-demo-memory",
          gateway: "vps",
          name: "Memory Dreaming Promotion",
          description: "Promote weighted short-term recalls into MEMORY.md",
          enabled: false,
          scheduleExpr: "0 3 * * *",
          updatedAtMs: now,
          lastRunStatus: "completed",
          lastRunAtMs: now - 26 * 3_600_000,
        },
      ],
    };
  }
  try {
    const jobs = await invoke("gateway_cron_list", { limit: 200 });
    return { demo: false, jobs: Array.isArray(jobs) ? jobs : [] };
  } catch (error) {
    return { demo: false, jobs: [], loadError: String(error) };
  }
}

export async function refreshCronJobs(gateways) {
  if (!isTauriRuntime()) {
    return { demo: true, results: gateways.map((gateway) => ({ gateway: gateway.label, ok: true, taskCount: 0, error: null })) };
  }
  try {
    const results = await invoke("gateway_cron_snapshot", { gateways });
    return { demo: false, results };
  } catch (error) {
    return { demo: false, results: [], loadError: String(error) };
  }
}

/// 设置存取：被追踪的 Gateway 列表（含 token）。token 只存本机 localStorage
/// （与 Control UI 同级的安全边界；不上传、不进账本）。
/// 读 Agent 会话活动快照（北斗等星位实时状态）：后端拉 sessions.list +
/// agents.list 并按 agent 归集。Tauri 下走真实命令；浏览器走演示数据。
export async function loadAgentsSnapshot(gateways) {
  if (!isTauriRuntime()) {
    const now = Date.now();
    const stars = [
      { id: "tianshu", name: "天枢" },
      { id: "tianxuan", name: "天璇" },
      { id: "tianji", name: "天玑" },
      { id: "tianquan", name: "天权" },
      { id: "yuheng", name: "玉衡" },
      { id: "kaiyang", name: "开阳" },
      { id: "yaoguang", name: "摇光" },
    ];
    return {
      demo: true,
      agents: stars.map((star, index) => ({
        agentId: `VPS-北斗:${star.id}`,
        name: star.name,
        active: index < 3,
        lastActiveMs: now - (index < 3 ? index * 4000 : 40 * 60_000),
        sessionCount: index < 3 ? 1 : 0,
        runningTasks: index < 3 ? 1 : 0,
      })),
      // 演示会话用量：北斗接力跳 = 群会话（真机形态 agent:<id>:feishu:group:oc_*）。
      sessions: [
        {
          key: "VPS-北斗:agent:tianshu:main",
          gateway: "VPS-北斗",
          agentId: "tianshu",
          isGroup: false,
          model: "gpt-6",
          contextTokens: 525000,
          // 87% ≈ 超过 80% 预警线：水位预警（六案⑥）的琥珀"建议清理"样例
          estimatedPromptTokens: 460_000,
          contextTokenBudget: 525000,
          promptMessageCount: 128,
          shouldCompact: false,
          hasActiveRun: false,
          updatedAt: now - 60_000,
        },
        ...stars.map((star, index) => ({
          key: `VPS-北斗:agent:${star.id}:feishu:group:oc_b15d1b110f2473c56fd31373fc88da6a`,
          gateway: "VPS-北斗",
          agentId: star.id,
          isGroup: true,
          model: "gpt-6",
          contextTokens: 525000,
          estimatedPromptTokens: index < 2 ? 40_000 + index * 35_000 : null,
          contextTokenBudget: 525000,
          promptMessageCount: index < 2 ? 18 + index * 22 : null,
          shouldCompact: false,
          // 天玑（index 2）= 正在跑的补发跳：运行中但上下文还没产出 → "启动中"
          hasActiveRun: index === 2,
          updatedAt: now - (index < 2 ? index * 4000 : index === 2 ? 3000 : 40 * 60_000),
        })),
      ],
    };
  }
  try {
    // 台账口径随拍下发：保留期/漏采补记窗口在设置页可调（Rust 侧再夹一次范围）。
    const monitor = loadMonitorConfig();
    const payload = await invoke("gateway_agents_snapshot", {
      gateways,
      ledger: {
        retentionDays: monitor.ledgerRetentionDays,
        missedWindowHours: monitor.missedWindowHours,
      },
    });
    return { demo: false, agents: payload?.agents ?? [], sessions: payload?.sessions ?? [] };
  } catch (error) {
    return { demo: false, agents: [], sessions: [], loadError: String(error) };
  }
}

/// 监控参数（任务页刷新间隔 / 无活动判定阈值）：存本机 localStorage，
/// 修改后下一拍即生效，无需重装。
const MONITOR_KEY = "metrik-monitor-cfg";

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function loadMonitorConfig() {
  // 水位预警阈值特殊：0 = 关闭（不预警），50–95 = 阈值百分比。
  const warnPct = (value, fallback) => {
    const n = Number(value);
    if (n === 0) return 0;
    return clampNumber(n ?? fallback, fallback, 50, 95);
  };
  // 免打扰时段是 HH:MM 字符串（支持跨午夜），非法值回缺省。
  const clock = (value, fallback) => {
    const text = String(value ?? "").trim();
    return /^([01]?\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
  };
  try {
    const raw = JSON.parse(localStorage.getItem(MONITOR_KEY) || "{}");
    return {
      refreshIntervalSec: clampNumber(raw.refreshIntervalSec, 3, 1, 60),
      staleThresholdSec: clampNumber(raw.staleThresholdSec, 120, 10, 3600),
      episodeGapMin: clampNumber(raw.episodeGapMin, 60, 5, 720),
      failedWindowH: clampNumber(raw.failedWindowH, 1, 1, 168),
      ledgerRetentionDays: clampNumber(raw.ledgerRetentionDays, 7, 1, 90),
      missedWindowHours: clampNumber(raw.missedWindowHours, 1, 1, 72),
      translateProgress: raw.translateProgress !== false,
      // 任务小组件贴边自动隐藏（边缘挂靠）：默认关，勾选后拖到屏幕边缘收起。
      tasksEdgeDock: raw.tasksEdgeDock === true,
      // 主窗"任务"页历史轮次回看窗口（分钟，0=关闭）。台账保留期是数据上限，
      // 这里只管显示多久；上限 10080 = 7 天（对齐台账缺省保留期）。
      historyWindowMin: clampNumber(raw.historyWindowMin, 1440, 0, 10080),
      // 星位上下文水位预警阈值（%，0=关）。
      watermarkWarnPct: warnPct(raw.watermarkWarnPct, 80),
      // 自绘提醒角标（六案 B·自绘壳）：总开关默认关，要用主动开。
      notifyEnabled: raw.notifyEnabled === true,
      notifyOnFailure: raw.notifyOnFailure !== false,
      notifyOnComplete: raw.notifyOnComplete === true,
      notifyAggregateMin: clampNumber(raw.notifyAggregateMin, 10, 2, 60),
      notifyStaySec: clampNumber(raw.notifyStaySec, 8, 4, 30),
      notifyQuietOn: raw.notifyQuietOn !== false,
      notifyQuietStart: clock(raw.notifyQuietStart, "23:00"),
      notifyQuietEnd: clock(raw.notifyQuietEnd, "08:00"),
    };
  } catch {
    return {
      refreshIntervalSec: 3,
      staleThresholdSec: 120,
      episodeGapMin: 60,
      failedWindowH: 1,
      ledgerRetentionDays: 7,
      missedWindowHours: 1,
      translateProgress: true,
      tasksEdgeDock: false,
      historyWindowMin: 1440,
      watermarkWarnPct: 80,
      notifyEnabled: false,
      notifyOnFailure: true,
      notifyOnComplete: false,
      notifyAggregateMin: 10,
      notifyStaySec: 8,
      notifyQuietOn: true,
      notifyQuietStart: "23:00",
      notifyQuietEnd: "08:00",
    };
  }
}

export function saveMonitorConfig(config) {
  const warnPct = (value, fallback) => {
    const n = Number(value);
    if (n === 0) return 0;
    return clampNumber(n ?? fallback, fallback, 50, 95);
  };
  const clock = (value, fallback) => {
    const text = String(value ?? "").trim();
    return /^([01]?\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
  };
  const clean = {
    refreshIntervalSec: clampNumber(config.refreshIntervalSec, 3, 1, 60),
    staleThresholdSec: clampNumber(config.staleThresholdSec, 120, 10, 3600),
    episodeGapMin: clampNumber(config.episodeGapMin, 60, 5, 720),
    failedWindowH: clampNumber(config.failedWindowH, 1, 1, 168),
    ledgerRetentionDays: clampNumber(config.ledgerRetentionDays, 7, 1, 90),
    missedWindowHours: clampNumber(config.missedWindowHours, 1, 1, 72),
    translateProgress: config.translateProgress !== false,
    tasksEdgeDock: config.tasksEdgeDock === true,
    historyWindowMin: clampNumber(config.historyWindowMin, 1440, 0, 10080),
    watermarkWarnPct: warnPct(config.watermarkWarnPct, 80),
    notifyEnabled: config.notifyEnabled === true,
    notifyOnFailure: config.notifyOnFailure !== false,
    notifyOnComplete: config.notifyOnComplete === true,
    notifyAggregateMin: clampNumber(config.notifyAggregateMin, 10, 2, 60),
    notifyStaySec: clampNumber(config.notifyStaySec, 8, 4, 30),
    notifyQuietOn: config.notifyQuietOn !== false,
    notifyQuietStart: clock(config.notifyQuietStart, "23:00"),
    notifyQuietEnd: clock(config.notifyQuietEnd, "08:00"),
  };
  localStorage.setItem(MONITOR_KEY, JSON.stringify(clean));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("metrik-monitor-changed"));
  }
  return clean;
}

const GATEWAYS_KEY = "metrik:gateways";

export function loadGatewayConfig() {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(GATEWAYS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((entry) => entry && entry.label && entry.url && entry.token) : [];
  } catch {
    return [];
  }
}

export function saveGatewayConfig(entries) {
  if (typeof window === "undefined") return;
  localStorage.setItem(GATEWAYS_KEY, JSON.stringify(entries));
}
