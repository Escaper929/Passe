import type { Layout } from '@/engine/layout';

import { PROFILE_SPECS, type ProfileSpec } from './fingerprint';

/**
 * 尺度不变性探针：量出**倒角带的像素宽度**，换算回设计单位。
 *
 * ## 为什么不能跨尺度逐点比指纹
 *
 * 实测过：把源图放大两倍，同一条探针在开窗边缘那一点上能差 150 级亮度。
 * 原因有两层：
 *
 * 1. `scaledPx` 是取整的，特征只有 2~4px 宽时取整的相对误差小不了。
 * 2. 采样点落在特征上的相位不同：一边落在切面上、一边落在相片里。
 *
 * 所以跨尺度不比**值**，比**量出来的几何** —— 这也正是开发指南 §1 那条红线的原文要求。
 *
 * ## 两条踩过的坑，都写在代码里
 *
 * **坑一：双线性插值会把硬边往内抹一个像素。** 第一版直接复用指纹的剖面采样
 * （双线性插值），量出来的宽度比真值小 0.5~1.0px，而且误差随尺寸变 ——
 * 两档尺寸的设计宽度差到 40%，比要抓的 bug 还大。
 * 现在改成**沿探针逐像素行走**（四条探针都是轴对齐的，走起来就是一个
 * 1px 宽的像素条），每个采样点就是一个真实像素，不做任何插值。
 *
 * **坑二：插值要在像素中心坐标系里做。** 像素 i 覆盖 [i, i+1)、中心在 i+0.5。
 * 一条"带→纸面"的硬边，真值就在两个像素的交界上；把两个像素的**中心**
 * 连线求中点，交点恰好落在交界上，没有系统性偏移。实测两档尺寸的设计宽度
 * 相差不到 2%，这才让容差能收到 10% —— 而"漏乘 scaleFactor"产生的偏差是 50%+。
 *
 * ## 判"回到纸面"用的是绝对差，不是"比纸面暗"
 *
 * 炭黑卡纸（#1C1C1E，亮度 28）上倒角带是 245，比纸面**亮**得多，极性是反的。
 * 用"与参考亮度的差 ≤ 阈值"+ 连续两点去抖，明暗两种卡纸都成立。
 */

export interface EdgeBandMeasurement {
  probeId: string;
  /** 换算回 1200px 短边设计坐标系的宽度 */
  designWidth: number;
  /** 实测像素宽度 */
  pixelWidth: number;
  /** 倒角带的亮度（取向列中位数） */
  bandLevel: number;
  /** 纸面参考亮度 */
  matLevel: number;
}

/** 取参考亮度时用靠纸面那一端的多少个像素。 */
const REFERENCE_SAMPLES = 8;

/**
 * 判定"这是倒角带 / 这是纸面"用的是**观察到的两个亮度之间的中点**，
 * 不是固定的对比阈值。
 *
 * 固定阈值试过：浅色卡纸背光侧的倒角带是 235、纸面是 242 —— 只差 7 级，
 * 纸纹抖动 ±2 就能让某个纸面像素被当成倒角带，量出来的宽度从 2.2 跳到 2.6。
 * 改成"相对中点分类"之后，两侧只要**彼此**分得开就够了，与绝对差无关；
 * 炭黑卡纸上倒角带（245）比纸面（28）亮得多，极性相反也一样成立。
 */
const MIN_BAND_CONTRAST = 2;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function measureBevelBand(
  canvas: HTMLCanvasElement,
  spec: ProfileSpec,
  layout: Layout,
): EdgeBandMeasurement | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const [xa, ya] = spec.from(layout);
  const [xb, yb] = spec.to(layout);
  const horizontal = Math.abs(xb - xa) > Math.abs(yb - ya);
  // 逐像素行走要求探针轴对齐；四条探针都是这么定义的
  if (horizontal ? Math.abs(yb - ya) > 0.5 : Math.abs(xb - xa) > 0.5) return null;

  const lo = Math.round(horizontal ? Math.min(xa, xb) : Math.min(ya, yb));
  const hi = Math.round(horizontal ? Math.max(xa, xb) : Math.max(ya, yb));
  const length = hi - lo + 1;
  if (length < 12) return null;

  const fixed = Math.round(horizontal ? ya : xa);
  const strip = horizontal
    ? ctx.getImageData(lo, fixed, length, 1)
    : ctx.getImageData(fixed, lo, 1, length);

  const samples: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const p = i * 4;
    samples.push(0.2126 * strip.data[p] + 0.7152 * strip.data[p + 1] + 0.0722 * strip.data[p + 2]);
  }

  // 开窗边缘在像素中心坐标系里的位置：像素 i 的中心是 i，覆盖 [i, i+1)
  const edge =
    spec.matEnd === 'end'
      ? horizontal
        ? layout.x + layout.w
        : layout.y + layout.h
      : horizontal
        ? layout.x
        : layout.y;
  const edgePos = edge - lo - 0.5;
  if (edgePos < 1 || edgePos > length - 2) return null;

  const step = spec.matEnd === 'end' ? 1 : -1;
  const matLevel =
    step > 0
      ? median(samples.slice(-REFERENCE_SAMPLES))
      : median(samples.slice(0, REFERENCE_SAMPLES));

  const start = step > 0 ? Math.ceil(edgePos) : Math.floor(edgePos);
  const seed = samples[start];
  // 紧贴边缘就是纸面：这一侧没有倒角带
  if (Math.abs(seed - matLevel) < MIN_BAND_CONTRAST) return null;

  /** 从开窗边缘向外找"连续两个像素都落在纸面一侧"的第一个像素。 */
  const findFirstMat = (bandLevel: number): number => {
    const middle = (bandLevel + matLevel) / 2;
    const matIsBrighter = matLevel > bandLevel;
    const isMatSide = (value: number): boolean => (matIsBrighter ? value > middle : value < middle);
    for (let i = start; i >= 0 && i < length; i += step) {
      const next = i + step;
      if (next < 0 || next >= length) break;
      if (isMatSide(samples[i]) && isMatSide(samples[next])) return i;
    }
    return -1;
  };

  let firstMat = findFirstMat(seed);
  if (firstMat < 0 || firstMat === start) return null;

  // 用整段倒角带的中位数再判一次：单像素当种子会被边缘抗锯齿带偏
  const collect = (first: number): number[] => {
    const values: number[] = [];
    for (let i = start; ; i += step) {
      values.push(samples[i]);
      if (i === first - step) break;
    }
    return values;
  };
  const bandLevel = median(collect(firstMat));
  firstMat = findFirstMat(bandLevel);
  if (firstMat < 0 || firstMat === start) return null;

  const lastBand = firstMat - step;

  /** 在两个像素中心之间线性插值出等于 threshold 的位置（像素中心坐标系）。 */
  const crossing = (iA: number, iB: number, threshold: number): number => {
    const vA = samples[iA];
    const vB = samples[iB];
    if (vB === vA) return iB;
    const frac = Math.min(1, Math.max(0, (threshold - vA) / (vB - vA)));
    return iA + (iB - iA) * frac;
  };

  const inner = crossing(start - step, start, (samples[start - step] + bandLevel) / 2);
  const outer = crossing(lastBand, firstMat, (bandLevel + matLevel) / 2);
  const pixelWidth = Math.abs(outer - inner);

  return {
    probeId: spec.id,
    pixelWidth,
    bandLevel,
    matLevel,
    designWidth: pixelWidth / layout.scale,
  };
}

/** 量出所有轴对齐探针上的倒角带（受光面量不到会返回 null，属正常）。 */
export function measureBevelBands(
  canvas: HTMLCanvasElement,
  layout: Layout,
): Record<string, EdgeBandMeasurement | null> {
  const result: Record<string, EdgeBandMeasurement | null> = {};
  for (const spec of PROFILE_SPECS) {
    result[spec.id] = measureBevelBand(canvas, spec, layout);
  }
  return result;
}
