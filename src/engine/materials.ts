import type { Layout } from './layout';
import type { SurfaceTone } from './palette';
import { scaledPx } from './scaleFactor';

/**
 * 四层物理材质的绘制。
 *
 * 每一层都以开发指南 §1 的物理描述为准，并遵守两条硬约束：
 * 所有尺寸经 scaleFactor 换算；所有光效强度按卡纸亮度自适应。
 */

/* ─────────────────────────── 45° 斜切白芯 ─────────────────────────── */

export interface BevelOptions {
  /** 以 1200px 短边为基准的切面宽度 */
  bevelWidth: number;
  /** 切芯颜色，纸芯本色 */
  bevelColor: string;
  surface: SurfaceTone;
}

/**
 * 卡纸开窗露出的 45° 倾斜剖面。
 *
 * 光源定在左上方，因此左上切面受光呈细白高光、右下切面背光呈微弱暗收边
 * （开发指南 §1）。倒角带画在开窗之外，随后被照片主体覆盖，
 * 所以只需保证画的顺序在照片之前。
 */
export function drawBevel(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  options: BevelOptions,
): void {
  const bw = scaledPx(options.bevelWidth, layout.canvasW, layout.canvasH, 1.5);
  const { x, y, w, h } = layout;
  const { surface } = options;

  // 1. 纸芯底色，向开窗四周外扩 bw
  ctx.save();
  ctx.fillStyle = options.bevelColor;
  ctx.fillRect(x - bw, y - bw, w + bw * 2, h + bw * 2);

  // 2. 受光面（上、左）：细白高光。切芯本色就是白的，深浅卡纸用同一强度
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.fillRect(x - bw, y - bw, w + bw * 2, bw);
  ctx.fillRect(x - bw, y - bw, bw, h + bw * 2);

  // 3. 背光面（下、右）：微弱暗收边
  ctx.fillStyle = `rgba(0, 0, 0, ${0.08 * surface.bevelShadeGain})`;
  ctx.fillRect(x - bw, y + h, w + bw * 2, bw);
  ctx.fillRect(x + w, y - bw, bw, h + bw * 2);
  ctx.restore();
}

/* ─────────────────────────── 相纸下落内阴影 ─────────────────────────── */

export interface InsetShadowOptions {
  /** 以 1200px 短边为基准的阴影半径 */
  insetShadowBlur: number;
}

/**
 * 卡纸厚度压在相纸上产生的遮蔽暗影（Ambient Occlusion），
 * 限定在相纸范围内羽化（开发指南 §1）。
 *
 * 开发指南 §3 的原始实现只画了上、左两条边，右下两侧完全没有过渡，
 * 白光环境下会读不出"卡纸压在相纸上"的厚度关系。
 * 这里补齐四边，并保持左上方为主光源的强度梯度：
 * 上 0.22 → 左 0.16 → 下 0.12 → 右 0.10。
 */
export function drawInsetShadow(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  options: InsetShadowOptions,
): void {
  const blur = scaledPx(options.insetShadowBlur, layout.canvasW, layout.canvasH, 3);
  if (blur <= 0) return;

  const { x, y, w, h } = layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  const top = ctx.createLinearGradient(0, y, 0, y + blur);
  top.addColorStop(0, 'rgba(0, 0, 0, 0.22)');
  top.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = top;
  ctx.fillRect(x, y, w, blur);

  const bottom = ctx.createLinearGradient(0, y + h, 0, y + h - blur);
  bottom.addColorStop(0, 'rgba(0, 0, 0, 0.12)');
  bottom.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = bottom;
  ctx.fillRect(x, y + h - blur, w, blur);

  const left = ctx.createLinearGradient(x, 0, x + blur, 0);
  left.addColorStop(0, 'rgba(0, 0, 0, 0.16)');
  left.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = left;
  ctx.fillRect(x, y, blur, h);

  const right = ctx.createLinearGradient(x + w, 0, x + w - blur, 0);
  right.addColorStop(0, 'rgba(0, 0, 0, 0.1)');
  right.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = right;
  ctx.fillRect(x + w - blur, y, blur, h);

  ctx.restore();
}

/* ─────────────────────────── 无墨立体钢印 ─────────────────────────── */

/** 旁轴相机简笔线稿。坐标系以 (x, y) 为锚点，按 size 缩放。 */
function drawCameraVector(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  const s = size / 40;
  ctx.scale(s, s);

  ctx.beginPath();
  ctx.moveTo(-18, 10);
  ctx.lineTo(-18, -4);
  ctx.arcTo(-18, -7, -15, -7, 2);
  ctx.lineTo(10, -7);
  ctx.lineTo(11, -9);
  ctx.lineTo(17, -9);
  ctx.arcTo(19, -9, 19, -6, 2);
  ctx.lineTo(19, 10);
  ctx.arcTo(19, 12, 16, 12, 2);
  ctx.lineTo(-15, 12);
  ctx.arcTo(-18, 12, -18, 10, 2);
  ctx.closePath();
  ctx.stroke();

  ctx.strokeRect(-15, -10, 4, 3);
  ctx.strokeRect(12, -12, 4, 3);

  ctx.beginPath();
  ctx.arc(-1, 2.5, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-1, 2.5, 4.5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeRect(10, -4.5, 5, 3.5);
  ctx.fillRect(2, -4, 3, 2.5);

  ctx.restore();
}

type CtxWithLetterSpacing = CanvasRenderingContext2D & { letterSpacing?: string };

let letterSpacingSupport: boolean | null = null;

/**
 * 探测 canvas 是否原生支持 letterSpacing。
 * Safari 17 之前不支持，需要逐字手动排版兜底。
 */
function hasNativeLetterSpacing(ctx: CanvasRenderingContext2D): boolean {
  if (letterSpacingSupport === null) {
    letterSpacingSupport = 'letterSpacing' in ctx;
  }
  return letterSpacingSupport;
}

/** 仅供测试重建：清空 letterSpacing 支持探测的缓存。 */
export function resetLetterSpacingProbe(): void {
  letterSpacingSupport = null;
}

/**
 * 绘制带字距的居中文本。
 *
 * 原生支持时直接赋 letterSpacing；不支持时按每字宽度累加自行排版，
 * 否则旧版 Safari 上钢印会挤成一团。
 */
export function drawTrackedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  baselineY: number,
  tracking: number,
): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (hasNativeLetterSpacing(ctx)) {
    (ctx as CtxWithLetterSpacing).letterSpacing = `${tracking}px`;
    ctx.fillText(text, centerX, baselineY);
    (ctx as CtxWithLetterSpacing).letterSpacing = '0px';
    return;
  }

  const chars = Array.from(text);
  if (chars.length === 0) return;

  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((sum, width) => sum + width, 0) + tracking * (chars.length - 1);

  let cursor = centerX - total / 2;
  ctx.textAlign = 'left';
  chars.forEach((ch, index) => {
    ctx.fillText(ch, cursor, baselineY);
    cursor += widths[index] + tracking;
  });
}

export interface DebossOptions {
  /** 以 1200px 短边为基准的下压深度 */
  stampDepth: number;
  cameraModel?: string;
  filmBrand?: string;
  surface: SurfaceTone;
}

/**
 * 底部无墨立体钢印（Blind Deboss）。
 *
 * 光学构成（开发指南 §1）：左上槽底阴影 + 右下截光边缘反光 + 凹槽内部纸浆轻微压暗。
 * 实现手法是三明治叠印：先把形状压暗，再向左上偏移画一层阴影棱，
 * 向右下偏移画一层迎光反光棱。光源方向与倒角、内阴影一致。
 *
 * 三层的不透明度按卡纸亮度自适应：炭黑卡纸上阴影棱几乎不可见，
 * 反光棱反而需要加强，否则钢印整层消失。
 */
export function drawDeboss(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  options: DebossOptions,
): void {
  const { cameraModel, filmBrand } = options;
  if (!cameraModel && !filmBrand) return;

  const { canvasW, canvasH, bottomOffset, scale } = layout;
  const { surface } = options;

  const centerX = layout.x + layout.w / 2;
  const iconSize = scaledPx(26, canvasW, canvasH, 20);
  const fontSize = scaledPx(9.5, canvasW, canvasH, 8);
  const iconY = Math.round(layout.y + layout.h + bottomOffset * 0.36);
  const textY = iconY + scaledPx(26, canvasW, canvasH, 20);
  const tracking = 2.4 * scale;
  const lineWidth = Math.max(1, 1.1 * scale);

  const label = [cameraModel, filmBrand].filter(Boolean).join('   /   ').toUpperCase();

  // 三层光效的不透明度按卡纸明暗切换。浅色卡纸沿用开发指南 §3 的原始取值，
  // 深色卡纸收阴影、强反光 —— 否则炭黑展厅上的钢印整层读不出来。
  const pitAlpha = surface.isLight ? 0.04 : 0.055;
  const shadowAlpha = surface.isLight ? 0.3 : 0.16;
  const highlightAlpha = surface.isLight ? 0.72 : 0.9;

  const paint = (): void => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lineWidth;

    drawCameraVector(ctx, centerX, iconY, iconSize);

    ctx.save();
    ctx.font = `600 ${fontSize}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
    drawTrackedText(ctx, label, centerX, textY, tracking);
    ctx.restore();
  };

  // 光源来自左上 (225°)：阴影棱朝左上偏移，反光棱朝右下偏移
  const angle = Math.PI * 0.75;
  const offset = scaledPx(options.stampDepth, canvasW, canvasH, 0.8);
  const dx = Math.cos(angle) * offset;
  const dy = -Math.sin(angle) * offset;

  // 1. 槽底纸浆轻微压暗
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgba(0, 0, 0, ${pitAlpha})`;
  ctx.strokeStyle = `rgba(0, 0, 0, ${pitAlpha})`;
  paint();
  ctx.restore();

  // 2. 背光阴影棱（左上）
  ctx.save();
  ctx.translate(dx, dy);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgba(40, 35, 30, ${shadowAlpha})`;
  ctx.strokeStyle = `rgba(40, 35, 30, ${shadowAlpha})`;
  paint();
  ctx.restore();

  // 3. 迎光反光棱（右下）
  ctx.save();
  ctx.translate(-dx, -dy);
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = `rgba(255, 255, 255, ${highlightAlpha})`;
  ctx.strokeStyle = `rgba(255, 255, 255, ${highlightAlpha})`;
  paint();
  ctx.restore();
}
