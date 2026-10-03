import assert from "node:assert/strict";
import test from "node:test";

import {
  agentDisplayName,
  buildAgentNameMap,
  buildTaskChains,
  chainHopsFor,
  hopGlyphOf,
  hopToneOf,
  isActiveTask,
  selectUsageSessions,
  sessionEpisodeHops,
  sessionRunHopStatus,
} from "./taskChains.js";

const task = (overrides) => ({
  taskId: overrides.taskId,
  status: overrides.status ?? "running",
  title: overrides.title ?? overrides.taskId,
  agentId: overrides.agentId,
  sessionKey: overrides.sessionKey,
  childSessionKey: overrides.childSessionKey,
  runId: overrides.runId,
  startedAtMs: overrides.startedAtMs ?? 0,
  firstSeenMs: overrides.firstSeenMs ?? 0,
});

test("chain groups tasks by shared runId in started order", () => {
  const tasks = [
    task({ taskId: "b", runId: "r1", agentId: "tianxuan", startedAtMs: 2000, sessionKey: "s-b" }),
    task({ taskId: "a", runId: "r1", agentId: "tianshu", startedAtMs: 1000, sessionKey: "s-a" }),
    task({ taskId: "c", runId: "r2", agentId: "tianji", startedAtMs: 3000, sessionKey: "s-c" }),
  ];
  const index = buildTaskChains(tasks);
  const hops = chainHopsFor(tasks[0], index);
  assert.deepEqual(hops.map((hop) => hop.taskId), ["a", "b"]);
});

test("parent childSessionKey joins the spawned subagent task across runIds", () => {
  const tasks = [
    task({
      taskId: "parent",
      status: "succeeded",
      agentId: "tianshu",
      sessionKey: "agent:tianshu:main",
      childSessionKey: "agent:tianxuan:subagent:xyz",
      runId: "exec:alpha",
      startedAtMs: 1000,
    }),
    task({
      taskId: "child",
      agentId: "tianxuan",
      sessionKey: "agent:tianxuan:subagent:xyz",
      runId: "exec:beta",
      startedAtMs: 5000,
    }),
  ];
  const index = buildTaskChains(tasks);
  const hops = chainHopsFor(tasks[1], index);
  assert.deepEqual(hops.map((hop) => hop.taskId), ["parent", "child"]);
});

test("cyclic parent links terminate instead of looping forever", () => {
  const tasks = [
    task({
      taskId: "x",
      sessionKey: "s-x",
      childSessionKey: "s-y",
      startedAtMs: 1000,
    }),
    task({
      taskId: "y",
      sessionKey: "s-y",
      childSessionKey: "s-x",
      startedAtMs: 2000,
    }),
  ];
  const index = buildTaskChains(tasks);
  const hops = chainHopsFor(tasks[0], index);
  assert.equal(hops.length, 2);
});

test("agent name map resolves both gateway-prefixed and short agent ids", () => {
  const map = buildAgentNameMap([
    { agentId: "VPS-北斗:tianshu", name: "天枢" },
    { agentId: "VPS-北斗:tianxuan", name: "天璇" },
  ]);
  assert.equal(agentDisplayName(map, "VPS-北斗:tianshu"), "天枢");
  assert.equal(agentDisplayName(map, "tianshu"), "天枢");
  assert.equal(agentDisplayName(map, "unknown"), "unknown");
  assert.equal(agentDisplayName(map, undefined), "");
});

test("usage sessions drop cron/idless sessions, sort by recency, cap at limit", () => {
  const now = Date.now();
  const sessions = [
    { key: "agent:tianshu:cron:cb75:run:e1", updatedAt: now - 900 },
    { key: "agent:yaoguang:feishu:group:oc_b15", isGroup: true, updatedAt: now - 100 },
    { key: "agent:tianshu:main", updatedAt: now - 300 },
    { key: "agent:tianxuan:feishu:group:oc_b15", isGroup: true, updatedAt: now - 200 },
    { key: "agent:tianji:feishu:group:oc_b15" }, // 无 updatedAt：空闲脏数据，剔除
    { key: "", updatedAt: now - 50 }, // 无 key，剔除
    null,
  ];
  const picked = selectUsageSessions(sessions, { limit: 2, nowMs: now });
  assert.deepEqual(picked.map((session) => session.key), [
    "agent:yaoguang:feishu:group:oc_b15",
    "agent:tianxuan:feishu:group:oc_b15",
  ]);
});

test("usage sessions tolerate null/undefined input", () => {
  assert.deepEqual(selectUsageSessions(null), []);
  assert.deepEqual(selectUsageSessions(undefined), []);
});

test("stale main sessions stay hidden until DM'd, group sessions always show", () => {
  const now = 1_800_000_000_000;
  const sessions = [
    // 天璇主会话：20 天没动、无估算 —— 私聊前不上屏
    { key: "agent:tianxuan:main", isGroup: false, updatedAt: now - 20 * 24 * 3600_000 },
    // 天璇群会话：再旧也是接力跳名单，常驻
    { key: "agent:tianxuan:feishu:group:oc_b15", isGroup: true, updatedAt: now - 20 * 24 * 3600_000 },
    // 天枢主会话：刚私聊过 → 上屏
    { key: "agent:tianshu:main", isGroup: false, updatedAt: now - 60_000 },
    // 主会话陈旧但带上下文估算 → 上屏（有信息量）
    { key: "agent:main:main", isGroup: false, estimatedPromptTokens: 55_000, updatedAt: now - 3 * 24 * 3600_000 },
  ];
  const picked = selectUsageSessions(sessions, { nowMs: now });
  assert.deepEqual(picked.map((session) => session.key), [
    "agent:tianshu:main",
    "agent:main:main",
    "agent:tianxuan:feishu:group:oc_b15",
  ]);
});

test("hopToneOf: 四档状态映射，current 只认正在跑的任务本身（状态驱动不点名）", () => {
  assert.equal(hopToneOf({ status: "succeeded", taskId: "a" }, "x").tone, "done");
  assert.equal(hopToneOf({ status: "failed", taskId: "a" }, "a").tone, "failed");
  assert.equal(hopToneOf({ status: "timed_out", taskId: "a" }, "a").tone, "failed");
  assert.equal(hopToneOf({ status: "queued", taskId: "a" }, "a").tone, "pending");
  const running = hopToneOf({ status: "running", taskId: "a" }, "a");
  assert.equal(running.tone, "current");
  assert.equal(running.current, true);
  assert.equal(hopToneOf({ status: "running", taskId: "a" }, "b").current, false);
});

test("hopGlyphOf: 字形与 tone 一一对应", () => {
  assert.equal(hopGlyphOf("done"), "✓");
  assert.equal(hopGlyphOf("failed"), "✕");
  assert.equal(hopGlyphOf("pending"), "○");
  assert.equal(hopGlyphOf("current"), "●");
});

test("isActiveTask: running/queued 算活跃，其余与缺状态不算", () => {
  assert.equal(isActiveTask({ status: "running" }), true);
  assert.equal(isActiveTask({ status: "queued" }), true);
  assert.equal(isActiveTask({ status: "succeeded" }), false);
  assert.equal(isActiveTask({}), false);
  assert.equal(isActiveTask(null), false);
});

test("sessionRunHopStatus: done→succeeded、failed→failed、running 保持", () => {
  assert.equal(sessionRunHopStatus("done"), "succeeded");
  assert.equal(sessionRunHopStatus("succeeded"), "succeeded");
  assert.equal(sessionRunHopStatus("failed"), "failed");
  assert.equal(sessionRunHopStatus("timed_out"), "failed");
  assert.equal(sessionRunHopStatus("running"), "running");
  assert.equal(sessionRunHopStatus(null), "running");
});

test("sessionEpisodeHops: 同群聊邻近 run 组成序列，跨群/窗外不入列", () => {
  const now = Date.now();
  const runs = [
    { id: 1, sessionKey: "agent:tianxuan:feishu:group:oc_a", agentId: "tianxuan", status: "failed", startedAtMs: now - 500_000, endedAtMs: now - 370_000, title: "首轮" },
    { id: 2, sessionKey: "agent:tianshu:feishu:group:oc_a", agentId: "tianshu", status: "running", startedAtMs: now - 230_000, title: "补发" },
    { id: 3, sessionKey: "agent:tianji:feishu:group:oc_b", agentId: "tianji", status: "running", startedAtMs: now - 100_000, title: "别的群" },
    { id: 4, sessionKey: "agent:tianshu:main", agentId: "tianshu", status: "done", startedAtMs: now - 300_000, endedAtMs: now - 290_000, title: "主会话" },
  ];
  const focus = { sessionKey: "agent:tianshu:feishu:group:oc_a", startedAtMs: now - 230_000 };
  const hops = sessionEpisodeHops(runs, focus);
  // 同群（oc_a）的两拍：天璇失败 → 天枢运行中；跨群 oc_b 与主会话不入列
  assert.equal(hops.length, 2);
  assert.equal(hops[0].taskId, "session-run:1");
  assert.equal(hops[0].status, "failed");
  assert.equal(hops[1].taskId, "session-run:2");
  assert.equal(hops[1].status, "running");
  assert.equal(hops[1].title, "补发");
  // 窗口外（>30 分钟）的邻近 run 不入列
  const far = [...runs, { id: 5, sessionKey: "agent:tianxuan:feishu:group:oc_a", agentId: "tianxuan", status: "done", startedAtMs: now - 3 * 3_600_000, endedAtMs: now - 2.9 * 3_600_000 }];
  assert.equal(sessionEpisodeHops(far, focus).length, 2);
  // 序列上限 6 跳
  const many = Array.from({ length: 10 }, (_, index) => ({
    id: 100 + index,
    sessionKey: "agent:tianshu:feishu:group:oc_a",
    agentId: "tianshu",
    status: "done",
    startedAtMs: now - (600 - index) * 60_000,
    endedAtMs: now - (599 - index) * 60_000,
  }));
  assert.equal(sessionEpisodeHops(many, many[9]).length, 6);
});
