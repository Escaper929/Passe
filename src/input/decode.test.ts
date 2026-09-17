import { createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  decodeInSequence,
  decodeWorkingCopy,
  describeDecodeError,
  planWorkingCopy,
  reopenFullResolution,
  WORKING_MAX_PIXELS,
  WORKING_SHORT_SIDE,
} from './decode';

/**
 * 解码相关测试。
 *
 * jsdom 既没有 2D 画布也没有 createImageBitmap，两样都接上真实实现，
 * 这样"降采样后位图有没有被释放"才是可断言的事实，而不是靠读代码相信。
 */

/** 造一个带 close 的真实位图替身：像素真实、可被 drawImage 消费。 */
function fakeBitmap(width: number, height: number) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, width, height);

  const close = vi.fn();
  Object.defineProperty(canvas, 'close', { value: close, configurable: true });
  return { bitmap: canvas as unknown as ImageBitmap, close };
}

let lastBitmap: { bitmap: ImageBitmap; close: ReturnType<typeof vi.fn> } | null = null;

function stubDecode(width: number, height: number) {
  lastBitmap = fakeBitmap(width, height);
  return lastBitmap;
}

beforeAll(() => {
  const native = Document.prototype.createElement;
  vi.spyOn(document, 'createElement').mockImplementation(function (
    this: Document,
    tagName: string,
    options?: ElementCreationOptions,
  ) {
    if (tagName.toLowerCase() === 'canvas') {
      return createCanvas(1, 1) as unknown as HTMLElement;
    }
    return native.call(document, tagName as 'div', options);
  } as typeof document.createElement);

  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      if (!lastBitmap) throw new Error('测试未预设位图');
      return lastBitmap.bitmap;
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('解码 · 工作副本尺寸决策', () => {
  it('短边未超限时不做任何缩放', () => {
    const plan = planWorkingCopy(1200, 900, 2400);
    expect(plan.needsDownscale).toBe(false);
    expect(plan.ratio).toBe(1);
    expect(plan.width).toBe(1200);
    expect(plan.height).toBe(900);
  });

  it('超限时按短边压到上限，长宽比保持不变', () => {
    // 短边 6000 压到 2400，比例 0.4 → 3200 × 2400
    const plan = planWorkingCopy(8000, 6000, 2400);
    expect(plan.needsDownscale).toBe(true);
    expect(plan.width).toBe(3200);
    expect(plan.height).toBe(2400);
    expect(plan.width / plan.height).toBeCloseTo(8000 / 6000, 6);
  });

  it('全景扫描件不该被误判为需要按短边缩放', () => {
    // 4000 × 1600：min(W,H) = 1600 ≤ 2400，像素 6.4MP ≤ 9MP，两项都没踩线。
    // 早期实现按"长边是否超过上限"判断，会把这张图误缩放，还顺带关掉正要返回的位图。
    const plan = planWorkingCopy(4000, 1600, 2400, 9e6);
    expect(plan.needsDownscale).toBe(false);
    expect(plan.width).toBe(4000);
    expect(plan.height).toBe(1600);
  });

  it('极端画幅由像素上限兜底 —— 只卡短边会漏掉 57MP 的全景接片', () => {
    // 24000 × 2400 的接片：短边才 2400，看似"没超限"，
    // 实际是 57.6MP（230MB）。像素上限必须接管。
    const plan = planWorkingCopy(24000, 2400, 2400, 9e6);
    expect(plan.needsDownscale).toBe(true);
    expect(plan.width * plan.height).toBeLessThanOrEqual(9e6 * 1.01);
    expect(plan.width / plan.height).toBeCloseTo(10, 2);
  });

  it('两个约束取更严格的那个', () => {
    // 短边约束给出 0.4，像素约束给出 0.433，应当取 0.4
    const plan = planWorkingCopy(8000, 6000, 2400, 9e6);
    expect(plan.ratio).toBeCloseTo(0.4, 6);

    // 反过来：短边达标但像素超标时，由像素约束决定
    const wide = planWorkingCopy(6000, 1000, 2400, 9e6);
    expect(wide.width * wide.height).toBeLessThanOrEqual(9e6 * 1.01);
  });

  it('极小图不会被算成 0 像素', () => {
    const plan = planWorkingCopy(3000, 2, 2400, 9e6);
    expect(plan.height).toBeGreaterThanOrEqual(1);
  });

  it('默认上限是短边 2400 与 900 万像素', () => {
    expect(WORKING_SHORT_SIDE).toBe(2400);
    expect(WORKING_MAX_PIXELS).toBe(9e6);
    expect(planWorkingCopy(9000, 9000).width).toBe(2400);
    expect(planWorkingCopy(9000, 9000).height).toBe(2400);
  });
});

describe('解码 · 工作副本生成与释放', () => {
  it('需要降采样时返回画布，并立即释放原始位图', async () => {
    const { close } = stubDecode(8000, 6000);

    const result = await decodeWorkingCopy(new Blob(['x']), { maxShortSide: 2400 });

    expect(result.downscaled).toBe(true);
    expect(result.width).toBe(3200);
    expect(result.height).toBe(2400);
    expect(result.source).toBeInstanceOf(Object);
    // 像素已经落到画布上，原图必须当场释放，否则 400MB 就留下了
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('原始尺寸单独带出来 —— 导出与内存守卫都要用它', async () => {
    stubDecode(20000, 15000);

    const result = await decodeWorkingCopy(new Blob(['x']));

    // 工作副本被压到 9MP 以内
    expect(result.width * result.height).toBeLessThanOrEqual(9e6 * 1.01);
    expect(result.downscaled).toBe(true);
    // 但原始尺寸必须原样保留：拿工作副本尺寸去评估导出会低估一个数量级
    expect(result.originalWidth).toBe(20000);
    expect(result.originalHeight).toBe(15000);
  });

  it('无需降采样时原始尺寸与工作副本尺寸相同', async () => {
    stubDecode(1200, 900);
    const result = await decodeWorkingCopy(new Blob(['x']));
    expect(result.originalWidth).toBe(result.width);
    expect(result.originalHeight).toBe(result.height);
  });

  it('不需要降采样时直接交出位图本身，且绝不能 close 它', async () => {
    const { bitmap, close } = stubDecode(1200, 900);

    const result = await decodeWorkingCopy(new Blob(['x']), { maxShortSide: 2400 });

    expect(result.downscaled).toBe(false);
    expect(result.source).toBe(bitmap);
    // 返回的就是它本人，close 掉等于把结果废了
    expect(close).not.toHaveBeenCalled();
  });

  it('宽幅图走免降采样分支，位图不会被误关', async () => {
    const { bitmap, close } = stubDecode(4000, 1600);

    const result = await decodeWorkingCopy(new Blob(['x']), { maxShortSide: 2400 });

    expect(result.downscaled).toBe(false);
    expect(result.source).toBe(bitmap);
    expect(close).not.toHaveBeenCalled();
    expect(result.width).toBe(4000);
  });

  it('调大短边上限也不会突破像素上限 —— 内存约束不可被绕过', async () => {
    stubDecode(9000, 6000);
    const result = await decodeWorkingCopy(new Blob(['x']), { maxShortSide: 4500 });
    expect(result.width * result.height).toBeLessThanOrEqual(9e6 * 1.01);
  });

  it('两个上限都可注入，便于导出路径复用同一套逻辑', async () => {
    stubDecode(9000, 6000);
    const result = await decodeWorkingCopy(new Blob(['x']), {
      maxShortSide: 4500,
      maxPixels: 1e8,
    });
    expect(result.width).toBe(6750);
    expect(result.height).toBe(4500);
  });

  it('解码本身失败时把异常抛给调用方，由它翻译成用户语言', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      }),
    );

    await expect(decodeWorkingCopy(new Blob(['x']))).rejects.toThrow(/could not be decoded/);

    // 还原，避免影响后续用例
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => lastBitmap?.bitmap),
    );
  });
});

describe('解码 · 顺序执行', () => {
  it('逐张解码，顺序与入参一致', async () => {
    const order: number[] = [];
    const result = await decodeInSequence([1, 2, 3], async (n) => {
      order.push(n);
    });

    expect(order).toEqual([1, 2, 3]);
    expect(result.done).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it('串行而非并行 —— 峰值内存只等于单张', async () => {
    // 若写成 Promise.all，这里的并发计数会等于 3
    let concurrent = 0;
    let peak = 0;

    await decodeInSequence([1, 2, 3], async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      concurrent -= 1;
    });

    expect(peak).toBe(1);
  });

  it('shouldContinue 为假时跳过该条目，且不影响其余条目', async () => {
    const decoded: number[] = [];
    const alive = new Set([1, 3]);

    const result = await decodeInSequence(
      [1, 2, 3],
      async (n) => {
        decoded.push(n);
      },
      { shouldContinue: (n) => alive.has(n) },
    );

    expect(decoded).toEqual([1, 3]);
    expect(result.done).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('进度回调与完成数同步', async () => {
    const seen: [number, number][] = [];
    await decodeInSequence(['a', 'b'], async () => {}, {
      onProgress: (done, total) => seen.push([done, total]),
    });

    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('单个条目抛错会向上冒泡，不静默吞掉', async () => {
    await expect(
      decodeInSequence([1], async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('解码 · 全分辨率重解', () => {
  it('导出路径拿到的仍是原始像素，不受工作副本上限影响', async () => {
    const { bitmap } = stubDecode(9000, 6000);
    const full = await reopenFullResolution(new Blob(['x']));
    expect(full).toBe(bitmap);
    expect(full.width).toBe(9000);
    expect(full.height).toBe(6000);
  });
});

describe('解码 · 错误文案', () => {
  it('把浏览器的解码报错翻译成可执行的建议', () => {
    const message = describeDecodeError(
      new DOMException('The source image could not be decoded.', 'InvalidStateError'),
      'IMG_0001.heic',
    );
    expect(message).toContain('IMG_0001.heic');
    expect(message).toContain('HEIC');
    expect(message).toContain('导出为 PNG 或 JPEG');
  });

  it('内存不足走单独一条建议 —— 让用户去清空队列而不是换格式', () => {
    const message = describeDecodeError(new Error('out of memory'), 'big.tif');
    expect(message).toContain('内存不足');
    expect(message).toContain('移除');
  });

  it('认不出的错误也保留原始信息，便于排查', () => {
    const message = describeDecodeError(new Error('奇怪的失败'), 'a.jpg');
    expect(message).toContain('奇怪的失败');
  });

  it('非 Error 对象也能处理，不会抛出二次异常', () => {
    expect(() => describeDecodeError('字符串错误', 'a.jpg')).not.toThrow();
    expect(describeDecodeError('字符串错误', 'a.jpg')).toContain('字符串错误');
  });
});
