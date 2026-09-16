import { describe, expect, it } from 'vitest';

import { calculateLayout } from '@/engine/layout';

const AUTO = { marginRatio: 0.14, bottomWeight: 1.25, targetAspect: null };

describe('calculateLayout · 自适应外框', () => {
  it('三边等距，底边按 bottomWeight 加权', () => {
    const layout = calculateLayout(2000, 1500, AUTO);
    const base = 1500 * 0.14; // 以照片短边为基准

    expect(layout.marginLeft).toBe(Math.round(base));
    expect(layout.marginRight).toBe(layout.marginLeft);
    expect(layout.marginTop).toBe(layout.marginLeft);
    expect(layout.marginBottom).toBe(Math.round(base * 1.25));
  });

  it('边距之和加照片尺寸严格等于画布尺寸（不留 1px 缝隙）', () => {
    const cases = [
      [2000, 1500],
      [1500, 2000],
      [4001, 2999],
      [1200, 1200],
      [1, 1],
    ] as const;

    for (const [w, h] of cases) {
      const layout = calculateLayout(w, h, AUTO);
      expect(layout.marginLeft + layout.w + layout.marginRight).toBe(layout.canvasW);
      expect(layout.marginTop + layout.h + layout.marginBottom).toBe(layout.canvasH);
    }
  });

  it('照片原点与边距一致', () => {
    const layout = calculateLayout(3000, 2000, AUTO);
    expect(layout.x).toBe(layout.marginLeft);
    expect(layout.y).toBe(layout.marginTop);
    expect(layout.bottomOffset).toBe(layout.marginBottom);
  });

  it('scale 等于 min(画布宽, 画布高) / 1200', () => {
    const layout = calculateLayout(4000, 3000, AUTO);
    expect(layout.scale).toBeCloseTo(Math.min(layout.canvasW, layout.canvasH) / 1200);
  });
});

describe('calculateLayout · 固定外框比例', () => {
  it('命中目标比例（误差在 1px 内）', () => {
    const cases = [
      { w: 2000, h: 1500, aspect: 4 / 3 },
      { w: 2000, h: 1500, aspect: 1 },
      { w: 2000, h: 1500, aspect: 5 / 4 },
      { w: 3000, h: 2000, aspect: 16 / 9 },
      { w: 2000, h: 3000, aspect: 1 },
    ] as const;

    for (const { w, h, aspect } of cases) {
      const layout = calculateLayout(w, h, { ...AUTO, targetAspect: aspect });
      const actual = layout.canvasW / layout.canvasH;
      expect(Math.abs(actual - aspect)).toBeLessThan(1e-3);
    }
  });

  it('两个方向都不会低于基准边距', () => {
    const base = 1500 * 0.14;
    const cases = [
      { w: 2000, h: 1500, aspect: 1 },
      { w: 2000, h: 1500, aspect: 21 / 9 },
      { w: 2000, h: 1500, aspect: 3 / 4 },
    ] as const;

    for (const { w, h, aspect } of cases) {
      const layout = calculateLayout(w, h, { ...AUTO, targetAspect: aspect });
      expect(layout.marginLeft).toBeGreaterThanOrEqual(Math.floor(base));
      expect(layout.marginRight).toBeGreaterThanOrEqual(Math.floor(base));
      expect(layout.marginTop).toBeGreaterThanOrEqual(Math.floor(base));
      expect(layout.marginBottom).toBeGreaterThanOrEqual(Math.floor(base));
    }
  });

  it('底边加权关系保持', () => {
    const layout = calculateLayout(2000, 1500, { ...AUTO, targetAspect: 1 });
    const ratio = layout.marginBottom / layout.marginTop;
    expect(Math.abs(ratio - AUTO.bottomWeight)).toBeLessThan(0.2);
  });

  it('边距与尺寸同样严格自洽', () => {
    const layout = calculateLayout(2400, 1800, { ...AUTO, targetAspect: 5 / 4 });
    expect(layout.marginLeft + layout.w + layout.marginRight).toBe(layout.canvasW);
    expect(layout.marginTop + layout.h + layout.marginBottom).toBe(layout.canvasH);
  });
});

describe('calculateLayout · 横竖构图', () => {
  it('短边基准一致，两个方向的三边边距相同', () => {
    const landscape = calculateLayout(2000, 1500, AUTO);
    const portrait = calculateLayout(1500, 2000, AUTO);

    // 边距基准取自照片短边，两种构图的短边都是 1500
    expect(portrait.marginLeft).toBe(landscape.marginLeft);
    expect(portrait.marginTop).toBe(landscape.marginTop);
    expect(portrait.marginBottom).toBe(landscape.marginBottom);
  });

  it('底边加权是非对称的：转置后外框不会简单互换', () => {
    // 这条是刻意锁住的行为 —— bottomWeight 让构图失去转置对称性，
    // 横构图的外框高不等于竖构图的外框宽（差值正好是加权带来的那部分）。
    const landscape = calculateLayout(2000, 1500, AUTO);
    const portrait = calculateLayout(1500, 2000, AUTO);

    expect(landscape.marginBottom).toBeGreaterThan(landscape.marginTop);
    const weightGap = landscape.marginBottom - landscape.marginTop;
    expect(landscape.canvasH - portrait.canvasW).toBe(weightGap);
  });

  it('bottomWeight 取 1 时恢复完全对称', () => {
    const config = { marginRatio: 0.14, bottomWeight: 1, targetAspect: null };
    const landscape = calculateLayout(2000, 1500, config);
    const portrait = calculateLayout(1500, 2000, config);

    expect(portrait.canvasW).toBe(landscape.canvasH);
    expect(portrait.canvasH).toBe(landscape.canvasW);
  });
});

describe('calculateLayout · 入参校验', () => {
  it('非法尺寸抛出错误', () => {
    expect(() => calculateLayout(0, 100, AUTO)).toThrow();
    expect(() => calculateLayout(100, -5, AUTO)).toThrow();
  });

  it('非法边距比例抛出错误', () => {
    expect(() => calculateLayout(100, 100, { ...AUTO, marginRatio: -0.1 })).toThrow();
  });

  it('非法底边加权倍数抛出错误', () => {
    expect(() => calculateLayout(100, 100, { ...AUTO, bottomWeight: 0.5 })).toThrow();
  });

  it('非法外框比例抛出错误', () => {
    expect(() => calculateLayout(100, 100, { ...AUTO, targetAspect: 0 })).toThrow();
    expect(() => calculateLayout(100, 100, { ...AUTO, targetAspect: Number.NaN })).toThrow();
  });
});
