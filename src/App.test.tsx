import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import App from '@/App';

/**
 * 组件挂载冒烟测试。
 *
 * 这里跑在 jsdom 下，jsdom 没有 2D 画布（getContext 返回 null），
 * 正好覆盖"画布不可用"这条退化路径：调校台必须仍然渲染出完整界面，
 * 而不是在 useState 初始化阶段抛错把整棵组件树带崩。
 * 引擎的真实像素行为由 render.test.ts 在 Skia 画布上验证。
 *
 * 阶段 3 起 App 的入口是正式调校台，材质验证台改为从页眉切入 ——
 * 因此这里的断言对齐的是调校台的文案。
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

  it('输入层就位：空队列时给出拖放与粘贴两种入口，并说明支持格式', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const text = container.textContent ?? '';
    expect(text).toContain('图片队列');
    // 视口里的大拖放区
    expect(text).toContain('选择或拖拽胶片扫描件');
    // 侧栏紧凑版面板：空队列时用一句话指路，两个按钮分别是选择图片与读剪贴板
    expect(text).toContain('队列为空');
    expect(text).toContain('从剪贴板');
    // 队列为空时不该出现内存条 —— 那会让人以为已经占了资源
    expect(text).not.toContain('常驻内存');

    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    // 必须允许多选：批量是 v1.0 的核心场景
    expect(fileInput?.hasAttribute('multiple')).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
