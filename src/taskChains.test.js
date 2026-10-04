import assert from "node:assert/strict";
import test from "node:test";

import {
  activeRelayEpisodes,
  agentDisplayName,
  detectRoundNotifications,
  isQuietNow,
  benignStateOf,
  buildAgentNameMap,
  buildTaskChains,
  chainHopsFor,
  cleanTaskTitle,
  cronNextRunMs,
  cronScheduleText,
  failureClassOf,
  groupSessionEpisodes,
  isSubagentTask,
  hopGlyphOf,
  listIdleSessions,
  hopToneOf,
  isActiveTask,
  countIdleSessions,
  selectUsageSessions,
  sessionEpisodeHops,
  sessionErrorText,
  sessionRunHopStatus,
  sessionRunHop,
  toolProgressLabel,
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

test("usage sessions: 只收有真实水位的会话，按水位降序（Leo 2026-10-04 定案：卡回答'谁快满了'，不做目录）", () => {
  const now = 1_800_000_000_000;
  const sessions = [
    // 有水位的群会话：上卡，但按水位排——刚活跃的 40k 排在 154k 之后
    { key: "agent:tianshu:feishu:group:oc_a", isGroup: true, estimatedPromptTokens: 40_000, contextTokenBudget: 525_000, updatedAt: now - 100 },
    // 有水位的主会话：水位最高，排最前（哪怕 3 天没动）
    { key: "agent:tianshu:main", isGroup: false, estimatedPromptTokens: 154_000, contextTokenBudget: 525_000, updatedAt: now - 3 * 24 * 3600_000 },
    // 无水位的群会话：不逐行占位（Leo 截图里一排"预 525k"的病根）
    { key: "agent:tianxuan:feishu:group:oc_a", isGroup: true, estimatedPromptTokens: null, updatedAt: now - 60_000 },
    // cron 会话：永远排除
    { key: "agent:tianshu:cron:cb75:run:e1", estimatedPromptTokens: 9_000, updatedAt: now - 50 },
    // 0 水位 = 没聊过：不上卡
    { key: "agent:kaiyang:feishu:group:oc_b", isGroup: true, estimatedPromptTokens: 0, updatedAt: now - 60 },
    // 刚接活、思考中（运行中无水位）：无条件上卡且置顶（Leo 2026-10-04 补的场景）
    { key: "agent:tianxuan:feishu:group:oc_b", isGroup: true, estimatedPromptTokens: null, hasActiveRun: true, updatedAt: now - 5 },
    // 脏数据
    { key: "", estimatedPromptTokens: 12_000 },
    null,
  ];
  const picked = selectUsageSessions(sessions, { limit: 10 });
  assert.deepEqual(picked.map((session) => session.key), [
    "agent:tianxuan:feishu:group:oc_b", // 运行中置顶
    "agent:tianshu:main",
    "agent:tianshu:feishu:group:oc_a",
  ]);
  // limit 截断先保运行中，再按水位取最满的
  const capped = selectUsageSessions(sessions, { limit: 1 });
  assert.deepEqual(capped.map((session) => session.key), ["agent:tianxuan:feishu:group:oc_b"]);
});

test("countIdleSessions/listIdleSessions: 空闲数与清单口径一致（cron 不算）", () => {
  const sessions = [
    { key: "agent:a:main", estimatedPromptTokens: 100 },
    { key: "agent:b:main", estimatedPromptTokens: null },
    { key: "agent:c:feishu:group:g", isGroup: true },
    { key: "agent:x:cron:1", estimatedPromptTokens: 50 },
  ];
  const shown = selectUsageSessions(sessions);
  assert.equal(countIdleSessions(sessions, shown), 2);
  assert.deepEqual(listIdleSessions(sessions, shown).map((session) => session.key), [
    "agent:b:main",
    "agent:c:feishu:group:g",
  ]);
  assert.equal(countIdleSessions(null, []), 0);
  assert.deepEqual(listIdleSessions(null, []), []);
});

test("usage sessions tolerate null/undefined input", () => {
  assert.deepEqual(selectUsageSessions(null), []);
  assert.deepEqual(selectUsageSessions(undefined), []);
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

test("failureClassOf: 真机话术分诊，词表外一律真失败（宁可错杀不漏报）", () => {
  // 真机 18791 采集的三类良性话术
  assert.equal(failureClassOf("heartbeat skipped: quiet-hours"), "skip");
  assert.equal(failureClassOf("agent run aborted for restart | OPENCLAW_RESTART_ABORT"), "abort");
  assert.equal(failureClassOf("Cancelled by operator"), "cancel");
  // 真失败与话术外新错误
  assert.equal(failureClassOf("Command failed (exit code 124)"), "real");
  assert.equal(failureClassOf("provider 502，未产出即回"), "real");
  assert.equal(failureClassOf("some new failure mode"), "real");
  assert.equal(failureClassOf(null), "real");
  assert.equal(failureClassOf(undefined), "real");
  assert.equal(failureClassOf(""), "real");
});

test("hopToneOf: 良性未跑走 skipped 档（灰显不染红），cancelled 也算", () => {
  const skip = hopToneOf({ status: "failed", taskId: "a", error: "heartbeat skipped: quiet-hours" }, "a");
  assert.equal(skip.tone, "skipped");
  assert.equal(skip.failed, false);
  assert.equal(skip.benign, true);
  const abort = hopToneOf({ status: "failed", taskId: "a", error: "OPENCLAW_RESTART_ABORT" }, "a");
  assert.equal(abort.tone, "skipped");
  const cancel = hopToneOf({ status: "cancelled", taskId: "a" }, "a");
  assert.equal(cancel.tone, "skipped");
  assert.equal(benignStateOf("heartbeat skipped: quiet-hours", "failed"), "静默跳过");
  assert.equal(benignStateOf("OPENCLAW_RESTART_ABORT", "failed"), "重启中止");
  assert.equal(benignStateOf(null, "cancelled"), "已取消");
  // 真失败不受影响
  const real = hopToneOf({ status: "failed", taskId: "a", error: "exit code 124" }, "a");
  assert.equal(real.tone, "failed");
  assert.equal(real.benign, false);
});

test("hopGlyphOf: 字形与 tone 一一对应（含 skipped ◌）", () => {
  assert.equal(hopGlyphOf("done"), "✓");
  assert.equal(hopGlyphOf("failed"), "✕");
  assert.equal(hopGlyphOf("skipped"), "◌");
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

test("toolProgressLabel/sessionErrorText: 工具名与常见报错的中文显示层", () => {
  assert.equal(toolProgressLabel("web_search"), "联网搜索");
  assert.equal(toolProgressLabel("exec"), "执行命令");
  assert.equal(toolProgressLabel("sessions_send"), "派发星位");
  assert.equal(toolProgressLabel("mystery_tool"), "mystery_tool");
  assert.equal(toolProgressLabel(null), "");
  assert.equal(
    sessionErrorText(
      "leo/gpt-6 request failed (provider internal error, HTTP 502). This is usually temporary — try again shortly.",
    ),
    "模型请求失败（provider 内部错误，HTTP 502）——通常是临时的，稍后重试",
  );
  assert.equal(sessionErrorText("LLM request timed out."), "模型请求超时");
  assert.equal(sessionErrorText("自定义错误原话"), "自定义错误原话");
  assert.equal(sessionErrorText(null), "");
});

test("toolProgressLabel/sessionErrorText: 关闭中文映射 = 回原文", () => {
  assert.equal(toolProgressLabel("exec", false), "exec");
  assert.equal(
    sessionErrorText("leo/gpt-6 request failed (provider internal error, HTTP 502).", false),
    "leo/gpt-6 request failed (provider internal error, HTTP 502).",
  );
});

test("groupSessionEpisodes: 台账全量按 gap 链分段，段按最近活动新→旧", () => {
  const min = 60_000;
  const now = 10_000_000_000;
  const at = (minAgo) => now - minAgo * min;
  const run = (id, sessionKey, startedMin, endedMin, status = "done") => ({
    id,
    sessionKey,
    status,
    startedAtMs: at(startedMin),
    endedAtMs: endedMin == null ? null : at(endedMin),
  });
  const runs = [
    // 同一群聊：3h 前一小轮（2 run）+ 刚才的一轮（3 run），中间沉默 2h 切段
    run(1, "agent:tianshu:feishu:group:oc_demo", 180, 176),
    run(2, "agent:tianxuan:feishu:group:oc_demo", 175, 171),
    run(3, "agent:tianshu:feishu:group:oc_demo", 40, 36),
    run(4, "agent:tianxuan:feishu:group:oc_demo", 35, 30),
    run(5, "agent:tianji:feishu:group:oc_demo", 30, 29, "failed"),
    // 另一个群聊的独立轮次（最近活动更新，应排最前）
    run(6, "agent:yuheng:feishu:group:oc_other", 25, 20),
  ];
  const episodes = groupSessionEpisodes(runs);
  assert.equal(episodes.length, 3);
  // 最近活动排序：oc_other 的轮次（20min）最靠前
  assert.equal(episodes[0].runs[0].id, 6);
  // 段内旧→新：刚收尾的一段是 3→4→5
  assert.deepEqual(episodes[1].runs.map((r) => r.id), [3, 4, 5]);
  assert.deepEqual(episodes[2].runs.map((r) => r.id), [1, 2]);
  // 段时间戳：开始 = 首跳开始，最近活动 = 末跳结束
  assert.equal(episodes[1].startedAtMs, at(40));
  assert.equal(episodes[1].lastActivityMs, at(29));
});

test("groupSessionEpisodes: 沉默上限跟随设置放宽/收紧", () => {
  const min = 60_000;
  const runs = [
    { id: 1, sessionKey: "agent:a:feishu:group:g", status: "done", startedAtMs: 120 * min, endedAtMs: 118 * min },
    { id: 2, sessionKey: "agent:b:feishu:group:g", status: "done", startedAtMs: 80 * min, endedAtMs: 75 * min },
  ];
  // 1h 上限：40 分钟沉默串成一段
  assert.equal(groupSessionEpisodes(runs).length, 1);
  // 20 分钟上限：切段
  assert.equal(groupSessionEpisodes(runs, 20 * min).length, 2);
  assert.equal(groupSessionEpisodes([]).length, 0);
  assert.equal(groupSessionEpisodes(null).length, 0);
});

test("isSubagentTask/cleanTaskTitle: 子 agent 任务识别与标题清理（真机 18791 形态）", () => {
  // 真机样例：tasks.list 里 kind=cli 的行，sessionKey/childSessionKey 落在
  // agent:天枢:subagent:<uuid>，标题 = spawn 上下文原文
  const sub = {
    kind: "cli",
    sessionKey: "agent:tianshu:subagent:59af0ac6-c53f-4baa-89ec-6095706bff34",
    childSessionKey: "agent:tianshu:subagent:59af0ac6-c53f-4baa-89ec-6095706bff34",
    title: "[Subagent Context] You are operating as a subagent of tianshu.",
  };
  assert.equal(isSubagentTask(sub), true);
  assert.equal(isSubagentTask({ sessionKey: "agent:tianshu:main" }), false);
  assert.equal(isSubagentTask({ sessionKey: "agent:tianshu:feishu:group:oc_x" }), false);
  assert.equal(isSubagentTask(null), false);
  assert.equal(
    cleanTaskTitle(sub),
    "You are operating as a subagent of tianshu.",
  );
  assert.equal(cleanTaskTitle({ title: "北斗巡检-OpenAI安全黑洞任务" }), "北斗巡检-OpenAI安全黑洞任务");
  assert.equal(cleanTaskTitle({ title: "" }), "");
  assert.equal(cleanTaskTitle(null), "");
});

test("sessionRunHop: 透传收工结论 terminalSummary（成果速览六案①）", () => {
  const hop = sessionRunHop({
    id: 9,
    status: "done",
    agentId: "tianshu",
    title: "巡检",
    terminalSummary: "巡检完成：发现 1 处卡点，已补发续跑卡。",
  });
  assert.equal(hop.terminalSummary, "巡检完成：发现 1 处卡点，已补发续跑卡。");
  assert.equal(sessionRunHop({ id: 1, status: "done" }).terminalSummary, null);
  assert.equal(sessionRunHop({}).terminalSummary, null);
});

test("cronScheduleText: 北斗常用族人话，其余透传", () => {
  assert.equal(cronScheduleText("0 14 * * *"), "每天 14:00");
  assert.equal(cronScheduleText("0 3 * * *"), "每天 03:00");
  assert.equal(cronScheduleText("*/30 * * * *"), "每 30 分钟");
  assert.equal(cronScheduleText("0 */6 * * *"), "每 6 小时");
  assert.equal(cronScheduleText("0 9 * * 1-5"), "工作日 09:00");
  assert.equal(cronScheduleText("15 8 1 * *"), "15 8 1 * *");
  assert.equal(cronScheduleText(""), "");
  assert.equal(cronScheduleText(null), "");
});

test("cronNextRunMs: 每天/工作日与每 N 分钟两族，其余 null", () => {
  const now = new Date("2026-10-04T15:00:00").getTime(); // 周六
  // 每天 14:00 已过 → 明天 14:00
  const nextDaily = cronNextRunMs("0 14 * * *", now);
  assert.equal(new Date(nextDaily).getDate(), 5);
  assert.equal(new Date(nextDaily).getHours(), 14);
  // 每 30 分钟 → 对齐到下个半点/整点
  const nextStep = cronNextRunMs("*/30 * * * *", now);
  assert.equal((nextStep - now) > 0 && (nextStep - now) <= 30 * 60_000, true);
  assert.equal(nextStep % (30 * 60_000), 0);
  // 工作日 09:00，周六 15:00 → 周一 09:00
  const nextWorkday = cronNextRunMs("0 9 * * 1-5", now);
  assert.equal(new Date(nextWorkday).getDay(), 1);
  assert.equal(new Date(nextWorkday).getHours(), 9);
  // 月度等不猜
  assert.equal(cronNextRunMs("15 8 1 * *", now), null);
  assert.equal(cronNextRunMs(null, now), null);
});

test("activeRelayEpisodes: 同群聊只留最新 run，展开完整轮次", () => {
  const now = 10_000_000_000;
  const min = 60_000;
  const runs = [
    { id: 1, sessionKey: "agent:tianshu:feishu:group:oc_r", agentId: "tianshu", status: "done", startedAtMs: now - 26 * min, endedAtMs: now - 24 * min },
    { id: 2, sessionKey: "agent:tianxuan:feishu:group:oc_r", agentId: "tianxuan", status: "done", startedAtMs: now - 24 * min, endedAtMs: now - 18 * min },
    { id: 3, sessionKey: "agent:tianji:feishu:group:oc_r", agentId: "tianji", status: "running", startedAtMs: now - 3 * min },
    // 另一群聊的活跃 run：独立成条
    { id: 4, sessionKey: "agent:yuheng:feishu:group:oc_other", agentId: "yuheng", status: "running", startedAtMs: now - 2 * min },
    // 已结束的 run 不是"活跃"
    { id: 5, sessionKey: "agent:kaiyang:feishu:group:oc_done", agentId: "kaiyang", status: "done", startedAtMs: now - min, endedAtMs: now - 30_000 },
  ];
  const activeRuns = runs.filter((run) => run.status === "running");
  const episodes = activeRelayEpisodes(runs, activeRuns);
  // oc_r 展开为 3 跳（1→2→3）；oc_other 单 run 不成链，不进全景
  assert.equal(episodes.length, 1);
  const relay = episodes[0];
  assert.equal(relay.chatId, "group:oc_r");
  assert.equal(relay.hops.length, 3);
  assert.equal(relay.hops[0].agentId, "tianshu");
  assert.equal(relay.hops[2].agentId, "tianji");
});

test("isQuietNow: 跨午夜免打扰与开关", () => {
  const at = (h, m) => new Date(2026, 9, 4, h, m);
  assert.equal(isQuietNow(true, "23:00", "08:00", at(23, 30)), true);
  assert.equal(isQuietNow(true, "23:00", "08:00", at(2, 0)), true);
  assert.equal(isQuietNow(true, "23:00", "08:00", at(12, 0)), false);
  assert.equal(isQuietNow(true, "23:00", "08:00", at(23, 0)), true);
  assert.equal(isQuietNow(true, "23:00", "08:00", at(8, 0)), false); // 端点右开
  assert.equal(isQuietNow(false, "23:00", "08:00", at(23, 30)), false); // 开关关=不静默
  assert.equal(isQuietNow(true, "12:00", "14:00", at(13, 0)), true); // 非跨午夜
  assert.equal(isQuietNow(true, "abc", "08:00", at(23, 30)), false); // 非法时间
});

test("detectRoundNotifications: 真失败响、良性哑、开机不回放历史", () => {
  const now = 10_000_000_000;
  const min = 60_000;
  const run = (over) => ({ agentId: "tianji", sessionKey: "agent:tianji:feishu:group:oc_r", ...over });
  const runs = [
    run({ id: 1, status: "done", title: "拆解", startedAtMs: now - 10 * min, endedAtMs: now - 9 * min }),
    // 真失败，新鲜 → 响
    run({ id: 2, status: "failed", title: "创作", error: "provider 502，未产出即回", startedAtMs: now - 6 * min, endedAtMs: now - 2 * min }),
    // 良性跳过 → 永远哑
    run({ id: 3, sessionKey: "agent:yuheng:cron:c1", agentId: "yuheng", status: "failed", title: "heartbeat", error: "heartbeat skipped: quiet-hours", startedAtMs: now - 3 * min, endedAtMs: now - 3 * min }),
    // 旧失败（超出新鲜窗）→ 不回放
    run({ id: 4, status: "failed", title: "旧账", error: "provider 502", startedAtMs: now - 60 * min, endedAtMs: now - 55 * min }),
  ];
  const config = { episodeGapMin: 60, freshnessMs: 15 * min, quietOn: false };
  const { toasts, next } = detectRoundNotifications(runs, {}, config, now);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, "fail");
  assert.ok(toasts[0].body.includes("创作"));
  // 第二拍：同一批 runs 再来 → 不重复响（failedSeen 已记）
  const second = detectRoundNotifications(runs, next, config, now + 3000);
  assert.equal(second.toasts.length, 0);
});

test("detectRoundNotifications: 跨轮失败合并成一张聚合卡", () => {
  const now = 10_000_000_000;
  const min = 60_000;
  const runs = [
    { id: 1, agentId: "tianxuan", sessionKey: "agent:tianxuan:feishu:group:oc_a", status: "failed", title: "研究", error: "provider 502", startedAtMs: now - 4 * min, endedAtMs: now - 2 * min },
    { id: 2, agentId: "tianji", sessionKey: "agent:tianji:feishu:group:oc_b", status: "failed", title: "创作", error: "LLM request timed out.", startedAtMs: now - 3 * min, endedAtMs: now - min },
  ];
  const { toasts } = detectRoundNotifications(runs, {}, { episodeGapMin: 60, freshnessMs: 15 * min }, now);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, "merge");
  assert.ok(toasts[0].body.includes("2 个轮次"));
});

test("detectRoundNotifications: 完成提醒只响一次，补发中的轮不提前响", () => {
  const now = 10_000_000_000;
  const min = 60_000;
  const key = "agent:tianji:feishu:group:oc_r";
  const done = { id: 2, agentId: "tianji", sessionKey: key, status: "done", title: "创作收工", startedAtMs: now - 5 * min, endedAtMs: now - 30_000 };
  // 上一拍：这轮还在跑（天枢 done + 天玑 running）
  const prevRuns = [
    { id: 1, agentId: "tianshu", sessionKey: key, status: "done", title: "拆解", startedAtMs: now - 10 * min, endedAtMs: now - 6 * min },
    { id: 2, agentId: "tianji", sessionKey: key, status: "running", title: "创作", startedAtMs: now - 5 * min },
  ];
  const config = { episodeGapMin: 60, freshnessMs: 15 * min };
  const first = detectRoundNotifications(prevRuns, {}, config, now - min);
  assert.equal(first.toasts.length, 0); // 还在跑，不响
  // 本拍：天玑收行 done → 完成提醒一次
  const second = detectRoundNotifications([...prevRuns.slice(0, 1), done], first.next, config, now);
  assert.equal(second.toasts.length, 1);
  assert.equal(second.toasts[0].kind, "ok");
  // 第三拍：同快照再来 → 不重复
  const third = detectRoundNotifications([done], second.next, config, now + min);
  assert.equal(third.toasts.length, 0);
});

test("detectRoundNotifications: 免打扰时段整批丢弃", () => {
  const now = new Date(2026, 9, 4, 23, 30).getTime();
  const min = 60_000;
  const runs = [
    { id: 1, agentId: "tianji", sessionKey: "agent:tianji:feishu:group:oc_r", status: "failed", title: "创作", error: "provider 502", startedAtMs: now - 2 * min, endedAtMs: now - min },
  ];
  const { toasts, next } = detectRoundNotifications(runs, {}, { episodeGapMin: 60, quietOn: true, quietStart: "23:00", quietEnd: "08:00" }, now);
  assert.equal(toasts.length, 0);
  // 免打扰里丢掉的失败，failedSeen 已记 → 时段过后也不回放（静默=不发）
  const later = detectRoundNotifications(runs, next, { episodeGapMin: 60 }, now + 3_600_000);
  assert.equal(later.toasts.length, 0);
});
