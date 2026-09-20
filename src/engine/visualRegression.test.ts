import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '@/engine/GalleryFramingEngine';
import { scaledPx } from '@/engine/scaleFactor';
import type { FrameConfig } from '@/engine/types';
import {
  baselinePath,
  readBaseline,
  updateMode,
  writeBaseline,
  writeDiagnostics,
  DIAGNOSTIC_DIR,
} from '@/test/visual/baselines';
import { writeContactSheet } from '@/test/visual/contactSheet';
import {
  compareFingerprint,
  computeFingerprint,
  formatDiff,
  isMatch,
  stampTextBand,
  summarizeDiff,
} from '@/test/visual/fingerprint';
import { installNativeCanvas } from '@/test/visual/nativeCanvas';
import { VISUAL_SCENES, findScene, renderScene, type VisualScene } from '@/test/visual/scenes';

/**
 * 阶段 5：视觉回归基线。
 *
 * ## 这个文件守的是什么
 *
 * 前面的测试都是"属性断言"：纸纹出现了没有、内阴影是不是左上更重、钢印有没有反差。
 * 它们证明每一层**存在**，但证明不了"这一版看起来和上一版一样"。
 * 一个把倒角从 2.5px 调成 1px 的改动，能让所有属性断言继续通过。
 *
 * 这里补上另一半：把十个固定场景的渲染结果压成指纹存进 `src/test/visual/baselines/`，
 * 每次跑测试重新渲染并比对。指纹的构成、容差的来历、以及**已知盲区**
 * 都写在 `src/test/visual/fingerprint.ts` 的模块注释里。
 *
 * ## 怎么用
 *
 * - `npm test`：正常比对。不一致会打印"哪个场景、哪条探针、第几个采样点、偏了多少"，
 *   并把实际渲染图与完整报告写到 `src/test/visual/__out__/`（不进版本库）。
 * - `npm run visual:update`：**有意**改动了观感之后重建基线。测试绝不自动写基线 ——
 *   那样回归就退化成"把当前结果抄一遍"，等于没有回归。
 * - `npm run visual:report`：只重出人眼评审拼图。
 */

const UPDATE = updateMode();

beforeAll(() => {
  installNativeCanvas();
});

afterAll(() => {
  vi.restoreAllMocks();
});

interface SceneFingerprintBundle {
  canvas: HTMLCanvasElement;
  fingerprint: ReturnType<typeof computeFingerprint>;
  layout: ReturnType<typeof renderScene>['layout'];
}

function fingerprintOf(scene: VisualScene): SceneFingerprintBundle {
  const { canvas, layout } = renderScene(scene);
  return { canvas, layout, fingerprint: computeFingerprint(scene.id, canvas, layout) };
}

/* ─────────────────────────── 正式比对 ─────────────────────────── */

describe.skipIf(UPDATE !== null)('视觉回归 · 指纹比对', () => {
  for (const scene of VISUAL_SCENES) {
    it(`${scene.id} —— ${scene.note}`, () => {
      const baseline = readBaseline(scene.id);
      if (!baseline) {
        throw new Error(
          `缺少基线 ${baselinePath(scene.id)}。首次使用或新增了场景请跑：npm run visual:update`,
        );
      }

      const { canvas, layout, fingerprint } = fingerprintOf(scene);
      const diff = compareFingerprint(baseline, fingerprint, { layout });

      if (!isMatch(diff)) {
        const files = writeDiagnostics(scene.id, canvas, diff);
        const hint = files.length > 0 ? `\n  诊断产物：${files.join('、')}` : '';
        throw new Error(`${formatDiff(diff)}${hint}\n  诊断目录：${DIAGNOSTIC_DIR}`);
      }

      expect(diff.comparedPoints).toBeGreaterThan(0);
    });
  }
});

/* ─────────────────────── 钢印文字带的两道锁 ─────────────────────── */

describe('视觉回归 · 钢印文字带不进指纹', () => {
  it('换掉机型名与胶卷名，指纹必须逐点一致 —— 证明带内确实没参与比对', () => {
    const base = findScene('baseline-light');
    const renamed = renderScene({
      ...base,
      config: {
        ...base.config,
        cameraModel: 'HASSELBLAD 907X & CFV II 50C',
        filmBrand: 'KODAK PORTRA 400',
      },
    });

    const original = fingerprintOf(base);
    const renamedFingerprint = computeFingerprint(base.id, renamed.canvas, renamed.layout);

    // 文字带被排除了，所以换了字也不该有任何一点变化
    expect(renamedFingerprint.grid.cells).toEqual(original.fingerprint.grid.cells);
    expect(renamedFingerprint.profiles).toEqual(original.fingerprint.profiles);
  });

  it('每个场景的钢印文字都落在排除带内 —— 用真实字体实测宽度，带子不够宽就会失败', () => {
    for (const scene of VISUAL_SCENES) {
      const resolved = resolveConfig(scene.config);
      if (!resolved.enableStamp || !resolved.layers.stamp) continue;

      const { canvas, layout } = renderScene(scene);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(`${scene.id}：无 2D 上下文`);

      // 与 materials.ts 的 drawDeboss 同源：逐字度量 + 末尾不计字距
      const label = [resolved.cameraModel, resolved.filmBrand]
        .filter(Boolean)
        .join('   /   ')
        .toUpperCase();
      const fontSize = scaledPx(9.5, layout.canvasW, layout.canvasH, 8);
      const tracking = 2.4 * layout.scale;

      ctx.font = `600 ${fontSize}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
      const chars = Array.from(label);
      const inkWidth =
        chars.reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) +
        tracking * (chars.length - 1);

      const centerX = layout.x + layout.w / 2;
      const band = stampTextBand(layout);

      expect(centerX - inkWidth / 2, `${scene.id}：文字左缘越出排除带`).toBeGreaterThanOrEqual(
        band.x0,
      );
      expect(centerX + inkWidth / 2, `${scene.id}：文字右缘越出排除带`).toBeLessThanOrEqual(
        band.x1,
      );
    }
  });
});

/* ─────────────────── 负向对照：容差真的抓得住回归 ─────────────────── */

/**
 * 光有"改动会失败"的信念不够 —— 容差可以被一路放宽到什么都不报。
 * 这一组用例把若干**必须失败**的改动喂给判定函数，是这道闸门的自检。
 *
 * 顺带把每条对照的实测数字打出来：数字能说明"这条余量还有多少"，
 * 也让人一眼看出哪个材质变敏感、哪个变得迟钝了。
 */
describe('视觉回归 · 负向对照（改了必须报错）', () => {
  const base = findScene('baseline-light');

  const controls: { title: string; config: Partial<FrameConfig> }[] = [
    { title: '倒角整层关闭', config: { layers: { bevel: false } } },
    { title: '内阴影整层关闭', config: { layers: { insetShadow: false } } },
    { title: '切面宽度 2.5 → 6（变宽 2.4 倍）', config: { bevelWidth: 6 } },
    { title: '内阴影半径 6 → 12（羽化加倍）', config: { insetShadowBlur: 12 } },
    { title: '卡纸换成暗房象牙', config: { matColor: '#F4F0E6' } },
    { title: '底边加权 1.25 → 1（几何变了）', config: { bottomWeight: 1 } },
  ];

  for (const control of controls) {
    it(`${control.title} —— 必须判为不通过`, () => {
      const good = fingerprintOf(base);
      const bad = fingerprintOf({
        ...base,
        config: { ...base.config, ...control.config },
      });

      const diff = compareFingerprint(good.fingerprint, bad.fingerprint, { layout: bad.layout });
      console.log(`[负向对照] ${control.title} → ${summarizeDiff(diff)}`);

      expect(isMatch(diff), `这条改动没有被抓到：${control.title}`).toBe(false);
      expect(diff.reasons.length).toBeGreaterThan(0);
    });
  }

  it('反过来：同一个场景渲染两次必须逐点一致（否则基线没有意义）', () => {
    const first = fingerprintOf(base);
    const second = fingerprintOf(base);
    const diff = compareFingerprint(first.fingerprint, second.fingerprint);
    expect(isMatch(diff), `同一场景两次渲染竟然不一致：${summarizeDiff(diff)}`).toBe(true);
    expect(diff.maxDelta).toBe(0);
  });
});

/* ─────────────────────────── 基线重建 ─────────────────────────── */

describe.runIf(UPDATE !== null)('视觉回归 · 重建基线', () => {
  it(`UPDATE_VISUAL=${UPDATE} —— 重写基线与人眼拼图`, () => {
    const written: string[] = [];

    for (const scene of VISUAL_SCENES) {
      const { fingerprint } = fingerprintOf(scene);
      if (UPDATE === 'all') {
        written.push(writeBaseline(fingerprint));
      }
    }

    const sheet = writeContactSheet();
    console.log(
      `[visual] ${UPDATE === 'all' ? `重写基线 ${written.length} 份` : '只重出拼图'}` +
        `｜拼图 ${sheet ?? '（当前画布实现不支持 PNG 编码，已跳过）'}`,
    );
    for (const file of written) {
      console.log(`[visual]   ${file}`);
    }

    expect(VISUAL_SCENES.length).toBeGreaterThan(0);
  });
});
