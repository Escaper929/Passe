import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import App from '@/App';

/**
 * 组件挂载冒烟测试。
 *
 * 这里跑在 jsdom 下，jsdom 没有 2D 画布（getContext 返回 null），
 * 正好覆盖"画布不可用"这条退化路径：验证台必须仍然渲染出完整界面，
 * 而不是在 useState 初始化阶段抛错把整棵组件树带崩。
 * 引擎的真实像素行为由 render.test.ts 在 Skia 画布上验证。
 */

let container: HTMLDivElement | null = null;

afterEach(() => {
  container?.remove();
  container = null;
});

describe('App 挂载', () => {
  it('画布不可用时仍然完整渲染，不抛异常', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const text = container.textContent ?? '';
    expect(text).toContain('Passe · 衬境');
    expect(text).toContain('材质验证台');
    expect(text).toContain('纸纤维颗粒');
    expect(text).toContain('炭黑展厅');

    await act(async () => {
      root.unmount();
    });
  });
});
