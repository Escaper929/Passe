/**
 * 预览背板配色。
 *
 * 深色工作台上放浅色卡纸没问题，放炭黑卡纸就糟了 —— 卡纸与背板同色系，
 * 成品的边界直接消失，用户根本看不出装裱范围在哪（这是深色工作台的固有缺陷）。
 *
 * 所以背板跟着卡纸亮度翻转：浅色卡纸配深背板、深色卡纸配浅背板。
 * 注意只有**视口**翻转，工作台面板与侧栏仍保持开发指南 §4 的深色 ——
 * 让整个界面跟着变亮会毁掉暗房工作台的气质。
 *
 * 再给成品加一圈极细中性描边兜底：万一遇到自定义的中间调卡纸，
 * 翻转不足以拉开对比时，边界依然读得出来。
 */

import { relativeLuminance } from '@/engine/palette';

/** 深背板。与工作台视口同色，浅色卡纸下使用。 */
export const DARK_BACKING = '#18181A';

/** 浅背板。比任何卡纸预设都亮，深色卡纸下使用。刻意不用纯白，避免塑料感。 */
export const LIGHT_BACKING = '#E6E4DE';

/** 深背板上的描边：极淡的白色，只在边缘起一线分隔。 */
const OUTLINE_ON_DARK = 'rgba(255, 255, 255, 0.12)';

/** 浅背板上的描边：极淡的黑色，同样只起一线分隔。 */
const OUTLINE_ON_LIGHT = 'rgba(0, 0, 0, 0.16)';

/**
 * 所选背板与卡纸之间必须达到的最低对比度。
 *
 * 这条不变量是自动成立的，不是靠运气：两种背板取更优者之后，最坏情形出现在
 * 卡纸亮度恰为两者几何中点时，此时仍有约 3.75:1。任何颜色都越不过这条线。
 * 测试里用一个颜色扫描把这个下界钉住。
 */
export const MIN_BACKING_CONTRAST = 3;

/** WCAG 对比度，返回值 1 ~ 21。 */
export function contrastRatio(colorA: string, colorB: string): number {
  const a = relativeLuminance(colorA);
  const b = relativeLuminance(colorB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface PreviewBacking {
  /** 视口背板底色 */
  background: string;
  /** 成品外的极细描边颜色。恒定渲染 —— 中间调卡纸下对比度只到 ~3.75:1，偏紧 */
  outline: string;
  /** 翻转为浅背板（即卡纸是深色） */
  inverted: boolean;
  /** 所选背板与卡纸的对比度 */
  contrast: number;
}

/**
 * 按卡纸颜色挑背板。
 *
 * 判断依据不是"卡纸亮度是否过半"，而是**实际对比度谁更高** ——
 * 中间调的卡纸（比如灰卡）用亮度阈值会得出很武断的结果，
 * 而对比度比较在任何颜色上都成立。
 */
export function previewBacking(matColor: string): PreviewBacking {
  const darkContrast = contrastRatio(matColor, DARK_BACKING);
  const lightContrast = contrastRatio(matColor, LIGHT_BACKING);

  const inverted = lightContrast > darkContrast;

  return {
    background: inverted ? LIGHT_BACKING : DARK_BACKING,
    outline: inverted ? OUTLINE_ON_LIGHT : OUTLINE_ON_DARK,
    inverted,
    contrast: inverted ? lightContrast : darkContrast,
  };
}
