import { describe, expect, it } from 'vitest';

import { MAX_CANVAS_PIXELS } from '@/engine/canvasLimit';
import { calculateLayout } from '@/engine/layout';

import {
  assessFrame,
  assessResidentMemory,
  BYTES_PER_PIXEL,
  defaultResidentLimit,
  formatMemory,
  HEAVY_LOAD,
  RESIDENT_SOFT_BYTES,
  suggestMaxDimension,
} from './budget';

/** 按给定的长边上限等比缩放一张图，模拟"先降采样再装裱"。 */
function scaledLevel(w: number, h: number, dimension: number, limit: number): string {
  const ratio = dimension / Math.max(w, h);
  const report = assessFrame(
    Math.max(1, Math.round(w * ratio)),
    Math.max(1, Math.round(h * ratio)),
    {},
    limit,
  );
  return report.level;
}

describe('内存守卫 · 与渲染器的几何一致性', () => {
  it('守卫算出的外框尺寸必须与引擎布局逐像素相同', () => {
    // 这是整个模块最容易悄悄失效的地方：一旦守卫自己实现一套边距公式，
    // 它给出的"安全/超限"判断就和真实渲染结果对不上，警告会变成假警报。
    const layout = calculateLayout(3000, 2000, {
      marginRatio: 0.14,
      bottomWeight: 1.25,
      targetAspect: null,
    });
    const report = assessFrame(3000, 2000);

    expect(report.framedW).toBe(layout.canvasW);
    expect(report.framedH).toBe(layout.canvasH);
    expect(report.megapixels).toBeCloseTo((layout.canvasW * layout.canvasH) / 1e6, 6);
  });

  it('配置透传：边距比例调大后外框像素随之增加', () => {
    const tight = assessFrame(3000, 2000, { marginRatio: 0.14 });
    const loose = assessFrame(3000, 2000, { marginRatio: 0.3 });
    expect(loose.megapixels).toBeGreaterThan(tight.megapixels);
  });

  it('固定外框比例会改变结果 —— 它约束的是整体形状，不只是内窗', () => {
    const adaptive = assessFrame(3000, 2000, { targetAspect: null });
    const square = assessFrame(3000, 2000, { targetAspect: 1 });
    expect(square.framedW).toBe(square.framedH);
    expect(square.megapixels).not.toBeCloseTo(adaptive.megapixels, 3);
  });

  it('外框像素随源图尺寸单调递增', () => {
    const small = assessFrame(2000, 1500);
    const large = assessFrame(6000, 4500);
    expect(large.megapixels).toBeGreaterThan(small.megapixels);
  });
});

describe('内存守卫 · 三档风险判定', () => {
  it('常规全画幅扫描件判定为安全', () => {
    const report = assessFrame(6000, 4000);
    expect(report.level).toBe('ok');
    expect(report.load).toBeLessThan(HEAVY_LOAD);
    expect(report.suggestedMaxDimension).toBeNull();
    expect(report.message).toContain('余量充足');
  });

  it('大画幅进入"偏重"档：仍可导出，但明确告知会变慢', () => {
    const report = assessFrame(9000, 6000);
    expect(report.level).toBe('heavy');
    expect(report.load).toBeGreaterThan(HEAVY_LOAD);
    expect(report.load).toBeLessThanOrEqual(1);
    expect(report.message).toContain('变慢');
  });

  it('超过安全上限时判定为超限，并给出可执行的建议尺寸', () => {
    const report = assessFrame(12000, 9000);
    expect(report.level).toBe('blocked');
    expect(report.load).toBeGreaterThan(1);
    expect(report.suggestedMaxDimension).not.toBeNull();
    expect(report.message).toContain('安全上限');
  });

  it('阈值是相对上限的，换一个小上限后中等图也会超限', () => {
    // 3000 × 2000 装裱后是 3560 × 2630 ≈ 9.4MP
    const limit = 6e6; // 6MP
    expect(assessFrame(3000, 2000, {}, limit).level).toBe('blocked');
    // 1000 × 800 装裱后约 1.1MP，同一上限下仍然安全
    expect(assessFrame(1000, 800, {}, limit).level).toBe('ok');
  });

  it('估算内存把源图与外框都算进去', () => {
    const report = assessFrame(2000, 1500);
    const expected = (report.framedW * report.framedH + 2000 * 1500) * BYTES_PER_PIXEL;
    expect(report.estimatedBytes).toBe(expected);
  });
});

describe('内存守卫 · 建议降采样尺寸', () => {
  const W = 12000;
  const H = 9000;

  it('按建议尺寸缩过之后落回"余量充足"档，而不是贴着上限', () => {
    const suggestion = suggestMaxDimension(W, H);
    expect(suggestion).not.toBeNull();
    // 这一条是关键：点完"一键修正"之后不该还留着一条"偏重"警告；
    // 盯上限本身的话，用户修完看到的还是同一个警告，等于白点。
    expect(scaledLevel(W, H, suggestion as number, MAX_CANVAS_PIXELS)).toBe('ok');
  });

  it('建议值不是"越大越好"：放大 5% 跌出余量充足档，放大 50% 才重新超限', () => {
    const suggestion = suggestMaxDimension(W, H) as number;
    expect(scaledLevel(W, H, Math.ceil(suggestion * 1.05), MAX_CANVAS_PIXELS)).toBe('heavy');
    expect(scaledLevel(W, H, Math.ceil(suggestion * 1.5), MAX_CANVAS_PIXELS)).toBe('blocked');
  });

  it('本来就装得下的图，建议值就是它自己的长边 —— 不该凭空缩图', () => {
    expect(suggestMaxDimension(3000, 2000)).toBe(3000);
  });

  it('连下限都装不下时返回 null，让调用方去调边距而不是缩图', () => {
    // 边距比例荒谬地大，任何尺寸都超限
    expect(suggestMaxDimension(12000, 9000, { marginRatio: 40 }, 2e7)).toBeNull();
  });

  it('上限越小，建议尺寸越小', () => {
    const loose = suggestMaxDimension(W, H, {}, 1.2e8) as number;
    const tight = suggestMaxDimension(W, H, {}, 4e7) as number;
    expect(tight).toBeLessThan(loose);
  });
});

describe('内存守卫 · 队列常驻内存', () => {
  it('求和而不是取最大 —— 工作副本是同时驻留的', () => {
    const report = assessResidentMemory([
      { width: 2400, height: 1600 },
      { width: 2400, height: 1600 },
      { width: 2400, height: 1600 },
    ]);
    expect(report.count).toBe(3);
    expect(report.megapixels).toBeCloseTo((2400 * 1600 * 3) / 1e6, 6);
    expect(report.estimatedBytes).toBe(2400 * 1600 * 3 * BYTES_PER_PIXEL);
  });

  it('空队列占用为零且判定为安全', () => {
    const report = assessResidentMemory([]);
    expect(report.estimatedBytes).toBe(0);
    expect(report.level).toBe('ok');
    expect(report.load).toBe(0);
  });

  it('三档判定按上限的比例给出，并把上限一并回报给界面', () => {
    const size = { width: 2400, height: 1600 };
    const single = assessResidentMemory([size], 1e6);
    expect(single.level).toBe('blocked');
    expect(single.limit).toBe(1e6);
    expect(single.message).toContain('请先移除部分图片');

    const mild = assessResidentMemory([size], 100 * 1024 * 1024);
    expect(mild.level).toBe('ok');
  });

  it('软阈值之上的多图会给出"浏览器已开始吃力"的提示', () => {
    // 每张 2400×2400 = 5.76MP ≈ 23MB，凑到软阈值以上
    const count = Math.ceil(RESIDENT_SOFT_BYTES / (2400 * 2400 * BYTES_PER_PIXEL)) + 1;
    const report = assessResidentMemory(
      Array.from({ length: count }, () => ({ width: 2400, height: 2400 })),
      10 * 1024 * 1024 * 1024,
    );
    expect(report.level).toBe('heavy');
    expect(report.message).toContain('吃力');
  });

  it('设备上限落在合理区间内，不会算出 0 或无限大', () => {
    const limit = defaultResidentLimit();
    expect(limit).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(limit).toBeLessThanOrEqual(1024 * 1024 * 1024);
  });
});

describe('内存守卫 · 格式化', () => {
  it('KB / MB / GB 三档都可读', () => {
    expect(formatMemory(512 * 1024)).toBe('512 KB');
    expect(formatMemory(300 * 1024 * 1024)).toBe('300 MB');
    expect(formatMemory(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
  });
});
