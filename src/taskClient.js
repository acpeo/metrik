// Gateway 任务页数据客户端：连接 Metrik 后端（Tauri命令）或浏览器演示数据。
// 口径：与 usageClient.js 同构——浏览器预览走演示数据，Tauri 走真实命令。

import { invoke } from "@tauri-apps/api/core";

function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export { isTauriRuntime };

/// 演示数据：一组形态真实的多 Agent 协作任务（含 running / blocked / 终态）。
function demoTasks() {
  const now = Date.now();
  const min = 60_000;
  return [
    {
      taskId: "demo-1",
      gateway: "本机",
      runtime: "subagent",
      status: "running",
      title: "竞品分析·储能赛道",
      agentId: "tianxuan",
      sessionKey: "agent:tianxuan:subagent:demo-1",
      runId: "demo-run-1",
      progressSummary: "已检索 23 篇研报，正在对比各家装机成本数据",
      startedAtMs: now - 4 * min,
      lastSeenMs: now - 12_000,
      firstSeenMs: now - 5 * min,
    },
    {
      taskId: "demo-2",
      gateway: "本机",
      runtime: "subagent",
      status: "running",
      title: "财报数据抽取·比亚迪",
      agentId: "tianji",
      sessionKey: "agent:tianji:subagent:demo-2",
      runId: "demo-run-2",
      progressSummary: "正在抽取 2025 年报现金流量表",
      startedAtMs: now - 12 * min,
      lastSeenMs: now - 40_000,
      firstSeenMs: now - 13 * min,
    },
    {
      taskId: "demo-3",
      gateway: "VPS",
      runtime: "cron",
      status: "running",
      title: "行情快照定时任务",
      agentId: "tianshu",
      sessionKey: "agent:tianshu:cron:demo-3:run:abc",
      runId: "cron:demo-3:123:run:abc",
      progressSummary: "正在抓取盘中行情 156/214",
      startedAtMs: now - 2 * min,
      lastSeenMs: now - 5_000,
      firstSeenMs: now - 30 * min,
    },
    {
      taskId: "demo-4",
      gateway: "VPS",
      runtime: "subagent",
      status: "succeeded",
      title: "公告检索·宁德时代",
      agentId: "tianshu",
      sessionKey: "agent:tianshu:subagent:demo-4",
      childSessionKey: "agent:tianxuan:subagent:demo-1",
      runId: "demo-run-1",
      startedAtMs: now - 46 * min,
      endedAtMs: now - 31 * min,
      terminalSummary: "completed",
      lastSeenMs: now - 31 * min,
      firstSeenMs: now - 47 * min,
    },
    {
      taskId: "demo-5",
      gateway: "本机",
      runtime: "cli",
      status: "failed",
      title: "文档导出",
      agentId: "tianshu",
      sessionKey: "agent:tianshu:main",
      runId: "exec:demo-5",
      startedAtMs: now - 3 * 60 * min,
      endedAtMs: now - 2 * 60 * min,
      error: "写入目标目录无权限",
      lastSeenMs: now - 2 * 60 * min,
      firstSeenMs: now - 3 * 60 * min,
    },
    {
      taskId: "demo-6",
      gateway: "本机",
      runtime: "subagent",
      status: "queued",
      title: "选题初审·储能赛道",
      agentId: "tianquan",
      runId: "demo-run-1",
      firstSeenMs: now - 60_000,
      lastSeenMs: now - 60_000,
    },
    {
      taskId: "demo-7",
      gateway: "本机",
      runtime: "subagent",
      status: "queued",
      title: "母稿创作·储能赛道",
      agentId: "tianji",
      runId: "demo-run-1",
      firstSeenMs: now - 50_000,
      lastSeenMs: now - 50_000,
    },
    {
      taskId: "demo-8",
      gateway: "本机",
      runtime: "subagent",
      status: "queued",
      title: "终审·储能赛道",
      agentId: "tianquan",
      runId: "demo-run-1",
      firstSeenMs: now - 40_000,
      lastSeenMs: now - 40_000,
    },
    {
      taskId: "demo-9",
      gateway: "本机",
      runtime: "subagent",
      status: "queued",
      title: "配图生成·储能赛道",
      agentId: "yuheng",
      runId: "demo-run-1",
      firstSeenMs: now - 30_000,
      lastSeenMs: now - 30_000,
    },
    {
      taskId: "demo-10",
      gateway: "本机",
      runtime: "subagent",
      status: "queued",
      title: "视频脚本·储能赛道",
      agentId: "kaiyang",
      runId: "demo-run-1",
      firstSeenMs: now - 20_000,
      lastSeenMs: now - 20_000,
    },
    {
      taskId: "demo-11",
      gateway: "本机",
      runtime: "subagent",
      status: "queued",
      title: "发布运营·储能赛道",
      agentId: "yaoguang",
      runId: "demo-run-1",
      firstSeenMs: now - 10_000,
      lastSeenMs: now - 10_000,
    },
  ];
}

/// 读任务列表：Tauri 下走 gateway_task_list；浏览器走演示数据。
export async function loadGatewayTasks(status) {
  if (!isTauriRuntime()) {
    const tasks = demoTasks();
    return {
      demo: true,
      tasks:
        status === "active"
          ? tasks.filter((task) => task.status === "running" || task.status === "queued")
          : status
            ? tasks.filter((task) => task.status === status)
            : tasks,
    };
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
          estimatedPromptTokens: 154174,
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
          hasActiveRun: index === 0,
          updatedAt: now - (index < 3 ? index * 4000 : 40 * 60_000),
        })),
      ],
    };
  }
  try {
    const payload = await invoke("gateway_agents_snapshot", { gateways });
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
  try {
    const raw = JSON.parse(localStorage.getItem(MONITOR_KEY) || "{}");
    return {
      refreshIntervalSec: clampNumber(raw.refreshIntervalSec, 3, 1, 60),
      staleThresholdSec: clampNumber(raw.staleThresholdSec, 120, 10, 3600),
    };
  } catch {
    return { refreshIntervalSec: 3, staleThresholdSec: 120 };
  }
}

export function saveMonitorConfig(config) {
  const clean = {
    refreshIntervalSec: clampNumber(config.refreshIntervalSec, 3, 1, 60),
    staleThresholdSec: clampNumber(config.staleThresholdSec, 120, 10, 3600),
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
