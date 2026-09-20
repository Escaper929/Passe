import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Layout } from '@/engine/layout';
import type { FrameConfig } from '@/engine/types';
import { compareFingerprint, computeFingerprint } from '@/test/visual/fingerprint';
import { installNativeCanvas } from '@/test/visual/nativeCanvas';
import { measureBevelBands, type EdgeBandMeasurement } from '@/test/visual/scaleProbe';
import { findScene, renderScene, type PhotoSize } from '@/test/visual/scenes';

/**
 * 尺度不变性（开发指南 §1 的红线）。
 *
 * > 所有线宽、倒角宽度、阴影模糊半径都必须以 1200px 短边为基准书写，
 * > 再乘以 scaleFactor，才能保证 1000px 屏幕预览与 8K 打印件的比例绝对一致。
 *
 * 这条红线此前只有"每一处都记得乘"的自觉在守：属性断言管不到它，
 * 而它恰恰是最容易漏的 —— 少乘一次不会有任何报错，只会让成品与预览的比例走样，
 * 等用户拿去打印才发现。
 *
 * ## 两个检查，各管一段
 *
 * 1. **网格跨尺度一致**：16×16 平均亮度对大面积变化敏感、天然抗抖动，
 *    管"边距、开窗位置、整体明度"这类**大几何**。
 * 2. **倒角带宽度换算回设计单位后一致**：对细特征的**实测**，直接对应红线原文。
 *
 * ## 尺度为什么选 1× 与 2×，边距为什么固定 0.15
 *
 * `scaledPx` 是取整的，取整会让同一条倒角在两档尺寸下的**设计宽度**天然出现偏差 ——
 * 特征越细偏得越多。所以这两档是**挑过**的：`marginRatio` 取 0.15 时
 * 源图 1200×800 得到画布 1440×1070，源图 2400×1600 得到 2880×2140，
 * 恰好是严格的 2:1；倒角也恰好是 2px 与 4px（`round(2.5×0.8917)=2`、
 * `round(2.5×1.7833)=4`），取整误差被消掉，剩下的才是真的比例问题。
 *
 * ## 为什么取四条探针的中位数
 *
 * 单条探针会被低对比边坑到：浅色卡纸背光侧的倒角带与纸面只差 7 级，
 * 纸纹抖动能把某条探针量出的宽度推高 15%。但四条探针量的是**同一个**
 * `bevelWidth`，取中位数就把单条探针的失手挡掉了 —— 实测两档中位数相差 1.3%
 * （炭黑卡纸上 0.1%），而"漏乘 scaleFactor"产生的偏差是 50%。
 */

/** 两档的相对放大：源图 1200×800 → 2400×1600。 */
const MAGNIFY = 2;

/** 固定边距比例，让两档画布严格成 2:1（见文件头说明）。 */
const SCALE_CONFIG: Partial<FrameConfig> = { marginRatio: 0.15 };

/** 倒角带中位数设计宽度的跨尺度相对容差。实测 1.3%，这里留约 8 倍余量。 */
const DESIGN_WIDTH_RELATIVE_TOLERANCE = 0.1;

/** 网格均值跨尺度容差。 */
const GRID_MEAN_TOLERANCE = 1;

const SCENE_IDS = ['baseline-light', 'dark-gallery'] as const;

beforeAll(() => {
  installNativeCanvas();
});

afterAll(() => {
  vi.restoreAllMocks();
});

interface SampledScene {
  canvas: HTMLCanvasElement;
  layout: Layout;
  bands: Record<string, EdgeBandMeasurement | null>;
}

function sampleAt(sceneId: string, magnify: number): SampledScene {
  const scene = findScene(sceneId);
  const photo: PhotoSize = {
    width: scene.photo.width * magnify,
    height: scene.photo.height * magnify,
  };
  const { canvas, layout } = renderScene(scene, photo, SCALE_CONFIG);
  return { canvas, layout, bands: measureBevelBands(canvas, layout) };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 四条探针量出来的设计宽度中位数；任何一条量不到都会先被下面的用例点出来。 */
function medianDesignWidth(bands: Record<string, EdgeBandMeasurement | null>): number {
  const widths = Object.values(bands).map((band) => band?.designWidth ?? Number.NaN);
  if (widths.some((width) => Number.isNaN(width))) {
    throw new Error(`有探针没量到倒角带：${JSON.stringify(bands, null, 2)}`);
  }
  return median(widths as number[]);
}

describe('尺度不变性 · 预览与导出比例必须一致', () => {
  for (const sceneId of SCENE_IDS) {
    it(`${sceneId}：两档画布严格成 ${MAGNIFY}:1（尺度可比的前提）`, () => {
      const small = sampleAt(sceneId, 1);
      const big = sampleAt(sceneId, MAGNIFY);
      expect(big.layout.canvasW).toBe(small.layout.canvasW * MAGNIFY);
      expect(big.layout.canvasH).toBe(small.layout.canvasH * MAGNIFY);
      expect(big.layout.scale).toBeCloseTo(small.layout.scale * MAGNIFY, 6);
    });

    it(`${sceneId}：四边倒角带在两种尺寸下量出来的设计宽度一致`, () => {
      const small = sampleAt(sceneId, 1);
      const big = sampleAt(sceneId, MAGNIFY);

      const smallWidth = medianDesignWidth(small.bands);
      const bigWidth = medianDesignWidth(big.bands);
      const relative = Math.abs(smallWidth - bigWidth) / Math.max(smallWidth, bigWidth);

      const detail = Object.entries(small.bands)
        .map(([id, band]) => `${id} ${(band as EdgeBandMeasurement).pixelWidth.toFixed(2)}px`)
        .join('｜');
      console.log(
        `[尺度不变性] ${sceneId} 倒角带设计宽度 ${smallWidth.toFixed(3)} vs ${bigWidth.toFixed(3)}` +
          `（小图各边 ${detail}）→ 相对差 ${(relative * 100).toFixed(2)}%`,
      );

      // 先确认"量出来的东西是对的"：量到 0.3 或 18 也判失败，
      // 否则探针坏掉时两档会一起坏、比出来反而"一致"
      expect(smallWidth).toBeGreaterThan(1.8);
      expect(smallWidth).toBeLessThan(3.2);

      expect(relative).toBeLessThan(DESIGN_WIDTH_RELATIVE_TOLERANCE);
    });

    it(`${sceneId}：网格（边距、开窗位置、整体明度）跨尺度不变`, () => {
      const small = sampleAt(sceneId, 1);
      const big = sampleAt(sceneId, MAGNIFY);
      const smallFp = computeFingerprint(`${sceneId}@1×`, small.canvas, small.layout);
      const bigFp = computeFingerprint(`${sceneId}@${MAGNIFY}×`, big.canvas, big.layout);

      const diff = compareFingerprint(smallFp, bigFp, { ignoreCanvasSize: true });
      console.log(
        `[尺度不变性] ${sceneId} 网格平均偏差 ${diff.gridMeanDelta.toFixed(2)}／越界 ${diff.gridExceedCount} 格`,
      );

      expect(diff.gridMeanDelta).toBeLessThan(GRID_MEAN_TOLERANCE);
      expect(diff.gridExceedCount).toBe(0);
    });
  }

  it('负向对照：漏乘 scaleFactor 必须被量出来', () => {
    const sceneId = 'baseline-light';
    const scene = findScene(sceneId);
    const correct = sampleAt(sceneId, MAGNIFY);
    const reference = sampleAt(sceneId, 1);

    // 2× 的画布上，bevelWidth 的设计值应当仍是 2.5（内部再乘 2）。
    // 这里除以 2 → 渲染出来的切面仍是 2px —— 正是"漏乘 scaleFactor"的产物。
    const wrong = renderScene(
      scene,
      { width: scene.photo.width * MAGNIFY, height: scene.photo.height * MAGNIFY },
      { ...SCALE_CONFIG, bevelWidth: 2.5 / MAGNIFY },
    );
    const wrongWidth = medianDesignWidth(measureBevelBands(wrong.canvas, wrong.layout));
    const referenceWidth = medianDesignWidth(reference.bands);
    const relative = Math.abs(referenceWidth - wrongWidth) / Math.max(referenceWidth, wrongWidth);

    console.log(
      `[尺度不变性·负向对照] 设计宽度 正确 ${referenceWidth.toFixed(3)}／` +
        `漏乘 ${wrongWidth.toFixed(3)}（未漏乘的同尺寸应为 ${medianDesignWidth(correct.bands).toFixed(3)}）` +
        ` → 相对差 ${(relative * 100).toFixed(1)}%`,
    );

    expect(relative).toBeGreaterThan(DESIGN_WIDTH_RELATIVE_TOLERANCE * 2);
  });
});
