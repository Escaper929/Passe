import { createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getFiberTile, resetFiberTiles, type FiberPolarity } from '@/engine/noise';

/**
 * 纸纹瓦片的性质测试。
 *
 * 这一层是阶段 5 视觉回归的**地基**：只要瓦片还是随机的，
 * 「同一输入 → 同一像素」就不成立，基线比对无从谈起。
 * 所以这里锁的不只是"噪声好不好看"，而是**可复现性**本身，
 * 外加几条统计性质 —— 换哈希实现时不能把均匀性换没了（那会变成可见的花纹）。
 */

const TILE_SIZE = 256;

function createNapiCanvas(width = 1, height = 1): HTMLCanvasElement {
  return createCanvas(width, height) as unknown as HTMLCanvasElement;
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

const POLARITIES: readonly FiberPolarity[] = ['shadow', 'light', 'neutral'];

function readTile(polarity: FiberPolarity): Uint8ClampedArray {
  const tile = getFiberTile(polarity);
  const ctx = tile.getContext('2d');
  if (!ctx) throw new Error('读取瓦片失败：无 2D 上下文');
  return ctx.getImageData(0, 0, tile.width, tile.height).data;
}

describe('纸纹瓦片 · 可复现性', () => {
  it('瓦片尺寸固定为 256×256', () => {
    const tile = getFiberTile('neutral');
    expect(tile.width).toBe(TILE_SIZE);
    expect(tile.height).toBe(TILE_SIZE);
  });

  it('清掉缓存重建后逐像素一致 —— 视觉回归基线能成立的前提', () => {
    for (const polarity of POLARITIES) {
      resetFiberTiles();
      const first = readTile(polarity);
      resetFiberTiles();
      const second = readTile(polarity);

      // 逐点比完，出问题时能直接看出差在哪个像素
      expect(Array.from(second)).toEqual(Array.from(first));
    }
  });

  it('同一极性重复取用拿的是同一张瓦片（缓存生效、与参数解耦）', () => {
    resetFiberTiles();
    expect(getFiberTile('neutral')).toBe(getFiberTile('neutral'));
  });

  it('三种极性互不相关：同一坐标上的取值不会大面积重合', () => {
    resetFiberTiles();
    const shadow = readTile('shadow');
    const light = readTile('light');

    let identical = 0;
    for (let i = 0; i < shadow.length; i += 4) {
      if (shadow[i] === light[i]) identical += 1;
    }
    // 随机相撞的概率约 1/256；大面积相等说明种子没参与混淆
    expect(identical).toBeLessThan((shadow.length / 4) * 0.02);
  });
});

describe('纸纹瓦片 · 统计性质', () => {
  it('中立瓦片双向扰动：中值两侧都有取值', () => {
    resetFiberTiles();
    const neutral = readTile('neutral');

    let below = 0;
    let above = 0;
    for (let i = 0; i < neutral.length; i += 4) {
      if (neutral[i] < 128) below += 1;
      else if (neutral[i] > 128) above += 1;
    }
    const total = neutral.length / 4;
    expect(below / total).toBeGreaterThan(0.45);
    expect(above / total).toBeGreaterThan(0.45);
  });

  it('取值均匀铺满 0~255，不聚集在某个区间', () => {
    resetFiberTiles();
    const neutral = readTile('neutral');

    const buckets = new Array<number>(16).fill(0);
    for (let i = 0; i < neutral.length; i += 4) {
      buckets[Math.min(15, Math.floor(neutral[i] / 16))] += 1;
    }

    const expected = neutral.length / 4 / 16;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(expected * 0.9);
      expect(count).toBeLessThan(expected * 1.1);
    }
  });

  it('没有竖条纹结构：任一列内部铺满整个取值域', () => {
    resetFiberTiles();
    const tile = getFiberTile('neutral');
    const ctx = tile.getContext('2d');
    if (!ctx) throw new Error('读取瓦片失败：无 2D 上下文');
    const { data } = ctx.getImageData(0, 0, tile.width, tile.height);

    const columnSpread = (x: number): number => {
      let min = 255;
      let max = 0;
      for (let y = 0; y < tile.height; y += 1) {
        const v = data[(y * tile.width + x) * 4];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return max - min;
    };

    // "整列同值"就是竖条纹的来源，逐列铺满说明列与列之间没有被哈希串起来
    for (let x = 0; x < 32; x += 1) {
      expect(columnSpread(x)).toBeGreaterThan(200);
    }
  });

  it('没有横条纹结构：任一行内部铺满整个取值域', () => {
    resetFiberTiles();
    const tile = getFiberTile('neutral');
    const ctx = tile.getContext('2d');
    if (!ctx) throw new Error('读取瓦片失败：无 2D 上下文');
    const { data } = ctx.getImageData(0, 0, tile.width, tile.height);

    const rowSpread = (y: number): number => {
      let min = 255;
      let max = 0;
      for (let x = 0; x < tile.width; x += 1) {
        const v = data[(y * tile.width + x) * 4];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return max - min;
    };

    for (let y = 0; y < 32; y += 1) {
      expect(rowSpread(y)).toBeGreaterThan(200);
    }
  });

  it('四通道写入正确：RGB 同值、Alpha 满值', () => {
    resetFiberTiles();
    const neutral = readTile('neutral');
    for (let i = 0; i < 4000; i += 4) {
      expect(neutral[i + 1]).toBe(neutral[i]);
      expect(neutral[i + 2]).toBe(neutral[i]);
      expect(neutral[i + 3]).toBe(255);
    }
  });
});
