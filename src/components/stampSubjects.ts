/**
 * 钢印上那两个字段的常用取值。
 *
 * ## 为什么不并进 `presets.ts` 的装裱预设
 *
 * 装裱预设**刻意不含机型与胶卷** —— 那套东西描述的是"怎么装裱"，而机型与胶卷
 * 描述的是"拍的是什么"。把机型塞进装裱预设会有两个后果：切预设时把用户刚填的
 * 机型悄悄改掉；同一次批量里混着两台相机的扫描件时，预设一应用就全被统一成一台。
 *
 * 所以这里是另一类东西：**只是给两个文本框准备的候选值**，不是"一套配置"。
 * 点一下等于替用户敲一遍字，点完仍然可以随便改，也不参与任何存取。
 *
 * ## 为什么值得内置一份
 *
 * 钢印是一行等宽字，写错一个字母就会印在一张 8K 成品上。而机型与胶卷的写法
 * 有大量"看起来都行"的变体（`M6` / `LEICA M6` / `Leica M6`、`PORTRA 400` /
 * `KODAK PORTRA 400`）。给一份统一的写法，比让每个人自己敲要省事，
 * 也让同一位摄影师的一批成品看起来是一套。
 *
 * ## 写法与硬约束
 *
 * - **一律大写**：`drawDeboss` 本来就会 `toUpperCase()`，这里直接给最终形态，
 *   免得"选的"和"印出来的"看起来不一样。
 * - **带上品牌**：`LEICA M6` 而不是 `M6`。钢印上只有这一行字，没有别的上下文。
 * - **别太长**：钢印是一行居中文字，越界的部分不会换行，只会顶出卡纸。
 *   上限由 `stampSubjects.test.ts` 与视觉回归里"最长组合不越界"那条一起守。
 */

/** 相机机型。按旁轴 → 单反 → 口袋机 → 中画幅排，同组内大致按常见度。 */
export const CAMERA_PRESETS: readonly string[] = [
  // 旁轴
  'LEICA M6',
  'LEICA M3',
  'LEICA MP',
  // 单反
  'NIKON FM2',
  'NIKON F3',
  'CANON AE-1',
  'PENTAX K1000',
  // 口袋机
  'CONTAX T2',
  'OLYMPUS MJU II',
  'YASHICA T4',
  'ROLLEI 35',
  // 中画幅
  'HASSELBLAD 500CM',
  'HASSELBLAD 503CW',
  'ROLLEIFLEX 2.8F',
  'MAMIYA 7 II',
  'PENTAX 67',
];

/** 胶卷型号。彩色负片 → 反转片 → 黑白 → 电影卷排。 */
export const FILM_PRESETS: readonly string[] = [
  // 彩色负片
  'KODAK PORTRA 400',
  'KODAK PORTRA 160',
  'KODAK PORTRA 800',
  'KODAK EKTAR 100',
  'KODAK GOLD 200',
  'FUJIFILM PRO 400H',
  'FUJIFILM SUPERIA 400',
  'LOMOGRAPHY 800',
  // 反转片
  'KODAK EKTACHROME E100',
  'FUJIFILM VELVIA 50',
  // 黑白
  'KODAK TRI-X 400',
  'ILFORD HP5 PLUS',
  'ILFORD FP4 PLUS',
  'FUJIFILM ACROS 100 II',
  // 电影卷
  'CINESTILL 800T',
  'CINESTILL 400D',
];

/**
 * 单条取值的长度上限。
 *
 * 不是为了好看，是为了**版面**：钢印是一行居中文字，长出卡纸就顶出去。
 * 视觉回归里"最长机型 + 最长胶卷"那条会拿真实字体实测，这条只是更早、
 * 更便宜的一道闸 —— 加新条目时先在这里被拦下，不必等跑到渲染。
 */
export const MAX_SUBJECT_LENGTH = 21;

/** 列表里最长的机型 / 胶卷。给"最长组合不越界"那条断言用，免得手抄两个字面量。 */
export function longestOf(values: readonly string[]): string {
  return values.reduce((longest, value) => (value.length > longest.length ? value : longest), '');
}
