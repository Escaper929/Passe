import { describe, expect, it } from 'vitest';

import { DESIGN_MIN_SIDE, scaleFactor, scaledPx } from '@/engine/scaleFactor';

describe('scaleFactor', () => {
  it('基准短边下系数为 1', () => {
    expect(scaleFactor(DESIGN_MIN_SIDE, 2000)).toBe(1);
    expect(scaleFactor(2000, DESIGN_MIN_SIDE)).toBe(1);
  });

  it('取短边而非长边，横竖构图行为一致', () => {
    expect(scaleFactor(2400, 1200)).toBe(scaleFactor(1200, 2400));
  });

  it('按分辨率线性放大', () => {
    expect(scaleFactor(4000, 4000)).toBeCloseTo(4000 / 1200);
    expect(scaleFactor(8000, 8000)).toBeCloseTo(8000 / 1200);
  });
});

describe('尺寸无关性（开发指南 §1 的核心约束）', () => {
  it('同一张图在预览与 8K 导出下，线宽占短边的比例恒定', () => {
    const cases = [
      { w: 1200, h: 1600 },
      { w: 4000, h: 5000 },
      { w: 8000, h: 10000 },
    ];
    const bevelBase = 2.5;
    const ratios = cases.map(({ w, h }) => scaledPx(bevelBase, w, h) / Math.min(w, h));

    // 低分辨率下受取整影响，允许 1 个像素级的偏差
    const [first, ...rest] = ratios;
    for (const ratio of rest) {
      expect(Math.abs(ratio - first)).toBeLessThan(1 / 1200);
    }
  });
});

describe('scaledPx', () => {
  it('遵守像素下限，避免小图上线条消失', () => {
    expect(scaledPx(2.5, 200, 200, 1.5)).toBe(1.5);
    expect(scaledPx(2.5, 10000, 10000, 1.5)).toBe(21);
  });
});
