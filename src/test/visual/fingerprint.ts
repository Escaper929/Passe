import type { Layout } from '@/engine/layout';

/**
 * 视觉指纹：把一张装裱成品压缩成"可读数值"，用于跨提交比对。
 *
 * ## 为什么不是整图 diff
 *
 * 本机没有可用的无头浏览器（GPU 进程在沙箱里直接 FATAL），跨平台的
 * 抗锯齿实现也不保证逐像素相同。整图逐像素 diff 会把大量噪声报成回归，
 * 于是没人看，回归就死了。这里改成两级指纹，各自守一类变化：
 *
 * 1. **网格 `grid`（16×16 平均亮度）**：守大面积的变化 —— 卡纸色偏移、
 *    相片没贴上去、整体明度变了、边距改了。
 * 2. **边缘探针 `profiles`（开窗四边各 48 点）**：守细特征。单靠网格会漏掉
 *    "倒角没了"：外框 1178px 高、16 行 → 每行约 74px，一条 2.5px 宽、
 *    亮度差 8 的切面只把所在行均值拉动 2.5×8/74 ≈ 0.27，落在容差里根本看不见。
 *
 * ## 探针为什么是"显微"的
 *
 * 最初的设计是四条长剖面（每条横跨 300px、64 点）。间距 4.9px —— 而倒角只有
 * 2.5px 宽，一个采样点跨过去就没了，等于用一个测不准的尺子量细节。
 * 现在改成以开窗边缘为中心、向两侧各 20px（乘 scaleFactor）的窗口：
 * 48 点 / 40px ≈ 0.85px 间距，切面、内阴影的羽化、背光暗收边都能落在好几个点上。
 * 跨尺寸时窗口按 scaleFactor 一起缩放，所以 1200 与 3600 短边上的采样
 * 落在同一处**结构**上，尺度不变性才比得起来。
 *
 * 采样用单像素（不做块平均）：纸纹改造为坐标哈希后是逐像素确定的，
 * 块平均反而会把 2.5px 的切面抹平。
 *
 * ## 判定为什么不是"越界点占比"
 *
 * 占比是**全局**指标，结构性回归却往往只影响少数几个点：
 * "倒角整层消失"在 48 点探针上大约打中 3 个点，占比 6% —— 恰好卡在
 * "≤5% 才失败"的线上，改一改参数就漏过去了。所以判定改成
 * **每条剖面自己的最大单点偏差**：探针是围绕某个具体材质设计的，
 * 它上面出现一个 8 级的突变就不可能是抗锯齿抖动。
 *
 * ## 已知盲区（写在明处，免得被误当成"全覆盖"）
 *
 * - **纸纹强度**：强度 0.04 时逐像素抖动约 ±2.3，单点采样下远小于容差，
 *   因此"纸纹整层关掉"这条探针**抓不到** —— 它由 `render.test.ts` 里
 *   针对性的断言守着（平均绝对偏差 2.29 vs 0.00）。
 * - **钢印文字与图标的墨迹**：整条文字带被排除在外（见下），
 *   由排版数学与炭黑反差两条断言守着。
 *
 * ## 与钢印文字的关系
 *
 * 钢印文字用的是 `Inter, -apple-system, BlinkMacSystemFont, sans-serif`。
 * 本机 macOS 落到 SF Pro，CI 的 ubuntu 上这三个都没有、落到 DejaVu，
 * 字形宽度与抗锯齿都不一样；而钢印是**逐字居中**的，宽度一变整行就平移。
 * 9.5px 的小字会把这点差异放大成整条带子的错位。
 *
 * 所以指纹**刻意避开钢印文字带**：网格里与该带相交的格子记为 `null`（不参与比对），
 * 四条探针也全部走在文字带之外。这个范围由两条用例锁住 ——
 * `stampTextBand` 的注释里写了具体是哪两条。
 */

/** 网格分辨率。 */
export const GRID_COLS = 16;
export const GRID_ROWS = 16;

/** 每条探针的采样点数。 */
export const PROFILE_SAMPLES = 48;

/** 探针向边缘两侧各伸展的距离（设计单位，实际会乘 scaleFactor）。 */
export const EDGE_PROBE_SPAN = 20;

export interface Tolerances {
  /** 剖面单点容差：**每条剖面自己的最大单点偏差**不得超过它 */
  profilePointDelta: number;
  /** 剖面均值容差 */
  profileMeanDelta: number;
  /** 网格单点容差（格子平均后的值） */
  gridPointDelta: number;
  /** 允许越界的网格格子数：跨平台抖动可能推动零星几格 */
  gridExceedAllowance: number;
  /** 网格均值容差 */
  gridMeanDelta: number;
  /** 兜底硬线：任何单点越过它直接失败 */
  hardPointDelta: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  profilePointDelta: 6,
  profileMeanDelta: 2,
  gridPointDelta: 6,
  gridExceedAllowance: 2,
  gridMeanDelta: 1.5,
  hardPointDelta: 25,
};

/**
 * 尺度不变性比对的容差。
 *
 * 两档渲染的比例完全一致，但采样落在结构上的**相位**会差一丁点：
 * 探针跨度是 40px（小图）与 120px（大图）各 48 个点，取整抖动在小图上
 * 相当于 0.5/0.85 ≈ 59% 个采样间距，在大图上是 20%。于是紧贴边缘那一两个点
 * 会有十几级的差 —— 这不是回归，是采样相位。
 *
 * 所以放宽单点、盯紧**均值**："线宽忘了乘 scaleFactor"这类错误
 * 会让整条剖面系统性地移位、峰的位置整体挪走，均值必然被拉起来，跑不掉。
 */
export const SCALE_TOLERANCES: Tolerances = {
  profilePointDelta: 14,
  profileMeanDelta: 3,
  gridPointDelta: 6,
  gridExceedAllowance: 4,
  gridMeanDelta: 2.5,
  hardPointDelta: 30,
};

export interface GridFingerprint {
  cols: number;
  rows: number;
  /** 逐格平均亮度；`null` 表示该格落在钢印文字带内、不参与比对。 */
  cells: (number | null)[];
}

export interface SceneFingerprint {
  scene: string;
  /** 画布尺寸。几何一变这里就变，是最早的信号。 */
  canvas: [number, number];
  grid: GridFingerprint;
  profiles: Record<string, number[]>;
}

/* ───────────────────────────── 取样基础 ───────────────────────────── */

/** Rec.709 亮度。 */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 以 1 位小数记录下来：既压缩了 JSON，也让浮点噪声不会污染 diff。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampIndex(value: number, limit: number): number {
  if (value < 0) return 0;
  if (value >= limit) return limit - 1;
  return value;
}

/**
 * 双线性插值取亮度。
 *
 * 采样坐标是**小数**而不是取整到整数像素，这一点很关键：
 * 探针的采样间距在小图上只有 1px 级，取整会引入 ±0.5px 的量化 ——
 * 对一条 2~4px 宽的切面来说就是 15%~25% 的位置误差，量出来的宽度会随尺寸乱跳。
 * 插值后采样位置是连续的，"同一处结构"在任何尺寸下都取到同一个相对位置。
 */
function lumaAt(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const fx = Math.min(Math.max(x, 0), width - 1);
  const fy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = clampIndex(x0 + 1, width);
  const y1 = clampIndex(y0 + 1, height);
  const tx = fx - x0;
  const ty = fy - y0;

  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;

  const top =
    luma(data[i00], data[i00 + 1], data[i00 + 2]) * (1 - tx) +
    luma(data[i10], data[i10 + 1], data[i10 + 2]) * tx;
  const bottom =
    luma(data[i01], data[i01 + 1], data[i01 + 2]) * (1 - tx) +
    luma(data[i11], data[i11 + 1], data[i11 + 2]) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** 1×1 取样（无插值），供需要"原始像素"的场合使用。 */
function lumaAtPixel(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const cx = clampIndex(Math.round(x), width);
  const cy = clampIndex(Math.round(y), height);
  const i = (cy * width + cx) * 4;
  return luma(data[i], data[i + 1], data[i + 2]);
}

/* ─────────────────────────── 钢印文字带 ─────────────────────────── */

/**
 * 保守的钢印文字带（画布坐标）。
 *
 * 横向取画布宽的 25%~75%：钢印内容在底边距里**居中**，
 * 文字宽度随字体而变（跨平台差得最多就是这个），所以不能按实测宽度算 ——
 * 那样等于把字体差异引回来。25%~75% 这个范围足够宽，能盖住
 * 50 字符级的长机型名；纵向取相片下沿到底边。
 *
 * 由两条用例锁住：
 * 1. `visualRegression.test.ts`「换掉机型名指纹必须不变」—— 证明带内确实没参与比对；
 * 2. 同文件「每个场景的钢印文字都落在排除带内」—— 按各场景真实字体**实测**宽度，
 *    证明带够宽（有人把机型名写长了、或调大了字号，这条会先失败）。
 */
export function stampTextBand(layout: Layout): {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
} {
  return {
    x0: layout.canvasW * 0.25,
    x1: layout.canvasW * 0.75,
    y0: layout.y + layout.h,
    y1: layout.canvasH,
  };
}

function gridCellRect(layout: Layout, col: number, row: number) {
  return {
    x0: (layout.canvasW * col) / GRID_COLS,
    x1: (layout.canvasW * (col + 1)) / GRID_COLS,
    y0: (layout.canvasH * row) / GRID_ROWS,
    y1: (layout.canvasH * (row + 1)) / GRID_ROWS,
  };
}

/** 与钢印文字带**相交**就排除（不是"中心落在带内"才排除，否则半个格子的文字会漏进来）。 */
function isCellExcluded(layout: Layout, col: number, row: number): boolean {
  const cell = gridCellRect(layout, col, row);
  const band = stampTextBand(layout);
  return !(cell.x1 <= band.x0 || cell.x0 >= band.x1 || cell.y1 <= band.y0 || cell.y0 >= band.y1);
}

/* ────────────────────────────── 探针 ────────────────────────────── */

export interface ProfileSpec {
  id: string;
  /** 这条探针是用来守什么的 —— 失败信息里要打出来，方便定位。 */
  note: string;
  /**
   * 纸面（卡纸）在探针的哪一端。用来取"参考亮度"，
   * 也是 `measureBevelBand` 判断"从开窗向外"是哪个方向的依据。
   */
  matEnd: 'start' | 'end';
  from(layout: Layout): readonly [number, number];
  to(layout: Layout): readonly [number, number];
}

const span = (layout: Layout): number => EDGE_PROBE_SPAN * layout.scale;

/**
 * 四条开窗边缘探针，端点全部以 layout 的相对位置 + scaleFactor 表达。
 *
 * 用相对位置而不是绝对像素，是为了让同一组探针同时适用于
 * 不同尺寸（1200 / 3600 短边）与不同边距比例的画布 ——
 * 它们始终落在同一处**结构**上。
 *
 * 四条都刻意避开居中的钢印文字带：`edge-bottom` 走在文字左侧，
 * 其余三条在窗口上半部。
 */
export const PROFILE_SPECS: readonly ProfileSpec[] = [
  {
    id: 'edge-left',
    matEnd: 'start',
    note: '开窗左边缘：受光白高光切面 + 内阴影左侧',
    from: (l) => [l.x - span(l), l.y + l.h / 2],
    to: (l) => [l.x + span(l), l.y + l.h / 2],
  },
  {
    id: 'edge-top',
    matEnd: 'start',
    note: '开窗上边缘：切面 + 内阴影上侧（主光源方向）',
    from: (l) => [l.x + l.w / 2, l.y - span(l)],
    to: (l) => [l.x + l.w / 2, l.y + span(l)],
  },
  {
    id: 'edge-bottom',
    matEnd: 'end',
    note: '开窗下边缘：内阴影下侧 + 背光暗收边（走在钢印文字左侧）',
    from: (l) => [l.x + 0.08 * l.w, l.y + l.h - span(l)],
    to: (l) => [l.x + 0.08 * l.w, l.y + l.h + span(l)],
  },
  {
    id: 'edge-right',
    matEnd: 'end',
    note: '开窗右边缘：背光暗收边 + 内阴影右侧',
    from: (l) => [l.x + l.w - span(l), l.y + l.h / 2],
    to: (l) => [l.x + l.w + span(l), l.y + l.h / 2],
  },
];

/** 采样点坐标（**小数**，不再取整）。定位信息里再四舍五入显示。 */
export function profilePoint(
  spec: ProfileSpec,
  layout: Layout,
  index: number,
): readonly [number, number] {
  const [x0, y0] = spec.from(layout);
  const [x1, y1] = spec.to(layout);
  const t = index / (PROFILE_SAMPLES - 1);
  return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
}

/* ──────────────────────────── 指纹计算 ──────────────────────────── */

export function computeFingerprint(
  sceneId: string,
  canvas: HTMLCanvasElement,
  layout: Layout,
): SceneFingerprint {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`计算指纹失败：${sceneId} 无 2D 上下文`);

  const width = canvas.width;
  const height = canvas.height;
  const { data } = ctx.getImageData(0, 0, width, height);

  const cells: (number | null)[] = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      if (isCellExcluded(layout, col, row)) {
        cells.push(null);
        continue;
      }
      const rect = gridCellRect(layout, col, row);
      const x0 = Math.round(rect.x0);
      const x1 = Math.max(x0 + 1, Math.round(rect.x1));
      const y0 = Math.round(rect.y0);
      const y1 = Math.max(y0 + 1, Math.round(rect.y1));

      let sum = 0;
      let count = 0;
      for (let y = y0; y < Math.min(y1, height); y += 1) {
        for (let x = x0; x < Math.min(x1, width); x += 1) {
          sum += lumaAtPixel(data, width, height, x, y);
          count += 1;
        }
      }
      cells.push(count === 0 ? null : round1(sum / count));
    }
  }

  const profiles: Record<string, number[]> = {};
  for (const spec of PROFILE_SPECS) {
    const samples: number[] = [];
    for (let i = 0; i < PROFILE_SAMPLES; i += 1) {
      const [x, y] = profilePoint(spec, layout, i);
      samples.push(round1(lumaAt(data, width, height, x, y)));
    }
    profiles[spec.id] = samples;
  }

  return {
    scene: sceneId,
    canvas: [width, height],
    grid: { cols: GRID_COLS, rows: GRID_ROWS, cells },
    profiles,
  };
}

/* ───────────────────────────── 比对 ───────────────────────────── */

export interface FingerprintMismatch {
  part: string;
  index: number;
  where: string;
  baseline: number;
  actual: number;
  delta: number;
}

export interface ProfileStat {
  id: string;
  maxDelta: number;
  meanDelta: number;
  /** 最大偏差出现在第几个采样点 */
  maxIndex: number;
}

export interface FingerprintDiff {
  scene: string;
  mismatches: FingerprintMismatch[];
  /** 逐条"为什么不通过"，都是人话。 */
  reasons: string[];
  comparedPoints: number;
  skippedCells: number;
  maxDelta: number;
  gridMeanDelta: number;
  gridExceedCount: number;
  profiles: ProfileStat[];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface CompareOptions {
  /** 给出 layout 后，失败信息里能直接报出画布坐标 */
  layout?: Layout;
  /** 尺度不变性比对时两边画布尺寸本来就不一样，这条判定要显式关掉 */
  ignoreCanvasSize?: boolean;
  tolerances?: Partial<Tolerances>;
}

export function compareFingerprint(
  baseline: SceneFingerprint,
  actual: SceneFingerprint,
  options: CompareOptions = {},
): FingerprintDiff {
  const { layout, ignoreCanvasSize = false } = options;
  const tolerance: Tolerances = { ...DEFAULT_TOLERANCES, ...options.tolerances };

  const mismatches: FingerprintMismatch[] = [];
  const reasons: string[] = [];

  if (
    !ignoreCanvasSize &&
    (baseline.canvas[0] !== actual.canvas[0] || baseline.canvas[1] !== actual.canvas[1])
  ) {
    reasons.push(
      `画布尺寸由 ${baseline.canvas[0]}×${baseline.canvas[1]} 变成 ` +
        `${actual.canvas[0]}×${actual.canvas[1]}（几何变了，必须是一次有意的改动）`,
    );
  }

  let comparedPoints = 0;
  let skippedCells = 0;
  let maxDelta = 0;

  // ── 网格 ──
  const gridDeltas: number[] = [];
  let gridExceedCount = 0;
  const cells = Math.min(baseline.grid.cells.length, actual.grid.cells.length);
  for (let i = 0; i < cells; i += 1) {
    const expected = baseline.grid.cells[i];
    const got = actual.grid.cells[i];
    if (expected === null || got === null) {
      skippedCells += 1;
      continue;
    }
    comparedPoints += 1;
    const delta = Math.abs(got - expected);
    gridDeltas.push(delta);
    if (delta > maxDelta) maxDelta = delta;
    if (delta > tolerance.gridPointDelta) {
      gridExceedCount += 1;
      const col = i % baseline.grid.cols;
      const row = Math.floor(i / baseline.grid.cols);
      const rect = layout ? gridCellRect(layout, col, row) : null;
      mismatches.push({
        part: '网格',
        index: i,
        where: rect
          ? `第 ${row + 1} 行第 ${col + 1} 列（画布 x ${Math.round(rect.x0)}~${Math.round(rect.x1)}、y ${Math.round(rect.y0)}~${Math.round(rect.y1)}）`
          : `第 ${row + 1} 行第 ${col + 1} 列`,
        baseline: expected,
        actual: got,
        delta,
      });
    }
  }
  const gridMeanDelta = mean(gridDeltas);

  // ── 探针 ──
  const profiles: ProfileStat[] = [];
  for (const spec of PROFILE_SPECS) {
    const expected = baseline.profiles[spec.id];
    const got = actual.profiles[spec.id];
    if (!expected || !got) {
      reasons.push(`探针 ${spec.id} 在基线里不存在（新增了探针？记得跑 visual:update）`);
      continue;
    }

    const deltas: number[] = [];
    let profileMax = 0;
    let profileMaxIndex = 0;
    const count = Math.min(expected.length, got.length);
    for (let i = 0; i < count; i += 1) {
      comparedPoints += 1;
      const delta = Math.abs(got[i] - expected[i]);
      deltas.push(delta);
      if (delta > profileMax) {
        profileMax = delta;
        profileMaxIndex = i;
      }
      if (delta > maxDelta) maxDelta = delta;
      if (delta > tolerance.profilePointDelta) {
        const point = layout ? profilePoint(spec, layout, i) : null;
        mismatches.push({
          part: `探针 ${spec.id}`,
          index: i,
          where: point
            ? `第 ${i}/${count - 1} 个采样点（画布 x ${Math.round(point[0])}、y ${Math.round(point[1])}）—— ${spec.note}`
            : `第 ${i}/${count - 1} 个采样点 —— ${spec.note}`,
          baseline: expected[i],
          actual: got[i],
          delta,
        });
      }
    }

    const profileMean = mean(deltas);
    profiles.push({
      id: spec.id,
      maxDelta: profileMax,
      meanDelta: profileMean,
      maxIndex: profileMaxIndex,
    });

    // 关键判定：探针是围绕某个具体材质设计的，它上面出现一个超过容差的
    // 突变就不可能是抗锯齿抖动 —— 不按"占比"稀释
    if (profileMax > tolerance.profilePointDelta) {
      reasons.push(
        `探针 ${spec.id} 最大单点偏差 ${profileMax.toFixed(1)} 超过容差 ` +
          `${tolerance.profilePointDelta}（第 ${profileMaxIndex} 点，${spec.note}）`,
      );
    }
    if (profileMean > tolerance.profileMeanDelta) {
      reasons.push(
        `探针 ${spec.id} 平均偏差 ${profileMean.toFixed(2)} 超过容差 ${tolerance.profileMeanDelta}`,
      );
    }
  }

  // ── 网格判定 ──
  if (gridMeanDelta > tolerance.gridMeanDelta) {
    reasons.push(`网格平均偏差 ${gridMeanDelta.toFixed(2)} 超过容差 ${tolerance.gridMeanDelta}`);
  }
  if (gridExceedCount > tolerance.gridExceedAllowance) {
    reasons.push(
      `网格有 ${gridExceedCount} 格偏差超过 ${tolerance.gridPointDelta}，` +
        `超过允许的 ${tolerance.gridExceedAllowance} 格`,
    );
  }
  if (maxDelta > tolerance.hardPointDelta) {
    reasons.push(`单点最大偏差 ${maxDelta.toFixed(1)} 越过硬线 ${tolerance.hardPointDelta}`);
  }

  mismatches.sort((a, b) => b.delta - a.delta);

  return {
    scene: actual.scene,
    mismatches,
    reasons,
    comparedPoints,
    skippedCells,
    maxDelta,
    gridMeanDelta,
    gridExceedCount,
    profiles,
  };
}

export function isMatch(diff: FingerprintDiff): boolean {
  return diff.reasons.length === 0;
}

/** 一行摘要，负向对照与诊断报告都用它。 */
export function summarizeDiff(diff: FingerprintDiff): string {
  const profiles = diff.profiles
    .map((item) => `${item.id} 峰${item.maxDelta.toFixed(1)}/均${item.meanDelta.toFixed(2)}`)
    .join('｜');
  return `网格 均${diff.gridMeanDelta.toFixed(2)}/越界${diff.gridExceedCount} ｜ ${profiles} ｜ 全局最大 ${diff.maxDelta.toFixed(1)}`;
}

/** 把差异整理成可读报告 —— 失败信息必须能直接指出"哪条探针的第几个点"。 */
export function formatDiff(diff: FingerprintDiff): string {
  const lines: string[] = [`场景 ${diff.scene} 视觉回归失败：`];
  for (const reason of diff.reasons) {
    lines.push(`  · ${reason}`);
  }
  lines.push(
    `  比对点 ${diff.comparedPoints} 个（另有 ${diff.skippedCells} 个网格被钢印文字带排除）`,
  );
  lines.push(`  ${summarizeDiff(diff)}`);
  for (const item of diff.mismatches.slice(0, 12)) {
    lines.push(
      `  · ${item.part}[${item.index}] ${item.where}\n` +
        `      基线 ${item.baseline.toFixed(1)} → 实际 ${item.actual.toFixed(1)}（偏 ${item.delta.toFixed(1)}）`,
    );
  }
  if (diff.mismatches.length > 12) {
    lines.push(`  · …另有 ${diff.mismatches.length - 12} 个越界点，完整数据见诊断报告`);
  }
  return lines.join('\n');
}
