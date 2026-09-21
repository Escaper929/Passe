/**
 * 导出方案。
 *
 * 把"用户选了 4K"翻译成一件具体的事：输出多少像素、外框会有多大、
 * 会不会撞上画布内存上限、文件叫什么名字。全是纯计算，所以能脱离浏览器验证 ——
 * 而导出恰恰是最不能出错的一步：用户等了几十秒，然后标签页崩了。
 */

import type { FrameConfig } from '@/engine/types';
import { assessFrame, suggestMaxDimension, type RenderBudget } from '@/input/budget';
import {
  DEFAULT_TARGET_DPI,
  achievedDpi,
  findPrintSize,
  fitInsidePaper,
  printSourceLongSide,
  requiredFramedLongSidePx,
  type PrintPlan,
} from './printSize';

export interface ExportSizeOption {
  id: string;
  label: string;
  /** 长边像素上限。null 表示不做任何降采样 */
  maxDimension: number | null;
  hint: string;
}

export const EXPORT_SIZES: readonly ExportSizeOption[] = [
  { id: 'original', label: '原始', maxDimension: null, hint: '不做降采样，按扫描件原尺寸输出' },
  { id: '8k', label: '8K', maxDimension: 8192, hint: '长边 8192px，艺术微喷可用' },
  { id: '4k', label: '4K', maxDimension: 4096, hint: '长边 4096px，通用印刷' },
  { id: '2k', label: '2K', maxDimension: 2048, hint: '长边 2048px，网页与社交分享' },
] as const;

export const DEFAULT_EXPORT_SIZE_ID = '8k';

/**
 * 非字母数字一律折叠成连字符，保留中文。
 *
 * 下划线刻意排除在外：它是段间分隔符（`Passe_M6_scan_001`），
 * 如果在段内也把下划线折成连字符，`a_b` 和 `a-b` 就撞在一起，文件名失去边界。
 */
const NON_WORD = /[^\p{L}\p{N}_]+/gu;

/** 去掉文件扩展名。只对源文件名用，机型名里的点不该被当成扩展名。 */
export function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,6}$/, '');
}

export function sanitizeSegment(value: string): string {
  return value
    .normalize('NFKC')
    .replace(NON_WORD, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

export interface FilenameInput {
  cameraModel?: string;
  sourceName?: string | null;
  /** 输出长边，写进文件名以便一眼看出规格 */
  longSide: number;
  extension?: string;
}

/**
 * 组装导出文件名。
 *
 * 刻意带上机型与输出长边：一次导出十几张时，文件名是唯一还能分辨来源的线索，
 * 而"Passe_Gallery_1726..."这种时间戳命名等于没有信息。
 */
export function buildExportFilename(input: FilenameInput): string {
  const { cameraModel, sourceName, longSide, extension = '.jpg' } = input;

  const parts = [
    'Passe',
    sanitizeSegment(cameraModel ?? ''),
    sanitizeSegment(stripExtension(sourceName ?? '')),
  ];

  return `${parts.filter(Boolean).join('_')}_${longSide}px${extension}`;
}

export interface ExportPlan {
  /**
   * 实际生效的尺寸档 id；被守卫修正后为 'custom'。
   *
   * 可能来自 `EXPORT_SIZES`（像素档）或 `PRINT_SIZES`（纸规格）—— 两者共用这一个
   * 取值，于是守卫、批量、文件名都不需要知道"用户选的是纸还是像素"。
   */
  sizeId: string;
  /** 输出长边像素 */
  outputLongSide: number;
  outputW: number;
  outputH: number;
  /** 传给引擎的 maxDimension。null 表示无需降采样 */
  maxDimension: number | null;
  /** 装裱后外框尺寸 */
  framedW: number;
  framedH: number;
  budget: RenderBudget;
  canExport: boolean;
  /**
   * 被守卫拦下时，把上限设成它就能导出（以**源图长边**为口径）。
   *
   * 它瞄准的是"余量充足"档（上限的 HEAVY_LOAD），不是上限本身 ——
   * 点完修正之后不该还留着一条黄色警告。
   */
  suggestedMaxDimension: number | null;
  /** 选了纸规格时的物理换算；选像素档时为 null */
  print: PrintPlan | null;
  filename: string;
}

export interface BuildExportPlanInput {
  source: { width: number; height: number };
  config: FrameConfig;
  /** `EXPORT_SIZES` 或 `PRINT_SIZES` 里的 id */
  sizeId: string;
  /**
   * 直接指定源图长边上限，优先于 sizeId。
   * 守卫拦下导出后用建议值一键修复，走的就是这条路。
   */
  overrideMaxDimension?: number | null;
  /** 目标打印 DPI。仅当 sizeId 是纸规格时有意义 */
  targetDpi?: number;
  /** 相机机型，进文件名 */
  cameraModel?: string;
  /** 原始文件名，进文件名 */
  sourceName?: string | null;
  /** 画布像素上限，可注入 */
  limit?: number;
}

export function buildExportPlan(input: BuildExportPlanInput): ExportPlan {
  const { source, config, sizeId, limit } = input;

  const override = input.overrideMaxDimension ?? null;
  const paper = findPrintSize(sizeId);
  const preset = paper
    ? null
    : (EXPORT_SIZES.find((option) => option.id === sizeId) ?? EXPORT_SIZES[0]);

  const sourceLongSide = Math.max(source.width, source.height);

  /**
   * 选了纸就按目标 DPI **反推**所需像素；否则仍走像素档。
   *
   * 反推分两步，中间那步最容易漏：纸装的是**含卡纸的成品图**，而 `maxDimension`
   * 的口径是**照片**长边，所以要先算"成品图需要多少像素"，再除以装裱放大系数。
   * 详见 printSize.ts 的文件头。
   *
   * 放大系数与比例都取自**源图尺寸下的布局**：`calculateLayout` 对像素严格线性，
   * 所以这两个量与最终输出尺寸无关，不必回代求解。
   */
  let printCore: Omit<PrintPlan, 'achievedDpi'> | null = null;
  let requested = override ?? preset?.maxDimension ?? null;

  if (paper) {
    const dpi = input.targetDpi ?? DEFAULT_TARGET_DPI;
    const atSource = assessFrame(source.width, source.height, config, limit);
    const framedLong = Math.max(atSource.framedW, atSource.framedH);
    const framedShort = Math.min(atSource.framedW, atSource.framedH);
    const aspect = framedLong / framedShort;
    const matExpansion = framedLong / sourceLongSide;

    const fit = fitInsidePaper(paper, aspect);
    const requiredLongSide = printSourceLongSide(
      requiredFramedLongSidePx(paper, dpi, aspect),
      matExpansion,
    );

    requested = override ?? requiredLongSide;
    printCore = {
      paperId: paper.id,
      paperLabel: paper.label,
      dpi,
      printedLongMm: fit.longMm,
      printedShortMm: fit.shortMm,
      limitedBy: fit.limitedBy,
      requiredLongSide,
    };
  }

  // 只降不升：没有哪种重采样能凭空造出细节
  const outputLongSide = requested === null ? sourceLongSide : Math.min(sourceLongSide, requested);

  const ratio = outputLongSide / sourceLongSide;
  const outputW = Math.max(1, Math.round(source.width * ratio));
  const outputH = Math.max(1, Math.round(source.height * ratio));

  const budget = assessFrame(outputW, outputH, config, limit);
  const canExport = budget.level !== 'blocked';

  return {
    sizeId: override === null ? (preset?.id ?? sizeId) : 'custom',
    outputLongSide,
    outputW,
    outputH,
    maxDimension: requested,
    framedW: budget.framedW,
    framedH: budget.framedH,
    budget,
    canExport,
    // 建议值以源图长边为口径 —— maxDimension 正是这个含义，直接可用
    suggestedMaxDimension: canExport
      ? null
      : suggestMaxDimension(source.width, source.height, config, limit),
    /**
     * 实际 DPI 按**成品图**的实际像素算 —— 纸装的是成品图，不是照片。
     *
     * 它同时兜住了两件事：源图不够（只降不升），以及内存守卫把尺寸压小了。
     * 两种情况下用户看到的都是同一个诚实的数字。
     */
    print: printCore
      ? {
          ...printCore,
          achievedDpi: achievedDpi(
            Math.max(budget.framedW, budget.framedH),
            printCore.printedLongMm,
          ),
        }
      : null,
    filename: buildExportFilename({
      cameraModel: input.cameraModel,
      sourceName: input.sourceName,
      longSide: outputLongSide,
    }),
  };
}
