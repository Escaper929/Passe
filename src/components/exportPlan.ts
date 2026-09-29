/**
 * 导出方案。
 *
 * 把"用户选了 4K"翻译成一件具体的事：输出多少像素、外框会有多大、
 * 会不会撞上画布内存上限、文件叫什么名字。全是纯计算，所以能脱离浏览器验证 ——
 * 而导出恰恰是最不能出错的一步：用户等了几十秒，然后标签页崩了。
 */

import {
  MAX_CANVAS_PIXELS,
  resolveCanvasLimit,
  resolveCanvasLimitInfo,
} from '@/engine/canvasLimit';
import type { FrameConfig } from '@/engine/types';
import {
  assessFrame,
  ceilingSourceLongSide,
  suggestMaxDimension,
  type RenderBudget,
} from '@/input/budget';

import {
  DEFAULT_EXPORT_FORMAT_ID,
  DEFAULT_QUALITY,
  resolveExportFormat,
  resolveQuality,
  type ExportMimeType,
} from './exportFormat';

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
  /** 实际生效的尺寸预设 id；被守卫修正后为 'custom' */
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
  /**
   * 生效的画布上限是不是**真被这台机器压低**了（严格小于桌面兜底常量）。
   *
   * 用来区分"这台上限是设备的特性"和"这只是个兜底值"。后者（桌面、以及所有
   * 探测不出结果的设备）报出来是噪音 —— 它既不是设备的限制，也没有可执行的动作。
   */
  hasDeviceCeiling: boolean;
  /**
   * 「本机导出上限」：源图长边最多到多少像素仍不会被守卫拦下。
   *
   * 报给用户的数，**必须与守卫同源**——它就是拿同一个 `limit` 反查出来的，
   * 所以"面板说装得下"与"守卫真的放行"不会打架。
   *
   * 为 null 有两种情形，对界面是同一个动作（不渲染那一行）：
   * - 上限只是兜底常量、且当前这张图本来就在上限之内 —— 没什么可说的；
   * - 连 `floor` 都装不下（边距比例离谱）—— 这时该建议调边距，
   *   报一个上限数字反而误导。
   */
  ceilingLongSide: number | null;
  /** 实际生效的格式档 id */
  formatId: string;
  /**
   * 传给编码器的 MIME。
   *
   * 文件名扩展名**由它推导**而不是各写一份 —— 面板展示的名字与实际写盘的名字
   * 必须逐字相同，这是用户唯一能核对的线索。
   */
  mimeType: ExportMimeType;
  /** 传给编码器的质量；无损格式为 undefined（该格式没有质量这一说） */
  quality: number | undefined;
  filename: string;
}

export interface BuildExportPlanInput {
  source: { width: number; height: number };
  config: FrameConfig;
  sizeId: string;
  /**
   * 直接指定源图长边上限，优先于 sizeId。
   * 守卫拦下导出后用建议值一键修复，走的就是这条路。
   */
  overrideMaxDimension?: number | null;
  /** `EXPORT_FORMATS` 里的 id。取不到就退回默认格式 */
  formatId?: string;
  /** 质量。仅对无损以外的格式有意义 */
  quality?: number;
  /** 相机机型，进文件名 */
  cameraModel?: string;
  /** 原始文件名，进文件名 */
  sourceName?: string | null;
  /** 画布像素上限，可注入 */
  limit?: number;
}

export function buildExportPlan(input: BuildExportPlanInput): ExportPlan {
  const { source, config, sizeId, limit } = input;

  /**
   * 上限只解析一次，再喂给下面所有判定（守卫、建议尺寸、本机上限）。
   * 各处分别去取默认值，在缓存一致时结果相同 —— 但那是巧合，不是保证。
   */
  const canvasLimit = limit ?? resolveCanvasLimit();
  /**
   * 注入的上限本身就低于兜底常量，这已经是"有人把它压下来了"的证据；
   * 没注入时才去问探测结果（否则界面要多探测一次，那是几百 MB）。
   */
  const hasDeviceCeiling =
    limit === undefined ? resolveCanvasLimitInfo().isDeviceProbed : limit < MAX_CANVAS_PIXELS;

  const override = input.overrideMaxDimension ?? null;
  const preset = EXPORT_SIZES.find((option) => option.id === sizeId) ?? EXPORT_SIZES[0];
  const requested = override ?? preset.maxDimension;

  const format = resolveExportFormat(input.formatId ?? DEFAULT_EXPORT_FORMAT_ID);
  const quality = resolveQuality(format, input.quality ?? DEFAULT_QUALITY);

  const sourceLongSide = Math.max(source.width, source.height);
  // 只降不升：没有哪种重采样能凭空造出细节
  const outputLongSide = requested === null ? sourceLongSide : Math.min(sourceLongSide, requested);

  const ratio = outputLongSide / sourceLongSide;
  const outputW = Math.max(1, Math.round(source.width * ratio));
  const outputH = Math.max(1, Math.round(source.height * ratio));

  const budget = assessFrame(outputW, outputH, config, canvasLimit);
  const canExport = budget.level !== 'blocked';

  const ceiling = ceilingSourceLongSide(source.width, source.height, config, canvasLimit);
  /**
   * 只在"这句话有用"时留下它。两种情况下有用：
   *
   * 1. 上限是设备特性 —— 手机用户需要提前知道这台机器装不下更大的图，
   *    而不是等到选了 8K 才被拦下；
   * 2. 当前这张源图已经越过上限 —— 桌面也有这种情形（选了"原始"的大画幅扫描件），
   *    此时他马上就会看到拦截提示，提前一行说清楚更好。
   *
   * 都不满足就不出：桌面 + 中等源图，这一行说"上限 ≈ 10700px"纯属噪音。
   */
  const ceilingLongSide =
    ceiling !== null && (hasDeviceCeiling || Math.max(source.width, source.height) > ceiling)
      ? ceiling
      : null;

  return {
    sizeId: override === null ? preset.id : 'custom',
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
      : suggestMaxDimension(source.width, source.height, config, canvasLimit),
    hasDeviceCeiling,
    ceilingLongSide,
    formatId: format.id,
    mimeType: format.mimeType,
    quality,
    filename: buildExportFilename({
      cameraModel: input.cameraModel,
      sourceName: input.sourceName,
      longSide: outputLongSide,
      extension: format.extension,
    }),
  };
}
