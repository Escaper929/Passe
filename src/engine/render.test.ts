import { createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MAX_CANVAS_PIXELS } from '@/engine/canvasLimit';
import { GalleryFramingEngine, isBlankCanvas } from '@/engine/GalleryFramingEngine';
import { drawTrackedText, stampGeometry } from '@/engine/materials';
import type { FrameConfig, RenderSource } from '@/engine/types';

/**
 * 真实渲染测试。
 *
 * jsdom 不自带 2D 画布，这里把 document.createElement('canvas') 接到
 * @napi-rs/canvas 的 Skia 实现上，于是引擎可以在测试里真正跑完一遍渲染管线，
 * 断言的不再是"函数被调用过"，而是像素结果 —— 纸纹到底有没有出现、
 * 内阴影有没有压暗、倒角有没有留出白边。
 *
 * 这同时是阶段 5 视觉回归的地基。
 */

const PHOTO_W = 1200;
const PHOTO_H = 800;

function createNapiCanvas(width = 1, height = 1): HTMLCanvasElement {
  return createCanvas(width, height) as unknown as HTMLCanvasElement;
}

/** 中性灰"照片"，方便判断各层材质对画面的影响。 */
function createPhoto(): RenderSource {
  const canvas = createNapiCanvas(PHOTO_W, PHOTO_H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('测试照片创建失败');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, PHOTO_W, PHOTO_H);
  return canvas;
}

/** 关闭全部材质层，只留卡纸底色 —— 用于取得确定性的基线像素。 */
const ONLY_MAT: Partial<FrameConfig> = {
  layers: {
    paperTexture: false,
    bevel: false,
    insetShadow: false,
    stamp: false,
  },
};

function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number] {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('读取像素失败：无 2D 上下文');
  const { data } = ctx.getImageData(x, y, 1, 1);
  return [data[0], data[1], data[2]];
}

/** 区域内的平均绝对偏差，用来量化"纹理强度"。 */
function meanAbsDeviation(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('读取像素失败：无 2D 上下文');
  const { data } = ctx.getImageData(x, y, w, h);

  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i];
    count += 1;
  }
  const mean = sum / count;

  let deviation = 0;
  for (let i = 0; i < data.length; i += 4) {
    deviation += Math.abs(data[i] - mean);
  }
  return deviation / count;
}

beforeAll(() => {
  const native = Document.prototype.createElement;
  vi.spyOn(document, 'createElement').mockImplementation(function (
    this: Document,
    tagName: string,
    options?: ElementCreationOptions,
  ) {
    if (tagName.toLowerCase() === 'canvas') {
      return createNapiCanvas() as unknown as HTMLElement;
    }
    return native.call(document, tagName as 'div', options);
  } as typeof document.createElement);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('GalleryFramingEngine.render · 画布与几何', () => {
  const photo = createPhoto();

  it('输出画布尺寸与 layout 一致', () => {
    const layout = GalleryFramingEngine.layout(photo, {});
    const output = GalleryFramingEngine.render(photo, {});

    expect(output.width).toBe(layout.canvasW);
    expect(output.height).toBe(layout.canvasH);
    expect(layout.canvasW).toBeGreaterThan(PHOTO_W);
    expect(layout.canvasH).toBeGreaterThan(PHOTO_H);
  });

  it('超出本机画布上限时拒绝渲染并给出可读原因', () => {
    const huge = { width: 20000, height: 20000 } as unknown as RenderSource;
    expect(() => GalleryFramingEngine.render(huge, {})).toThrow(/超出本机画布上限/);
    expect(20000 * 20000).toBeGreaterThan(MAX_CANVAS_PIXELS);
  });
});

describe('卡纸底色', () => {
  const photo = createPhoto();

  it('四角像素等于所选卡纸色', () => {
    const cases = [
      { color: '#F8F7F3', expected: [248, 247, 243] },
      { color: '#F4F0E6', expected: [244, 240, 230] },
      { color: '#ECEEF0', expected: [236, 238, 240] },
      { color: '#1C1C1E', expected: [28, 28, 30] },
    ] as const;

    for (const { color, expected } of cases) {
      const output = GalleryFramingEngine.render(photo, { ...ONLY_MAT, matColor: color });
      expect(pixelAt(output, 4, 4)).toEqual([...expected]);
    }
  });
});

describe('纯棉纸纤维微噪点', () => {
  const photo = createPhoto();
  const textureOnly: FrameConfig = {
    layers: { bevel: false, insetShadow: false, stamp: false },
    paperTextureIntensity: 0.06,
  };

  it('修正方案在浅色卡纸上产生可见纹理', () => {
    const output = GalleryFramingEngine.render(photo, { ...textureOnly, matColor: '#F8F7F3' });
    const deviation = meanAbsDeviation(output, 2, 2, 80, 80);

    console.log('[纸纹] 暖白 · 乘算+滤色 =', deviation.toFixed(3));
    expect(deviation).toBeGreaterThan(0.5);
  });

  it('修正方案在炭黑卡纸上依然可见 —— 这是开发指南原方案失效的地方', () => {
    const corrected = GalleryFramingEngine.render(
      photo,
      { ...textureOnly, matColor: '#1C1C1E' },
      undefined,
      { paperTextureMode: 'multiply-screen' },
    );
    const legacy = GalleryFramingEngine.render(
      photo,
      { ...textureOnly, matColor: '#1C1C1E' },
      undefined,
      { paperTextureMode: 'soft-light' },
    );

    const correctedDeviation = meanAbsDeviation(corrected, 2, 2, 80, 80);
    const legacyDeviation = meanAbsDeviation(legacy, 2, 2, 80, 80);

    console.log(
      '[纸纹] 炭黑 · 乘算+滤色 =',
      correctedDeviation.toFixed(3),
      '/ soft-light =',
      legacyDeviation.toFixed(3),
    );

    expect(correctedDeviation).toBeGreaterThan(legacyDeviation * 2);
  });

  it('强度调大纹理随之增强 —— 原实现的缓存会让这里完全没反应', () => {
    const weak = GalleryFramingEngine.render(photo, {
      ...textureOnly,
      matColor: '#F8F7F3',
      paperTextureIntensity: 0.01,
    });
    const strong = GalleryFramingEngine.render(photo, {
      ...textureOnly,
      matColor: '#F8F7F3',
      paperTextureIntensity: 0.08,
    });

    const weakDeviation = meanAbsDeviation(weak, 2, 2, 80, 80);
    const strongDeviation = meanAbsDeviation(strong, 2, 2, 80, 80);

    console.log(
      '[纸纹] 强度 0.01 =',
      weakDeviation.toFixed(3),
      '/ 强度 0.08 =',
      strongDeviation.toFixed(3),
    );

    expect(strongDeviation).toBeGreaterThan(weakDeviation * 3);
  });

  it('绝不污染相片区域', () => {
    const withTexture = GalleryFramingEngine.render(photo, {
      ...textureOnly,
      matColor: '#F8F7F3',
    });
    const layout = GalleryFramingEngine.layout(photo, {});

    // 取照片内部的四角与中心，纹理层不得改动任何一个像素
    const probes: [number, number][] = [
      [layout.x + 3, layout.y + 3],
      [layout.x + layout.w - 4, layout.y + 3],
      [layout.x + 3, layout.y + layout.h - 4],
      [layout.x + layout.w - 4, layout.y + layout.h - 4],
      [layout.x + Math.round(layout.w / 2), layout.y + Math.round(layout.h / 2)],
    ];

    for (const [x, y] of probes) {
      const [r, g, b] = pixelAt(withTexture, x, y);
      expect([r, g, b]).toEqual([128, 128, 128]);
    }
  });
});

describe('45° 斜切白芯', () => {
  const photo = createPhoto();

  it('开窗外的切面带明显亮于卡纸底色', () => {
    const withBevel = GalleryFramingEngine.render(photo, {
      matColor: '#F8F7F3',
      bevelWidth: 2.5,
      layers: { paperTexture: false, insetShadow: false, stamp: false },
    });
    const withoutBevel = GalleryFramingEngine.render(photo, { ...ONLY_MAT, matColor: '#F8F7F3' });
    const layout = GalleryFramingEngine.layout(photo, {});

    const [bevelR] = pixelAt(withBevel, layout.x - 1, layout.y + 40);
    const [matR] = pixelAt(withoutBevel, layout.x - 1, layout.y + 40);

    expect(bevelR).toBeGreaterThan(matR);
    // 切芯本色是纯白，应当非常接近 255
    expect(bevelR).toBeGreaterThan(240);
  });

  it('切面不覆盖照片本体', () => {
    const output = GalleryFramingEngine.render(photo, {
      matColor: '#F8F7F3',
      layers: { paperTexture: false, insetShadow: false, stamp: false },
    });
    const layout = GalleryFramingEngine.layout(photo, {});
    const [r, g, b] = pixelAt(output, layout.x + 20, layout.y + 20);
    expect([r, g, b]).toEqual([128, 128, 128]);
  });
});

describe('相纸下落内阴影', () => {
  const photo = createPhoto();

  it('未启用时不改变相片像素', () => {
    const output = GalleryFramingEngine.render(photo, { ...ONLY_MAT });
    const layout = GalleryFramingEngine.layout(photo, {});
    const [top] = pixelAt(output, layout.x + Math.round(layout.w / 2), layout.y + 2);
    const [center] = pixelAt(
      output,
      layout.x + Math.round(layout.w / 2),
      layout.y + Math.round(layout.h / 2),
    );
    expect(top).toBe(center);
  });

  it('启用后上边缘被压暗，且方向梯度符合左上主光源', () => {
    const output = GalleryFramingEngine.render(photo, {
      matColor: '#F8F7F3',
      insetShadowBlur: 6,
      layers: { paperTexture: false, bevel: false, stamp: false, insetShadow: true },
    });
    const layout = GalleryFramingEngine.layout(photo, {});
    const midX = layout.x + Math.round(layout.w / 2);
    const midY = layout.y + Math.round(layout.h / 2);

    const top = pixelAt(output, midX, layout.y + 1)[0];
    const bottom = pixelAt(output, midX, layout.y + layout.h - 2)[0];
    const left = pixelAt(output, layout.x + 1, midY)[0];
    const right = pixelAt(output, layout.x + layout.w - 2, midY)[0];

    console.log('[内阴影] 上/下/左/右 =', top, bottom, left, right);

    // 四向都有过渡 —— 原实现只画了上、左，右下两条边完全没有
    expect(top).toBeLessThan(128);
    expect(bottom).toBeLessThan(128);
    expect(left).toBeLessThan(128);
    expect(right).toBeLessThan(128);

    // 左上为主光源，压暗强于右下
    expect(top).toBeLessThan(right);
    expect(left).toBeLessThan(right);
  });
});

describe('无墨立体钢印', () => {
  const photo = createPhoto();

  it('启用后在底边留白区留下压痕，关闭时该区域保持纯色', () => {
    const base: FrameConfig = {
      matColor: '#F8F7F3',
      cameraModel: 'LEICA M6',
      filmBrand: 'KODAK PORTRA 400',
      layers: { paperTexture: false, bevel: false, insetShadow: false },
    };

    const withStamp = GalleryFramingEngine.render(photo, { ...base, enableStamp: true });
    const withoutStamp = GalleryFramingEngine.render(photo, {
      ...base,
      enableStamp: false,
    });

    const layout = GalleryFramingEngine.layout(photo, {});
    const stampY = Math.round(layout.y + layout.h + (layout.canvasH - layout.y - layout.h) * 0.36);
    const x = layout.x + Math.round(layout.w / 2) - 200;

    const stamped = meanAbsDeviation(withStamp, x, stampY - 30, 400, 60);
    const plain = meanAbsDeviation(withoutStamp, x, stampY - 30, 400, 60);

    console.log('[钢印] 有 =', stamped.toFixed(3), '/ 无 =', plain.toFixed(3));

    expect(plain).toBeLessThan(0.01);
    expect(stamped).toBeGreaterThan(0.5);
  });

  it('炭黑卡纸上的钢印依然有可读的凹凸反差', () => {
    const output = GalleryFramingEngine.render(photo, {
      matColor: '#1C1C1E',
      enableStamp: true,
      layers: { paperTexture: false, bevel: false, insetShadow: false },
    });
    const layout = GalleryFramingEngine.layout(photo, {});
    const stampY = Math.round(layout.y + layout.h + (layout.canvasH - layout.y - layout.h) * 0.36);
    const x = layout.x + Math.round(layout.w / 2) - 200;
    const deviation = meanAbsDeviation(output, x, stampY - 30, 400, 60);

    console.log('[钢印] 炭黑反差 =', deviation.toFixed(3));

    expect(deviation).toBeGreaterThan(1);
  });
});

/** 逐层比对的差值。`rows[y]` 是第 y 行的变化像素数，下标即行号。 */
interface LayerDiff {
  rows: number[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  changed: number;
  strong: number;
  maxDelta: number;
}

/**
 * 把"有这一层"与"没有这一层"两张画布逐像素比对，顺便给出变化区域的包围盒与逐行分布。
 *
 * 判据取 `delta > 2` 而不是 `> 0`：渲染本身是确定性的（同一份配置渲两次逐点相同，
 * 已有控制实验确认），但两层叠印的抗锯齿边缘会落在 1~2 的量化误差里 ——
 * 卡在 0 上会把整块卡纸的渐变也算成"变化"。
 */
function diffLayers(canvas: HTMLCanvasElement, baseline: HTMLCanvasElement): LayerDiff {
  const a = canvas.getContext('2d');
  const b = baseline.getContext('2d');
  if (!a || !b) throw new Error('读取像素失败：无 2D 上下文');
  if (canvas.width !== baseline.width || canvas.height !== baseline.height) {
    throw new Error('两张画布尺寸不一致，无法逐像素比对');
  }

  const dataA = a.getImageData(0, 0, canvas.width, canvas.height).data;
  const dataB = b.getImageData(0, 0, baseline.width, baseline.height).data;

  const diff: LayerDiff = {
    rows: new Array<number>(canvas.height).fill(0),
    x0: canvas.width,
    x1: -1,
    y0: canvas.height,
    y1: -1,
    changed: 0,
    strong: 0,
    maxDelta: 0,
  };

  for (let i = 0; i < dataA.length; i += 4) {
    const delta = Math.max(
      Math.abs(dataA[i] - dataB[i]),
      Math.abs(dataA[i + 1] - dataB[i + 1]),
      Math.abs(dataA[i + 2] - dataB[i + 2]),
    );
    if (delta <= 2) continue;

    const pixel = i / 4;
    const x = pixel % canvas.width;
    const y = Math.floor(pixel / canvas.width);

    diff.changed += 1;
    diff.rows[y] += 1;
    if (delta > diff.maxDelta) diff.maxDelta = delta;
    if (delta > 8) diff.strong += 1;
    if (x < diff.x0) diff.x0 = x;
    if (x > diff.x1) diff.x1 = x;
    if (y < diff.y0) diff.y0 = y;
    if (y > diff.y1) diff.y1 = y;
  }

  return diff;
}

/** 一段时间内最长的连续空白行数 —— 用来判断一枚印中间有没有断成两截。 */
function longestEmptyRun(rows: readonly number[], from: number, to: number): number {
  let run = 0;
  let longest = 0;
  for (let y = from; y <= to; y += 1) {
    run = rows[y] === 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * 钢印的尺寸与构图。
 *
 * 这一组是"钢印太小、太不明显"那轮反馈留下的护栏。那条反馈没有给数字，
 * 所以先把抱怨量成指标 —— 墨迹占画布宽多少、图标与文字之间的空隙是字高的几倍 ——
 * 再对着指标改，改完拿同一套指标复核。这几个断言就是那套指标本身。
 */
describe('无墨立体钢印 · 尺寸与构图', () => {
  const photo = createPhoto();

  /**
   * 只关钢印的基线。
   *
   * 踩过一次：顺手把纸纹/倒角/内阴影一起关掉当基线，diff 圈出来的是**整块卡纸**
   * （变化占画布 32.9%），看起来像"钢印盖满了全图"。
   * 基线必须只差被测的那一层，否则量到的是别的材质。
   */
  const WITHOUT_STAMP: Partial<FrameConfig> = {
    matColor: '#F8F7F3',
    cameraModel: 'LEICA M6',
    filmBrand: 'KODAK PORTRA 400',
    layers: { paperTexture: false, bevel: false, insetShadow: false, stamp: false },
  };
  const WITH_STAMP: Partial<FrameConfig> = {
    ...WITHOUT_STAMP,
    layers: { ...WITHOUT_STAMP.layers, stamp: true },
  };

  it('图标与文字之间的净空隙小于字高 —— 两者读成一枚印，而不是两枚记号', () => {
    const layout = GalleryFramingEngine.layout(photo, {});
    const geometry = stampGeometry(layout);

    console.log(
      `[钢印构图] 图标名义 ${geometry.iconSize}、实际占位 ${geometry.iconWidth.toFixed(1)}×` +
        `${geometry.iconHeight.toFixed(1)}；文字 ${geometry.fontSize}px；` +
        `净空隙 ${geometry.netGap.toFixed(1)}px = 字高的 ${(geometry.netGap / geometry.fontSize).toFixed(2)} 倍`,
    );

    // 根因就在这里：原先"图标 26、间距也 26"看起来整齐，实际图标只有 0.6 × 26 高，
    // 间距里剩下的一半比 9.5px 的字还高 —— 图标与文字被读成两个互不相干的记号。
    expect(geometry.netGap).toBeLessThan(geometry.fontSize);
    // 但也不能糊到一起
    expect(geometry.netGap).toBeGreaterThan(0);
  });

  it('像素上也是一枚连着的印：图标与文字之间没有空白横行', () => {
    const layout = GalleryFramingEngine.layout(photo, {});
    const geometry = stampGeometry(layout);

    const diff = diffLayers(
      GalleryFramingEngine.render(photo, WITH_STAMP),
      GalleryFramingEngine.render(photo, WITHOUT_STAMP),
    );
    const gap = longestEmptyRun(diff.rows, diff.y0, diff.y1);

    console.log(
      `[钢印像素] 包围盒 ${diff.x1 - diff.x0 + 1}×${diff.y1 - diff.y0 + 1}，` +
        `最长空白横行 ${gap}px（字高 ${geometry.fontSize}px）`,
    );

    // 上面那条几何断言依赖 CAMERA_VECTOR_*_UNITS 与路径同步。这里是它的兜底：
    // 就算那几个常量跟路径走散了，只要中间真的裂出一条比字还高的空白，
    // 这条就会红 —— 而它量的正是用户实际会看到的东西。
    expect(gap).toBeLessThan(geometry.fontSize);
  });

  it('墨迹宽度不低于画布宽的 11% —— 低于这个数，界面上缩到三分之一就只剩几个 CSS 像素', () => {
    const preview = GalleryFramingEngine.render(photo, WITH_STAMP);
    const diff = diffLayers(preview, GalleryFramingEngine.render(photo, WITHOUT_STAMP));
    const widthRatio = (diff.x1 - diff.x0 + 1) / preview.width;

    console.log(
      `[钢印尺寸] 墨迹宽 ${diff.x1 - diff.x0 + 1}px / 画布 ${preview.width}px = ${(widthRatio * 100).toFixed(1)}%`,
    );

    // 改之前是 8.8%，改成 38 / 14 / 3.5 之后是 12.9%。11% 这条线卡在中间，
    // 既是"确实变大了"的证据，也不至于把尺寸钉死到某一个像素。
    expect(widthRatio).toBeGreaterThan(0.11);
  });

  it('再长的机型名也留在照片宽度内、也留在底边带内', () => {
    const longModel = 'HASSELBLAD 503CW';
    const longFilm = 'KODAK EKTACHROME E100';

    const layout = GalleryFramingEngine.layout(photo, {});
    const canvas = GalleryFramingEngine.render(photo, {
      ...WITH_STAMP,
      cameraModel: longModel,
      filmBrand: longFilm,
    });
    const diff = diffLayers(
      canvas,
      GalleryFramingEngine.render(photo, {
        ...WITHOUT_STAMP,
        cameraModel: longModel,
        filmBrand: longFilm,
      }),
    );

    const label = `${longModel}   /   ${longFilm}`;
    console.log(
      `[钢印长名] ${label.length} 字 → 墨迹 x${diff.x0}..${diff.x1}` +
        `（照片 x${layout.x}..${layout.x + layout.w}），下沿距画布底 ${canvas.height - diff.y1 - 1}px`,
    );

    // 钢印放大之后最容易出的事故：文字比照片还宽，压在卡纸上。
    expect(diff.x0).toBeGreaterThanOrEqual(layout.x);
    expect(diff.x1).toBeLessThanOrEqual(layout.x + layout.w);
    expect(diff.y1).toBeLessThan(canvas.height);
  });

  it('下压深度逐档可辨 —— 滑杆不能是死的', () => {
    const depths = [1.2, 1.5, 1.8];
    const counts = depths.map(
      (stampDepth) =>
        diffLayers(
          GalleryFramingEngine.render(photo, { ...WITH_STAMP, stampDepth }),
          GalleryFramingEngine.render(photo, { ...WITHOUT_STAMP, stampDepth }),
        ).changed,
    );

    console.log(`[钢印深度] ${depths.map((d, i) => `${d} → ${counts[i]}px`).join('，')}`);

    // 回归的是这一条：`scaledPx(options.stampDepth, …, 0.8)` 把位移舍成了整数，
    // 预览尺度（scale ≈ 1.31）上 1.2 / 1.5 / 1.8 都落到同一个 2px，
    // 三个档位渲出来**逐点相同** —— 用户把滑杆拖过去，画面一点不动。
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).not.toBe(counts[i - 1]);
    }
    // 更深的档位应当压出更多变化，而不是只在数值上换了个数
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0]);
  });
});

describe('图层开关', () => {
  const photo = createPhoto();

  it('全部关闭时卡纸是纯色，没有任何纹理残留', () => {
    const output = GalleryFramingEngine.render(photo, {
      matColor: '#F8F7F3',
      layers: {
        mat: true,
        paperTexture: false,
        bevel: false,
        insetShadow: false,
        stamp: false,
      },
    });
    const deviation = meanAbsDeviation(output, 2, 2, 80, 80);
    expect(deviation).toBeLessThan(0.01);
  });

  it('每一层只在各自的作用区域生效，不会越界影响别处', () => {
    // 用炭黑卡纸做底：浅色卡纸上的高光与纯色太接近，判定不出方向
    const allOff: FrameConfig = {
      matColor: '#1C1C1E',
      layers: {
        mat: true,
        paperTexture: false,
        bevel: false,
        insetShadow: false,
        stamp: false,
      },
    };
    const withLayer = (layer: 'paperTexture' | 'bevel' | 'insetShadow' | 'stamp'): FrameConfig => ({
      ...allOff,
      layers: { ...allOff.layers, [layer]: true },
    });

    const layout = GalleryFramingEngine.layout(photo, {});
    const midX = layout.x + Math.round(layout.w / 2);
    const stampY = layout.y + layout.h + Math.round(140 * 0.36);

    const base = GalleryFramingEngine.render(photo, allOff);
    const baseCorner = pixelAt(base, 2, 2)[0];
    const baseBevelSide = pixelAt(base, layout.x - 2, layout.y + 40)[0];
    const basePhotoTop = pixelAt(base, midX, layout.y + 1)[0];

    expect(baseCorner).toBe(28);
    expect(basePhotoTop).toBe(128);

    // 纸纹：作用于整片卡纸（所以角落像素本身会变），但绝不能进入相片
    const textured = GalleryFramingEngine.render(photo, {
      ...withLayer('paperTexture'),
      paperTextureIntensity: 0.06,
    });
    expect(meanAbsDeviation(textured, 2, 2, 80, 80)).toBeGreaterThan(0.5);
    expect(pixelAt(textured, midX, layout.y + 1)[0]).toBe(basePhotoTop);

    // 倒角：只加一圈白芯，角落仍是卡纸本色
    const beveled = GalleryFramingEngine.render(photo, withLayer('bevel'));
    expect(baseBevelSide).toBe(28);
    expect(pixelAt(beveled, layout.x - 2, layout.y + 40)[0]).toBeGreaterThan(200);
    expect(pixelAt(beveled, 2, 2)[0]).toBe(baseCorner);

    // 内阴影：只压暗相纸内侧
    const shadowed = GalleryFramingEngine.render(photo, withLayer('insetShadow'));
    expect(pixelAt(shadowed, midX, layout.y + 1)[0]).toBeLessThan(basePhotoTop);
    expect(pixelAt(shadowed, 2, 2)[0]).toBe(baseCorner);

    // 钢印：只在底边留白留下压痕
    const stamped = GalleryFramingEngine.render(photo, withLayer('stamp'));
    const stampDeviation = meanAbsDeviation(
      stamped,
      layout.x + Math.round(layout.w / 2) - 200,
      stampY - 30,
      400,
      60,
    );
    expect(stampDeviation).toBeGreaterThan(1);
    expect(pixelAt(stamped, 2, 2)[0]).toBe(baseCorner);
  });
});

describe('drawTrackedText · 钢印文字必须与相机图标同心', () => {
  /** 取整块画布上墨迹（alpha 明显不为 0 的像素）的左右边界。 */
  function inkSpan(canvas: HTMLCanvasElement): { minX: number; maxX: number; center: number } {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('读取像素失败：无 2D 上下文');

    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] <= 8) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }

    return { minX, maxX, center: (minX + maxX) / 2 };
  }

  it('墨迹中心落在请求的中心上，不随字距偏移', () => {
    const canvas = createNapiCanvas(800, 120);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('测试画布创建失败');

    ctx.fillStyle = '#000000';
    ctx.font = '600 24px sans-serif';

    const CENTER = 400;
    const TRACKING = 4;
    drawTrackedText(ctx, 'LEICA M6', CENTER, 60, TRACKING);

    // 这条断言就是拦住"改用原生 ctx.letterSpacing 更省事"那次改动的：
    // 原生实现把末尾字距也算进居中宽度，实测整体左偏 tracking/2 = 2.00px，
    // 于是文字与它上方那台按几何中心画的相机图标错开。
    const span = inkSpan(canvas);
    expect(span.maxX).toBeGreaterThan(span.minX);
    expect(Math.abs(span.center - CENTER)).toBeLessThanOrEqual(1);
  });

  it('按每字宽度累加，且末尾字距不计入居中宽度', () => {
    const drawn: { text: string; x: number }[] = [];
    const ctx = Object.create(null) as CanvasRenderingContext2D;
    Object.assign(ctx, {
      textAlign: 'left',
      textBaseline: 'middle',
      measureText: (text: string) => ({ width: text.length * 10 }),
      fillText: (text: string, x: number) => {
        drawn.push({ text, x });
      },
    });

    drawTrackedText(ctx, 'ABC', 100, 50, 4);

    // 三字各宽 10，字距 4，墨迹总宽 10 + 4 + 10 + 4 + 10 = 38，
    // 因此首字左边缘在 100 - 19 = 81
    expect(drawn.map((item) => item.x)).toEqual([81, 95, 109]);
    expect(drawn.map((item) => item.text)).toEqual(['A', 'B', 'C']);
  });

  it('单字不带尾随字距，仍然居中', () => {
    const drawn: { x: number }[] = [];
    const ctx = Object.create(null) as CanvasRenderingContext2D;
    Object.assign(ctx, {
      textAlign: 'left',
      textBaseline: 'middle',
      measureText: () => ({ width: 20 }),
      fillText: (_text: string, x: number) => {
        drawn.push({ x });
      },
    });

    drawTrackedText(ctx, 'M', 100, 50, 4);
    expect(drawn.map((item) => item.x)).toEqual([90]);
  });
});

/**
 * 空白成品自检。
 *
 * 这条自检要拦的是一个**不会报错**的失败：画布超出浏览器能力时，
 * getContext 照样给上下文，绘制调用也照样返回，只是像素没落上去；
 * toBlob 于是交出一张纯白图。用户等完进度条得到的是一张什么都没有的图，
 * 而且没有任何线索指向原因。所以必须真的读像素来判断。
 */
describe('空白成品自检', () => {
  /** 五个图层全关：画布上不会有任何强制绘制，只剩照片自己。 */
  const NO_LAYERS: FrameConfig = {
    layers: {
      mat: false,
      paperTexture: false,
      bevel: false,
      insetShadow: false,
      stamp: false,
    },
  };

  /** 有内容但**完全不透明**的照片。 */
  function opaquePhoto(): RenderSource {
    const canvas = createNapiCanvas(200, 150);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('测试照片创建失败');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 200, 150);
    return canvas;
  }

  /** 一张从没被画过的画布 —— 它留在那儿的就是全透明的初始状态。 */
  function untouchedCanvas(width: number, height: number): HTMLCanvasElement {
    return createNapiCanvas(width, height);
  }

  it('一个像素都没落上去的画布判为空白', () => {
    expect(isBlankCanvas(untouchedCanvas(64, 64))).toBe(true);
  });

  it('铺过卡纸底色的画布不判为空白', () => {
    const photo = opaquePhoto();
    const framed = GalleryFramingEngine.render(photo, {});
    // 卡纸底色铺满整张画布，所以第一个取样点（正中心）就已经不透明
    expect(isBlankCanvas(framed)).toBe(false);
  });

  it('判据是不透明度而不是颜色：纯黑成品不算空白', () => {
    const black = createNapiCanvas(120, 90);
    const ctx = black.getContext('2d');
    if (!ctx) throw new Error('测试画布创建失败');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 120, 90);

    // 用颜色判会在这里误报 —— 炭黑卡纸与夜景照片的取样点本来就是黑的
    expect(isBlankCanvas(black)).toBe(false);
  });

  it('画布静默失效时，导出抛可读错误而不是交出一张白图', async () => {
    // 直接替掉渲染这一步，模拟"尺寸没超但像素就是上不去"的那种画布
    const spy = vi
      .spyOn(GalleryFramingEngine, 'render')
      .mockReturnValue(untouchedCanvas(4096, 4096));

    await expect(GalleryFramingEngine.exportBlob(opaquePhoto(), {})).rejects.toThrow(
      /成品是空白的/,
    );
    // 报错里必须带上尺寸，否则用户不知道要调小到多少
    await expect(GalleryFramingEngine.exportBlob(opaquePhoto(), {})).rejects.toThrow(/4096×4096/);

    spy.mockRestore();
  });

  it('图层全关但照片不透明时照常导出', async () => {
    // 对照组：证明上一道检查认的是"全透明"，不是"没铺卡纸底色"
    const blob = await GalleryFramingEngine.exportBlob(opaquePhoto(), NO_LAYERS);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('图层全关且照片本身透明时判为空白（故意的空也拦）', async () => {
    const transparent = untouchedCanvas(200, 150) as unknown as RenderSource;
    await expect(GalleryFramingEngine.exportBlob(transparent, NO_LAYERS)).rejects.toThrow(
      /成品是空白的/,
    );
  });
});
