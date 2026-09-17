/**
 * 受控解码。
 *
 * "受控"体现在三件事上，每一件都对应一种真实会发生的崩溃：
 *
 * 1. **降采样到工作副本**。一张 100MP 中画幅扫描件解成 ImageBitmap 就是 400MB。
 *    实时预览根本用不到这个分辨率，所以解码后立刻压到 2400px 短边，
 *    并 close 掉原始位图。原图不常驻内存。
 * 2. **顺序解码**。批量拖入 20 张时并行解码会让峰值内存等于 20 张之和。
 *    串行处理把峰值压到单张，代价只是多等几秒 —— 用时间换不崩，值。
 * 3. **全分辨率按需重解**。导出时才重新解码原文件，且一次只解一张。
 */

import { decodeImageFile } from '@/engine/source';
import type { RenderSource } from '@/engine/types';

import { disposeSource } from './queue';

/**
 * 工作副本的短边上限。
 *
 * 2400px 短边在 4K 屏上按 1:1 放大观察仍有富余，而像素量只有
 * 8000px 扫描件的 1/11。调大它等于按平方倍吃掉内存。
 */
export const WORKING_SHORT_SIDE = 2400;

/**
 * 工作副本的像素总量上限。
 *
 * 只卡短边是不够的：一张 24000 × 2400 的全景接片短边才 2400，看似"没超限"，
 * 实际像素量却是 57.6MP（230MB）。两个约束同时生效，取更严格的那个。
 */
export const WORKING_MAX_PIXELS = 9e6;

export interface WorkingCopyPlan {
  needsDownscale: boolean;
  width: number;
  height: number;
  /** 目标尺寸相对原图的比例 */
  ratio: number;
}

/** 纯粹尺寸决策，与画布无关，方便脱离浏览器环境测试。 */
export function planWorkingCopy(
  sourceW: number,
  sourceH: number,
  maxShortSide: number = WORKING_SHORT_SIDE,
  maxPixels: number = WORKING_MAX_PIXELS,
): WorkingCopyPlan {
  const shortSide = Math.min(sourceW, sourceH);
  const pixels = sourceW * sourceH;

  if (shortSide <= maxShortSide && pixels <= maxPixels) {
    return { needsDownscale: false, width: sourceW, height: sourceH, ratio: 1 };
  }

  // 面积按比例平方缩放，所以像素约束对应的是比例的算术平方根
  const byShortSide = maxShortSide / shortSide;
  const byPixels = Math.sqrt(maxPixels / pixels);
  const ratio = Math.min(byShortSide, byPixels);

  return {
    needsDownscale: true,
    width: Math.max(1, Math.round(sourceW * ratio)),
    height: Math.max(1, Math.round(sourceH * ratio)),
    ratio,
  };
}

export interface DecodedImage {
  source: RenderSource;
  /** 工作副本尺寸 */
  width: number;
  height: number;
  /**
   * 原始文件尺寸。
   *
   * 必须单独带出来：导出走的是按需重解的全分辨率图，而内存守卫要评估的
   * 正是那张图的装裱结果。拿工作副本的尺寸去算，守卫会认为 20000 × 15000
   * 的扫描件"装得下"（工作副本只有 9MP），然后用户白等几十秒才看到报错。
   */
  originalWidth: number;
  originalHeight: number;
  /** 是否为控制内存做过降采样 */
  downscaled: boolean;
}

export interface DecodeWorkingCopyOptions {
  maxShortSide?: number;
  /** 工作副本像素总量上限，默认 WORKING_MAX_PIXELS */
  maxPixels?: number;
  /** 是否按 EXIF 方向自动旋转，默认 true */
  respectExif?: boolean;
}

/**
 * 解码文件并生成受控工作副本。
 *
 * 返回的 source 由调用方负责释放（`disposeSource`）。
 * 需要降采样时原始位图会在本函数内被立即 close，不会泄漏。
 */
export async function decodeWorkingCopy(
  file: Blob,
  options: DecodeWorkingCopyOptions = {},
): Promise<DecodedImage> {
  const { maxShortSide = WORKING_SHORT_SIDE, maxPixels = WORKING_MAX_PIXELS } = options;
  const respectExif = options.respectExif ?? true;

  const bitmap = await decodeImageFile(file, { respectExif });
  const plan = planWorkingCopy(bitmap.width, bitmap.height, maxShortSide, maxPixels);

  // 未超限就直接把位图本身交出去，不做多余的拷贝 —— 它已经是工作副本。
  // 注意这里不能按"长边是否超过 maxShortSide"判断：一张 4000 × 1600 的全景
  // 扫描件短边只有 1600，属于无需降采样，但它长边确实超了。
  if (!plan.needsDownscale) {
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
      downscaled: false,
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;

  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 上下文：工作副本生成失败');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);

    return {
      source: canvas,
      width: plan.width,
      height: plan.height,
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
      downscaled: true,
    };
  } finally {
    // 像素已经落到 canvas 上，原始位图此刻可以立即释放
    disposeSource(bitmap);
  }
}

export interface SequenceOptions<T> {
  /** 每完成一张回调一次，用于更新进度 */
  onProgress?: (done: number, total: number) => void;
  /** 返回 false 则跳过该条目之后的解码（例如用户已把它删掉） */
  shouldContinue?: (item: T) => boolean;
}

export interface SequenceResult {
  done: number;
  skipped: number;
}

/**
 * 顺序解码一批条目。
 *
 * 串行是刻意的：并行解码让峰值内存等于批次总和，而这正是批量处理最容易崩的地方。
 */
export async function decodeInSequence<T>(
  items: readonly T[],
  decodeOne: (item: T) => Promise<void>,
  options: SequenceOptions<T> = {},
): Promise<SequenceResult> {
  const { onProgress, shouldContinue } = options;
  let done = 0;
  let skipped = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (shouldContinue && !shouldContinue(item)) {
      skipped += 1;
      continue;
    }

    await decodeOne(item);
    done += 1;
    onProgress?.(done, items.length);
  }

  return { done, skipped };
}

/**
 * 全分辨率重新解码，供导出使用。
 *
 * 调用方必须在导出结束后 `disposeSource(result)` —— 这正是"原图不常驻内存"
 * 这个设计能成立的前提。
 */
export async function reopenFullResolution(file: Blob): Promise<RenderSource> {
  return decodeImageFile(file, { respectExif: true });
}

/**
 * 把浏览器抛出的解码错误翻译成用户看得懂的话。
 *
 * 原始报错通常是 "The source image could not be decoded." ——
 * 对用户完全没有指导意义，而真实原因八成是 HEIC/TIFF 或文件损坏。
 */
export function describeDecodeError(error: unknown, fileName: string): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (/could not be decoded|unsupported|invalid image|not an image/i.test(raw)) {
    return (
      `${fileName}：浏览器无法解码这个文件。` +
      `常见原因是 iPhone 的 HEIC、未转换的 TIFF，或文件本身已损坏 —— 请导出为 PNG 或 JPEG 后重试。`
    );
  }

  if (/out of memory|allocation/i.test(raw)) {
    return `${fileName}：可用内存不足，请先移除队列里的其他图片再试。`;
  }

  return `${fileName}：解码失败（${raw}）`;
}
