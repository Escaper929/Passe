import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CONTACT_SHEET } from './baselines';
import { encodePng, createNativeCanvas } from './nativeCanvas';
import { VISUAL_SCENES, renderScene, sheetPhotoSize, type VisualScene } from './scenes';

/**
 * 人眼评审拼图。
 *
 * 指纹能告诉你"第 3 行第 7 列偏了 12.4"，但看不出"这一版是不是更难看"。
 * 把十个场景拼成一张图提交进仓库，评审时在 GitHub 上直接打开就能比 ——
 * 这是给人看的那一半，JSON 是给机器看的那一半。
 *
 * 缩略渲染（源图短边 200px）而不是全尺寸：引擎的线宽全部绑在 scaleFactor 上，
 * 比例与全尺寸一致，而十个全尺寸场景拼起来是几十 MB。
 * 代价是钢印小字在这个尺寸下读不清 —— 拼图是用来看**材质**的。
 */

export interface SheetCell {
  id: string;
  canvas: HTMLCanvasElement;
}

const COLUMNS = 5;
const CELL_W = 248;
const CELL_H = 200;
const LABEL_H = 34;
const GAP = 14;
const PAD = 16;

/** 深色底衬：成品四边都是浅色卡纸，深背景才能看清边界。 */
const SHEET_BG = '#121212';
const LABEL_COLOR = '#E6E2D8';
const LABEL_MUTED = '#8A867E';

export function buildContactSheet(cells: readonly SheetCell[]): HTMLCanvasElement {
  if (cells.length === 0) throw new Error('拼图失败：没有任何场景');

  const rows = Math.ceil(cells.length / COLUMNS);
  const width = PAD * 2 + COLUMNS * CELL_W + (COLUMNS - 1) * GAP;
  const height = PAD * 2 + rows * (CELL_H + LABEL_H) + (rows - 1) * GAP;

  const sheet = createNativeCanvas(width, height);
  const ctx = sheet.getContext('2d');
  if (!ctx) throw new Error('拼图失败：无 2D 上下文');

  ctx.fillStyle = SHEET_BG;
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.imageSmoothingQuality = 'high';

  cells.forEach((cell, index) => {
    const col = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const x = PAD + col * (CELL_W + GAP);
    const y = PAD + row * (CELL_H + LABEL_H + GAP);

    const scale = Math.min(CELL_W / cell.canvas.width, CELL_H / cell.canvas.height);
    const w = Math.max(1, Math.round(cell.canvas.width * scale));
    const h = Math.max(1, Math.round(cell.canvas.height * scale));
    ctx.drawImage(
      cell.canvas,
      x + Math.round((CELL_W - w) / 2),
      y + Math.round((CELL_H - h) / 2),
      w,
      h,
    );

    ctx.fillStyle = LABEL_COLOR;
    ctx.font = '500 12px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(`${index + 1}. ${cell.id}`, x, y + CELL_H + 11);

    ctx.fillStyle = LABEL_MUTED;
    ctx.font = '400 11px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(`${cell.canvas.width}×${cell.canvas.height}`, x, y + CELL_H + 26);
  });

  return sheet;
}

/** 按缩略尺寸渲染每个场景，供拼图使用。 */
export function renderSheetCells(scenes: readonly VisualScene[] = VISUAL_SCENES): SheetCell[] {
  return scenes.map((scene) => ({
    id: scene.id,
    canvas: renderScene(scene, sheetPhotoSize(scene)).canvas,
  }));
}

/** 写拼图，返回路径；画布实现不支持编码时返回 null。 */
export function writeContactSheet(scenes?: readonly VisualScene[]): string | null {
  const png = encodePng(buildContactSheet(renderSheetCells(scenes)));
  if (!png) return null;
  mkdirSync(path.dirname(CONTACT_SHEET), { recursive: true });
  writeFileSync(CONTACT_SHEET, png);
  return CONTACT_SHEET;
}
