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
