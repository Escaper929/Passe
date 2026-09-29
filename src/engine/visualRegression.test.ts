import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CAMERA_PRESETS, FILM_PRESETS, longestOf } from '@/components/stampSubjects';
import { resolveConfig } from '@/engine/GalleryFramingEngine';
import { measureStampLabelInk, stampGeometry, stampLabel } from '@/engine/materials';
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

      // 字号、字距、字体串全部取自引擎那一份（`stampGeometry` / 量宽助手）。
      // 这里踩过一次：v1.4.4 把字号 9.5 → 14、字距 2.4 → 3.5 之后，
      // 本条用例还按 9.5 / 2.4 在量 —— 于是这把尺子比真实值乐观了三分之一，
      // 而它照样全绿。**量尺与算式分家，是"断言还在、守卫已经失效"的典型。**
      const geometry = stampGeometry(layout);
      const label = stampLabel(resolved.cameraModel, resolved.filmBrand);
      const inkWidth = measureStampLabelInk(ctx, label, geometry);

      const centerX = layout.x + layout.w / 2;
      const band = stampTextBand(layout);
      const used = (inkWidth / (band.x1 - band.x0)) * 100;

      console.log(
        `[排除带] ${scene.id}：${label.length} 字／墨迹 ${inkWidth.toFixed(0)}px ／` +
          `带宽 ${(band.x1 - band.x0).toFixed(0)}px → 占 ${used.toFixed(0)}%`,
      );

      expect(centerX - inkWidth / 2, `${scene.id}：文字左缘越出排除带`).toBeGreaterThanOrEqual(
        band.x0,
      );
      expect(centerX + inkWidth / 2, `${scene.id}：文字右缘越出排除带`).toBeLessThanOrEqual(
        band.x1,
      );
    }
  });

  /**
   * 界面给机型与胶卷各配了一份候选列表（`stampSubjects.ts`）。
   *
   * 用户在两边各点一下，就会得到**这个列表能产出的最长那一行字**。
   * 那条最长的组合必须留在相片宽度内 —— 否则"提供了这个选项"
   * 就等于"提供了一个会把字样压到卡纸上的选项"，而这只有在用户真去点的时候才发作。
   *
   * ⚠️ 判定线是**相片宽度**（`layout.x .. layout.x + layout.w`），与 `render.test.ts`
   * 「再长的机型名也留在照片宽度内」是同一条。**不要**改成 `stampTextBand()` 那 25%~75%：
   * 排除带的宽度只由画布几何决定（与字体无关），墨迹宽度却随字体走，
   * 而"字体"在 CI 与本机不是同一套 —— 同一份代码，同一行字，CI 上能比本机宽一半。
   *
   * 实测（44 字，`small-source`）：本机墨迹 173px / 带宽 178px = 97%，贴着边过；
   * CI 的字体回退（无 Arial/Helvetica，落到 DejaVu 系）墨迹 267px = 150%，直接判死。
   * 也就是说，拿排除带当设计上限，等于把"CI 装了哪几个字体"变成了验收条件。
   *
   * 换成相片宽度后，同一场景：本机墨迹占相片宽 58%、CI 89%（还剩 16px）——
   * 余量仍然是最紧的一条，因为 `small-source` 的字号本来就被钳位下限顶住了，
   * 小画布上钢印**本来就**相对偏大。但它紧得有道理：真越过去就是字压到卡纸上，
   * 那是该报错的。其余八个场景两边都在 70% 以下。
   */
  it('候选列表里最长的机型 + 最长的胶卷，在每个场景里都留在相片宽度内', () => {
    const cameraModel = longestOf(CAMERA_PRESETS);
    const filmBrand = longestOf(FILM_PRESETS);
    const label = stampLabel(cameraModel, filmBrand);

    const checked: string[] = [];

    for (const scene of VISUAL_SCENES) {
      const resolved = resolveConfig(scene.config);
      if (!resolved.enableStamp || !resolved.layers.stamp) continue;

      const { canvas, layout } = renderScene({
        ...scene,
        config: { ...scene.config, cameraModel, filmBrand },
      });
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(`${scene.id}：无 2D 上下文`);

      const geometry = stampGeometry(layout);
      const inkWidth = measureStampLabelInk(ctx, label, geometry);
      const centerX = layout.x + layout.w / 2;
      const band = stampTextBand(layout);

      const left = centerX - inkWidth / 2;
      const right = centerX + inkWidth / 2;
      const slack = Math.round(Math.min(left - layout.x, layout.x + layout.w - right));

      // 余量按相片宽度算（判定用的那个量），顺带记下占排除带多少 —— 后者只供人眼参考，
      // 它离 100% 多远取决于跑测试的机器装了哪套字体，不构成验收条件。
      checked.push(
        `${scene.id} 余 ${slack}px／相片宽 ${Math.round(layout.w)}px` +
          `（占排除带 ${((inkWidth / (band.x1 - band.x0)) * 100).toFixed(0)}%）`,
      );

      expect(left, `${scene.id}：最长预设的左缘压到卡纸上`).toBeGreaterThanOrEqual(layout.x);
      expect(right, `${scene.id}：最长预设的右缘压到卡纸上`).toBeLessThanOrEqual(
        layout.x + layout.w,
      );
    }

    // 没有一条场景带钢印的话，上面的循环一次都不会进 —— 那样这条用例会静默地"通过"。
    expect(checked.length, '没有任何场景带钢印，这条用例等于没跑').toBeGreaterThan(0);

    console.log(
      `[最长预设] ${cameraModel}   /   ${filmBrand}（${label.length} 字）距相片边缘：` +
        checked.join('｜'),
    );
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
