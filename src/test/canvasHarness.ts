/**
 * React + Canvas 的测试挂具。
 *
 * 难点在于两边都要满足：
 * - React 必须拿到**真正的 DOM 元素**才能把 `<canvas>` 渲染进组件树
 *   （napi 画布不是 Node，appendChild 会直接抛错）；
 * - 渲染代码必须拿到**真正的 2D 上下文**才能画像素
 *   （jsdom 的 getContext 返回 null）。
 *
 * 解法：DOM 元素照常由 jsdom 提供，替它把 getContext 接到一块按需分配的
 * 原生画布上；再把原生上下文的 drawImage 包一层，让"传入 DOM 画布"自动
 * 翻译成"传入它对应的原生画布"。于是 render / createPreviewSource 这类
 * 会在画布之间互相绘制的代码，不需要任何改动就能在测试里跑通。
 *
 * 引擎的直接像素测试（src/engine/render.test.ts）不走这里 —— 那边没有 React，
 * 直接把 createElement 换成原生画布更省事。
 */

import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { vi } from 'vitest';

const backings = new WeakMap<HTMLCanvasElement, Canvas>();
const patchedContexts = new WeakSet<object>();

function isDomCanvas(value: unknown): value is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement;
}

/** 取出（或按元素当前尺寸创建）原生画布。 */
function nativeFor(element: HTMLCanvasElement): Canvas {
  const width = Math.max(1, element.width || 1);
  const height = Math.max(1, element.height || 1);

  let canvas = backings.get(element);
  if (!canvas) {
    canvas = createCanvas(width, height);
    backings.set(element, canvas);
    return canvas;
  }

  // 元素尺寸变了就跟着改 —— 引擎习惯先设 width/height 再取上下文
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas;
}

/** 让"画布互相绘制"在 DOM 画布与原生画布之间自动翻译。 */
function patchImageSourceMethods(ctx: CanvasRenderingContext2D): CanvasRenderingContext2D {
  if (patchedContexts.has(ctx)) return ctx;

  /**
   * 所有把画布当作图像源传进来的上下文方法。
   *
   * 光包 drawImage 不够 —— 纸纹是用 createPattern(瓦片) 贴上去的，
   * 而那个瓦片同样是 document.createElement('canvas') 的产物。
   * 原生实现只认自己家的类型，拿到 DOM 元素会直接报
   * "Value is none of these types Image, ImageData, CanvasElement, SVGCanvas"。
   */
  const overrides = new Map<string, (...args: unknown[]) => unknown>();

  for (const name of ['drawImage', 'createPattern'] as const) {
    const original = (ctx[name] as unknown as (...args: unknown[]) => unknown).bind(ctx);
    overrides.set(name, (source: unknown, ...rest: unknown[]) =>
      original(isDomCanvas(source) ? nativeFor(source) : source, ...rest),
    );
  }

  let usedDefineProperty = true;
  for (const [name, fn] of overrides) {
    try {
      Object.defineProperty(ctx, name, { value: fn, configurable: true });
    } catch {
      usedDefineProperty = false;
      break;
    }
  }

  if (!usedDefineProperty) {
    // 对象不可扩展时退回代理，行为一致
    return new Proxy(ctx, {
      get(target, property, receiver) {
        const override = typeof property === 'string' ? overrides.get(property) : undefined;
        if (override) return override;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as () => void).bind(target) : value;
      },
    });
  }

  patchedContexts.add(ctx);
  return ctx;
}

export function installCanvasHarness(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    contextId: string,
  ) {
    if (contextId !== '2d') return null;
    // Skia 的上下文比 DOM 的少几个方法（drawFocusIfNeeded 等），
    // 引擎实际用到的那些两个实现都有 —— 断言成 DOM 类型即可
    const ctx = nativeFor(this).getContext('2d');
    return patchImageSourceMethods(ctx as unknown as CanvasRenderingContext2D);
  } as typeof HTMLCanvasElement.prototype.getContext);

  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
    quality?: number,
  ) {
    nativeFor(this).toBlob(callback, type, quality);
  });
}
