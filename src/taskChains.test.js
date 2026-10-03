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

test("sessionEpisodeHops: 同群聊接力链按交接连续性成段，跨群/断档不入列", () => {
  const now = Date.now();
  const runs = [
    { id: 1, sessionKey: "agent:tianxuan:feishu:group:oc_a", agentId: "tianxuan", status: "failed", startedAtMs: now - 500_000, endedAtMs: now - 370_000, title: "首轮" },
    { id: 2, sessionKey: "agent:tianshu:feishu:group:oc_a", agentId: "tianshu", status: "running", startedAtMs: now - 230_000, title: "补发" },
    { id: 3, sessionKey: "agent:tianji:feishu:group:oc_b", agentId: "tianji", status: "running", startedAtMs: now - 100_000, title: "别的群" },
    { id: 4, sessionKey: "agent:tianshu:main", agentId: "tianshu", status: "done", startedAtMs: now - 300_000, endedAtMs: now - 290_000, title: "主会话" },
  ];
  const focus = { sessionKey: "agent:tianshu:feishu:group:oc_a", startedAtMs: now - 230_000 };
  const hops = sessionEpisodeHops(runs, focus);
  // 同群（oc_a）的两拍：天璇失败 → 天枢运行中（交接间隔 140s，连续）；跨群 oc_b 与主会话不入列
  assert.equal(hops.length, 2);
  assert.equal(hops[0].taskId, "session-run:1");
  assert.equal(hops[0].status, "failed");
  assert.equal(hops[1].taskId, "session-run:2");
  assert.equal(hops[1].status, "running");
  assert.equal(hops[1].title, "补发");
  // 断档（上一棒结束距当前 run 开始 > 1h 沉默）不入列——哪怕同群
  const far = [...runs, { id: 5, sessionKey: "agent:tianxuan:feishu:group:oc_a", agentId: "tianxuan", status: "done", startedAtMs: now - 3 * 3_600_000, endedAtMs: now - 2.9 * 3_600_000 }];
  assert.equal(sessionEpisodeHops(far, focus).length, 2);
  // 不设格数上限：持续交接的长链全部入列（总时长 10 分钟、10 棒）
  const many = Array.from({ length: 10 }, (_, index) => ({
    id: 100 + index,
    sessionKey: "agent:tianshu:feishu:group:oc_a",
    agentId: "tianshu",
    status: "done",
    startedAtMs: now - (600 - index) * 60_000,
    endedAtMs: now - (599 - index) * 60_000,
  }));
  assert.equal(sessionEpisodeHops(many, many[9]).length, 10);
});

test("sessionEpisodeHops: 长任务只要交接连续就不断链，沉默超 1h 才切开", () => {
  const now = Date.now();
  const min = 60_000;
  // 三个星位接力，总时长 2.5 小时（远超旧 30 分钟窗），但每次交接只隔 1 分钟
  const longChain = [
    { id: 1, sessionKey: "agent:tianshu:feishu:group:oc_c", agentId: "tianshu", status: "done", startedAtMs: now - 150 * min, endedAtMs: now - 148 * min, title: "派活" },
    { id: 2, sessionKey: "agent:tianxuan:feishu:group:oc_c", agentId: "tianxuan", status: "done", startedAtMs: now - 147 * min, endedAtMs: now - 90 * min, title: "研究" },
    { id: 3, sessionKey: "agent:tianquan:feishu:group:oc_c", agentId: "tianquan", status: "done", startedAtMs: now - 89 * min, endedAtMs: now - 40 * min, title: "初审" },
    { id: 4, sessionKey: "agent:tianji:feishu:group:oc_c", agentId: "tianji", status: "running", startedAtMs: now - 39 * min, title: "创作" },
  ];
  const focus = { sessionKey: "agent:tianji:feishu:group:oc_c", startedAtMs: now - 39 * min };
  assert.equal(sessionEpisodeHops(longChain, focus).length, 4);
  // 中途沉默 65 分钟（等 Leo 确认去了）：后半段自成一段，前半段不混入
  const withPause = [
    longChain[0],
    longChain[1],
    { id: 5, sessionKey: "agent:tianquan:feishu:group:oc_c", agentId: "tianquan", status: "done", startedAtMs: now - 25 * min, endedAtMs: now - 20 * min, title: "复审" },
    { id: 6, sessionKey: "agent:tianji:feishu:group:oc_c", agentId: "tianji", status: "running", startedAtMs: now - 5 * min, title: "续作" },
  ];
  const laterFocus = { sessionKey: "agent:tianji:feishu:group:oc_c", startedAtMs: now - 5 * min };
  const hops = sessionEpisodeHops(withPause, laterFocus);
  // 复审（-25min 起）与续作（-5min 起）交接间隔 15min → 同段；研究（-90min 终）
  // 结束后到复审开始沉默 65 分钟 > 1h → 断开
  assert.deepEqual(hops.map((hop) => hop.taskId), ["session-run:5", "session-run:6"]);
  // 沉默上限可调（设置页 episodeGapMin）：放宽到 2h，65 分钟的沉默也串回来
  const relaxed = sessionEpisodeHops(withPause, laterFocus, 2 * 3_600_000);
  assert.deepEqual(relaxed.map((hop) => hop.taskId), ["session-run:1", "session-run:2", "session-run:5", "session-run:6"]);
});
