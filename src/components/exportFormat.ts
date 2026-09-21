/**
 * 导出格式与质量。
 *
 * 引擎（`GalleryFramingEngine.exportBlob`）从第一天起就接受 `format` 与 `quality`，
 * 但调校台一直把它们硬编码成 `image/jpeg` + 0.98 —— 界面上没有任何出口。
 * 这一层把那两个参数接到界面上，并且定死三条口径。
 *
 * ## 一、PNG 不给质量控件
 *
 * `canvas.toBlob(cb, 'image/png', 0.9)` 的第三个参数会被**静默忽略**（规范如此）。
 * 摆一个拖了没反应的滑杆比不摆更糟：用户会以为"调到 90% 文件就小了"，
 * 然后对着一个没变小的文件怀疑是自己没点对。所以 `resolveQuality()` 在 PNG 下
 * 返回 `undefined`，界面据此整块不渲染。
 *
 * ## 二、扩展名跟着格式走，且只从**一处**推导
 *
 * 文件名由 `buildExportPlan` 在**编码之前**算出来（面板要展示它，用户要核对它），
 * 所以扩展名只能从选中的格式推导。真正的陷阱是：`toBlob` 遇到不支持的 MIME 会
 * **静默回退成 PNG**（旧版 Safari 上的 WebP 就是如此），那一刻文件名会撒谎。
 * 这里只提供 JPEG / PNG，两者在所有目标浏览器上都原生支持，这条风险不存在 ——
 * **将来若要加 WebP，必须在编码后核对 `blob.type` 再定扩展名。**
 *
 * ## 三、质量只在一个地方被夹取
 *
 * 滑杆的上下限、`clampQuality` 的夹取、以及最终传给编码器的值，三者若各写一遍，
 * 迟早会出现"界面显示 98% 而实际传了 1.0"这种看不见的分叉。这里只有一个函数。
 */

export type ExportFormatId = 'jpeg' | 'png';

export type ExportMimeType = 'image/jpeg' | 'image/png';

export interface ExportFormat {
  id: ExportFormatId;
  label: string;
  /** 传给 `canvas.toBlob` 的 MIME */
  mimeType: ExportMimeType;
  /** 文件名扩展名，含点 */
  extension: string;
  /** 是否吃 `quality` 参数 */
  lossy: boolean;
  hint: string;
}

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  {
    id: 'jpeg',
    label: 'JPEG',
    mimeType: 'image/jpeg',
    extension: '.jpg',
    lossy: true,
    hint: '通用格式，质量可调；压得狠了胶片颗粒会起块',
  },
  {
    id: 'png',
    label: 'PNG',
    mimeType: 'image/png',
    extension: '.png',
    lossy: false,
    hint: '无损，钢印与纸纹细节完整；文件会大好几倍',
  },
] as const;

export const DEFAULT_EXPORT_FORMAT_ID: ExportFormatId = 'jpeg';

/**
 * 按 id 取格式，取不到就退回默认。
 *
 * 不做成返回 null：格式只有两个，调用方拿到 null 也只能退回同一个默认值，
 * 多一次判断却不多一种应对。（与 `findPrintSize` 的 null 语义不同 ——
 * 那边要靠 null 区分"纸"和"像素档"两类 id，这里不存在第二条支线。）
 */
export function resolveExportFormat(id: string): ExportFormat {
  return EXPORT_FORMATS.find((format) => format.id === id) ?? EXPORT_FORMATS[0];
}

/**
 * JPEG 质量下限 0.6 是有意抬高的。
 *
 * 引擎允许低到 0.1，但胶片扫描件是高频图像，0.5 以下会在颗粒上压出肉眼可见的
 * 块状伪影。与其给一个注定难看的区间，不如把它挡在外面。
 */
export const QUALITY_MIN = 0.6;
export const QUALITY_MAX = 1;
export const QUALITY_STEP = 0.01;
export const DEFAULT_QUALITY = 0.98;

export function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return DEFAULT_QUALITY;
  return Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, quality));
}

/**
 * 真正要传给编码器的质量。
 *
 * `undefined` = "这个格式没有质量这一说"。界面据此整块不渲染质量控件。
 *
 * **一个反直觉的地方**：传 `undefined` 并不等于"不传"。引擎那边写的是
 * `const { quality = 0.98 } = exportOpts`，而解构默认值**连显式传入的 undefined
 * 也会补上**，所以 PNG 最终仍会带着 0.98 进 `toBlob`。
 * 这没有害处 —— 规范规定 PNG 忽略质量参数，画面完全不受影响 ——
 * 但别指望在编码器那一层能观察到 `undefined`。这条契约的观察点在
 * `ExportPlan.quality`：那里确实是 `undefined`，而它才是调用方读的地方。
 */
export function resolveQuality(format: ExportFormat, quality: number): number | undefined {
  return format.lossy ? clampQuality(quality) : undefined;
}

/** 滑杆右侧的读数。光一个百分比无法判断"该不该再往右拖"。 */
export function describeQuality(quality: number): string {
  const value = clampQuality(quality);
  const percent = `${Math.round(value * 100)}%`;
  if (value >= 0.95) return `${percent} · 接近无损`;
  if (value >= 0.85) return `${percent} · 高质量`;
  if (value >= 0.75) return `${percent} · 通用`;
  return `${percent} · 明显压缩`;
}
