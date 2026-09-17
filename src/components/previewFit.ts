/**
 * 预览成品的显示尺寸。
 *
 * 为什么不让 CSS 自己缩（这是踩过的坑）：
 *
 * 画布是**替换元素**，`max-height: 100%` 只在包含块高度**确定**时才生效。
 * 而包着它的那个盒子高度是按内容撑开的（auto），于是这条百分比上限实际被
 * 当作 `none` —— 画布保持自己的渲染尺寸（短边 1200，成品约 1450 × 1180 CSS 像素）
 * 不收缩。再往上，`flex-1` 的预览区带默认的 `min-height: auto`，会被这个超大内容
 * 顶着一起长高，整列于是溢出 `h-screen overflow-hidden` 的根容器：底部状态条被
 * 推出可视区，用户看到的是"整个画面下边看不到"。
 *
 * 与其去调那条百分比链（每一环都得是确定高度，且 flex 的 auto 最小尺寸还会插一脚），
 * 不如在这里把尺寸算清楚：拿到可用区域，直接给画布一个确定的 CSS 尺寸。
 * 于是"绝不超出可用区域"由这段算术保证，而不是指望浏览器把百分比解开。
 *
 * 纯函数，所以边界情况可以脱离浏览器逐条钉住。
 */

export interface PreviewFitInput {
  /** 可用区域尺寸（CSS 像素） */
  boxWidth: number;
  boxHeight: number;
  /** 预览渲染出来的画布尺寸（像素） */
  imageWidth: number;
  imageHeight: number;
}

export interface PreviewFit {
  /** 画布应占据的 CSS 尺寸。为 0 表示还量不出可用区域，调用方应先把画布藏起来 */
  width: number;
  height: number;
}

export function fitPreview(input: PreviewFitInput): PreviewFit {
  const { boxWidth, boxHeight, imageWidth, imageHeight } = input;

  const measurable = boxWidth > 0 && boxHeight > 0 && imageWidth > 0 && imageHeight > 0;
  if (!measurable) return { width: 0, height: 0 };

  /**
   * 只缩不放。
   *
   * 预览渲染的短边固定在 1200，超过 1:1 只会把纸纹这类高频细节糊掉 ——
   * 而预览的用途恰恰是判断材质质感。所以大屏上的成品按原尺寸显示，
   * 多出来的空间留给背板，不拿放大去填。
   */
  const scale = Math.min(1, boxWidth / imageWidth, boxHeight / imageHeight);

  // 向下取整：宁可小 1px，也不要因为四舍五入多出半个像素被裁掉
  return {
    width: Math.floor(imageWidth * scale),
    height: Math.floor(imageHeight * scale),
  };
}
