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
  try {
    const raw = JSON.parse(localStorage.getItem(MONITOR_KEY) || "{}");
    return {
      refreshIntervalSec: clampNumber(raw.refreshIntervalSec, 3, 1, 60),
      staleThresholdSec: clampNumber(raw.staleThresholdSec, 120, 10, 3600),
      episodeGapMin: clampNumber(raw.episodeGapMin, 60, 5, 720),
      failedWindowH: clampNumber(raw.failedWindowH, 24, 1, 168),
      ledgerRetentionDays: clampNumber(raw.ledgerRetentionDays, 7, 1, 90),
      missedWindowHours: clampNumber(raw.missedWindowHours, 1, 1, 72),
      translateProgress: raw.translateProgress !== false,
    };
  } catch {
    return {
      refreshIntervalSec: 3,
      staleThresholdSec: 120,
      episodeGapMin: 60,
      failedWindowH: 24,
      ledgerRetentionDays: 7,
      missedWindowHours: 1,
      translateProgress: true,
    };
  }
}

export function saveMonitorConfig(config) {
  const clean = {
    refreshIntervalSec: clampNumber(config.refreshIntervalSec, 3, 1, 60),
    staleThresholdSec: clampNumber(config.staleThresholdSec, 120, 10, 3600),
    episodeGapMin: clampNumber(config.episodeGapMin, 60, 5, 720),
    failedWindowH: clampNumber(config.failedWindowH, 24, 1, 168),
    ledgerRetentionDays: clampNumber(config.ledgerRetentionDays, 7, 1, 90),
    missedWindowHours: clampNumber(config.missedWindowHours, 1, 1, 72),
    translateProgress: config.translateProgress !== false,
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
