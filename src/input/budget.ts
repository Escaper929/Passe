/**
 * 内存守卫。
 *
 * 一个 1 亿像素的 2D 画布连同它的源图副本会吃掉 800MB 以上内存，
 * 在导出时还要再叠一份编码缓冲 —— 标签页会在用户点下"导出"的一刻直接崩，
 * 而且是在没有任何提示的情况下崩。这是纯前端图像工具最容易被投诉的失败模式。
 *
 * 因此这里把"内存"变成用户可以看见、可以决策的东西：
 * 三档风险（ok / heavy / blocked）+ 一条明确的建议降采样尺寸。
 *
 * 布局计算复用引擎的 calculateLayout，不另起一套几何公式 ——
 * 否则守卫算出的像素数和真实渲染结果会对不上，警告就变成假警报了。
 */

import { resolveCanvasLimit } from '@/engine/canvasLimit';
import { calculateLayout } from '@/engine/layout';
import type { FrameConfig } from '@/engine/types';

/** RGBA 每像素字节数。canvas 内部统一按 4 字节/像素计。 */
export const BYTES_PER_PIXEL = 4;

/**
 * "偏重"档的阈值。超过安全上限的这个比例就先给用户提个醒，
 * 而不是等到引擎抛错才告诉他。
 */
export const HEAVY_LOAD = 0.55;

/** 队列中所有工作副本同时驻留内存的软上限（超过则提示）。 */
export const RESIDENT_SOFT_BYTES = 400 * 1024 * 1024;

/** 队列工作副本的硬上限，超过就不再接受新图。 */
export const RESIDENT_LIMIT_BYTES = 1024 * 1024 * 1024;

export type BudgetLevel = 'ok' | 'heavy' | 'blocked';

export interface RenderBudget {
  level: BudgetLevel;
  framedW: number;
  framedH: number;
  megapixels: number;
  /** 占画布安全上限的比例，1 表示正好触顶 */
  load: number;
  /** 源图 + 外框同时驻留的粗略峰值（不含导出编码缓冲） */
  estimatedBytes: number;
  /** 面向用户的一句话结论 */
  message: string;
  /** 仅 blocked 时给出：把源图长边压到该值以内即可回到安全区 */
  suggestedMaxDimension: number | null;
}

interface LayoutInputLike {
  marginRatio: number;
  bottomWeight: number;
  targetAspect: number | null;
}

function framedSize(
  imageW: number,
  imageH: number,
  input: LayoutInputLike,
): { w: number; h: number } {
  const layout = calculateLayout(imageW, imageH, input);
  return { w: layout.canvasW, h: layout.canvasH };
}

function toLayoutInput(config: FrameConfig, defaults: Required<LayoutInputLike>): LayoutInputLike {
  return {
    marginRatio: config.marginRatio ?? defaults.marginRatio,
    bottomWeight: config.bottomWeight ?? defaults.bottomWeight,
    targetAspect: config.targetAspect ?? defaults.targetAspect,
  };
}

/** 引擎默认值。与 DEFAULT_CONFIG 保持一致，避免循环依赖所以在此重复一份常量。 */
const DEFAULT_LAYOUT_INPUT: Required<LayoutInputLike> = {
  marginRatio: 0.14,
  bottomWeight: 1.25,
  targetAspect: null,
};

/**
 * 评估按当前配置装裱某张图需要多少像素。
 *
 * `limit` 可注入，便于测试；不传则取**本机**上限（`resolveCanvasLimit()`）——
 * 手机的单画布上限只有桌面常量的七分之一左右，写死一个数会让守卫在 iOS 上
 * 放行一次注定画不出东西的导出（详见 engine/canvasLimit.ts）。
 */
export function assessFrame(
  imageW: number,
  imageH: number,
  config: FrameConfig = {},
  limit: number = resolveCanvasLimit(),
): RenderBudget {
  const input = toLayoutInput(config, DEFAULT_LAYOUT_INPUT);
  const { w: framedW, h: framedH } = framedSize(imageW, imageH, input);

  const framedPixels = framedW * framedH;
  const sourcePixels = imageW * imageH;
  const megapixels = framedPixels / 1e6;
  const load = framedPixels / limit;
  const estimatedBytes = (framedPixels + sourcePixels) * BYTES_PER_PIXEL;

  const base = {
    framedW,
    framedH,
    megapixels,
    load,
    estimatedBytes,
  };

  if (framedPixels > limit) {
    const suggestion = suggestMaxDimension(imageW, imageH, config, limit);
    return {
      ...base,
      level: 'blocked',
      suggestedMaxDimension: suggestion,
      message:
        `外框 ${framedW} × ${framedH}（${megapixels.toFixed(1)}MP）` +
        `超出画布安全上限 ${(limit / 1e6).toFixed(0)}MP。` +
        (suggestion
          ? `把源图长边压到 ${suggestion}px 以内即可安全导出。`
          : `请调小边距比例后重试。`),
    };
  }

  if (load > HEAVY_LOAD) {
    return {
      ...base,
      level: 'heavy',
      suggestedMaxDimension: null,
      message:
        `外框 ${framedW} × ${framedH}（${megapixels.toFixed(1)}MP），` +
        `约 ${formatMemory(estimatedBytes)}，已占安全上限的 ${Math.round(load * 100)}%，` +
        `预览与导出会明显变慢。`,
    };
  }

  return {
    ...base,
    level: 'ok',
    suggestedMaxDimension: null,
    message: `外框 ${framedW} × ${framedH}（${megapixels.toFixed(1)}MP），约 ${formatMemory(
      estimatedBytes,
    )}，余量充足。`,
  };
}

/**
 * 求"源图长边压到多少像素，装裱后能落回**余量充足**的一档"。
 *
 * 刻意不瞄准上限本身。上限只是"不会崩"的线，贴着它给建议有两个代价：
 * 用户点完"一键修正"后黄色"偏重"警告还挂在那里（语义上没错，但看起来像没修好），
 * 而且此后每一次预览与导出都要按顶格内存跑。修正的意义本该是"回到轻松的那一档"，
 * 所以目标定在 HEAVY_LOAD（上限的 55%）—— 按建议值缩过之后，
 * `assessFrame` 判定的档位正好是 'ok'，警告消失。
 *
 * 也就是说：想拿最大可导出的尺寸，用户该去选 8K 预设；这里给的是"能顺畅干活"的尺寸。
 *
 * 外框像素随源图尺寸单调递增，因此可以二分。返回 null 表示即使压到
 * `floor` 仍然超限 —— 那说明是边距比例或比例约束出了问题，不是尺寸问题。
 */
export function suggestMaxDimension(
  imageW: number,
  imageH: number,
  config: FrameConfig = {},
  limit: number = resolveCanvasLimit(),
  floor = 1200,
): number | null {
  const input = toLayoutInput(config, DEFAULT_LAYOUT_INPUT);
  const longSide = Math.max(imageW, imageH);
  /** 建议值要落进去的目标像素数。比上限低一档，不是上限本身 */
  const target = limit * HEAVY_LOAD;

  const fits = (dimension: number): boolean => {
    const ratio = dimension / longSide;
    const w = Math.max(1, Math.round(imageW * ratio));
    const h = Math.max(1, Math.round(imageH * ratio));
    const framed = framedSize(w, h, input);
    return framed.w * framed.h <= target;
  };

  if (!fits(floor)) return null;
  if (fits(longSide)) return longSide;

  let low = floor;
  let high = longSide;
  // 二分 20 次足以收敛到 1px 精度内，且循环次数有确定上界
  for (let i = 0; i < 20 && high - low > 1; i += 1) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid;
  }

  return low;
}

export interface ResidentMemoryReport {
  level: BudgetLevel;
  /** 驻留条目数 */
  count: number;
  /** 工作副本像素合计 */
  megapixels: number;
  estimatedBytes: number;
  /** 本次评估使用的上限 */
  limit: number;
  /** estimatedBytes / limit，UI 进度条直接用这个 */
  load: number;
  message: string;
}

/**
 * 评估队列里所有工作副本的合计占用。
 *
 * 注意这跟"渲染峰值"是两个模型：渲染是一次一张（峰值取最大），
 * 而工作副本是全部同时在内存里（合计求和）。混用会严重误判。
 */
export function assessResidentMemory(
  sizes: readonly { width: number; height: number }[],
  limit: number = RESIDENT_LIMIT_BYTES,
): ResidentMemoryReport {
  let pixels = 0;
  for (const size of sizes) pixels += size.width * size.height;

  const megapixels = pixels / 1e6;
  const estimatedBytes = pixels * BYTES_PER_PIXEL;

  const base = {
    count: sizes.length,
    megapixels,
    estimatedBytes,
    limit,
    load: limit > 0 ? estimatedBytes / limit : 0,
  };

  if (estimatedBytes > limit) {
    return {
      ...base,
      level: 'blocked',
      message: `${sizes.length} 张已占用约 ${formatMemory(estimatedBytes)}，超过安全上限 ${formatMemory(
        limit,
      )}，请先移除部分图片。`,
    };
  }

  if (estimatedBytes > RESIDENT_SOFT_BYTES) {
    return {
      ...base,
      level: 'heavy',
      message: `${sizes.length} 张占用约 ${formatMemory(estimatedBytes)}，浏览器已开始吃力。`,
    };
  }

  return {
    ...base,
    level: 'ok',
    message: `${sizes.length} 张占用约 ${formatMemory(estimatedBytes)}。`,
  };
}

/**
 * 设备自适应的驻留上限。
 *
 * Chrome 暴露 navigator.deviceMemory（单位 GB，且向下取整到 2 的幂），
 * 小内存机器上应当更保守。其他浏览器拿不到，退回默认值。
 */
export function defaultResidentLimit(): number {
  if (typeof navigator === 'undefined') return RESIDENT_LIMIT_BYTES;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof memory !== 'number' || !Number.isFinite(memory) || memory <= 0) {
    return RESIDENT_LIMIT_BYTES;
  }
  // 给浏览器留出至少一半内存给画布、编码缓冲和其他标签页
  const budget = memory * 1024 * 1024 * 1024 * 0.35;
  return Math.max(256 * 1024 * 1024, Math.min(RESIDENT_LIMIT_BYTES, budget));
}

export function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
