import { describe, expect, it } from 'vitest';

import { fitPreview } from './previewFit';

/**
 * 预览显示尺寸的算术。
 *
 * 这些边界看着琐碎，但每一条都对应一个用户真的会看到的症状：
 * 量不出区域时按 0 渲染（画面整块消失）、多出 1px 被裁（画面边缘切掉一条）、
 * 或者在大屏上放大（纸纹糊掉，预览失去判断质感的作用）。
 */

describe('fitPreview', () => {
  it('量不出可用区域时给 0，而不是按未测量的尺寸先画一张', () => {
    expect(fitPreview({ boxWidth: 0, boxHeight: 600, imageWidth: 1200, imageHeight: 900 })).toEqual(
      { width: 0, height: 0 },
    );
    expect(fitPreview({ boxWidth: 800, boxHeight: 0, imageWidth: 1200, imageHeight: 900 })).toEqual(
      { width: 0, height: 0 },
    );
  });

  it('还没有渲染结果（图为 0）时也给 0', () => {
    expect(fitPreview({ boxWidth: 800, boxHeight: 600, imageWidth: 0, imageHeight: 900 })).toEqual({
      width: 0,
      height: 0,
    });
  });

  it('图比区域大：按受限的那一条边等比缩放', () => {
    // 1450 × 1180 的成品放进 800 × 600 —— 高度更吃紧
    const fit = fitPreview({
      boxWidth: 800,
      boxHeight: 600,
      imageWidth: 1450,
      imageHeight: 1180,
    });
    expect(fit.height).toBe(600);
    expect(fit.width).toBeLessThan(800);
  });

  it('宽度更吃紧时反过来', () => {
    const fit = fitPreview({
      boxWidth: 400,
      boxHeight: 600,
      imageWidth: 1200,
      imageHeight: 600,
    });
    expect(fit.width).toBe(400);
    expect(fit.height).toBe(200);
  });

  it('区域比图大时保持原尺寸 —— 只缩不放', () => {
    // 放大只会把纸纹这类高频细节糊掉，而预览的用途正是判断材质
    expect(
      fitPreview({ boxWidth: 4000, boxHeight: 3000, imageWidth: 1200, imageHeight: 900 }),
    ).toEqual({ width: 1200, height: 900 });
  });

  it('恰好等大时是恒等', () => {
    expect(
      fitPreview({ boxWidth: 1200, boxHeight: 900, imageWidth: 1200, imageHeight: 900 }),
    ).toEqual({ width: 1200, height: 900 });
  });

  it('取整方向保证结果绝不超出可用区域', () => {
    // 100 / 300 是无限循环小数，乘回去会得到 99.999…，
    // 若用四舍五入就会变成 100 再把边框挤出去
    /** 最小一档取到窄窗口：视口 500px 时背板只剩几十像素宽 */
    const cases = [
      { boxWidth: 100, boxHeight: 100, imageWidth: 300, imageHeight: 200 },
      { boxWidth: 801, boxHeight: 601, imageWidth: 1600, imageHeight: 1200 },
      { boxWidth: 333, boxHeight: 777, imageWidth: 4096, imageHeight: 2731 },
      { boxWidth: 68, boxHeight: 400, imageWidth: 8192, imageHeight: 5461 },
    ];

    for (const input of cases) {
      const fit = fitPreview(input);
      expect(fit.width).toBeLessThanOrEqual(input.boxWidth);
      expect(fit.height).toBeLessThanOrEqual(input.boxHeight);
      // 不能因为取整把画面缩成一条线
      expect(fit.width).toBeGreaterThan(0);
      expect(fit.height).toBeGreaterThan(0);
    }
  });

  it('缩放后比例与原画面一致，画面不会被拉变形', () => {
    const input = { boxWidth: 800, boxHeight: 600, imageWidth: 1450, imageHeight: 1180 };
    const fit = fitPreview(input);
    const sourceRatio = input.imageWidth / input.imageHeight;
    const fitRatio = fit.width / fit.height;
    // 取整误差在 1px 之内
    expect(Math.abs(fitRatio - sourceRatio)).toBeLessThan(0.002);
  });
});
