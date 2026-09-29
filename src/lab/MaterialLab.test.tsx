import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFramingSettings } from '@/components/framingSettings';
import { useImageQueue } from '@/input/useImageQueue';
import { installCanvasHarness } from '@/test/canvasHarness';
import { waitFor } from '@/test/waitFor';

import MaterialLab from './MaterialLab';

/**
 * 材质验证台的 1:1 取样放大镜。
 *
 * 这一组只守两件容易被"顺手清理掉"的事：
 *
 * 1. 未取样时**不该摆一个空的纯黑框** —— 那在界面上就是一个洞，用户得自己猜到
 *    "得先去点右边那个按钮"。占位条把下一步直接说出来。
 * 2. 但画布**不能跟着占位一起卸载** —— `renderSample` 是拿它的 ref 往上画的，
 *    卸载掉 ref 就是 null，放大镜会永远画不出东西，而且**不报错**。
 *
 * 第 2 条正是"看起来更干净"的那种改法会踩的坑，所以第三条用例把 renderSample
 * 真跑一遍：只断言占位消失是防不住它的（占位会正常消失，只是画布一片空白）。
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness() {
  const queue = useImageQueue();
  // 装裱配方住在 App（framingSettings.ts），测试里由这个薄壳提供同一份
  const settings = useFramingSettings();
  return <MaterialLab queue={queue} settings={settings} />;
}

beforeAll(() => {
  installCanvasHarness();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock'),
    revokeObjectURL: vi.fn(),
  });
});

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

function text(): string {
  return container?.textContent ?? '';
}

function canvases(): HTMLCanvasElement[] {
  return Array.from(container?.querySelectorAll('canvas') ?? []);
}

/** 放大镜那张画布：它是唯一带 `max-w-full` 的（预览那张由 fitPreview 钉住尺寸）。 */
function loupeCanvas(): HTMLCanvasElement | null {
  return container?.querySelector('canvas[class*="max-w-full"]') ?? null;
}

/** 放大镜的黑底外框。`bg-black/50`（拖放提示）是另一个类名，不会误匹配。 */
function loupeFrame(): HTMLElement | null {
  return container?.querySelector('div.bg-black') ?? null;
}

function findButton(label: string): HTMLButtonElement {
  const buttons = Array.from(container?.querySelectorAll('button') ?? []);
  const match = buttons.find((button) => (button.textContent ?? '').includes(label));
  if (!match) throw new Error(`找不到按钮：${label}`);
  return match as HTMLButtonElement;
}

describe('验证台 · 放大镜的未取样态', () => {
  it('未取样时给出下一步，而不是摆一个空的纯黑框', async () => {
    await mount();

    expect(text()).toContain('还没有取样');
    expect(text()).toContain('渲染高分辨率样本');

    // 外框还在（画布挂在它里面），但被藏起来了 —— 界面上看不到那个洞
    expect(loupeFrame()).not.toBeNull();
    // 按 class token 判断，不用 toContain：外框身上另有 `overflow-hidden`，
    // 字符串包含关系会把那截也当成"藏起来了"，断言就永远为真
    expect(loupeFrame()!.classList.contains('hidden')).toBe(true);
  });

  it('画布仍挂载着 —— renderSample 拿的就是它的 ref', async () => {
    await mount();

    // 预览一张 + 放大镜一张
    expect(canvases()).toHaveLength(2);
    expect(loupeCanvas()).not.toBeNull();
  });

  it('点渲染之后占位消失、画布露出来，且采样真的画上去了', async () => {
    await mount();

    await act(async () => {
      findButton('渲染高分辨率样本').click();
    });

    // 只有等取样真的完成后占位才会消失
    await waitFor(() => !text().includes('还没有取样'), { label: '取样完成' });
    expect(loupeFrame()!.classList.contains('hidden')).toBe(false);

    // 画布尺寸被真正设过（默认是 300×150）—— 这一条才是"ref 还活着"的证据。
    // 只断言占位消失是防不住的：占位会正常消失，而画布一片空白。
    //
    // **要等的是被断言的那个量本身。** 这里踩过一次竞态：占位消失只是 state 变了，
    // 画布尺寸可能还落在紧随其后的一次 effect 里 —— CPU 忙的时候断言会跑到它前面，
    // 报出 "expected 300 to be greater than 300" 这种看不懂的错。
    // 实测整套用例跑七次就会偶发一次，属于必须修掉的那类不稳定。
    const loupe = loupeCanvas();
    expect(loupe).not.toBeNull();
    await waitFor(() => loupe!.width > 300, { label: '放大镜画布被设过尺寸' });
    expect(loupe!.height).toBeGreaterThan(150);

    // 状态条会报出这一笔的规模，说明走完了"重解原图 → 渲染 → 取样"整条路
    expect(text()).toContain('画布');
    expect(text()).toContain('scaleFactor');
  });
});
