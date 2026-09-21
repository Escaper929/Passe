import { describe, expect, it } from 'vitest';

import { assessFrame } from '@/input/budget';

import {
  buildExportFilename,
  buildExportPlan,
  EXPORT_SIZES,
  sanitizeSegment,
  stripExtension,
} from './exportPlan';

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

describe('导出方案 · 按目标 DPI 反推（物理打印尺寸）', () => {
  /** 源图远大于 A4@300 所需，因此输出尺寸由反推值决定，而不是源图。 */
  const HUGE = { width: 12000, height: 8000 };

  it('源图足够大时，按反推值输出，实际 DPI 正好落在目标上', () => {
    const plan = buildExportPlan({ source: HUGE, config: {}, sizeId: 'a4', targetDpi: 300 });

    expect(plan.print).not.toBeNull();
    // 这条是这个功能的核心断言。反推必须先把"成品图需要的像素"除以装裱放大系数，
    // 再当作源图长边；漏掉那一步实际 DPI 会高出约 1.19 倍（≈357），这里立刻红。
    expect(plan.print?.achievedDpi).toBeGreaterThanOrEqual(295);
    expect(plan.print?.achievedDpi).toBeLessThanOrEqual(302);

    // 输出尺寸由反推值决定：既不该顶着源图渲，也不该再多要像素
    expect(plan.maxDimension).toBe(plan.print?.requiredLongSide);
    expect(plan.outputLongSide).toBe(plan.print?.requiredLongSide);
    expect(plan.outputLongSide).toBeLessThan(HUGE.width);
    expect(plan.canExport).toBe(true);
  });

  it('反推要真的看比例：方图与 3:2 在同一张纸上占的尺寸差很多', () => {
    const wide = buildExportPlan({ source: HUGE, config: {}, sizeId: 'a4', targetDpi: 300 });
    const square = buildExportPlan({
      source: { width: 8000, height: 8000 },
      config: {},
      sizeId: 'a4',
      targetDpi: 300,
    });

    // 卡纸会把画面变得**不那么长条**：3:2 的照片装裱后比例约 1.35，
    // 仍小于 A4 的 297/210 ≈ 1.414，所以在 A4 上吃的都是短边（210mm）。
    // 两者都短边受限，但长边方向能占的毫米数差别很大 —— 这才是比例真正起作用的地方。
    expect(wide.print?.limitedBy).toBe('short');
    expect(square.print?.limitedBy).toBe('short');
    expect(wide.print?.printedLongMm as number).toBeGreaterThan(
      square.print?.printedLongMm as number,
    );
    expect(square.maxDimension as number).toBeLessThan(wide.maxDimension as number);
  });

  it('画幅足够宽时才轮到纸的长边受限（全景 3:1）', () => {
    const pano = buildExportPlan({
      source: { width: 6000, height: 2000 },
      config: {},
      sizeId: 'a4',
      targetDpi: 300,
    });

    // 3:1 装裱后比例约 2.5 > 1.414 → 长边吃满 297mm，短边只剩 119mm
    expect(pano.print?.limitedBy).toBe('long');
    expect(pano.print?.printedLongMm).toBeCloseTo(297, 6);
    expect(pano.print?.printedShortMm as number).toBeLessThan(210);

    // 长边吃满 297mm，反推出的成品图像素数正是 A4@300 那个熟知的 3508；
    // 但喂给导出管线的口径是**源图**长边，所以要除掉装裱放大系数后更小。
    expect(pano.maxDimension as number).toBeGreaterThan(3000);
    expect(pano.maxDimension as number).toBeLessThan(3508);
  });

  it('目标 DPI 越高，要求的源图像素越多', () => {
    const at150 = buildExportPlan({ source: HUGE, config: {}, sizeId: 'a4', targetDpi: 150 });
    const at300 = buildExportPlan({ source: HUGE, config: {}, sizeId: 'a4', targetDpi: 300 });
    expect(at150.outputLongSide).toBeLessThan(at300.outputLongSide);
  });

  it('源图不够时不放大，并如实报出实际 DPI', () => {
    const plan = buildExportPlan({
      source: { width: 2400, height: 1600 },
      config: {},
      sizeId: 'a4',
      targetDpi: 300,
    });

    // 只降不升：输出就是源图尺寸，一像素都没放大
    expect(plan.outputLongSide).toBe(2400);
    expect(plan.outputW).toBe(2400);
    expect(plan.outputH).toBe(1600);
    // 但需求仍要说清楚 —— 用户据此决定换小一号纸还是重扫
    expect(plan.print?.requiredLongSide).toBeGreaterThan(2400);
    expect(plan.print?.achievedDpi).toBeLessThan(300);
  });

  it('打印需求本身就已经限住了尺寸，宽松上限不会触发守卫', () => {
    // A4@300 要求源图长边 ~3200px，装裱后约 11.7MP；上限 12MP 时只是"偏重"，仍可导出
    const plan = buildExportPlan({
      source: HUGE,
      config: {},
      sizeId: 'a4',
      targetDpi: 300,
      limit: 1.2e7,
    });
    expect(plan.canExport).toBe(true);
    expect(plan.suggestedMaxDimension).toBeNull();
    expect(plan.print?.achievedDpi).toBeGreaterThanOrEqual(295);
  });

  it('内存守卫把尺寸压小之后，报出的实际 DPI 必须跟着掉', () => {
    const limit = 8e6;
    const plan = buildExportPlan({
      source: HUGE,
      config: {},
      sizeId: 'a4',
      targetDpi: 300,
      limit,
    });
    expect(plan.canExport).toBe(false);
    expect(plan.suggestedMaxDimension).not.toBeNull();

    const fixed = buildExportPlan({
      source: HUGE,
      config: {},
      sizeId: 'a4',
      targetDpi: 300,
      limit,
      overrideMaxDimension: plan.suggestedMaxDimension,
    });
    expect(fixed.canExport).toBe(true);
    expect(fixed.sizeId).toBe('custom');
    // 关键：不能还挂着"300DPI"自欺 —— 守卫让步的代价就是 DPI 下降。
    // 面板上这两行字必须自洽（"300DPI 需 ≥ Npx" + "实际 M DPI"），
    // 否则用户会以为拿到的是 300DPI 的成品。
    expect(fixed.print?.achievedDpi).toBeLessThan(300);
    expect(fixed.print?.achievedDpi).toBeGreaterThan(100);
    // 需求行仍然是原始的目标值，不因为被压过就改口
    expect(fixed.print?.requiredLongSide).toBe(plan.print?.requiredLongSide);
  });

  it('选像素档时没有物理换算，sizeId 也照旧', () => {
    const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: '8k', targetDpi: 300 });
    expect(plan.print).toBeNull();
    expect(plan.sizeId).toBe('8k');
    expect(plan.maxDimension).toBe(8192);
  });

  it('选了纸规格时 sizeId 保留纸的 id，不被像素档兜底顶掉', () => {
    const plan = buildExportPlan({ source: SOURCE, config: {}, sizeId: 'a3', targetDpi: 300 });
    expect(plan.sizeId).toBe('a3');
    expect(plan.print?.paperLabel).toBe('A3');
  });

  it('同一张图换纸：A3 比 A4 要求更多像素', () => {
    const atA4 = buildExportPlan({ source: HUGE, config: {}, sizeId: 'a4', targetDpi: 300 });
    const atA3 = buildExportPlan({ source: HUGE, config: {}, sizeId: 'a3', targetDpi: 300 });
    expect(atA3.outputLongSide as number).toBeGreaterThan(atA4.outputLongSide as number);
  });

  it('文件名仍写实际输出长边 —— 达标与否都用同一个诚实的口径', () => {
    const plan = buildExportPlan({
      source: HUGE,
      config: {},
      sizeId: 'a4',
      targetDpi: 300,
      sourceName: 'scan.tif',
      cameraModel: 'M6',
    });
    expect(plan.filename).toBe(`Passe_M6_scan_${plan.outputLongSide}px.jpg`);
  });
});
