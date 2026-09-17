import { describe, expect, it } from 'vitest';

import { assessFrame, HEAVY_LOAD } from '@/input/budget';

import {
  buildBatchPlan,
  suggestUnifiedMaxDimension,
  uniquifyFilenames,
  type BatchCandidate,
} from './batchPlan';

const CONFIG = { marginRatio: 0.14, bottomWeight: 1.25, targetAspect: null };

function item(id: string, name: string, w: number, h: number): BatchCandidate {
  return { id, name, originalWidth: w, originalHeight: h };
}

/**
 * 把长边压到 dimension 之后，每张各落在哪一档。
 *
 * 用公开的 `assessFrame` 反推"够不够宽松"，而不是复算内部的目标像素数 ——
 * `ok` 一档的边界正好是 HEAVY_LOAD，于是"都是 ok"就等于"都在余量档内"。
 */
function levelsAt(items: readonly BatchCandidate[], dimension: number, limit: number): string[] {
  return items.map((entry) => {
    const longSide = Math.max(entry.originalWidth, entry.originalHeight);
    const ratio = Math.min(1, dimension / longSide);
    const w = Math.max(1, Math.round(entry.originalWidth * ratio));
    const h = Math.max(1, Math.round(entry.originalHeight * ratio));
    return assessFrame(w, h, CONFIG, limit).level;
  });
}

describe('uniquifyFilenames', () => {
  it('没有冲突时原样返回', () => {
    expect(uniquifyFilenames(['a.jpg', 'b.jpg'])).toEqual(['a.jpg', 'b.jpg']);
  });

  it('序号插在扩展名之前 —— 名尾挂序号会让双击打不开', () => {
    expect(uniquifyFilenames(['scan.tif', 'scan.tif', 'scan.tif'])).toEqual([
      'scan.tif',
      'scan-2.tif',
      'scan-3.tif',
    ]);
  });

  it('候选名本身被占用时继续往上找，不会二次撞名', () => {
    // 第三个如果只用 -2，就会和第二个撞上，于是又覆盖一次
    expect(uniquifyFilenames(['a.jpg', 'a-2.jpg', 'a.jpg'])).toEqual([
      'a.jpg',
      'a-2.jpg',
      'a-3.jpg',
    ]);
  });

  it('没有扩展名的直接追加', () => {
    expect(uniquifyFilenames(['scan', 'scan'])).toEqual(['scan', 'scan-2']);
  });

  it('隐藏文件不把整名当扩展名', () => {
    expect(uniquifyFilenames(['.gitignore', '.gitignore'])).toEqual(['.gitignore', '.gitignore-2']);
  });

  it('中文名照常处理', () => {
    expect(uniquifyFilenames(['胶片_001.tif', '胶片_001.tif'])).toEqual([
      '胶片_001.tif',
      '胶片_001-2.tif',
    ]);
  });
});

describe('suggestUnifiedMaxDimension', () => {
  it('整批在原始尺寸下就都在余量档内时不给建议', () => {
    const items = [item('a', 'a.tif', 2000, 1500), item('b', 'b.tif', 1600, 1200)];
    expect(suggestUnifiedMaxDimension(items, CONFIG, 1.2e8)).toBeNull();
  });

  it('尺寸量不出来时不给建议，也不抛错', () => {
    expect(suggestUnifiedMaxDimension([item('a', 'queued.tif', 0, 0)], CONFIG, 6e6)).toBeNull();
    expect(suggestUnifiedMaxDimension([], CONFIG, 6e6)).toBeNull();
  });

  it('压到下限也救不回来时给 null —— 那是边距的问题，不是尺寸的问题', () => {
    // 6×6 方图 + 0.3 的大留白：连压到 1200 都还在余量档之外
    const items = [item('a', 'square.tif', 8000, 8000)];
    const fat = { marginRatio: 0.3, bottomWeight: 1.25, targetAspect: null };
    expect(suggestUnifiedMaxDimension(items, fat, 6e6)).toBeNull();
  });

  it('不同长宽比的素材混在一起时，统一值是"同时满足所有张"里最大的那个', () => {
    // 4:3 与 1:1 混排：同一条长边下两者装裱出的像素数不同，
    // 所以不能各算各的建议值再取最小值 —— 取最小也不保证对 1:1 那张成立
    const items = [item('a', 'wide.tif', 8000, 6000), item('b', 'square.tif', 2000, 2000)];
    const unified = suggestUnifiedMaxDimension(items, CONFIG, 6e6);

    if (unified === null) throw new Error('应当给得出统一修正值');

    // 受限的是那张方图：它的长边只有 2000，却比 4:3 那张更吃像素
    expect(unified).toBeLessThan(2000);
    expect(levelsAt(items, unified, 6e6)).toEqual(['ok', 'ok']);
    // 再大 1px 就有张落不进去 —— 说明它确实是上界，不是随便一个保守值
    expect(levelsAt(items, unified + 1, 6e6)).not.toEqual(['ok', 'ok']);
  });
});

describe('buildBatchPlan · 分类', () => {
  it('能导的、超限的、还没解码的各归各的', () => {
    const items = [
      item('a', 'small.tif', 2000, 1500),
      item('b', 'giant.tif', 8000, 6000),
      item('c', 'pending.tif', 0, 0),
    ];
    const plan = buildBatchPlan({ items, config: CONFIG, sizeId: 'original', limit: 6e6 });

    expect(plan.exportable.map((entry) => entry.item.id)).toEqual(['a']);
    expect(plan.skipped.map((entry) => entry.item.id)).toEqual(['b', 'c']);
    expect(plan.skipped[0].reason).toBe('over-limit');
    expect(plan.skipped[1].reason).toBe('not-ready');
    // 被跳过的也要给出人话，否则汇总里只剩一串文件名
    expect(plan.skipped[0].message).toContain('超出画布安全上限');
    expect(plan.skipped[1].message).toContain('尚未解码');
    // 队列里的每一条都有归属，一条都不丢
    expect(plan.entries).toHaveLength(3);
  });

  it('逐张按自己的原图尺寸判定，不拿当前预览那张外推', () => {
    // 两张都"看起来正常"，但小画布上限下只有小图过得去
    const items = [item('a', 'small.tif', 2000, 1500), item('b', 'big.tif', 6000, 4000)];
    const plan = buildBatchPlan({ items, config: CONFIG, sizeId: 'original', limit: 6e6 });

    expect(plan.exportable.map((entry) => entry.item.id)).toEqual(['a']);
    expect(plan.skipped.map((entry) => entry.item.id)).toEqual(['b']);
  });

  it('还没解码完的条目不会把整批带走 —— 它们连尺寸都没有', () => {
    // 0 × 0 会让几何层直接抛错，这里是防它把整个批量方案炸掉
    const items = [item('a', 'queued.tif', 0, 0), item('b', 'ok.tif', 2000, 1500)];
    const plan = buildBatchPlan({ items, config: CONFIG, sizeId: 'original', limit: 1.2e8 });

    expect(plan.exportable.map((entry) => entry.item.id)).toEqual(['b']);
    expect(plan.skipped.map((entry) => entry.item.id)).toEqual(['a']);
  });
});

describe('buildBatchPlan · 峰值内存', () => {
  it('取单张最大值，不是批次总和', () => {
    const items = [
      item('a', 'a.tif', 3000, 2000),
      item('b', 'b.tif', 2000, 1500),
      item('c', 'c.tif', 1500, 1000),
    ];
    const plan = buildBatchPlan({ items, config: CONFIG, sizeId: 'original', limit: 1.2e8 });

    const each = plan.exportable.map((entry) => entry.plan.budget.estimatedBytes);
    const sum = each.reduce((total, value) => total + value, 0);

    expect(plan.exportable).toHaveLength(3);
    expect(plan.peakBytes).toBe(Math.max(...each));
    expect(plan.peakName).toBe('a.tif');
    // 串行导出，按总和对用户报数会把能跑完的批次说成跑不完
    expect(plan.peakBytes).toBeLessThan(sum);
  });
});

describe('buildBatchPlan · 文件名', () => {
  it('同名素材在同一次批量里被解开，不会互相覆盖', () => {
    const items = [item('a', 'scan.tif', 2000, 1500), item('b', 'scan.tif', 2000, 1500)];
    const plan = buildBatchPlan({ items, config: CONFIG, sizeId: '8k', limit: 1.2e8 });

    expect(plan.exportable.map((entry) => entry.filename)).toEqual([
      'Passe_scan_2000px.jpg',
      'Passe_scan_2000px-2.jpg',
    ]);
  });

  it('不同素材的名字各归各的，同名只在撞上时才改', () => {
    const items = [
      item('a', 'one.tif', 2000, 1500),
      item('b', 'two.tif', 2000, 1500),
      item('c', 'one.tif', 2000, 1500),
    ];
    const plan = buildBatchPlan({ items, config: CONFIG, sizeId: '8k', limit: 1.2e8 });

    expect(plan.exportable.map((entry) => entry.filename)).toEqual([
      'Passe_one_2000px.jpg',
      'Passe_two_2000px.jpg',
      'Passe_one_2000px-2.jpg',
    ]);
  });

  it('被跳过的图不占用文件名，别把能导出的挤成 -2', () => {
    const items = [item('a', 'scan.tif', 8000, 6000), item('b', 'scan.tif', 2000, 1500)];
    const plan = buildBatchPlan({ items, config: CONFIG, sizeId: 'original', limit: 6e6 });

    expect(plan.skipped).toHaveLength(1);
    expect(plan.exportable.map((entry) => entry.filename)).toEqual(['Passe_scan_2000px.jpg']);
  });
});

describe('buildBatchPlan · 统一修正', () => {
  it('把统一值设上去之后，一张都不落且都回到余量充足档', () => {
    const items = [item('a', 'giant.tif', 8000, 6000), item('b', 'square.tif', 2000, 2000)];
    const plan = buildBatchPlan({ items, config: CONFIG, sizeId: 'original', limit: 6e6 });

    expect(plan.skipped).toHaveLength(2);

    const unified = plan.unifiedMaxDimension;
    if (unified === null) throw new Error('应当给得出统一修正值');

    const fixed = buildBatchPlan({
      items,
      config: CONFIG,
      sizeId: 'original',
      overrideMaxDimension: unified,
      limit: 6e6,
    });

    expect(fixed.skipped).toHaveLength(0);
    expect(fixed.exportable).toHaveLength(2);
    // 瞄准的是余量档而不是上限本身 —— 点完修正不该还挂着黄色警告
    for (const entry of fixed.exportable) {
      expect(entry.plan.budget.level).toBe('ok');
      expect(entry.plan.budget.load).toBeLessThanOrEqual(HEAVY_LOAD);
    }
  });

  it('没有人被拦下时不给多余的统一值', () => {
    const items = [item('a', 'a.tif', 2000, 1500)];
    const plan = buildBatchPlan({ items, config: CONFIG, sizeId: 'original', limit: 1.2e8 });

    expect(plan.skipped).toHaveLength(0);
    expect(plan.unifiedMaxDimension).toBeNull();
  });
});
