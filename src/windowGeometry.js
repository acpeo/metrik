function normalizedScale(value) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/// 只有稳定的悬浮形态才能参与位置记忆与边缘挂靠。竖条详情会临时移动、
/// 放大同一个原生窗口；那段几何不能被当成用户摆放结果。
function isStableFloatingMode(mode, transient = false) {
  if (transient) return false;
  return mode === "compact" || mode === "strip" || mode === "strip-horizontal" || mode === "strip-vertical";
}

/// 原生窗口移动事件是物理坐标。挂靠窗口只要离开当前锚点，就说明用户正在
/// 把它拖往别处；旧挂靠轮询必须立即失效，不能在拖动途中按旧边缘把窗口拉回。
function isDockAnchorPosition(position, anchor, tolerance = 2) {
  if (
    !position
    || !anchor
    || !Number.isFinite(position.x)
    || !Number.isFinite(position.y)
    || !Number.isFinite(anchor.x)
    || !Number.isFinite(anchor.y)
  ) {
    return false;
  }
  return (
    Math.abs(position.x - anchor.x) <= tolerance
    && Math.abs(position.y - anchor.y) <= tolerance
  );
}

/// 挂靠收起后窗口的停泊位：只留 peekPx（物理像素，按显示器缩放折算）一条
/// 细边在屏幕内，其余滑出工作区。
function edgeDockHiddenPosition(dock, peekPx = 6) {
  if (!dock?.edge) return null;
  const visible = Math.round(peekPx * (dock.scale || 1));
  switch (dock.edge) {
    case "bottom": return { x: dock.x, y: dock.bottom - visible };
    case "left": return { x: dock.left - dock.width + visible, y: dock.y };
    case "right": return { x: dock.right - visible, y: dock.y };
    default: return { x: dock.x, y: dock.top - dock.height + visible };
  }
}

/// 挂靠锚点自校验：窗口仍停在记录的几何上（显形用挂靠原位、收起用停泊位）
/// 且尺寸未变，才算"仍在锚点上"。展开/折叠面板这类程序化改尺寸、外力位移
/// 都会让锚点过期，调用方按"用户拖动"同一语义释放并重估。
function isDockGeometryCurrent(position, size, dock, hidden = false) {
  if (!position || !size || !dock) return false;
  const anchor = hidden ? edgeDockHiddenPosition(dock) : { x: dock.x, y: dock.y };
  if (!isDockAnchorPosition(position, anchor)) return false;
  return size.width === dock.width && size.height === dock.height;
}

function monitorArea(monitor) {
  if (!monitor?.position || !monitor?.size) return null;
  return {
    x: monitor.workArea?.position?.x ?? monitor.position.x,
    y: monitor.workArea?.position?.y ?? monitor.position.y,
    width: monitor.workArea?.size?.width ?? monitor.size.width,
    height: monitor.workArea?.size?.height ?? monitor.size.height,
  };
}

function overlapArea(rect, area) {
  const overlapX =
    Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const overlapY =
    Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  return Math.max(0, overlapX) * Math.max(0, overlapY);
}

/// 把 CSS 设计尺寸按应用缩放与目标显示器 DPI 换成整数物理像素。
function physicalWindowSize(width, height, contentScale = 1, monitorScale = 1) {
  const scale = normalizedScale(contentScale) * normalizedScale(monitorScale);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

function floatingViewportSize(width, height, contentScale, monitorScale, workArea) {
  const scale = normalizedScale(contentScale) * normalizedScale(monitorScale);
  return {
    width: workArea?.width > 0 ? Math.min(width, Math.floor(workArea.width / scale)) : width,
    height: workArea?.height > 0 ? Math.min(height, Math.floor(workArea.height / scale)) : height,
  };
}

/// WebView2 偶尔在混合 DPI 环境保留一层额外 zoom，导致原生窗口物理尺寸正确，
/// 但 CSS 视口仍偏小。以当前“物理像素 / CSS 视口”的实测比例反算目标尺寸，
/// 不再假设系统 DPI 与 setZoom 就是完整缩放链。
function viewportCorrectedPhysicalSize({
  currentPhysicalWidth,
  currentPhysicalHeight,
  viewportWidth,
  viewportHeight,
  expectedWidth,
  expectedHeight,
}) {
  const values = [
    currentPhysicalWidth,
    currentPhysicalHeight,
    viewportWidth,
    viewportHeight,
    expectedWidth,
    expectedHeight,
  ];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return null;

  const widthRatio = expectedWidth / viewportWidth;
  const heightRatio = expectedHeight / viewportHeight;
  // 防止隐藏/切形态的瞬时 0 尺寸把窗口放大到不可恢复；正常 DPI/zoom
  // 残差都落在 0.5–2 之间（应用自身允许的缩放范围也是 0.75–2）。
  if (
    widthRatio < 0.5 ||
    widthRatio > 2 ||
    heightRatio < 0.5 ||
    heightRatio > 2
  ) {
    return null;
  }
  return {
    width: Math.max(1, Math.round(currentPhysicalWidth * widthRatio)),
    height: Math.max(1, Math.round(currentPhysicalHeight * heightRatio)),
  };
}

function horizontalStripTargetWidth({
  cellCount,
  cellWidth,
  controlsWidth,
  paddingLeft,
  paddingRight,
  gap,
  roundingAllowance = 1,
}) {
  const cells = Math.max(1, Math.round(cellCount || 0));
  return (
    cells * cellWidth +
    controlsWidth +
    paddingLeft +
    paddingRight +
    cells * gap +
    roundingAllowance
  );
}

/// 宽度失配自愈的重试间隔（ms）。attempt 是本轮失配内已做过的自愈次数：
/// 首次立即，其后 250/600/1200ms 快速追试，4 次后回到固定 2s 的旧节奏。
/// WebView2 的合成/zoom 迁就经常晚于 setSize 返回，一次事务后视口仍可能
/// 差上几个像素；可见的失配（右列被裁、滚动条）不能让观众等满一个 2s
/// 节流周期，也不能退化成每 120ms 一次的无限重断言，所以按轮次升级。
function desyncHealRetryDelayMs(attempt) {
  const normalized = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  if (normalized === 0) return 0;
  if (normalized === 1) return 250;
  if (normalized === 2) return 600;
  if (normalized === 3) return 1200;
  return 2000;
}

/// 竖向胶囊的悬停卡片需要临时放大透明窗口。窗口扩展方向取胶囊所在的
/// 半屏，原胶囊的屏幕坐标保持不动；纵向只移动到足够容纳卡片的位置。
function verticalStripHoverLocalLayout({ targetHeight, anchorY, cardHeight, margin = 8, pointerMargin = 22 }) {
  if ([targetHeight, anchorY, cardHeight, margin, pointerMargin].some((value) => !Number.isFinite(value))) {
    return null;
  }
  const halfCard = cardHeight / 2;
  const cardCenter = Math.min(
    Math.max(anchorY, halfCard + margin),
    Math.max(targetHeight - halfCard - margin, halfCard + margin),
  );
  const pointerY = Math.min(
    Math.max(anchorY - cardCenter + halfCard, pointerMargin),
    Math.max(cardHeight - pointerMargin, pointerMargin),
  );
  return { cardCenter, pointerY };
}

function verticalStripHoverLayout({ railPosition, railSize, workArea, targetSize, anchorY, cardHeight, margin = 8 }) {
  const values = [
    railPosition?.x,
    railPosition?.y,
    railSize?.width,
    railSize?.height,
    workArea?.x,
    workArea?.y,
    workArea?.width,
    workArea?.height,
    targetSize?.width,
    targetSize?.height,
    anchorY,
    cardHeight,
  ];
  if (values.some((value) => !Number.isFinite(value))) return null;

  const workRight = workArea.x + workArea.width;
  const workBottom = workArea.y + workArea.height;
  // 卡片固定朝胶卷左侧弹（Leo 2026-10-03 拍板，替代"朝屏幕中心"）：左侧放得下
  // 整卡才朝左（side=right，窗口朝左扩、胶卷钉右缘不动）；胶囊贴左缘放不下时
  // 退回朝右兜底（side=left），卡片不被屏幕边裁掉。
  const side = railPosition.x + railSize.width - targetSize.width - margin >= workArea.x
    ? "right"
    : "left";
  const local = verticalStripHoverLocalLayout({
    targetHeight: targetSize.height,
    anchorY,
    cardHeight,
    margin,
  });
  if (!local) return null;
  const { cardCenter } = local;
  const desiredX = side === "left"
    ? railPosition.x
    : railPosition.x + railSize.width - targetSize.width;
  const desiredY = railPosition.y - (cardCenter - anchorY);
  const x = Math.min(Math.max(desiredX, workArea.x), Math.max(workRight - targetSize.width, workArea.x));
  // 窗口不仅要留在工作区，也必须完整包住原胶囊。只按卡片锚点移动时，
  // 悬停下方条目会让 railOffsetY 变成负数，把胶囊上半段推出透明窗口。
  const railBottom = railPosition.y + railSize.height;
  const minY = Math.max(workArea.y, railBottom - targetSize.height);
  const maxY = Math.min(workBottom - targetSize.height, railPosition.y);
  const y = Math.min(Math.max(desiredY, minY), Math.max(maxY, minY));

  return {
    side,
    x,
    y,
    cardCenter,
    railOffsetY: railPosition.y - y,
  };
}

/// 横条悬停详情卡几何：窗口向上长高放卡（上方放不下改向下），x 一律不动——
/// 卡片与条同宽通栏，横向挪窗会把贴屏幕边缘的条搬离光标（条不动、卡出现）。
/// 输入输出均为物理像素。返回 null = 上下都放不下（调用方不扩窗不出卡）。
/// cardTop 的 above 分支恒等于 anchorTop：窗口上移 growHeight 后，内容在新
/// 视口里整体下移 growHeight，格子新 y 恰好回到原值。
function horizontalTasksHoverLayout({
  stripPosition,
  stripSize,
  workArea,
  growHeight,
  anchorTop,
  anchorBottom,
  gap,
}) {
  const values = [
    stripPosition?.x,
    stripPosition?.y,
    stripSize?.width,
    stripSize?.height,
    workArea?.x,
    workArea?.y,
    workArea?.width,
    workArea?.height,
    growHeight,
    anchorTop,
    anchorBottom,
    gap,
  ];
  if (values.some((value) => !Number.isFinite(value))) return null;

  const workBottom = workArea.y + workArea.height;
  const aboveY = stripPosition.y - growHeight;
  const cardAbove = aboveY >= workArea.y;
  if (!cardAbove && stripPosition.y + stripSize.height + growHeight > workBottom) return null;
  const y = cardAbove ? aboveY : stripPosition.y;
  const cardTop = cardAbove ? anchorTop : anchorBottom + gap;
  return { side: cardAbove ? "above" : "below", y, cardTop, cardLeft: 0 };
}

/// 记忆坐标是物理像素；用每台显示器自己的 DPI 推导候选窗口大小，再选与工作区
/// 重叠最多的显示器。不能先读当前窗口 DPI——窗口随后可能恢复到另一台屏幕。
function monitorForWindowPosition(
  monitors,
  position,
  logicalSize,
  contentScale = 1,
) {
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !logicalSize ||
    !Number.isFinite(logicalSize.width) ||
    !Number.isFinite(logicalSize.height)
  ) {
    return null;
  }

  let best = null;
  let bestOverlap = 0;
  (monitors || []).forEach((monitor) => {
    const area = monitorArea(monitor);
    if (!area) return;
    const physical = physicalWindowSize(
      logicalSize.width,
      logicalSize.height,
      contentScale,
      monitor.scaleFactor,
    );
    const overlap = overlapArea(
      { x: position.x, y: position.y, ...physical },
      area,
    );
    if (overlap > bestOverlap) {
      best = monitor;
      bestOverlap = overlap;
    }
  });
  return best;
}

export {
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
};
