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
  stampExclusionBand,
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

/* ────────────── 底边带的三道锁：带内、带沿、带外 ────────────── */

/*
 * 底边带（相片下沿到底边、横向整幅）是所有排除区里唯一与**字体无关**的一块，
 * 也是最容易被顺手改坏的一块 —— 调字体、调字号、改网格分辨率都会碰到它。
 * 所以三个方向各有一条用例：带内确实没进指纹、钢印确实没越出带沿、
 * 带外该报的回归确实还能报出来（见下面各条用例自己的注释）。
 */

describe('视觉回归 · 底边带不进指纹', () => {
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

    // 底边带整条都被排除了，所以换了字也不该有任何一点变化
    expect(renamedFingerprint.grid.cells).toEqual(original.fingerprint.grid.cells);
    expect(renamedFingerprint.profiles).toEqual(original.fingerprint.profiles);
  });

  /**
   * 底边带是**自证**的：钢印只要漏进指纹，上面那条「换掉机型名指纹必须不变」就会红。
   * 但它成立有个前提 —— 钢印整块得落在带内。真越到相片上时，上面那条只会以
   * "指纹不一致"的形式报警，看不出是"字跑到相片上了"。
   *
   * 所以这里正面量一次，而且要量的是**整组**（图标 + 文字），不只是文字的左右缘：
   * 两者都各自居中画（见 `drawDeboss`），水平占位取更宽的那个。
   *
   * 量尺全部取自 `stampGeometry` 与量宽助手，**不在这里重算**。
   * 这里踩过一次：v1.4.4 把字号 9.5 → 14、字距 2.4 → 3.5 之后，本条用例还按
   * 9.5 / 2.4 在量 —— 这把尺子比真实值乐观了三分之一，而它照样全绿。
   * **量尺与算式分家，是"断言还在、守卫已经失效"的典型。**
   */
  it('钢印整块落在底边带内 —— 越到相片上，指纹里就会混进随字体变的像素', () => {
    let checked = 0;

    for (const scene of VISUAL_SCENES) {
      const resolved = resolveConfig(scene.config);
      if (!resolved.enableStamp || !resolved.layers.stamp) continue;

      const { canvas, layout } = renderScene(scene);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(`${scene.id}：无 2D 上下文`);

      const geometry = stampGeometry(layout);
      const label = stampLabel(resolved.cameraModel, resolved.filmBrand);
      const inkWidth = measureStampLabelInk(ctx, label, geometry);
      const band = stampExclusionBand(layout);

      const halfWidth = Math.max(inkWidth, geometry.iconWidth) / 2;
      const centerX = layout.x + layout.w / 2;
      // 文字以 middle 基线画在 textY，上下各占约半个字高；图标中心在 iconY
      const top = geometry.iconY - geometry.iconHeight / 2;
      const bottom = geometry.textY + geometry.fontSize / 2;

      console.log(
        `[钢印带] ${scene.id}：墨迹 ${inkWidth.toFixed(0)}px、组半宽 ${halfWidth.toFixed(0)}px｜` +
          `纵向 ${top.toFixed(0)}..${bottom.toFixed(0)}（带 ${band.y0.toFixed(0)}..${band.y1.toFixed(0)}）`,
      );

      expect(top, `${scene.id}：钢印上沿压到相片上了`).toBeGreaterThanOrEqual(band.y0);
      expect(bottom, `${scene.id}：钢印下沿越出画布`).toBeLessThanOrEqual(band.y1);
      expect(centerX - halfWidth, `${scene.id}：钢印左缘越出画布`).toBeGreaterThanOrEqual(band.x0);
      expect(centerX + halfWidth, `${scene.id}：钢印右缘越出画布`).toBeLessThanOrEqual(band.x1);

      checked += 1;
    }

    expect(checked, '没有任何场景带钢印，这条用例等于没跑').toBeGreaterThan(0);
  });

  /**
   * 界面给机型与胶卷各配了一份候选列表（`stampSubjects.ts`）。
   *
   * 用户在两边各点一下，就会得到**这个列表能产出的最长那一行字**。
   * 那条最长的组合必须留在相片宽度内 —— 否则"提供了这个选项"
   * 就等于"提供了一个会把字样压到卡纸上的选项"，而这只有在用户真去点的时候才发作。
   *
   * ⚠️ 判定线只能是**设计量**：相片宽度（`layout.x .. layout.x + layout.w`），
   * 与 `render.test.ts`「再长的机型名也留在照片宽度内」是同一条。
   *
   * 这里踩过一次，值得记住整条链路 —— 当时判定线取的是**指纹排除带**，一个
   * 宽度只由画布几何决定（与字体无关）的固定框，而被判的墨迹宽度**随字体走**：
   * 同一行 44 个字，本机墨迹 173px 占带 97%（贴着边过），CI 的字体回退
   * （无 Arial/Helvetica，落到 DejaVu 系）是 267px = 150%，直接判死。
   * 等于把"CI 装了哪几个字体"变成了验收条件。
   *
   * 换成相片宽度之后，余量按字号的实测推：
   * - 本机：最紧的 `small-source` 还剩 56px（墨迹 188 / 相片宽 300），其余八个场景 ≥ 147px；
   * - CI：`small-source` 折算下来剩 **8px** —— 因为那一档的字号被钳位下限顶在 8px
   *   （画布只有 356px 宽），小画布上钢印**本来就**相对偏大，而 21 号字又把它推近了一格。
   *   这是余量最小的一条；真要越过去就是字压到相纸上，那确实该报错。
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

      const left = centerX - inkWidth / 2;
      const right = centerX + inkWidth / 2;
      const slack = Math.round(Math.min(left - layout.x, layout.x + layout.w - right));

      checked.push(
        `${scene.id} 余 ${slack}px／相片宽 ${Math.round(layout.w)}px` +
          `（墨迹 ${inkWidth.toFixed(0)}px）`,
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
