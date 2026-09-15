// Gateway 任务页数据客户端：连接 Metrik 后端（Tauri命令）或浏览器演示数据。
// 口径：与 usageClient.js 同构——浏览器预览走演示数据，Tauri 走真实命令。

import { invoke } from "@tauri-apps/api/core";

function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

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
      agentId: "main",
      sessionKey: "agent:main:subagent:demo-1",
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
      agentId: "main",
      sessionKey: "agent:main:subagent:demo-2",
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
      agentId: "main",
      sessionKey: "agent:main:cron:demo-3",
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
      agentId: "main",
      sessionKey: "agent:main:subagent:demo-4",
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
      agentId: "main",
      sessionKey: "agent:main:demo-5",
      startedAtMs: now - 3 * 60 * min,
      endedAtMs: now - 2 * 60 * min,
      error: "写入目标目录无权限",
      lastSeenMs: now - 2 * 60 * min,
      firstSeenMs: now - 3 * 60 * min,
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
