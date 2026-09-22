/**
 * 本机单张画布的像素上限。
 *
 * 为什么要有这个文件：`MAX_CANVAS_PIXELS`（1.2 亿）当初是按**桌面 Chromium**
 * 定的 —— 注释里写着"桌面单画布面积上限约 2.68 亿，取一半"。但这个工具在手机上
 * 的处境完全不同：标准 iPhone 的单画布面积上限只有 16,777,216 px（≈4096×4096），
 * 大约是本项目常量上限的 **七分之一**。
 *
 * 后果不是"导出失败并告诉你原因"，而是更糟的一种：预览阶段一切正常，按下导出、
 * 等十几秒，拿到一张**纯白图**。因为超限的画布不会抛错，它只是画不上去。
 * 所以上限不能是一个常量，得问这台机器。
 *
 * ## 探测为什么这么写
 *
 * 1. **只看 `getContext('2d')` 是否为 null 是抓不到的。** Safari 对超限画布
 *    照样给你一个上下文，只是随后的绘制静默失效。必须真的写一个像素、
 *    再读回来对颜色 —— 这是唯一可靠的判据。
 * 2. **候选面积升序，且只有啃下上一档才试下一档。** 顺序本身就是安全阀：
 *    探测本身要真的分配内存（67.1M px ≈ 268MB），升序保证那笔分配只会发生在
 *    "已经证明自己扛得住 33.5M"的机器上。
 * 3. **只在触屏为主的设备上跑。** 桌面本来就没这个问题，没必要为它多花一次
 *    几十 MB 的分配与一次启动探测。于是桌面行为与从前一字不差。
 * 4. **探不出来（无 document / 无 2D 上下文 / 首档就不通过）就退回原常量。**
 *    宁可维持旧口径，也不要因为"测不出来"把上限压到 0 —— 那会让整个工具
 *    在任何图上都拒绝导出。
 */

/**
 * 单张画布的**桌面兜底**上扬限制。
 *
 * 8K 中画幅扫描件加完边距后外框可达 1 亿像素，单张 2D 画布连同导出时的编码缓冲
 * 会吃掉 1GB 以上内存，标签页会直接崩。桌面 Chromium 的单画布面积上限约 2.68 亿
 * 像素，这里取一半作为安全线。
 *
 * 它从前住在 `GalleryFramingEngine.ts` 里，被当成一个普适常量用 —— 那是错的：
 * 这个数只对桌面成立。现在它降格成"探测不出来时的兜底值"，并且和探测策略
 * 放在同一个文件里，让"上限"这件事只有一处可读。
 */
export const MAX_CANVAS_PIXELS = 1.2e8;

/**
 * 探测候选面积，升序。
 *
 * 两个端点都有实测依据：16,777,216 是标准 iPhone 的实测上限（4096×4096 可用、
 * 4097×4096 就失效），67,108,864 是较新 Pro 机型被报告的放宽值。
 * 中间那档只是过渡台阶，让"能扛 3300 万但扛不住 6700 万"的机器能被量出来。
 */
export const CANVAS_PROBE_CANDIDATES: readonly number[] = [
  4096 * 4096, // 16,777,216
  5792 * 5792, // 33,547,264
  8192 * 8192, // 67,108,864
];

/**
 * 探测结果的安全系数。
 *
 * 取 0.5 是沿用仓库既有惯例（现有常量就是"桌面上限取一半"），不是另发明一个
 * 数：面积上限之外还有一条**所有画布合计**的内存上限（iOS 15 约 384MB），
 * 而导出那一刻同时活着的不止一张画布（源图 + 成品 + 预览副本）。
 */
export const CANVAS_SAFETY = 0.5;

export interface CanvasLimitDeps {
  /**
   * 造一张画布。默认是**真 DOM 画布** —— 必须与生产同一条路径，
   * 因为引擎渲染用的就是它，OffscreenCanvas 的上限未必相同。
   */
  createCanvas?: () => HTMLCanvasElement;
  /** 主指针是否为粗指针（触屏为主）。假时完全不探测 */
  isTouchPrimary?: () => boolean;
}

function defaultCreateCanvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}

function defaultIsTouchPrimary(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/** 把目标面积折成正方形边长 —— 判据是面积，形状不影响结论。 */
function squareFor(targetPixels: number): number {
  return Math.floor(Math.sqrt(targetPixels));
}

/**
 * 这张尺寸的画布真的能画吗。
 *
 * 判据是"写一个像素再读回来"，而不是 `getContext` 是否为 null ——
 * 超限画布在 Safari 上照样给上下文，只是画不上去（见文件头）。
 */
export function canRenderOnCanvas(
  width: number,
  height: number,
  createCanvas: () => HTMLCanvasElement = defaultCreateCanvas,
): boolean {
  try {
    const canvas = createCanvas();
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    ctx.fillStyle = '#FF0000';
    ctx.fillRect(0, 0, 1, 1);

    const { data } = ctx.getImageData(0, 0, 1, 1);
    return data[0] === 0xff && data[3] === 0xff;
  } catch {
    // 超限时上面任意一步都可能抛错，一律当作"这张画布用不了"
    return false;
  }
}

/** 升序探测，返回**通过的最大面积**。一个都没通过则返回 0。 */
export function probeMaxCanvasPixels(deps: CanvasLimitDeps = {}): number {
  const createCanvas = deps.createCanvas ?? defaultCreateCanvas;

  let passed = 0;
  for (const target of CANVAS_PROBE_CANDIDATES) {
    const side = squareFor(target);
    if (!canRenderOnCanvas(side, side, createCanvas)) break;
    passed = side * side;
  }
  return passed;
}

/**
 * 上限策略（纯函数）：桌面不探测；触屏设备探测后打折；探不出来退回原常量。
 *
 * 单独拆出来是为了可注入依赖 —— 测试用假画布走完整个策略，
 * 不必真的去分配几百 MB。
 */
export function computeCanvasLimit(deps: CanvasLimitDeps = {}): number {
  const isTouchPrimary = deps.isTouchPrimary ?? defaultIsTouchPrimary;
  if (!isTouchPrimary()) return MAX_CANVAS_PIXELS;

  const probed = probeMaxCanvasPixels(deps);
  if (probed <= 0) return MAX_CANVAS_PIXELS;

  return Math.min(probed * CANVAS_SAFETY, MAX_CANVAS_PIXELS);
}

/**
 * 上限策略的生产入口。
 *
 * 探测要真分配内存，所以整个进程只跑一次并缓存 —— 调用点在
 * `assessFrame` 的默认参数上，而那是每次拖动滑杆都会走到的路径。
 */
let cached: number | null = null;

export function resolveCanvasLimit(): number {
  if (cached === null) cached = computeCanvasLimit();
  return cached;
}

/** 只给测试用：清掉缓存，让下一次调用重新探测。 */
export function resetCanvasLimitCache(): void {
  cached = null;
}
