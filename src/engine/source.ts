import type { RenderSource } from './types';

/**
 * 图像输入与预览取样。
 *
 * 实时预览必须用降采样副本。开发指南 §4 的原始实现把**原图**直接交给渲染器，
 * 于是 canvas 尺寸等于原图尺寸 —— 一张 8000px 的中画幅扫描件会让每次拖动滑杆
 * 都触发上亿像素的重绘，滑块必然掉帧甚至假死。
 *
 * 导出仍然走原始全分辨率图（见 exportBlob），预览降采样只影响实时预览。
 */

/** 是否需要降采样。 */
export function needsDownscale(image: RenderSource, maxShortSide: number): boolean {
  return Math.min(image.width, image.height) > maxShortSide;
}

/**
 * 生成预览用副本：把照片短边压到 maxShortSide 以内。
 *
 * 已经足够小时直接返回原对象，不做多余的拷贝。
 */
export function createPreviewSource(image: RenderSource, maxShortSide: number): RenderSource {
  const shortSide = Math.min(image.width, image.height);
  if (shortSide <= maxShortSide) return image;

  const ratio = maxShortSide / shortSide;
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法获取 2D 上下文：预览副本生成失败');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);

  return canvas;
}

export interface DecodeOptions {
  /** 是否按 EXIF 方向自动旋转（默认 true）。手机拍摄的竖幅胶片扫描件依赖它 */
  respectExif?: boolean;
}

/**
 * 解码用户选择的图片文件。
 *
 * 刻意不用 FileReader + dataURL：base64 编码会让内存占用膨胀约 33%，
 * 8K 扫描件上这是压垮标签页的最后一根稻草。createImageBitmap 直接持有原始字节。
 */
export async function decodeImageFile(
  file: Blob,
  options: DecodeOptions = {},
): Promise<ImageBitmap> {
  const { respectExif = true } = options;
  return createImageBitmap(file, {
    imageOrientation: respectExif ? 'from-image' : 'none',
  });
}

/** 判断一个拖入的 DataTransfer 是否携带图片文件。 */
export function hasImageFile(transfer: DataTransfer): boolean {
  return Array.from(transfer.items).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/'),
  );
}

/** 从拖放事件里取出第一个图片文件。 */
export function firstImageFile(transfer: DataTransfer): File | null {
  const file = Array.from(transfer.files).find((f) => f.type.startsWith('image/'));
  return file ?? null;
}
