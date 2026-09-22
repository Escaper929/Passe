import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CANVAS_PROBE_CANDIDATES,
  CANVAS_SAFETY,
  MAX_CANVAS_PIXELS,
  canRenderOnCanvas,
  computeCanvasLimit,
  probeMaxCanvasPixels,
  resetCanvasLimitCache,
  resolveCanvasLimit,
} from './canvasLimit';

/**
 * 画布上限探测。
 *
 * 全部用**假画布**跑 —— 这个模块的真身会去分配 16.7M～67.1M 像素的画布
 * （最大约 268MB），测试里绝不能真的建出来。所以依赖全部注入，
 * 断言的是"策略对不对"，而不是"这台机器能画多大"。
 */

const SMALL = 4096 * 4096;
const MID = 5792 * 5792;
const LARGE = 8192 * 8192;

interface FakeCanvas {
  width: number;
  height: number;
  getContext: (id: string) => unknown;
}

/**
 * 造一个"面积超过 ceiling 就失效"的假画布工厂。
 *
 * `log` 记录每次实际读像素时的面积 —— 靠它断言"没试不该试的那一档"。
 */
function factoryWithCeiling(ceiling: number, log: number[] = []): () => HTMLCanvasElement {
  return () => {
    const canvas: FakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect: () => undefined,
        getImageData: () => {
          const area = canvas.width * canvas.height;
          log.push(area);
          // 真实 Safari 的行为：超限时读像素直接抛
          if (area > ceiling) throw new Error('Canvas area exceeds the maximum limit');
          return { data: new Uint8ClampedArray([0xff, 0x00, 0x00, 0xff]) };
        },
      }),
    };
    return canvas as unknown as HTMLCanvasElement;
  };
}

/** 画得上去，但读回来是空的 —— Safari 那类"静默失效"的画布。 */
function factorySilentlyBlank(): () => HTMLCanvasElement {
  return () =>
    ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect: () => undefined,
        getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }),
      }),
    }) as unknown as HTMLCanvasElement;
}

/** 连 2D 上下文都拿不到（jsdom 的默认行为）。 */
function factoryWithoutContext(): () => HTMLCanvasElement {
  return () => ({ width: 0, height: 0, getContext: () => null }) as unknown as HTMLCanvasElement;
}

afterEach(() => {
  resetCanvasLimitCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('画布上限 · 单张画布能不能画', () => {
  it('能画上去也读得回来 → 通过', () => {
    expect(canRenderOnCanvas(64, 64, factoryWithCeiling(Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  it('拿不到 2D 上下文 → 不通过', () => {
    expect(canRenderOnCanvas(64, 64, factoryWithoutContext())).toBe(false);
  });

  it('读像素抛错（超限）→ 不通过', () => {
    expect(canRenderOnCanvas(64, 64, factoryWithCeiling(1024))).toBe(false);
  });

  it('画得上去但读回来是空的 → 不通过', () => {
    // 这条是重点：只看 getContext 是否为 null 会把它判成"可用"，
    // 而它在真实浏览器里就是那张静默的白图。
    expect(canRenderOnCanvas(64, 64, factorySilentlyBlank())).toBe(false);
  });
});

describe('画布上限 · 升序探测', () => {
  it('三档全过 → 取最大的一档', () => {
    const probe = probeMaxCanvasPixels({
      createCanvas: factoryWithCeiling(Number.MAX_SAFE_INTEGER),
    });
    expect(probe).toBe(LARGE);
  });

  it('卡在最高一档 → 取中间档，失败即停', () => {
    const log: number[] = [];
    const probe = probeMaxCanvasPixels({ createCanvas: factoryWithCeiling(MID, log) });

    expect(probe).toBe(MID);
    // 升序 + 失败即停：最大那档是**最后**被试的，试过就收手。
    // 那条 268MB 的分配只发生在已经扛住 33.5M 的机器上，这就是升序的安全意义。
    expect(log).toEqual([SMALL, MID, LARGE]);
  });

  it('第一档就不过 → 返回 0（交给上层退回原常量）', () => {
    const log: number[] = [];
    expect(probeMaxCanvasPixels({ createCanvas: factoryWithCeiling(0, log) })).toBe(0);
    // 只试了最小的一档就收手
    expect(log).toEqual([SMALL]);
  });

  it('候选表本身是升序的', () => {
    const sorted = [...CANVAS_PROBE_CANDIDATES].sort((a, b) => a - b);
    expect([...CANVAS_PROBE_CANDIDATES]).toEqual(sorted);
  });
});

describe('画布上限 · 策略', () => {
  it('桌面不探测 —— 一次画布都不建，直接沿用原常量', () => {
    const log: number[] = [];
    const limit = computeCanvasLimit({
      isTouchPrimary: () => false,
      createCanvas: factoryWithCeiling(Number.MAX_SAFE_INTEGER, log),
    });

    expect(limit).toBe(MAX_CANVAS_PIXELS);
    expect(log).toEqual([]);
  });

  it('触屏设备按探测值打折', () => {
    const limit = computeCanvasLimit({
      isTouchPrimary: () => true,
      createCanvas: factoryWithCeiling(SMALL),
    });
    expect(limit).toBe(SMALL * CANVAS_SAFETY);
  });

  it('触屏但探不出来 → 退回原常量，绝不把上限压到 0', () => {
    // 压到 0 的后果是任何图都被判超限、整个工具没法用 —— 比维持旧口径糟得多
    const limit = computeCanvasLimit({
      isTouchPrimary: () => true,
      createCanvas: factoryWithoutContext(),
    });
    expect(limit).toBe(MAX_CANVAS_PIXELS);
  });

  it('探测值再高也不会越过原常量', () => {
    const limit = computeCanvasLimit({
      isTouchPrimary: () => true,
      createCanvas: factoryWithCeiling(Number.MAX_SAFE_INTEGER),
    });
    expect(limit).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  });
});

describe('画布上限 · 生产入口的缓存', () => {
  /**
   * 注意：这个 jsdom 里**没有** `window.matchMedia`（本仓库的 jsdom 很精简）。
   * 也就是说测试环境下 `defaultIsTouchPrimary()` 恒为 false —— 探测永远不会
   * 在测试里自己跑起来，不会去分配那几百 MB。这里靠 stubGlobal 显式打开它。
   */
  const stubTouchPrimary = () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
  };

  it('整个进程只探测一次', () => {
    // 调用点是 assessFrame 的默认参数 —— 每次拖动滑杆都会走到
    stubTouchPrimary();
    const created = vi.spyOn(document, 'createElement');

    const first = resolveCanvasLimit();
    const second = resolveCanvasLimit();

    expect(second).toBe(first);
    // jsdom 没有 2D 上下文 → 首档就不过 → 退回原常量；这里要断言的是**只走了一轮**
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('清掉缓存后会重新探测', () => {
    stubTouchPrimary();
    const created = vi.spyOn(document, 'createElement');

    resolveCanvasLimit();
    resetCanvasLimitCache();
    resolveCanvasLimit();

    expect(created).toHaveBeenCalledTimes(2);
  });

  it('没有 matchMedia 的环境里不探测，直接沿用原常量', () => {
    // 这个 jsdom 正是这种环境 —— 顺带说明测试为何不会被探测拖慢
    vi.unstubAllGlobals();
    expect(typeof window.matchMedia).not.toBe('function');

    const created = vi.spyOn(document, 'createElement');
    resetCanvasLimitCache();

    expect(resolveCanvasLimit()).toBe(MAX_CANVAS_PIXELS);
    expect(created).not.toHaveBeenCalled();
  });
});
