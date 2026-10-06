import type { Layout } from './layout';
import type { SurfaceTone } from './palette';
import { scaledPx } from './scaleFactor';

/**
 * 四层物理材质的绘制。
 *
 * 每一层都以开发指南 §1 的物理描述为准，并遵守两条硬约束：
 * 所有尺寸经 scaleFactor 换算；所有光效强度按卡纸亮度自适应。
 */

/* ─────────────────────────── 45° 斜切白芯 ─────────────────────────── */

export interface BevelOptions {
  /** 以 1200px 短边为基准的切面宽度 */
  bevelWidth: number;
  /** 切芯颜色，纸芯本色 */
  bevelColor: string;
  surface: SurfaceTone;
}

/**
 * 卡纸开窗露出的 45° 倾斜剖面。
 *
 * 光源定在左上方，因此左上切面受光呈细白高光、右下切面背光呈微弱暗收边
 * （开发指南 §1）。倒角带画在开窗之外，随后被照片主体覆盖，
 * 所以只需保证画的顺序在照片之前。
 */
export function drawBevel(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  options: BevelOptions,
): void {
  const bw = scaledPx(options.bevelWidth, layout.canvasW, layout.canvasH, 1.5);
  const { x, y, w, h } = layout;
  const { surface } = options;

  // 1. 纸芯底色，向开窗四周外扩 bw
  ctx.save();
  ctx.fillStyle = options.bevelColor;
  ctx.fillRect(x - bw, y - bw, w + bw * 2, h + bw * 2);

  // 2. 受光面（上、左）：细白高光。切芯本色就是白的，深浅卡纸用同一强度
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.fillRect(x - bw, y - bw, w + bw * 2, bw);
  ctx.fillRect(x - bw, y - bw, bw, h + bw * 2);

  // 3. 背光面（下、右）：微弱暗收边
  ctx.fillStyle = `rgba(0, 0, 0, ${0.08 * surface.bevelShadeGain})`;
  ctx.fillRect(x - bw, y + h, w + bw * 2, bw);
  ctx.fillRect(x + w, y - bw, bw, h + bw * 2);
  ctx.restore();
}

/* ─────────────────────────── 相纸下落内阴影 ─────────────────────────── */

export interface InsetShadowOptions {
  /** 以 1200px 短边为基准的阴影半径 */
  insetShadowBlur: number;
}

/**
 * 卡纸厚度压在相纸上产生的遮蔽暗影（Ambient Occlusion），
 * 限定在相纸范围内羽化（开发指南 §1）。
 *
 * 开发指南 §3 的原始实现只画了上、左两条边，右下两侧完全没有过渡，
 * 白光环境下会读不出"卡纸压在相纸上"的厚度关系。
 * 这里补齐四边，并保持左上方为主光源的强度梯度：
 * 上 0.22 → 左 0.16 → 下 0.12 → 右 0.10。
 */
export function drawInsetShadow(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  options: InsetShadowOptions,
): void {
  const blur = scaledPx(options.insetShadowBlur, layout.canvasW, layout.canvasH, 3);
  if (blur <= 0) return;

  const { x, y, w, h } = layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  const top = ctx.createLinearGradient(0, y, 0, y + blur);
  top.addColorStop(0, 'rgba(0, 0, 0, 0.22)');
  top.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = top;
  ctx.fillRect(x, y, w, blur);

  const bottom = ctx.createLinearGradient(0, y + h, 0, y + h - blur);
  bottom.addColorStop(0, 'rgba(0, 0, 0, 0.12)');
  bottom.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = bottom;
  ctx.fillRect(x, y + h - blur, w, blur);

  const left = ctx.createLinearGradient(x, 0, x + blur, 0);
  left.addColorStop(0, 'rgba(0, 0, 0, 0.16)');
  left.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = left;
  ctx.fillRect(x, y, blur, h);

  const right = ctx.createLinearGradient(x + w, 0, x + w - blur, 0);
  right.addColorStop(0, 'rgba(0, 0, 0, 0.1)');
  right.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = right;
  ctx.fillRect(x + w - blur, y, blur, h);

  ctx.restore();
}

/* ─────────────────────────── 无墨立体钢印 ─────────────────────────── */

/**
 * 相机线稿在它自己那套 40 单位坐标系里实际占用的尺寸。
 *
 * 从下面的路径读出来：x 从 −18 到 19、y 从 −12 到 12（两个取景器凸起
 * 分别落在 y = −12 与 y = −7 上）。这两个数**必须与路径同步改**，
 * 否则 `stampGeometry` 报出的净空隙就是假的，而"图标与文字读成一枚印"
 * 这条构图约束正是靠它守着的。
 */
const CAMERA_VECTOR_UNITS = 40;
const CAMERA_VECTOR_WIDTH_UNITS = 37;
const CAMERA_VECTOR_HEIGHT_UNITS = 24;

/** 旁轴相机简笔线稿。坐标系以 (x, y) 为锚点，按 size 缩放。 */
function drawCameraVector(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  const s = size / CAMERA_VECTOR_UNITS;
  ctx.scale(s, s);

  ctx.beginPath();
  ctx.moveTo(-18, 10);
  ctx.lineTo(-18, -4);
  ctx.arcTo(-18, -7, -15, -7, 2);
  ctx.lineTo(10, -7);
  ctx.lineTo(11, -9);
  ctx.lineTo(17, -9);
  ctx.arcTo(19, -9, 19, -6, 2);
  ctx.lineTo(19, 10);
  ctx.arcTo(19, 12, 16, 12, 2);
  ctx.lineTo(-15, 12);
  ctx.arcTo(-18, 12, -18, 10, 2);
  ctx.closePath();
  ctx.stroke();

  ctx.strokeRect(-15, -10, 4, 3);
  ctx.strokeRect(12, -12, 4, 3);

  ctx.beginPath();
  ctx.arc(-1, 2.5, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-1, 2.5, 4.5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeRect(10, -4.5, 5, 3.5);
  ctx.fillRect(2, -4, 3, 2.5);

  ctx.restore();
}

/**
 * 绘制带字距的居中文本（钢印用）。
 *
 * **刻意不使用 `ctx.letterSpacing`，一律逐字排版。** 两个理由，都是实测出来的：
 *
 * 1. 原生 letterSpacing 把字距加在**每个**字符之后（末尾那个也加），而
 *    `textAlign: 'center'` 是按"含尾随字距的推进宽度"居中的 —— 于是墨迹整体
 *    左偏 tracking/2。实测 tracking = 4px 时偏 2.00px，正好是 tracking/2。
 *    钢印上方那台相机图标是按几何中心画的，两者就此错开：1200px 预览偏 1.2px，
 *    8K 成品上到 8px。在 1.5px 级的压凹线宽上，图标与文字错开是看得出来的。
 * 2. 老 Safari（17 之前）根本没有这个属性，本来也需要兜底。
 *
 * 与其维护两条会分叉的路径（而且其中一条永远只跑在一个浏览器里、进不了
 * Skia 视觉回归基准），不如只留一条：逐字排版在任何环境下都落在同一个位置，
 * 于是预览、导出、回归基准、各浏览器之间逐像素一致。
 *
 * 代价是失去跨字符的字形整形（kerning）。钢印内容是大写机型名 / 胶卷名配
 * 2.4px 级字距，字距远大于任何 kerning 值，看不出来。
 */
export function drawTrackedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  baselineY: number,
  tracking: number,
): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const chars = Array.from(text);
  if (chars.length === 0) return;

  const widths = chars.map((ch) => ctx.measureText(ch).width);
  // 末尾不加字距：居中要按墨迹范围算，不能按"含尾随空隙的推进宽度"算，
  // 否则就会重现上面第 1 条那个左偏
  const total = widths.reduce((sum, width) => sum + width, 0) + tracking * (chars.length - 1);

  let cursor = centerX - total / 2;
  chars.forEach((ch, index) => {
    ctx.fillText(ch, cursor, baselineY);
    cursor += widths[index] + tracking;
  });
}

export interface DebossOptions {
  /** 以 1200px 短边为基准的下压深度 */
  stampDepth: number;
  cameraModel?: string;
  filmBrand?: string;
  surface: SurfaceTone;
}

/**
 * 钢印的尺寸常量，全部以 1200px 短边为基准（经 `scaledPx` 换算）。
 *
 * 这几个数是**一起**定的，单独动一个都会散架：
 *
 * - `STAMP_ICON_SIZE`（26 → 38）：相机图标的名义尺寸。它在 `drawCameraVector`
 *   的 40 单位坐标系里画，实际占到约 0.93 宽 × 0.6 高，所以 38 得到约 23px 高的标记。
 * - `STAMP_ICON_GAP_RATIO`（新增）：图标中心到文字中线的距离，**按图标尺寸取比例**。
 *   原来这两处都写 26，看起来"图标 26、间距 26"很整齐，实际是个坑：
 *   图标只有 0.6 × 26 = 15.6 高，于是间距里剩下 26 − 10 ≈ 16px，**比 9.5px 的字还高**。
 *   图标和文字就此读成两个不相干的记号，而不是一个钢印。按比例给 0.68 之后
 *   间距约 9px，两者才咬合成一体。
 * - `STAMP_FONT_SIZE`（9.5 → 14 → 21）：整块钢印原先只占画布宽的 8.8%，
 *   而画布在界面上还会再缩到约 0.37 倍显示 —— 文字落到 3.5 个 CSS 像素，
 *   读不出来。用户的反馈正是"太小、太不明显"。14 那一档（屏幕 8.4 CSS px）
 *   仍然偏小，21 是第二档：屏幕约 12.6 CSS px，≈ 常规正文可读性。
 *   代价是墨迹占到画布宽的约 24%（真实画廊卡纸上的钢印通常是卡纸宽的 2~10%），
 *   属于"比实物抢眼、但读得清"的一侧；要更接近实物就把这个数往回拧。
 * - `STAMP_TRACKING`（2.4 → 3.5 → 5.25）：字距与字号同步放大，
 *   始终保持 **0.25 的字距/字号比**（5.25 / 21 = 0.25）。改字号时这个数要跟着走，
 *   否则字会先挤成一团、再在放大后散开。
 *
 * 改这几个数之后必须重建视觉回归基线（`npm run visual:update`）——
 * 它们直接决定底边带上那一片像素。
 *
 * ⚠️ 字号还和**小图下限**耦合：`stampGeometry` 里字号走
 * `scaledPx(STAMP_FONT_SIZE, …, 8)`，300×200 那档小源图（`small-source`）落到的
 * 是下限 8，不受这里改动影响 —— 所以抬字号不会把那一档撑得更宽，
 * 但也别指望它跟着变大。
 */
const STAMP_ICON_SIZE = 38;
const STAMP_ICON_GAP_RATIO = 0.68;
const STAMP_FONT_SIZE = 21;
const STAMP_TRACKING = 5.25;

/** 钢印线宽与图标尺寸的比。放大图标而不加粗，图标就成了灰线。 */
const STAMP_STROKE_RATIO = 1.25;

/**
 * 钢印默认下压深度的**唯一出处**。
 *
 * 从前 `1.2` 分别写在五处（引擎默认配置、界面初始配方、出厂预设、
 * 以及两个界面里给滑杆用的 `?? 1.2` 兜底）。于是"改默认值"这件事
 * 在代码里根本没有一个能改对的地方：改了引擎的，滑杆显示的仍是旧值。
 * 抬高默认值（配合整块钢印放大 1.46 倍那一次改动）时合并到这里。
 *
 * 取值 1.5 的依据：位移在预览尺度上是像素级的，1.2 时钢印的棱几乎贴在一起、
 * 读成一片灰；2.2 往上则开始像套印错位而不是压痕。1.5 处在
 * 出厂预设区间（1.0 ~ 1.6）的偏上位置，与炭黑展厅（深色卡纸需要更强反光）同档。
 */
export const DEFAULT_STAMP_DEPTH = 1.5;

/** 钢印用的字体栈。逐字排版，不依赖任何字体特性（见 `drawTrackedText`）。 */
const STAMP_FONT_STACK = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';

/**
 * 钢印一块印的全部几何量。**唯一的一次计算在这里**。
 *
 * 抽出来是为了让"图标与文字读成一枚印"这条构图约束能被测试直接断言 ——
 * 从前这套算式只写在 `drawDeboss` 里，测试要验证它就得抄一遍，
 * 而抄一遍就必然分叉（当初"图标 26、间距也 26"正是这么写错的）。
 */
export interface StampGeometry {
  /** 图标的名义尺寸（喂给 `drawCameraVector` 的 40 单位坐标系） */
  iconSize: number;
  /** 图标线稿的**实际**占位，比名义尺寸小得多 */
  iconWidth: number;
  iconHeight: number;
  /** 图标中心的 y 坐标 */
  iconY: number;
  /** 文字中线的 y 坐标 */
  textY: number;
  /**
   * 图标下沿到文字上沿之间的**净空隙**（px）。
   *
   * 有意忽略线宽带来的半个笔画的差 —— 于是它是一个上界：
   * 真实空隙只会更小。断言"净空隙 < 字高"因此是偏保守的。
   */
  netGap: number;
  fontSize: number;
  tracking: number;
  lineWidth: number;
  /** 三层光效之间沿 225° 的位移距离 */
  offset: number;
}

/**
 * 由版式算出钢印的全部几何量。纯函数，同样的 layout 必得同样的结果。
 *
 * `depth` 默认取 `DEFAULT_STAMP_DEPTH`，测试与预览因此走同一条路径。
 */
export function stampGeometry(layout: Layout, depth: number = DEFAULT_STAMP_DEPTH): StampGeometry {
  const { canvasW, canvasH, bottomOffset, scale } = layout;

  const iconSize = scaledPx(STAMP_ICON_SIZE, canvasW, canvasH, 20);
  const fontSize = scaledPx(STAMP_FONT_SIZE, canvasW, canvasH, 8);
  const iconWidth = (iconSize * CAMERA_VECTOR_WIDTH_UNITS) / CAMERA_VECTOR_UNITS;
  const iconHeight = (iconSize * CAMERA_VECTOR_HEIGHT_UNITS) / CAMERA_VECTOR_UNITS;

  const iconToText = Math.round(iconSize * STAMP_ICON_GAP_RATIO);

  /**
   * 钢印组在底边带里**居中**，而不是按固定比例往下推。
   *
   * ## 为什么不能是常数
   *
   * 原来是 `iconY = 相片下沿 + bottomOffset * 0.36`。那个 0.36 是按
   * **典型底边带（140px）** 校准的：0.36×140 = 50.4，加上半个组高补偿后
   * 恰好让组心落在带中线上 —— 在 `baseline-light` 上实测偏 **-9px**，
   * 确实是居中的。
   *
   * 但底边带不是一个常数。它由 `marginRatio × 照片短边 × bottomWeight` 决定，
   * 实际范围从 `small-source` 的 **35px** 到横图套 9:16 的 **962px**，跨度 27 倍。
   * 系数固定，于是"居中"只在那个被校准的带宽上成立：
   *
   * | 场景 | 底边带 | 组心偏离带中线 |
   * |---|---|---|
   * | `baseline-light` | 140px | −9px（≈居中） |
   * | `margin-wide` | 300px | −28px |
   * | `aspect-portrait-3-4` | 611px | −71px |
   * | `aspect-portrait-9-16` | 962px | **−120px** |
   *
   * 越到竖屏档钢印越贴向相片一侧，在 9:16 下离照片三百多像素。
   * 这不是"钢印太大"，是**锚点公式在大留白下失效**。
   *
   * ## 现在的算法
   *
   * 直接解"组心 = 带中线"这个方程。**注意组心不能按 `groupHeight / 2` 算** ——
   * `iconY` 是图标的**中心**、不是组的顶边，所以组高里不该含 `iconHeight`：
   *
   * ```
   * 组顶 = iconY − iconHeight/2
   * 组底 = textY  + fontSize/2 = iconY + iconToText + fontSize/2
   * 组心 = (组顶 + 组底) / 2 = iconY + (iconToText + fontSize/2) / 2
   * ```
   *
   * 代入 `组心 = 带中线`，得 `iconY = 带中线 − (iconToText + fontSize/2) / 2`。
   * 这一步算错的话不会崩，只会让钢印**恒定偏上十几像素** ——
   * 看着仍"大致居中"，所以必须靠断言量出来，别靠眼睛。
   *
   * 于是公式**对任意带宽都成立**，不再依赖"典型值"这个隐含前提：
   * 窄带（35px）里钢印贴着相片、宽带（962px）里居中，两头都对。
   * 修正前后的实测（组心偏离带中线）：
   *
   * | 场景 | 底边带 | 修正前 | 修正后 |
   * |---|---|---|---|
   * | `baseline-light` | 140px | −9px | ≈0 |
   * | `aspect-portrait-3-4` | 611px | −71px | ≈0 |
   * | `aspect-portrait-9-16` | 962px | **−120px** | ≈0 |
   */
  const bandTop = layout.y + layout.h;
  const bandCenter = bandTop + bottomOffset / 2;
  const centered = bandCenter - (iconToText + fontSize / 2) / 2;
  /**
   * ## 窄带装不下时，居中会把钢印推到相片上
   *
   * `margin-tight`（`marginRatio: 0.05`）的底边带只有 **50px**，而组高 41px ——
   * 装得下，但**居中后上沿会越过相片下沿 5px**。旧公式在窄带上恰好躲过了
   * （它把钢印往下按，窄带时反而更安全），代价是宽带上贴向相片。
   *
   * 所以要**夹取**：算完居中位，若组超出带就贴边。
   * 两头都要守住 —— 压到相片上会让指纹混进随字体变的像素
   * （那条底边带自证锁直接红），越出画布则是肉眼可见的裁切。
   */
  const minIconY = bandTop + iconHeight / 2;
  /**
   * 贴边那一支要**向上取整**（`ceil`），不能四舍五入。
   *
   * `margin-tight` 实测：夹取后的精确值是 839.6，而带沿在 840 ——
   * 差 0.4px。`Math.round(839.6) = 840` 看着正好贴边，但断言量的是
   * `iconY − iconHeight/2` 这个**未取整**的几何值，仍是 839.6 < 840，
   * 于是"压到相片上"照红。取整方向必须**向内**（下取整），宁可留一丝缝，
   * 也不能让亚像素的溢出变成真的压在相片上。
   */
  const iconY = centered < minIconY ? Math.ceil(minIconY) : Math.round(centered);
  const textY = iconY + iconToText;
  const netGap = textY - fontSize / 2 - (iconY + iconHeight / 2);

  return {
    iconSize,
    iconWidth,
    iconHeight,
    iconY,
    textY,
    netGap,
    fontSize,
    tracking: STAMP_TRACKING * scale,
    lineWidth: Math.max(1, STAMP_STROKE_RATIO * scale),
    // 不取整：位移一旦被舍成整数，滑杆在预览尺度上就废掉了大半（见 drawDeboss）
    offset: Math.max(0.5, depth * scale),
  };
}

/**
 * 钢印上那一行字。**标签怎么拼只有这一处**。
 *
 * 抽出来是因为除了 `drawDeboss`，还有两处需要知道"字到底是什么"：
 * 视觉回归那条"文字必须落在排除带内"的锁，以及预设列表"最长组合会不会越界"
 * 的检查。它们各自拼一遍的话，改分隔符就会有一处悄悄量错。
 */
export function stampLabel(cameraModel?: string, filmBrand?: string): string {
  return [cameraModel, filmBrand].filter(Boolean).join('   /   ').toUpperCase();
}

/**
 * 把钢印的字体装到 2D 上下文上。
 *
 * 字体串（含 `600` 这个字重）**只在这里出现一次** —— 量宽与真正绘制必须用
 * 同一套字形，否则"量出来 384px"和"画出来 400px"这种分歧不会有任何报错。
 */
export function applyStampFont(ctx: CanvasRenderingContext2D, fontSize: number): void {
  ctx.font = `600 ${fontSize}px ${STAMP_FONT_STACK}`;
}

/**
 * 量出这一行字的墨迹宽度（px）。
 *
 * 与 `drawTrackedText` 同源：逐字度量，**末尾那个字距不计**——
 * 居中按墨迹范围算，算进尾随空隙就会整体左偏（见 `drawTrackedText` 的注释）。
 */
export function measureStampLabelInk(
  ctx: CanvasRenderingContext2D,
  label: string,
  geometry: Pick<StampGeometry, 'fontSize' | 'tracking'>,
): number {
  applyStampFont(ctx, geometry.fontSize);
  const chars = Array.from(label);
  if (chars.length === 0) return 0;
  return (
    chars.reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) +
    geometry.tracking * (chars.length - 1)
  );
}

/**
 * 底部无墨立体钢印（Blind Deboss）。
 *
 * 光学构成（开发指南 §1）：左上槽底阴影 + 右下截光边缘反光 + 凹槽内部纸浆轻微压暗。
 * 实现手法是三明治叠印：先把形状压暗，再向左上偏移画一层阴影棱，
 * 向右下偏移画一层迎光反光棱。光源方向与倒角、内阴影一致。
 *
 * 三层的不透明度按卡纸亮度自适应：炭黑卡纸上阴影棱几乎不可见，
 * 反光棱反而需要加强，否则钢印整层消失。
 */
export function drawDeboss(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  options: DebossOptions,
): void {
  const { cameraModel, filmBrand } = options;
  if (!cameraModel && !filmBrand) return;

  const { surface } = options;

  const centerX = layout.x + layout.w / 2;
  const { iconSize, fontSize, iconY, textY, tracking, lineWidth, offset } = stampGeometry(
    layout,
    options.stampDepth,
  );

  const label = stampLabel(cameraModel, filmBrand);

  // 三层光效的不透明度按卡纸明暗切换。浅色卡纸沿用开发指南 §3 的原始取值，
  // 深色卡纸收阴影、强反光 —— 否则炭黑展厅上的钢印整层读不出来。
  const pitAlpha = surface.isLight ? 0.04 : 0.055;
  const shadowAlpha = surface.isLight ? 0.3 : 0.16;
  const highlightAlpha = surface.isLight ? 0.72 : 0.9;

  const paint = (): void => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lineWidth;

    drawCameraVector(ctx, centerX, iconY, iconSize);

    ctx.save();
    applyStampFont(ctx, fontSize);
    drawTrackedText(ctx, label, centerX, textY, tracking);
    ctx.restore();
  };

  // 光源来自左上 (225°)：阴影棱朝左上偏移，反光棱朝右下偏移
  const angle = Math.PI * 0.75;
  /**
   * 位移取 `stampGeometry` 那一份，**这里刻意不做 `scaledPx` 的取整**。
   *
   * 位移只有连续变化，"钢印下压深度"滑杆才有意义。一旦取整，在预览尺度
   * （scale ≈ 1.315）上 1.2 / 1.5 / 1.8 会被舍成同一个 2px —— 实测这三个档位
   * 渲染出来的像素**逐点相同**，用户把滑杆从中间拖到偏高，画面一点不动。
   *
   * 而位移最后还要乘 (∓0.707, ±0.707)（225° 方向），本来就不是整数，
   * 取整既没换来锐利、也没换来一致，只是把滑杆废掉了大半。
   * （`lineWidth` 同样是不取整的写法，这里与它保持一致。）
   */
  const dx = Math.cos(angle) * offset;
  const dy = -Math.sin(angle) * offset;

  // 1. 槽底纸浆轻微压暗
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgba(0, 0, 0, ${pitAlpha})`;
  ctx.strokeStyle = `rgba(0, 0, 0, ${pitAlpha})`;
  paint();
  ctx.restore();

  // 2. 背光阴影棱（左上）
  ctx.save();
  ctx.translate(dx, dy);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgba(40, 35, 30, ${shadowAlpha})`;
  ctx.strokeStyle = `rgba(40, 35, 30, ${shadowAlpha})`;
  paint();
  ctx.restore();

  // 3. 迎光反光棱（右下）
  ctx.save();
  ctx.translate(-dx, -dy);
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = `rgba(255, 255, 255, ${highlightAlpha})`;
  ctx.strokeStyle = `rgba(255, 255, 255, ${highlightAlpha})`;
  paint();
  ctx.restore();
}
