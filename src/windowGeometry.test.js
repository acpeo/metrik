import assert from "node:assert/strict";
import test from "node:test";

import {
  desyncHealRetryDelayMs,
  edgeDockHiddenPosition,
  floatingViewportSize,
  horizontalStripTargetWidth,
  horizontalTasksHoverLayout,
  isDockAnchorPosition,
  isDockGeometryCurrent,
  isStableFloatingMode,
  monitorForWindowPosition,
  physicalWindowSize,
  verticalStripHoverLocalLayout,
  verticalStripHoverLayout,
  viewportCorrectedPhysicalSize,
} from "./windowGeometry.js";

test("floating content fits the physical work area at combined app and monitor scale", () => {
  assert.deepEqual(floatingViewportSize(42, 900, 2, 1.5, { width: 1920, height: 1040 }), {
    width: 42, height: 346,
  });
  assert.deepEqual(floatingViewportSize(1200, 28, 1.25, 1.5, { width: 1366, height: 728 }), {
    width: 728, height: 28,
  });
  assert.deepEqual(floatingViewportSize(320, 900, 1, 1, null), { width: 320, height: 900 });
});

test("moving a docked window away from its anchor is treated as a user drag", () => {
  const anchor = { x: 1878, y: 300 };
  assert.equal(isDockAnchorPosition({ x: 1878, y: 300 }, anchor), true);
  assert.equal(isDockAnchorPosition({ x: 1880, y: 299 }, anchor), true);
  assert.equal(isDockAnchorPosition({ x: 1600, y: 300 }, anchor), false);
});

test("transient strip geometry never participates in persistent floating state", () => {
  assert.equal(isStableFloatingMode("compact"), true);
  assert.equal(isStableFloatingMode("strip-vertical"), true);
  assert.equal(isStableFloatingMode("strip-vertical", true), false);
  assert.equal(isStableFloatingMode("expanded"), false);
});

test("docked window parks with only a thin sliver inside the work area", () => {
  const scale = 1.25;
  const peek = Math.round(6 * scale);
  const rightDock = { edge: "right", x: 1500, y: 100, width: 400, height: 500, left: 0, top: 0, right: 1920, bottom: 1080, scale };
  assert.deepEqual(edgeDockHiddenPosition(rightDock), { x: 1920 - peek, y: 100 });
  const leftDock = { edge: "left", x: 0, y: 100, width: 400, height: 500, left: 0, top: 0, right: 1920, bottom: 1080, scale };
  assert.deepEqual(edgeDockHiddenPosition(leftDock), { x: 0 - 400 + peek, y: 100 });
  const topDock = { edge: "top", x: 100, y: 0, width: 400, height: 500, left: 0, top: 0, right: 1920, bottom: 1080, scale };
  assert.deepEqual(edgeDockHiddenPosition(topDock), { x: 100, y: 0 - 500 + peek });
  const bottomDock = { edge: "bottom", x: 100, y: 580, width: 400, height: 500, left: 0, top: 0, right: 1920, bottom: 1080, scale };
  assert.deepEqual(edgeDockHiddenPosition(bottomDock), { x: 100, y: 1080 - peek });
  assert.equal(edgeDockHiddenPosition(null), null);
});

test("dock geometry check fails when the window moved or was resized off its anchor", () => {
  const scale = 1;
  const dock = { edge: "right", x: 1600, y: 100, width: 320, height: 384, left: 0, top: 0, right: 1920, bottom: 1080, scale };
  // 显形停在与锚点一致的位置、尺寸没变 → 仍在锚点上。
  assert.equal(isDockGeometryCurrent({ x: 1600, y: 100 }, { width: 320, height: 384 }, dock), true);
  // 折叠面板改了尺寸（顶左不动）→ 锚点过期，挂靠要释放重估。
  assert.equal(isDockGeometryCurrent({ x: 1600, y: 100 }, { width: 42, height: 224 }, dock), false);
  // 外力位移（拖动中）→ 锚点过期。
  assert.equal(isDockGeometryCurrent({ x: 1500, y: 100 }, { width: 320, height: 384 }, dock), false);
  // 收起态用停泊位对账，不能拿显形锚点误判。
  const parked = edgeDockHiddenPosition(dock);
  assert.equal(isDockGeometryCurrent(parked, { width: 320, height: 384 }, dock, true), true);
  assert.equal(isDockGeometryCurrent({ x: 1600, y: 100 }, { width: 320, height: 384 }, dock, true), false);
  assert.equal(isDockGeometryCurrent(null, { width: 320, height: 384 }, dock), false);
});

function monitor(x, width, scaleFactor, workHeight = 1080) {
  return {
    position: { x, y: 0 },
    size: { width, height: workHeight },
    workArea: {
      position: { x, y: 0 },
      size: { width, height: workHeight - 40 },
    },
    scaleFactor,
  };
}

test("physical size combines app scale with destination monitor DPI", () => {
  assert.deepEqual(physicalWindowSize(320, 440, 1.25, 1.5), {
    width: 600,
    height: 825,
  });
  assert.deepEqual(physicalWindowSize(52, 272, 1, 1.75), {
    width: 91,
    height: 476,
  });
});

test("remembered position selects the destination monitor instead of the current one", () => {
  const primary = monitor(0, 1920, 1.25);
  const secondary = monitor(1920, 3840, 2);
  const selected = monitorForWindowPosition(
    [primary, secondary],
    { x: 2400, y: 120 },
    { width: 320, height: 440 },
    1,
  );
  assert.equal(selected, secondary);
  assert.deepEqual(physicalWindowSize(52, 272, 1, selected.scaleFactor), {
    width: 104,
    height: 544,
  });
});

test("overlap chooses the monitor that will contain most of the restored window", () => {
  const left = monitor(-1920, 1920, 1.5);
  const right = monitor(0, 1920, 2);
  const selected = monitorForWindowPosition(
    [left, right],
    { x: -120, y: 80 },
    { width: 320, height: 320 },
    1,
  );
  assert.equal(selected, right);
});

test("fully off-screen remembered positions do not select a monitor", () => {
  const selected = monitorForWindowPosition(
    [monitor(0, 1920, 1.5)],
    { x: 9000, y: 9000 },
    { width: 320, height: 440 },
    1,
  );
  assert.equal(selected, null);
});

test("horizontal strip width includes every outer flex gap", () => {
  assert.equal(
    horizontalStripTargetWidth({
      cellCount: 2,
      cellWidth: 68,
      controlsWidth: 146,
      paddingLeft: 6,
      paddingRight: 5,
      gap: 4,
    }),
    302,
  );
  assert.equal(
    horizontalStripTargetWidth({
      cellCount: 0,
      cellWidth: 68,
      controlsWidth: 146,
      paddingLeft: 6,
      paddingRight: 5,
      gap: 4,
    }),
    230,
  );
});

test("vertical strip hover expands away from the nearest screen edge", () => {
  assert.deepEqual(
    verticalStripHoverLayout({
      railPosition: { x: 1878, y: 300 },
      railSize: { width: 42, height: 260 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      targetSize: { width: 392, height: 320 },
      anchorY: 69,
      cardHeight: 280,
    }),
    { side: "right", x: 1528, y: 240, cardCenter: 148, railOffsetY: 60 },
  );
});

test("vertical strip hover keeps the whole rail visible for a lower cell", () => {
  const layout = verticalStripHoverLayout({
    railPosition: { x: 1878, y: 300 },
    railSize: { width: 42, height: 360 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    targetSize: { width: 312, height: 360 },
    anchorY: 299,
    cardHeight: 180,
  });

  assert.deepEqual(layout, {
    side: "right",
    x: 1608,
    y: 300,
    cardCenter: 262,
    railOffsetY: 0,
  });
  assert.ok(layout.railOffsetY >= 0);
  assert.ok(layout.railOffsetY + 360 <= 360);
});

test("vertical strip hover keeps the rail bottom visible for the first cell", () => {
  const layout = verticalStripHoverLayout({
    railPosition: { x: 2464, y: 357 },
    railSize: { width: 54, height: 314 },
    workArea: { x: 0, y: 0, width: 2560, height: 1400 },
    targetSize: { width: 510, height: 314 },
    anchorY: 23,
    cardHeight: 270,
  });

  assert.deepEqual(layout, {
    side: "right",
    x: 2008,
    y: 357,
    cardCenter: 143,
    railOffsetY: 0,
  });
});

test("vertical strip hover stays inside the work area near the top-left", () => {
  assert.deepEqual(
    verticalStripHoverLayout({
      railPosition: { x: 0, y: 0 },
      railSize: { width: 42, height: 90 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      targetSize: { width: 392, height: 300 },
      anchorY: 23,
      cardHeight: 270,
    }),
    { side: "left", x: 0, y: 0, cardCenter: 143, railOffsetY: 0 },
  );
});

test("vertical strip hover pops the card to the rail's left when there is room", () => {
  assert.deepEqual(
    verticalStripHoverLayout({
      railPosition: { x: 400, y: 300 },
      railSize: { width: 42, height: 260 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      targetSize: { width: 392, height: 320 },
      anchorY: 69,
      cardHeight: 280,
    }),
    { side: "right", x: 50, y: 240, cardCenter: 148, railOffsetY: 60 },
  );
});

test("vertical strip hover falls back to the rail's right side near the left edge", () => {
  assert.deepEqual(
    verticalStripHoverLayout({
      railPosition: { x: 120, y: 300 },
      railSize: { width: 42, height: 260 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      targetSize: { width: 392, height: 320 },
      anchorY: 69,
      cardHeight: 280,
    }),
    { side: "left", x: 120, y: 240, cardCenter: 148, railOffsetY: 60 },
  );
});

test("Wayland-local strip hover clamps the card and pointer without global coordinates", () => {
  assert.deepEqual(
    verticalStripHoverLocalLayout({
      targetHeight: 300,
      anchorY: 23,
      cardHeight: 270,
    }),
    { cardCenter: 143, pointerY: 22 },
  );
  assert.deepEqual(
    verticalStripHoverLocalLayout({
      targetHeight: 300,
      anchorY: 277,
      cardHeight: 270,
    }),
    { cardCenter: 157, pointerY: 248 },
  );
});

test("runtime viewport corrects a hidden WebView zoom layer", () => {
  assert.deepEqual(
    viewportCorrectedPhysicalSize({
      currentPhysicalWidth: 560,
      currentPhysicalHeight: 560,
      viewportWidth: 256,
      viewportHeight: 256,
      expectedWidth: 320,
      expectedHeight: 320,
    }),
    { width: 700, height: 700 },
  );
});

test("runtime viewport correction rejects transient invalid measurements", () => {
  assert.equal(
    viewportCorrectedPhysicalSize({
      currentPhysicalWidth: 560,
      currentPhysicalHeight: 560,
      viewportWidth: 0,
      viewportHeight: 0,
      expectedWidth: 320,
      expectedHeight: 320,
    }),
    null,
  );
});

test("desync heal retries escalate fast then settle at the 2s cadence", () => {
  assert.equal(desyncHealRetryDelayMs(0), 0);
  assert.equal(desyncHealRetryDelayMs(1), 250);
  assert.equal(desyncHealRetryDelayMs(2), 600);
  assert.equal(desyncHealRetryDelayMs(3), 1200);
  assert.equal(desyncHealRetryDelayMs(4), 2000);
  assert.equal(desyncHealRetryDelayMs(9), 2000);
});

test("desync heal retry cadence tolerates invalid attempt counters", () => {
  assert.equal(desyncHealRetryDelayMs(undefined), 0);
  assert.equal(desyncHealRetryDelayMs(Number.NaN), 0);
  assert.equal(desyncHealRetryDelayMs(-3), 0);
  assert.equal(desyncHealRetryDelayMs(2.8), 600);
});

test("horizontal strip hover grows upward and keeps the card gap above the cell", () => {
  // 条 224×36 @ (100,500)，长高 6+168=174：上方放得下 → 向上长，x 不动，
  // 卡片与条同宽通栏（cardLeft=0），above 分支的 cardTop 恒等于 anchorTop
  assert.deepEqual(
    horizontalTasksHoverLayout({
      stripPosition: { x: 100, y: 500 },
      stripSize: { width: 224, height: 36 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      growHeight: 174,
      anchorTop: 500,
      anchorBottom: 536,
      gap: 6,
    }),
    { side: "above", y: 326, cardTop: 500, cardLeft: 0 },
  );
});

test("horizontal strip hover falls back to below when the top has no room", () => {
  // 条贴着工作区顶（y=0）：向上放不下 → 向下长，卡贴格子下缘 + 间距
  assert.deepEqual(
    horizontalTasksHoverLayout({
      stripPosition: { x: 100, y: 0 },
      stripSize: { width: 224, height: 36 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      growHeight: 174,
      anchorTop: 0,
      anchorBottom: 36,
      gap: 6,
    }),
    { side: "below", y: 0, cardTop: 42, cardLeft: 0 },
  );
});

test("horizontal strip hover returns null when neither side fits", () => {
  // 工作区高 120，条在 y=60：向上差 114、向下差 90 → 不扩窗不出卡
  assert.equal(
    horizontalTasksHoverLayout({
      stripPosition: { x: 100, y: 60 },
      stripSize: { width: 224, height: 36 },
      workArea: { x: 0, y: 0, width: 1920, height: 120 },
      growHeight: 174,
      anchorTop: 60,
      anchorBottom: 96,
      gap: 6,
    }),
    null,
  );
});
