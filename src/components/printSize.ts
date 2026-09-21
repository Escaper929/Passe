/**
 * 物理打印尺寸。
 *
 * ## 为什么是"反推"而不是"报告"
 *
 * 用户真正的约束是「我要 A4、300 DPI 艺术微喷」，而不是「我的图是 6000px」。
 * 所以这一层接受（纸 + 目标 DPI），**反推出需要多少像素**；
 * 反过来报告"按当前像素印出来是 254 DPI"只是把换算负担丢回给用户。
 *
 * ## 反推规则："装进纸内"
 *
 * 成品图整体缩放进纸里，**两个方向都不溢出**，比例不变，不裁切 ——
 * 对胶片扫描件来说，为了凑纸的比例而裁掉照片边缘是不可接受的代价。
 * 于是纸比成品图大的那个方向会留白（印后可自行裁掉）。
 *
 * ## 一个容易搞错的地方：纸装的是"成品图"，不是"照片"
 *
 * `buildExportPlan` 的 `maxDimension` 口径是**源图（照片）长边**，
 * 而纸要装的是**含卡纸的成品图**。两者差一个放大系数 k：
 *
 *     k = 成品图长边px / 照片长边px          （marginRatio 0.14 时 k ≈ 1.19~1.4）
 *
 * 所以反推必须**先算出成品图需要多少像素，再除以 k** 得到源图需要多少像素。
 * 漏掉这一步会让实际 DPI 比目标高出一档（图会不必要地大）。
 * 这个换算由 `printSourceLongSide()` 负责，并有端到端用例守着：
 * 源图足够大时，按反推值输出，**实际 DPI 必须落在目标附近**。
 *
 * 之所以能这样精确反推：`calculateLayout` 里 `baseMargin = min(w,h) * marginRatio`，
 * 几何对像素尺寸**严格线性**（只有四舍五入的零头），因此 k 与尺寸无关。
 */

const MM_PER_INCH = 25.4;

export interface PaperSize {
  id: string;
  label: string;
  /** 长边毫米 */
  longMm: number;
  /** 短边毫米 */
  shortMm: number;
  hint: string;
}

/** 纸只存两个边长，**不存"横竖"** —— 方向由成品图比例决定，
 * 成品图是横的就横着用纸（打印时转纸，不是转照片）。
 */
export const PRINT_SIZES: readonly PaperSize[] = [
  { id: 'a4', label: 'A4', longMm: 297, shortMm: 210, hint: '297 × 210mm，小幅面成品' },
  { id: 'a3', label: 'A3', longMm: 420, shortMm: 297, hint: '420 × 297mm，展览常用幅面' },
  {
    id: '8x10',
    label: '8×10',
    longMm: 254,
    shortMm: 203.2,
    hint: '254 × 203.2mm，美制 8×10 英寸',
  },
] as const;

/**
 * 按 id 找纸规格。找不到返回 null —— 调用方据此判断"用户选的是纸还是像素档"，
 * 不需要另立一套"哪些 id 属于纸"的清单（两处清单一定会分叉）。
 */
export function findPrintSize(id: string): PaperSize | null {
  return PRINT_SIZES.find((paper) => paper.id === id) ?? null;
}

export interface DpiOption {
  value: number;
  label: string;
  hint: string;
}

/** 目标 DPI。300 是艺术微喷的常规要求，150 只用于校样。 */
export const DPI_OPTIONS: readonly DpiOption[] = [
  { value: 300, label: '300', hint: '艺术微喷 / 展览级' },
  { value: 240, label: '240', hint: '通用印刷' },
  { value: 150, label: '150', hint: '校样 / 小样' },
] as const;

export const DEFAULT_TARGET_DPI = 300;

/** 成品图在纸上能占的最大物理尺寸（mm），长边在前。 */
export interface PaperFit {
  longMm: number;
  shortMm: number;
  /**
   * 先撞到哪条边。
   * `long`：成品图比纸更"长条"（如 3:2 配 A4），纸的长边用完，短边方向留白；
   * `short`：成品图比纸更"方"（如方图配 A4），纸的短边用完，长边方向留白。
   */
  limitedBy: 'long' | 'short';
}

/**
 * 把一个比例为 `aspect`（长边/短边，≥ 1）的成品图装进纸内。
 *
 * 长边对齐总是面积最优，所以只需比较：纸的长边够不够给成品图的长边用。
 *   aspect ≥ 纸比例 → 长边受限；否则短边受限。
 */
export function fitInsidePaper(paper: PaperSize, aspect: number): PaperFit {
  const { longMm: long, shortMm: short } = paper;
  if (!Number.isFinite(aspect) || aspect < 1) {
    throw new Error(`成品图比例非法：${aspect}`);
  }
  if (aspect >= long / short) {
    return { longMm: long, shortMm: long / aspect, limitedBy: 'long' };
  }
  return { longMm: short * aspect, shortMm: short, limitedBy: 'short' };
}

/**
 * 达到目标 DPI 所需的**成品图**长边像素。
 *
 * 目标 DPI 是**下限**：宁可多要几个像素，也不要印出来差一点。
 * 先向上取整，再用 `achievedDpi` 反查一次补足浮点误差（见下）。
 */
export function requiredFramedLongSidePx(paper: PaperSize, dpi: number, aspect: number): number {
  const fit = fitInsidePaper(paper, aspect);
  const px = Math.ceil((fit.longMm / MM_PER_INCH) * dpi);

  /**
   * 补一个像素兜住浮点误差。
   *
   * `25.4` 不能被二进制精确表示，所以像 8×10 @240DPI 这种**数学上正好整除**的边界
   * 会以 `239.99999999999997` 反查回来（实测），上面那句 ceil 挡不住。
   * 与其把"目标 DPI 是下限"降级成"大约不低于"，不如在这里补到真成立 ——
   * 这句话要写进界面（"300DPI 需源图长边 ≥ Npx"），必须站得住。
   */
  return achievedDpi(px, fit.longMm) < dpi ? px + 1 : px;
}

/**
 * 把"成品图需要的像素"换算成"源图需要多少像素"。
 *
 * `matExpansion` = 成品图长边 / 照片长边，由调用方用 `assessFrame` 求得。
 * 见文件头：漏掉这一步会让实际 DPI 比目标高出一档。
 */
export function printSourceLongSide(requiredFramedPx: number, matExpansion: number): number {
  if (!Number.isFinite(matExpansion) || matExpansion <= 0) {
    throw new Error(`装裱放大系数非法：${matExpansion}`);
  }
  return Math.ceil(requiredFramedPx / matExpansion);
}

/** 给定实际输出像素，反查印到该物理尺寸上的实际 DPI。 */
export function achievedDpi(pixelLongSide: number, printedLongMm: number): number {
  if (printedLongMm <= 0) return 0;
  return (pixelLongSide / printedLongMm) * MM_PER_INCH;
}

/** 选纸后随导出方案一起给出的物理换算结果。 */
export interface PrintPlan {
  paperId: string;
  paperLabel: string;
  /** 目标 DPI（用户选的） */
  dpi: number;
  /** 成品图印在纸上的物理尺寸（mm），长边在前 */
  printedLongMm: number;
  printedShortMm: number;
  limitedBy: 'long' | 'short';
  /** 达到目标 DPI 所需的**源图**长边像素 */
  requiredLongSide: number;
  /** 按实际输出算出来的 DPI。源图不够或被守卫压过时会低于目标 */
  achievedDpi: number;
}

/** 第一行：印在哪、印多大。 */
export function describePrint(plan: PrintPlan): string {
  const paper = findPrintSize(plan.paperId);
  const size = `${Math.round(plan.printedLongMm)} × ${Math.round(plan.printedShortMm)}mm`;
  if (!paper) return `印在 ${plan.paperLabel}：成品 ${size}`;
  const paperSize = `${Math.round(paper.longMm)} × ${Math.round(paper.shortMm)}mm`;
  return `印在 ${plan.paperLabel}（${paperSize}）：成品 ${size}`;
}

/**
 * 第二行：需要多少像素 / 实际能做到多少。
 *
 * 达不到目标时必须**如实说**，并且说清原因是"源图不够"而不是含糊的"已降级" ——
 * 用户据此决定是换小一号纸还是重扫。
 */
export function describeDpi(plan: PrintPlan): string {
  const need = `${plan.dpi}DPI 需源图长边 ≥ ${plan.requiredLongSide}px`;
  const actual = Math.round(plan.achievedDpi);
  if (actual >= plan.dpi) return need;
  return `${need}；实际 ${actual}DPI（不放大）`;
}
