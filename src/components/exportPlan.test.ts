import { describe, expect, it } from 'vitest';

import { assessFrame } from '@/input/budget';

import {
  buildExportFilename,
  buildExportPlan,
  EXPORT_SIZES,
  sanitizeSegment,
  stripExtension,
} from './exportPlan';
import { DEFAULT_QUALITY, QUALITY_MAX, QUALITY_MIN } from './exportFormat';

const SOURCE = { width: 9000, height: 6000 };

describe('导出方案 · 文件名', () => {
  it('去掉扩展名但保留机型里的点', () => {
    expect(stripExtension('portra400.tif')).toBe('portra400');
    expect(stripExtension('无扩展名')).toBe('无扩展名');
    expect(stripExtension('a.b.c.jpeg')).toBe('a.b.c');
  });

  it('把空格与符号折叠成连字符，保留中文与下划线', () => {
    expect(sanitizeSegment('  KODAK PORTRA 400  ')).toBe('KODAK-PORTRA-400');
    expect(sanitizeSegment('M6 // 2024')).toBe('M6-2024');
    expect(sanitizeSegment('暗房 扫描件')).toBe('暗房-扫描件');
    // 下划线是段间分隔符，段内必须保留，否则 Passe_M6_scan_001 会失去边界
    expect(sanitizeSegment('scan_001')).toBe('scan_001');
    expect(sanitizeSegment('---')).toBe('');
    expect(sanitizeSegment('__a__')).toBe('a');
  });

  it('组装出能一眼看出规格的文件名', () => {
    const name = buildExportFilename({
      cameraModel: 'LEICA M6',
      sourceName: 'scan_001.tif',
      longSide: 8192,
    });
    expect(name).toBe('Passe_LEICA-M6_scan_001_8192px.jpg');
  });

  it('缺少机型或源文件名时不留多余下划线', () => {
    expect(buildExportFilename({ sourceName: 'a.jpg', longSide: 4096 })).toBe('Passe_a_4096px.jpg');
    expect(buildExportFilename({ cameraModel: 'M6', longSide: 2048 })).toBe('Passe_M6_2048px.jpg');
    expect(buildExportFilename({ longSide: 1024 })).toBe('Passe_1024px.jpg');
  });

  it('扩展名可换，且绝不能出现路径分隔符', () => {
    expect(
      buildExportFilename({ sourceName: 'a.jpg', longSide: 100, extension: '.png' }),
    ).toContain('.png');
    const dirty = buildExportFilename({
      cameraModel: '../../etc/passwd',
      sourceName: 'a/b\\c.jpg',
      longSide: 100,
    });
    expect(dirty).not.toContain('/');
    expect(dirty).not.toContain('\\');
  });
});

/**
 * 导出方案 · 格式与质量。
 *
 * 名字里的扩展名与真正交给编码器的 MIME 是同一个 plan 算出来的，
 * 所以这里要盯的是"两者永远一致"—— 用户唯一能核对的就是文件名。
 */
describe('导出方案 · 格式与质量', () => {
  it('默认走 JPEG：文件名 .jpg、MIME image/jpeg、质量取默认值', () => {
    const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: '2k' });

    expect(plan.formatId).toBe('jpeg');
    expect(plan.mimeType).toBe('image/jpeg');
    expect(plan.quality).toBe(DEFAULT_QUALITY);
    expect(plan.filename).toBe('Passe_2048px.jpg');
    expect(plan.filename).toBe(buildExportFilename({ longSide: 2048, extension: '.jpg' }));
  });

  it('选 PNG 时扩展名与 MIME 一起换成无损那套，质量变为 undefined', () => {
    const plan = buildExportPlan({
      source: SOURCE,
      config: {},
      sizeId: '2k',
      formatId: 'png',
    });

    expect(plan.formatId).toBe('png');
    expect(plan.mimeType).toBe('image/png');
    // PNG 没有质量这一说：传 undefined 而不是继续传 0.98
    expect(plan.quality).toBeUndefined();
    expect(plan.filename).toBe('Passe_2048px.png');
  });

  it('扩展名跟着格式走，而不是两处各写一份', () => {
    // 文件名与 MIME 必须来自同一次解析，否则会出现"写着 .png 却编成 JPEG"
    for (const formatId of ['jpeg', 'png']) {
      const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: '2k', formatId });
      expect(plan.filename).toBe(
        buildExportFilename({
          longSide: plan.outputLongSide,
          extension: `.${formatId === 'jpeg' ? 'jpg' : 'png'}`,
        }),
      );
      expect(plan.mimeType).toBe(formatId === 'jpeg' ? 'image/jpeg' : 'image/png');
    }
  });

  it('未知格式 id 退回 JPEG，不抛错也不写出没有扩展名的文件', () => {
    // 预设存的是历史 id、或将来删掉的格式，都不该让导出面板整个炸掉
    const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: '2k', formatId: 'webp' });

    expect(plan.formatId).toBe('jpeg');
    expect(plan.filename.endsWith('.jpg')).toBe(true);
  });

  it('质量越界在方案这一层就被夹住', () => {
    const low = buildExportPlan({ source: SOURCE, config: {}, sizeId: '2k', quality: 0.1 });
    const high = buildExportPlan({ source: SOURCE, config: {}, sizeId: '2k', quality: 2 });

    expect(low.quality).toBe(QUALITY_MIN);
    expect(high.quality).toBe(QUALITY_MAX);
  });

  it('质量只影响 quality，不碰尺寸与文件名', () => {
    const base = buildExportPlan({ source: SOURCE, config: {}, sizeId: '4k' });
    const low = buildExportPlan({ source: SOURCE, config: {}, sizeId: '4k', quality: 0.7 });

    expect(low.quality).toBe(0.7);
    expect(low.outputW).toBe(base.outputW);
    expect(low.outputH).toBe(base.outputH);
    expect(low.framedW).toBe(base.framedW);
    expect(low.filename).toBe(base.filename);
  });
});

describe('导出方案 · 尺寸换算', () => {
  it('原始尺寸不做任何降采样', () => {
    const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: 'original' });
    expect(plan.outputLongSide).toBe(9000);
    expect(plan.outputW).toBe(9000);
    expect(plan.outputH).toBe(6000);
    expect(plan.maxDimension).toBeNull();
  });

  it('选 4K 时按长边压到 4096，长宽比不变', () => {
    const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: '4k' });
    expect(plan.outputLongSide).toBe(4096);
    expect(plan.outputW).toBe(4096);
    expect(plan.outputH).toBe(2731);
    expect(plan.outputW / plan.outputH).toBeCloseTo(1.5, 2);
  });

  it('只降不升 —— 4000px 的源图选 8K 不会凭空放大', () => {
    const plan = buildExportPlan({
      source: { width: 4000, height: 3000 },
      config: {},
      sizeId: '8k',
    });
    expect(plan.outputLongSide).toBe(4000);
    // 但上限仍然照传，交由引擎判断（它同样不会放大）
    expect(plan.maxDimension).toBe(8192);
  });

  it('竖幅图按高边计算', () => {
    const plan = buildExportPlan({
      source: { width: 3000, height: 9000 },
      config: {},
      sizeId: '4k',
    });
    expect(plan.outputLongSide).toBe(4096);
    expect(plan.outputH).toBe(4096);
    expect(plan.outputW).toBe(1365);
  });

  it('不认识的尺寸 id 退回该预设列表的第一项，而不是崩掉', () => {
    const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: '不存在' });
    expect(plan.sizeId).toBe(EXPORT_SIZES[0].id);
    expect(plan.outputLongSide).toBe(9000);
  });
});

describe('导出方案 · 外框尺寸与守卫联动', () => {
  it('外框尺寸与直接评估引擎布局的结果一致', () => {
    const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: '4k' });
    const direct = assessFrame(plan.outputW, plan.outputH, {});
    expect(plan.framedW).toBe(direct.framedW);
    expect(plan.framedH).toBe(direct.framedH);
    expect(plan.budget.level).toBe(direct.level);
  });

  it('常见扫描件选 4K 时判定为可以导出', () => {
    const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: '4k' });
    expect(plan.canExport).toBe(true);
    expect(plan.suggestedMaxDimension).toBeNull();
  });

  it('原始尺寸撞上内存上限时拦下导出，并给出源图长边口径的建议值', () => {
    const limit = 4e7;
    const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: 'original', limit });

    expect(plan.canExport).toBe(false);
    expect(plan.budget.level).toBe('blocked');
    expect(plan.suggestedMaxDimension).not.toBeNull();

    // 建议值必须真的管用，而且要落进余量充足档 ——
    // 只是"不再超限"不够：那样用户点完修正，黄色警告还在
    const fixed = buildExportPlan({
      source: SOURCE,
      config: {},
      sizeId: 'original',
      overrideMaxDimension: plan.suggestedMaxDimension,
      limit,
    });
    expect(fixed.canExport).toBe(true);
    expect(fixed.budget.level).toBe('ok');
    expect(fixed.outputLongSide).toBeLessThan(SOURCE.width);
  });

  it('上限被顶格时给出的是"偏重"而不是"超限"，仍然允许导出', () => {
    // 9000 × 6000 装裱后约 84MP，落在 1.1 亿上限的 55% ~ 100% 之间
    const plan = buildExportPlan({
      source: SOURCE,
      config: {},
      sizeId: 'original',
      limit: 1.1e8,
    });
    expect(plan.budget.level).toBe('heavy');
    expect(plan.canExport).toBe(true);
  });

  it('override 优先生效，并把 sizeId 标成 custom', () => {
    const plan = buildExportPlan({
      source: SOURCE,
      config: {},
      sizeId: '8k',
      overrideMaxDimension: 3000,
    });
    expect(plan.sizeId).toBe('custom');
    expect(plan.maxDimension).toBe(3000);
    expect(plan.outputLongSide).toBe(3000);
    expect(plan.outputW).toBe(3000);
    expect(plan.outputH).toBe(2000);
  });

  it('filename 里带的是实际输出长边，而不是预设值', () => {
    const plan = buildExportPlan({
      source: { width: 4000, height: 3000 },
      config: {},
      sizeId: '8k',
      sourceName: 'portra400.tif',
      cameraModel: 'M6',
    });
    // 源图只有 4000，所以文件名必须写 4000，写 8192 就是骗人
    expect(plan.filename).toBe('Passe_M6_portra400_4000px.jpg');
  });
});
