/**
 * 批量导出方案。
 *
 * 单张导出只需要回答"这张能不能导"；批量要多回答三个问题，而这三个都容易做错：
 *
 * 1. **哪些张真的能导。** 内存守卫和源图尺寸有关，而队列里每张的尺寸都不一样 ——
 *    一张能过，不代表另一张能过。所以必须**逐张**按自己的原图尺寸过一遍守卫，
 *    不能拿"当前预览的那张能过"外推到整批。
 * 2. **峰值内存是多少。** 导出是串行的（见 batchExport.ts），所以峰值是
 *    **单张的最大值**，不是批次总和。按总和报数会把一个跑得完的批次说成跑不完，
 *    直接把用户劝退。
 * 3. **文件名会不会撞。** 两张同名（不同目录下的同名扫描件）在目录直写下会
 *    **静默互相覆盖**，用户最后拿到 9 张而不是 10 张。必须提前把名字解开。
 *
 * 全是纯计算，所以整批的判定都能脱离浏览器逐条钉住。
 */

import { resolveCanvasLimit } from '@/engine/canvasLimit';
import type { FrameConfig } from '@/engine/types';
import { assessFrame, HEAVY_LOAD } from '@/input/budget';

import { buildExportPlan, type ExportPlan } from './exportPlan';

/** 批量方案需要从队列条目里读到的最小信息。ImageItem 结构上满足它。 */
export interface BatchCandidate {
  id: string;
  name: string;
  /**
   * **原图**尺寸，不是工作副本尺寸。
   * 工作副本已被压到 9MP 以内，拿它过守卫会低估一个数量级，等于没有守卫。
   */
  originalWidth: number;
  originalHeight: number;
}

export type BatchSkipReason = 'not-ready' | 'over-limit';

/** 会进这一批的条目：它有一份按自己原图尺寸算出来的方案。 */
export interface BatchExportEntry<T extends BatchCandidate = BatchCandidate> {
  kind: 'export';
  item: T;
  plan: ExportPlan;
  /** 唯一化之后的文件名。撞名的会被加上 -2 / -3 后缀 */
  filename: string;
}

/** 不参与这一批的条目。**没有方案** —— 没解码完的图连尺寸都没有，算不出方案 */
export interface BatchSkipEntry<T extends BatchCandidate = BatchCandidate> {
  kind: 'skip';
  item: T;
  reason: BatchSkipReason;
  /** 面向用户的一句话，说明它为什么没进这一批 */
  message: string;
}

export type BatchEntry<T extends BatchCandidate = BatchCandidate> =
  BatchExportEntry<T> | BatchSkipEntry<T>;

export interface BatchPlan<T extends BatchCandidate = BatchCandidate> {
  /** 队列里的每一条都有归属，UI 才能把整队列的情况一次说清 */
  entries: BatchEntry<T>[];
  exportable: BatchExportEntry<T>[];
  skipped: BatchSkipEntry<T>[];
  /**
   * 预计峰值内存 = 导出项里最大的那一张。
   * 串行导出，任何时刻只有一张全分辨率位图活着，所以不是总和。
   */
  peakBytes: number;
  peakName: string | null;
  /**
   * 把源图长边统一压到它，**整批**就都能导出；null 表示没有可用的统一值。
   *
   * 只在真的有人被拦下时才有意义 —— 都过得去时返回 null，不必多此一举。
   */
  unifiedMaxDimension: number | null;
}

export interface BuildBatchPlanInput<T extends BatchCandidate> {
  items: readonly T[];
  config: FrameConfig;
  sizeId: string;
  /** 直接指定源图长边上限，优先于 sizeId */
  overrideMaxDimension?: number | null;
  /**
   * 导出格式与质量。
   *
   * 必须由这里透传到 `buildExportPlan`，而不是让批量与单张各认一份状态：
   * 两处口径一旦分叉，用户会拿到"面板上写着 .png、批量导出来却是 .jpg"的批次。
   */
  formatId?: string;
  quality?: number;
  cameraModel?: string;
  /** 画布像素上限，可注入 */
  limit?: number;
}

/** 拆出扩展名。`dot <= 0` 是 ".gitignore" 这类隐藏文件，不该把整名当扩展名。 */
function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * 把一组文件名改成互不相同。
 *
 * 序号插在**扩展名前**（`scan-2.tif` 而不是 `scan.tif-2`）—— 有些系统靠扩展名
 * 决定用什么程序打开它，名尾挂序号会让双击失灵。
 *
 * 候选名本身也要判重：`["a.jpg", "a-2.jpg", "a.jpg"]` 里第三个若只用 -2
 * 就会和第二个撞上，于是又覆盖一次 —— 所以从 2 起往上找第一个没被占用的。
 */
export function uniquifyFilenames(names: readonly string[]): string[] {
  const taken = new Set<string>();

  return names.map((name) => {
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }

    const { base, ext } = splitExtension(name);
    let index = 2;
    let candidate = `${base}-${index}${ext}`;
    while (taken.has(candidate)) {
      index += 1;
      candidate = `${base}-${index}${ext}`;
    }
    taken.add(candidate);
    return candidate;
  });
}

/**
 * 求一个能让**整批**都落进"余量充足"档的源图长边上限。
 *
 * 与单张的 `suggestMaxDimension` 同一个口径（瞄准上限的 HEAVY_LOAD 而不是上限本身），
 * 区别只在"要同时满足所有张"，所以是**二分 + 全体判定**，而不是逐张求解后取最小值 ——
 * 外框像素还跟长宽比有关：同一条长边下，1:1 的方图装裱出的像素数明显高于 3:2，
 * 取最小值在数学上并不成立。
 *
 * 返回 null 的两种情况：整批本来在原始尺寸下就都过得去（没有压的理由），
 * 或者压到 floor 也救不回来（那是边距比例的问题，不是尺寸的问题）。
 */
export function suggestUnifiedMaxDimension<T extends BatchCandidate>(
  items: readonly T[],
  config: FrameConfig,
  limit: number = resolveCanvasLimit(),
  floor = 1200,
): number | null {
  const measurable = items.filter((item) => item.originalWidth > 0 && item.originalHeight > 0);
  if (measurable.length === 0) return null;

  const widest = Math.max(
    ...measurable.map((item) => Math.max(item.originalWidth, item.originalHeight)),
  );
  const target = limit * HEAVY_LOAD;

  /** 长边压到 dimension 之后，装裱外框的像素数 */
  const framedPixelsAt = (item: T, dimension: number): number => {
    const longSide = Math.max(item.originalWidth, item.originalHeight);
    const ratio = Math.min(1, dimension / longSide);
    const w = Math.max(1, Math.round(item.originalWidth * ratio));
    const h = Math.max(1, Math.round(item.originalHeight * ratio));
    const budget = assessFrame(w, h, config, limit);
    return budget.framedW * budget.framedH;
  };

  /** 外框像素随长边单调递增，所以二分成立 */
  const fitsAll = (dimension: number): boolean =>
    measurable.every((item) => framedPixelsAt(item, dimension) <= target);

  if (fitsAll(widest)) return null;
  if (!fitsAll(floor)) return null;

  let low = floor;
  let high = widest;
  // 二分 20 次足以收敛到 1px 精度内，且循环次数有确定上界
  for (let i = 0; i < 20 && high - low > 1; i += 1) {
    const mid = Math.floor((low + high) / 2);
    if (fitsAll(mid)) low = mid;
    else high = mid;
  }
  return low;
}

export function buildBatchPlan<T extends BatchCandidate>(
  input: BuildBatchPlanInput<T>,
): BatchPlan<T> {
  const { items, config, sizeId, limit } = input;
  const override = input.overrideMaxDimension ?? null;

  /**
   * 只有量得出尺寸的条目才配算方案。
   *
   * 队列里随时可能停着排队中/解码中/解码失败的条目，它们的 originalWidth 是 0 ——
   * 拿 0 去算外框会得到 NaN 并让几何层直接抛错。整批导出不该因为队列里
   * 有一张还没解码完的图就整个炸掉。
   */
  const measurable = (item: T): boolean => item.originalWidth > 0 && item.originalHeight > 0;

  const planFor = (item: T): ExportPlan =>
    buildExportPlan({
      source: { width: item.originalWidth, height: item.originalHeight },
      config,
      sizeId,
      overrideMaxDimension: override,
      formatId: input.formatId,
      quality: input.quality,
      cameraModel: input.cameraModel,
      sourceName: item.name,
      limit,
    });

  const readyPlans = items.filter(measurable).map(planFor);

  /**
   * 文件名只在**真的会导出**的那些之间去重。
   *
   * 被跳过的那几份方案根本没生成文件名，若把它们的名字也拉进来占位，
   * 就会白白把一张能导出的图挤成 `-2`。
   */
  const filenames = uniquifyFilenames(readyPlans.map((plan) => plan.filename));

  let exportCursor = 0;
  const entries: BatchEntry<T>[] = items.map((item) => {
    if (!measurable(item)) {
      return {
        kind: 'skip',
        item,
        reason: 'not-ready',
        message: '尚未解码完成，本次不参与导出。',
      };
    }

    const plan = readyPlans[exportCursor];
    const filename = filenames[exportCursor];
    exportCursor += 1;

    if (!plan.canExport) {
      return { kind: 'skip', item, reason: 'over-limit', message: plan.budget.message };
    }

    return { kind: 'export', item, plan, filename };
  });

  const exportable = entries.filter((entry) => entry.kind === 'export');
  const skipped = entries.filter((entry) => entry.kind === 'skip');

  let peakBytes = 0;
  let peakName: string | null = null;
  for (const entry of exportable) {
    if (entry.plan.budget.estimatedBytes > peakBytes) {
      peakBytes = entry.plan.budget.estimatedBytes;
      peakName = entry.item.name;
    }
  }

  const unifiedMaxDimension = skipped.some((entry) => entry.reason === 'over-limit')
    ? suggestUnifiedMaxDimension(items, config, limit)
    : null;

  return { entries, exportable, skipped, peakBytes, peakName, unifiedMaxDimension };
}
