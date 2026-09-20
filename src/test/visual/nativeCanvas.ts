import { createCanvas } from '@napi-rs/canvas';
import { vi } from 'vitest';

/**
 * 引擎级测试的挂具。
 *
 * 和 `src/test/canvasHarness.ts` 的区别：那个是给 **React** 用的（必须保留真正的
 * DOM 元素，再把 getContext 接到 Skia 上）；这里没有 React，直接把
 * `document.createElement('canvas')` 换成 Skia 画布最省事 ——
 * 引擎内部所有 `document.createElement('canvas')` 都因此变成真画布，
 * 渲染管线能在测试里跑完，断言的是像素而不是"函数被调用过"。
 */

export function createNativeCanvas(width = 1, height = 1): HTMLCanvasElement {
  return createCanvas(width, height) as unknown as HTMLCanvasElement;
}

export function installNativeCanvas(): void {
  const native = Document.prototype.createElement;
  vi.spyOn(document, 'createElement').mockImplementation(function (
    this: Document,
    tagName: string,
    options?: ElementCreationOptions,
  ) {
    if (tagName.toLowerCase() === 'canvas') {
      return createNativeCanvas() as unknown as HTMLElement;
    }
    return native.call(document, tagName as 'div', options);
  } as typeof document.createElement);
}

/**
 * 把画布编码成 PNG 字节。
 *
 * 只有 Skia 画布支持 `toBuffer`；jsdom 画布没有，于是返回 null 让调用方
 * 安静跳过 —— 诊断图是**辅助**，绝不能因为它写不出来而掩盖真正的回归结论。
 */
export function encodePng(canvas: HTMLCanvasElement): Buffer | null {
  const native = canvas as unknown as { toBuffer?: (mime: string) => Buffer };
  if (typeof native.toBuffer !== 'function') return null;
  try {
    return native.toBuffer('image/png');
  } catch {
    return null;
  }
}
