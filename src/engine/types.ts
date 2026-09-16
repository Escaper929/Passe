/**
 * 装裱引擎的公共类型。
 *
 * 字段与开发指南 §3 的 FrameConfig 保持一致，额外增加了 `layers` ——
 * 材质验证台靠它逐层开关，以判断每一层对最终质感的贡献。
 */

/** 可绘制来源。刻意不收 string，避免引擎内部再做异步加载。 */
export type RenderSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas;

/** 材质分层开关。 */
export interface LayerToggles {
  /** 卡纸纯色底色 */
  mat: boolean;
  /** 纯棉纸纤维微噪点 */
  paperTexture: boolean;
  /** 45° 斜切白芯 */
  bevel: boolean;
  /** 相纸下落内阴影 */
  insetShadow: boolean;
  /** 无墨立体钢印 */
  stamp: boolean;
}

export interface FrameConfig {
  /** 卡纸底色（默认 "#F8F7F3"） */
  matColor?: string;
  /** 边距基准比例，以照片短边为基准（默认 0.14） */
  marginRatio?: number;
  /** 底部加权倍数（默认 1.25） */
  bottomWeight?: number;
  /** 固定外框比例，如 4/3；null 表示自适应 */
  targetAspect?: number | null;
  /** 纸张颗粒强度 0.01 ~ 0.08（默认 0.04） */
  paperTextureIntensity?: number;
  /** 45° 斜切切面基准宽度，以 1200px 短边为基准（默认 2.5） */
  bevelWidth?: number;
  /** 切芯颜色（默认 "#FFFFFF"，纸芯本色，是纯白红线的唯一例外） */
  bevelColor?: string;
  /** 卡纸下落内阴影半径，以 1200px 短边为基准（默认 6） */
  insetShadowBlur?: number;
  /** 是否启用无墨钢印（默认 true） */
  enableStamp?: boolean;
  /** 相机型号，如 "LEICA M6" */
  cameraModel?: string;
  /** 胶卷名称，如 "KODAK PORTRA 400" */
  filmBrand?: string;
  /** 钢印下压深度，以 1200px 短边为基准（默认 1.2） */
  stampDepth?: number;
  /** 材质分层开关 */
  layers?: Partial<LayerToggles>;
}

/** 补全默认值后的配置。 */
export type ResolvedFrameConfig = Required<Omit<FrameConfig, 'layers'>> & {
  layers: LayerToggles;
};

export interface ExportOptions {
  format?: 'image/jpeg' | 'image/png';
  /** JPEG 质量 0.1 ~ 1.0（默认 0.98） */
  quality?: number;
  /** 导出长边最大像素限制 */
  maxDimension?: number;
}
