/**
 * 内置合成测试图。
 *
 * 材质验证台默认用它，因为判定材质质感需要画面里同时具备几类"探针"：
 * 连续渐变（看得到颗粒与色阶断层）、饱和色块（胶片最容易溢出的青绿与暖橙）、
 * 肤色块（判断偏色的参照）、极暗与极亮两端（看内阴影和倒角会不会压死细节）、
 * 以及 1px 级的线对（判断倒角与钢印的边缘干净程度）。
 */

export interface TestPatternOptions {
  width?: number;
  height?: number;
}

const SATURATED_PATCHES: readonly string[] = [
  '#00A6A0', // 青绿 —— 胶片最容易在这里溢出
  '#C81E1E', // 高饱和红
  '#E08A20', // 暖橙 —— 肤色与夕照的典型色
  '#1F9E45', // 植被绿
  '#1F3FC0', // 深蓝
  '#E8C6A8', // 肤色参照
] as const;

export function createTestPattern(options: TestPatternOptions = {}): HTMLCanvasElement {
  const width = options.width ?? 3000;
  const height = options.height ?? 2000;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法获取 2D 上下文：测试图生成失败');

  const band = (index: number, count: number) => ({
    top: Math.round((height * index) / count),
    bottom: Math.round((height * (index + 1)) / count),
  });

  // 底色：中性灰，避免任何一层材质被背景掩盖
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, width, height);

  /* 第 1 带：连续灰阶渐变（判断颗粒可见度与色阶断层） */
  const progressive = band(0, 5);
  const greyRamp = ctx.createLinearGradient(0, 0, width, 0);
  greyRamp.addColorStop(0, '#000000');
  greyRamp.addColorStop(0.5, '#808080');
  greyRamp.addColorStop(1, '#FFFFFF');
  ctx.fillStyle = greyRamp;
  ctx.fillRect(0, progressive.top, width, progressive.bottom - progressive.top);

  /* 第 2 带：饱和色块 + 肤色 */
  const patches = band(1, 5);
  const patchWidth = width / SATURATED_PATCHES.length;
  SATURATED_PATCHES.forEach((color, index) => {
    ctx.fillStyle = color;
    ctx.fillRect(
      Math.round(index * patchWidth),
      patches.top,
      Math.ceil(patchWidth),
      patches.bottom - patches.top,
    );
  });

  /* 第 3 带：极暗与极亮两端（看内阴影 / 倒角是否压死细节） */
  const extremes = band(2, 5);
  const extremesHeight = extremes.bottom - extremes.top;

  const darkRamp = ctx.createLinearGradient(0, 0, width / 2, 0);
  darkRamp.addColorStop(0, '#000000');
  darkRamp.addColorStop(1, '#242424');
  ctx.fillStyle = darkRamp;
  ctx.fillRect(0, extremes.top, Math.round(width / 2), extremesHeight);

  const lightRamp = ctx.createLinearGradient(Math.round(width / 2), 0, width, 0);
  lightRamp.addColorStop(0, '#DCDCDC');
  lightRamp.addColorStop(1, '#FFFFFF');
  ctx.fillStyle = lightRamp;
  ctx.fillRect(Math.round(width / 2), extremes.top, Math.round(width / 2), extremesHeight);

  /* 第 4 带：细腻纹理与 1px 线对（判断边缘干净程度） */
  const detail = band(3, 5);
  const detailHeight = detail.bottom - detail.top;

  ctx.fillStyle = '#3A3A3A';
  ctx.fillRect(0, detail.top, width, detailHeight);

  // 天空式柔和渐变，模拟胶片常见的大面积平滑过渡
  const sky = ctx.createLinearGradient(0, detail.top, 0, detail.bottom);
  sky.addColorStop(0, '#8FA6B8');
  sky.addColorStop(1, '#E4E8EC');
  ctx.fillStyle = sky;
  ctx.fillRect(0, detail.top, Math.round(width * 0.5), detailHeight);

  // 线对：1px / 2px / 3px / 4px 的竖条纹
  const fineTop = detail.top + Math.round(detailHeight * 0.55);
  const fineHeight = detail.bottom - fineTop;
  let cursorX = Math.round(width * 0.52);
  for (const period of [1, 2, 3, 4]) {
    const blockWidth = period * 2 * 12;
    for (let i = 0; i < blockWidth; i += period * 2) {
      ctx.fillStyle = '#101010';
      ctx.fillRect(cursorX + i, fineTop, period, fineHeight);
    }
    cursorX += blockWidth + 12;
  }

  /* 第 5 带：明暗棋盘，观察边距与开窗的读图关系 */
  const checker = band(4, 5);
  const cell = Math.max(8, Math.round(height / 40));
  for (let y = checker.top; y < checker.bottom; y += cell) {
    for (let x = 0; x < width; x += cell) {
      const odd = ((x / cell) | 0) % 2 === ((y / cell) | 0) % 2;
      ctx.fillStyle = odd ? '#F2F0EA' : '#2A2A2A';
      ctx.fillRect(x, y, cell, Math.min(cell, checker.bottom - y));
    }
  }

  return canvas;
}
