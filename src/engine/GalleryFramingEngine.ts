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

/**
 * 单张画布的像素上限。
 *
 * 8K 中画幅扫描件加完边距后外框可达 1 亿像素，单张 2D 画布连同
 * 导出时的编码缓冲会吃掉 1GB 以上内存，标签页会直接崩。
 * 桌面 Chromium 的单画布面积上限约 2.68 亿像素，这里取一半作为安全线。
 */
export const MAX_CANVAS_PIXELS = 1.2e8;

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

function assertCanvasBudget(canvasW: number, canvasH: number): void {
  const pixels = canvasW * canvasH;
  if (pixels > MAX_CANVAS_PIXELS) {
    const megapixels = (pixels / 1e6).toFixed(1);
    const limit = (MAX_CANVAS_PIXELS / 1e6).toFixed(0);
    throw new Error(
      `装裱外框 ${canvasW}×${canvasH}（${megapixels}MP）超出画布内存安全上限 ${limit}MP，` +
        `请调小边距比例或对源图降采样后重试。`,
    );
  }
}
