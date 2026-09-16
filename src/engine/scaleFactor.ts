/**
 * 动态尺寸无关性（开发指南 §1）
 *
 * 所有线宽、倒角宽度、阴影模糊半径都必须以 1200px 短边为基准书写，
 * 再乘以下面的系数，才能保证 1000px 屏幕预览与 8K 打印件的比例绝对一致。
 * 任何绕过这个系数直接写死像素值的地方，都是 bug。
 */

/** 设计基准短边（px）。 */
export const DESIGN_MIN_SIDE = 1200;

/** 线宽 / 倒角 / 阴影模糊的统一换算系数。 */
export function scaleFactor(canvasWidth: number, canvasHeight: number): number {
  return Math.min(canvasWidth, canvasHeight) / DESIGN_MIN_SIDE;
}

/**
 * 把以基准尺寸写死的值换算到当前画布，并保证不小于下限。
 *
 * @param baseValue 以 1200px 短边为基准的值
 * @param floor     换算结果的像素下限（避免小图上线条消失）
 */
export function scaledPx(
  baseValue: number,
  canvasWidth: number,
  canvasHeight: number,
  floor = 0,
): number {
  return Math.max(floor, Math.round(baseValue * scaleFactor(canvasWidth, canvasHeight)));
}
