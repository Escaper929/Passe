import { describe, expect, it } from 'vitest';

import {
  DPI_OPTIONS,
  PRINT_SIZES,
  achievedDpi,
  describeDpi,
  describePrint,
  findPrintSize,
  fitInsidePaper,
  printSourceLongSide,
  requiredFramedLongSidePx,
  type PaperSize,
  type PrintPlan,
} from './printSize';

const A4 = findPrintSize('a4') as PaperSize;
const A3 = findPrintSize('a3') as PaperSize;
const EIGHT_BY_TEN = findPrintSize('8x10') as PaperSize;

/** 成品图比例（长边/短边，≥1）。 */
function aspect(photoW: number, photoH: number): number {
  return Math.max(photoW, photoH) / Math.min(photoW, photoH);
}

describe('纸规格', () => {
  it('三档纸的尺寸与国标 / 美制一致，且长边在前', () => {
    for (const paper of PRINT_SIZES) {
      expect(paper.longMm).toBeGreaterThan(paper.shortMm);
    }
    expect([A4.longMm, A4.shortMm]).toEqual([297, 210]);
    expect([A3.longMm, A3.shortMm]).toEqual([420, 297]);
    // 8×10 英寸 = 254 × 203.2mm
    expect(EIGHT_BY_TEN.longMm).toBeCloseTo(254, 6);
    expect(EIGHT_BY_TEN.shortMm).toBeCloseTo(203.2, 6);
  });

  it('DPI 档位按从高到低排列，默认 300 在其中', () => {
    const values = DPI_OPTIONS.map((option) => option.value);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(values).toContain(300);
  });

  it('未知 id 返回 null —— 调用方据此区分"纸"与"像素档"', () => {
    expect(findPrintSize('8k')).toBeNull();
    expect(findPrintSize('a4')?.label).toBe('A4');
  });
});

describe('装进纸内', () => {
  it('成品图比纸更长条时长边受限（3:2 配 A4）', () => {
    // 3:2 = 1.5 > A4 的 297/210 ≈ 1.414
    const fit = fitInsidePaper(A4, 1.5);
    expect(fit.limitedBy).toBe('long');
    expect(fit.longMm).toBeCloseTo(297, 6);
    expect(fit.shortMm).toBeCloseTo(198, 6);
  });

  it('成品图比纸更方时短边受限（方图配 A4）', () => {
    const fit = fitInsidePaper(A4, 1);
    expect(fit.limitedBy).toBe('short');
    expect(fit.longMm).toBeCloseTo(210, 6);
    expect(fit.shortMm).toBeCloseTo(210, 6);
  });

  it('比例与纸完全一致时，正好铺满一张纸（8×10 配 5:4）', () => {
    // 254 / 203.2 = 1.25 恰好等于 5:4
    const fit = fitInsidePaper(EIGHT_BY_TEN, 254 / 203.2);
    expect(fit.longMm).toBeCloseTo(254, 6);
    expect(fit.shortMm).toBeCloseTo(203.2, 6);
  });

  it('任何比例都不会溢出纸外，且比例保持不变', () => {
    for (const paper of PRINT_SIZES) {
      for (const ratio of [1, 1.2, 1.25, 1.3, 1.4142135, 1.5, 1.6, 2, 2.5, 3]) {
        const fit = fitInsidePaper(paper, ratio);
        expect(fit.longMm, `${paper.id} @${ratio} 长边溢出`).toBeLessThanOrEqual(
          paper.longMm + 1e-9,
        );
        expect(fit.shortMm, `${paper.id} @${ratio} 短边溢出`).toBeLessThanOrEqual(
          paper.shortMm + 1e-9,
        );
        // 至少一条边贴住纸 —— 否则说明还能再放大，就不是"最大"尺寸了
        const touches =
          Math.abs(fit.longMm - paper.longMm) < 1e-9 ||
          Math.abs(fit.shortMm - paper.shortMm) < 1e-9;
        expect(touches, `${paper.id} @${ratio} 没贴住任何一条边`).toBe(true);
        // 比例不变形
        expect(fit.longMm / fit.shortMm).toBeCloseTo(ratio, 9);
      }
    }
  });

  it('比例非法时明确报错，而不是算出一个负数尺寸', () => {
    expect(() => fitInsidePaper(A4, 0.5)).toThrow(/比例非法/);
    expect(() => fitInsidePaper(A4, Number.NaN)).toThrow(/比例非法/);
  });
});

describe('按目标 DPI 反推像素', () => {
  it('A4 300DPI 横向铺满长边 → 3508px（与业界熟知的 A4@300 一致）', () => {
    expect(requiredFramedLongSidePx(A4, 300, aspect(3000, 2000))).toBe(3508);
  });

  it('方图配 A4 时是短边受限 → 2481px，而不是想当然的 3508', () => {
    // 方图在 A4 上只能占 210 × 210mm，拿 3508 去要像素就是多算了 40%
    expect(requiredFramedLongSidePx(A4, 300, 1)).toBe(2481);
  });

  it('向上取整，保证实际 DPI 不低于目标（目标 DPI 是下限）', () => {
    for (const paper of PRINT_SIZES) {
      for (const ratio of [1, 1.3, 1.5, 2]) {
        for (const dpi of [150, 240, 300]) {
          const fit = fitInsidePaper(paper, ratio);
          const px = requiredFramedLongSidePx(paper, dpi, ratio);
          expect(
            achievedDpi(px, fit.longMm),
            `${paper.id} @${ratio} ${dpi}DPI 达不到目标`,
          ).toBeGreaterThanOrEqual(dpi);
        }
      }
    }
  });

  it('目标 DPI 越高所需像素越多', () => {
    const at150 = requiredFramedLongSidePx(A4, 150, 1.5);
    const at240 = requiredFramedLongSidePx(A4, 240, 1.5);
    const at300 = requiredFramedLongSidePx(A4, 300, 1.5);
    expect(at150).toBeLessThan(at240);
    expect(at240).toBeLessThan(at300);
  });
});

describe('成品图像素 → 源图像素', () => {
  it('按装裱放大系数除回去', () => {
    // 卡纸把长边放大了 1.25 倍，于是成品图要 3000px 时，照片只需 2400px
    expect(printSourceLongSide(3000, 1.25)).toBe(2400);
  });

  it('除不尽时向上取整，宁可多要一点', () => {
    expect(printSourceLongSide(3001, 1.25)).toBe(2401);
  });

  it('放大系数非法时明确报错', () => {
    expect(() => printSourceLongSide(3000, 0)).toThrow(/放大系数非法/);
    expect(() => printSourceLongSide(3000, Number.NaN)).toThrow(/放大系数非法/);
  });
});

describe('实际 DPI', () => {
  it('与反推互为逆运算', () => {
    expect(achievedDpi(3000, 254)).toBeCloseTo(300, 9);
    expect(achievedDpi(2481, 210)).toBeGreaterThanOrEqual(300);
  });

  it('物理尺寸为 0 时返回 0，不产生 Infinity', () => {
    expect(achievedDpi(1000, 0)).toBe(0);
  });
});

describe('给用户看的两行字', () => {
  const base: PrintPlan = {
    paperId: 'a4',
    paperLabel: 'A4',
    dpi: 300,
    printedLongMm: 284.26,
    printedShortMm: 210,
    limitedBy: 'short',
    requiredLongSide: 2830,
    achievedDpi: 300,
  };

  it('第一行说清印在哪张纸上、成品多大', () => {
    const text = describePrint(base);
    expect(text).toContain('A4');
    expect(text).toContain('297 × 210mm');
    expect(text).toContain('284 × 210mm');
  });

  it('达到目标时只报需求，不多说废话', () => {
    const text = describeDpi(base);
    expect(text).toContain('300DPI');
    expect(text).toContain('2830');
    expect(text).not.toContain('不放大');
  });

  it('达不到目标时如实报出实际 DPI 与原因', () => {
    const text = describeDpi({ ...base, achievedDpi: 254.4 });
    expect(text).toContain('254DPI');
    expect(text).toContain('不放大');
    // 仍然把"本需要多少"说清楚，用户据此决定换纸还是重扫
    expect(text).toContain('2830');
  });
});
