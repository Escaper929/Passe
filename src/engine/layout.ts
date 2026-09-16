import { scaleFactor } from './scaleFactor';

/**
 * 几何计算：算出外框尺寸、开窗坐标与四边实际边距。
 *
 * 相比开发指南 §3 的原始实现，这里修掉了两处会让边距出现 1px 缝隙的问题：
 * 1. 原实现分别对 canvasW / canvasH / x / y 取整，四舍五入后
 *    「左边距 + 照片宽 + 右边距」未必等于画布宽，右侧会多出或缺少一条像素；
 * 2. 原实现只返回 x / y 和 bottomOffset，调用方拿不到四边真实边距，
 *    导致倒角与内阴影只能按对称假设绘制。
 *
 * 这里改为先定画布尺寸，再由「余量」反推每条边距，并把余数的零头补给右侧 / 底部，
 * 保证 sum(边距) + 照片尺寸 === 画布尺寸 严格成立。
 */

export interface LayoutInput {
  /** 以照片短边为基准的边距比例 */
  marginRatio: number;
  /** 底部加权倍数，1.25 表示底边比其余三边宽 25% */
  bottomWeight: number;
  /** 固定外框比例（宽/高）。null 表示自适应 */
  targetAspect: number | null;
}

export interface Layout {
  canvasW: number;
  canvasH: number;
  /** 照片绘制原点与尺寸 */
  x: number;
  y: number;
  w: number;
  h: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  /** 底边距，钢印纵向定位用 */
  bottomOffset: number;
  /** 动态尺寸系数 scaleFactor = min(W, H) / 1200 */
  scale: number;
}

export function calculateLayout(imageW: number, imageH: number, input: LayoutInput): Layout {
  const w = Math.round(imageW);
  const h = Math.round(imageH);

  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    throw new Error(`照片尺寸非法：${imageW} × ${imageH}`);
  }

  const { marginRatio, bottomWeight } = input;
  if (!Number.isFinite(marginRatio) || marginRatio < 0) {
    throw new Error(`边距比例非法：${marginRatio}`);
  }
  if (!Number.isFinite(bottomWeight) || bottomWeight < 1) {
    throw new Error(`底边加权倍数非法：${bottomWeight}`);
  }

  const baseMargin = Math.min(w, h) * marginRatio;

  if (input.targetAspect === null) {
    const marginLeft = Math.round(baseMargin);
    const marginRight = marginLeft;
    const marginTop = marginLeft;
    const marginBottom = Math.round(baseMargin * bottomWeight);

    const canvasW = w + marginLeft + marginRight;
    const canvasH = h + marginTop + marginBottom;

    return {
      canvasW,
      canvasH,
      x: marginLeft,
      y: marginTop,
      w,
      h,
      marginLeft,
      marginRight,
      marginTop,
      marginBottom,
      bottomOffset: marginBottom,
      scale: scaleFactor(canvasW, canvasH),
    };
  }

  const targetAspect = input.targetAspect;
  if (!Number.isFinite(targetAspect) || targetAspect <= 0) {
    throw new Error(`固定外框比例非法：${targetAspect}`);
  }

  // 先求两个方向都不低于最小边距的尺寸下限，再取能满足目标比例的较大者
  const minW = w + baseMargin * 2;
  const minH = h + baseMargin * (1 + bottomWeight);

  let rawW: number;
  let rawH: number;
  if (minW / minH > targetAspect) {
    rawW = minW;
    rawH = rawW / targetAspect;
  } else {
    rawH = minH;
    rawW = rawH * targetAspect;
  }

  const canvasW = Math.max(w, Math.round(rawW));
  const canvasH = Math.max(h, Math.round(rawH));

  const remX = canvasW - w;
  const remY = canvasH - h;

  // 左右均分，奇数零头给右侧；上下按 bottomWeight 分配，零头给底部
  const marginLeft = Math.floor(remX / 2);
  const marginRight = remX - marginLeft;

  const marginTop = Math.round(remY / (1 + bottomWeight));
  const marginBottom = remY - marginTop;

  return {
    canvasW,
    canvasH,
    x: marginLeft,
    y: marginTop,
    w,
    h,
    marginLeft,
    marginRight,
    marginTop,
    marginBottom,
    bottomOffset: marginBottom,
    scale: scaleFactor(canvasW, canvasH),
  };
}
