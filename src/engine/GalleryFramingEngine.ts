import { resolveCanvasLimit } from './canvasLimit';
import { calculateLayout, type Layout } from './layout';
import { drawBevel, drawDeboss, drawInsetShadow } from './materials';
import { applyPaperTexture, type PaperTextureMode } from './noise';
import { analyzeSurface } from './palette';
import type {
  ExportOptions,
  FrameConfig,
  LayerToggles,
  RenderSource,
  ResolvedFrameConfig,
} from './types';

/** 开发指南 §1 / §3 的基准值。 */
export const DEFAULT_CONFIG: ResolvedFrameConfig = {
  matColor: '#F8F7F3',
  marginRatio: 0.14,
  bottomWeight: 1.25,
  targetAspect: null,
  paperTextureIntensity: 0.04,
  bevelWidth: 2.5,
  bevelColor: '#FFFFFF',
  insetShadowBlur: 6,
  enableStamp: true,
  cameraModel: 'LEICA M6',
  filmBrand: 'PORTRA 400',
  stampDepth: 1.2,
  layers: {
    mat: true,
    paperTexture: true,
    bevel: true,
    insetShadow: true,
    stamp: true,
  },
};

export function resolveConfig(config: FrameConfig = {}): ResolvedFrameConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    layers: { ...DEFAULT_CONFIG.layers, ...config.layers },
  };
}

export interface RenderOptions {
  /** 纸纹叠加方式。默认双通道乘算 + 滤色；'soft-light' 为开发指南 §3 的原始方案 */
  paperTextureMode?: PaperTextureMode;
}

export class GalleryFramingEngine {
  /** 计算外框与开窗几何，供外部（如材质验证台）做命中测试与取样定位。 */
  static layout(image: RenderSource, config: FrameConfig = {}): Layout {
    const resolved = resolveConfig(config);
    return calculateLayout(image.width, image.height, {
      marginRatio: resolved.marginRatio,
      bottomWeight: resolved.bottomWeight,
      targetAspect: resolved.targetAspect,
    });
  }

  /**
   * 完整装裱渲染管线。
   *
   * 图层顺序不可调换：卡纸底色 → 纸纹 → 45° 白芯 → 照片 → 内阴影 → 钢印。
   * 白芯必须画在照片之前（会被照片盖住内圈，只留出切面），
   * 内阴影必须画在照片之后（它作用在相纸上）。
   */
  static render(
    image: RenderSource,
    config: FrameConfig = {},
    targetCanvas?: HTMLCanvasElement,
    options: RenderOptions = {},
  ): HTMLCanvasElement {
    const resolved = resolveConfig(config);
    const layout = calculateLayout(image.width, image.height, {
      marginRatio: resolved.marginRatio,
      bottomWeight: resolved.bottomWeight,
      targetAspect: resolved.targetAspect,
    });

    assertCanvasBudget(layout.canvasW, layout.canvasH);

    const canvas = targetCanvas ?? document.createElement('canvas');
    canvas.width = layout.canvasW;
    canvas.height = layout.canvasH;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 渲染上下文');

    const surface = analyzeSurface(resolved.matColor);
    const layers: LayerToggles = resolved.layers;

    // 1. 卡纸纯色底色
    if (layers.mat) {
      ctx.fillStyle = resolved.matColor;
      ctx.fillRect(0, 0, layout.canvasW, layout.canvasH);
    }

    // 2. 纯棉纸纤维微噪点（EvenOdd 挖空开窗，不污染相片）
    if (layers.paperTexture) {
      applyPaperTexture(ctx, layout, {
        intensity: resolved.paperTextureIntensity,
        surface,
        mode: options.paperTextureMode,
      });
    }

    // 3. 45° 斜切白芯（画在照片之下，内圈被照片覆盖后只剩切面）
    if (layers.bevel) {
      drawBevel(ctx, layout, {
        bevelWidth: resolved.bevelWidth,
        bevelColor: resolved.bevelColor,
        surface,
      });
    }

    // 4. 照片主体
    ctx.drawImage(image, layout.x, layout.y, layout.w, layout.h);

    // 5. 相纸下落内阴影
    if (layers.insetShadow) {
      drawInsetShadow(ctx, layout, { insetShadowBlur: resolved.insetShadowBlur });
    }

    // 6. 底部无墨立体钢印
    if (layers.stamp && resolved.enableStamp) {
      drawDeboss(ctx, layout, {
        stampDepth: resolved.stampDepth,
        cameraModel: resolved.cameraModel,
        filmBrand: resolved.filmBrand,
        surface,
      });
    }

    return canvas;
  }

  /**
   * 导出为 Blob。
   *
   * maxDimension 会先对**源图**降采样再装裱 —— 装裱后的外框等比缩小，
   * 所有线宽由 scaleFactor 重新推导，因此比例与全尺寸导出完全一致。
   */
  static async exportBlob(
    image: RenderSource,
    config: FrameConfig = {},
    exportOpts: ExportOptions = {},
    renderOptions: RenderOptions = {},
  ): Promise<Blob> {
    const { format = 'image/jpeg', quality = 0.98, maxDimension } = exportOpts;

    let source: RenderSource = image;
    if (maxDimension && (image.width > maxDimension || image.height > maxDimension)) {
      const ratio = Math.min(maxDimension / image.width, maxDimension / image.height);
      const scaled = document.createElement('canvas');
      scaled.width = Math.max(1, Math.round(image.width * ratio));
      scaled.height = Math.max(1, Math.round(image.height * ratio));
      const scaledCtx = scaled.getContext('2d');
      if (!scaledCtx) throw new Error('无法获取 2D 上下文：源图降采样失败');
      scaledCtx.imageSmoothingQuality = 'high';
      scaledCtx.drawImage(image, 0, 0, scaled.width, scaled.height);
      source = scaled;
    }

    const output = this.render(source, config, undefined, renderOptions);

    /**
     * 落编码器之前的最后一眼。
     *
     * 为什么非要看这一眼：超限的画布**不会抛错**，它只是画不上去。于是
     * `toBlob` 会老老实实交出一张纯白（严格说是全透明）的 JPEG，用户等完
     * 进度条，得到一张什么都没有的图 —— 而且没有任何报错可循。
     * `assertCanvasBudget` 用的是探测出来的上限，但探测只对单张画布成立，
     * 导出这一刻同时活着的不止一张（源图 + 成品 + 编码缓冲），iOS 上还有一条
     * "所有画布合计"的内存线。这条检查是那道线之后的兜底：尺寸没超，
     * 但像素确实没落上去，就别把白图交给用户。
     */
    assertCanvasPainted(output);

    return new Promise<Blob>((resolve, reject) => {
      output.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Canvas 导出失败'));
        },
        format,
        quality,
      );
    });
  }

  /**
   * 触发浏览器下载。
   *
   * 注意这里拿的是**已经在内存里的**图。要导出全分辨率成品，应先
   * `reopenFullResolution(file)` 重解原图，导出后立刻 `disposeSource`，
   * 否则那张全分辨率位图会一直留着（见 src/input/decode.ts 的说明）。
   */
  static async download(
    image: RenderSource,
    filename = 'passe-framed.jpg',
    config: FrameConfig = {},
    exportOpts: ExportOptions = {},
    renderOptions: RenderOptions = {},
  ): Promise<void> {
    const blob = await this.exportBlob(image, config, exportOpts, renderOptions);
    saveBlob(blob, filename);
  }
}

/**
 * 把 Blob 存成文件。
 *
 * 单独抽出来是因为导出流程被拆成了"重解原图 → 渲染 → 保存 → 释放"四步，
 * 保存这一步得能被单独调用。objectURL 用完立即回收 —— 8K 成品的 blob
 * 是几十 MB 级别，忘了 revoke 就是一直占着。
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * 最后一道防线：画布面积超过**本机**上限就拒绝。
 *
 * 上限取自 `resolveCanvasLimit()`（触屏设备会先探测本机真实能力），
 * 与界面上的内存守卫是同一个口径 —— 两处各写一个数迟早会分叉。
 * 走到这里才报错说明上层的守卫漏了，但宁可在这里拦住，
 * 也不要真的去建一张注定画不上去的画布。
 */
function assertCanvasBudget(canvasW: number, canvasH: number): void {
  const pixels = canvasW * canvasH;
  const limit = resolveCanvasLimit();
  if (pixels > limit) {
    const megapixels = (pixels / 1e6).toFixed(1);
    const readable = (limit / 1e6).toFixed(0);
    throw new Error(
      `装裱外框 ${canvasW}×${canvasH}（${megapixels}MP）超出本机画布上限 ${readable}MP，` +
        `请调小边距比例或对源图降采样后重试。`,
    );
  }
}

/**
 * 取样网格，用**相对比例**而不是绝对像素。
 *
 * 卡纸边距是按比例算的，绝对坐标会一时落在照片上、一时落在卡纸上；
 * 九宫格（含正中心）在任何边距下都能同时摸到卡纸区与照片区。
 */
const BLANK_PROBE_GRID: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
  [0.5, 0.25],
  [0.5, 0.75],
  [0.25, 0.5],
  [0.75, 0.5],
];

/**
 * 这张成品图上是不是一个像素都没落上去。
 *
 * 判据是"不透明度"而不是颜色：正常渲染时卡纸底色铺满整张画布，九个取样点
 * 必然全不透明；而画不上去的画布留在那儿的是全透明的初始状态。
 * 用颜色判会误伤 —— 炭黑卡纸、夜景照片的取样点本来就是接近黑的。
 *
 * 只在**九个点全透明**时才判为空白。关掉卡纸底色层（调校用的图层开关）后再
 * 放一张带透明通道的 PNG，确实会得到一张全透明的成品 —— 那种"故意的空"很少见，
 * 而它撞上来的代价只是一次可读的报错，比放过一次真正的白图划算。
 *
 * 命中率也是顺着这条判据来的：非空白时**第一个**取样点就会返回，
 * 整趟自检只花一次 1×1 读像素。
 */
export function isBlankCanvas(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return true;

  for (const [fx, fy] of BLANK_PROBE_GRID) {
    // 减 1 是防越界：0.75 × 4 这类边界上 Math.floor 可能正好等于宽
    const x = Math.min(canvas.width - 1, Math.floor(canvas.width * fx));
    const y = Math.min(canvas.height - 1, Math.floor(canvas.height * fy));
    const { data } = ctx.getImageData(x, y, 1, 1);
    if (data[3] !== 0) return false;
  }

  return true;
}

/** 空白成品不许出关。理由见 `isBlankCanvas` 与 `exportBlob` 里的调用点。 */
function assertCanvasPainted(canvas: HTMLCanvasElement): void {
  if (!isBlankCanvas(canvas)) return;

  const megapixels = ((canvas.width * canvas.height) / 1e6).toFixed(1);
  throw new Error(
    `成品是空白的：${canvas.width}×${canvas.height}（${megapixels}MP）这张画布在本机没能画上东西，` +
      `像素被浏览器静默丢弃了（常见于手机的单张画布上限）。` +
      `请把导出尺寸调小一档，或先对源图降采样后重试。`,
  );
}
