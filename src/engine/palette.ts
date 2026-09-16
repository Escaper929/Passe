/**
 * 卡纸配色与亮度分析。
 *
 * 开发指南 §1 给出了四种卡纸色，但只给了颜色没给"怎么在深色卡纸上做凹凸"的答案。
 * 这里补上相对亮度计算，供噪点叠加方式、钢印光效强度、倒角暗收边一起查表，
 * 否则炭黑展厅（#1C1C1E）上的纸纹和钢印会整层失效。
 */

export interface MatboardPreset {
  id: string;
  name: string;
  color: string;
}

/** 开发指南 §1 的四种卡纸基准色。刻意不含 #FFFFFF 纯白。 */
export const MATBOARD_PRESETS: readonly MatboardPreset[] = [
  { id: 'warm-white', name: '博物馆暖白', color: '#F8F7F3' },
  { id: 'ivory', name: '暗房象牙色', color: '#F4F0E6' },
  { id: 'cool-grey', name: '当代冷灰', color: '#ECEEF0' },
  { id: 'carbon', name: '炭黑展厅', color: '#1C1C1E' },
] as const;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 解析 #RGB / #RRGGBB。无法解析时抛错，不做静默兜底。 */
export function hexToRgb(hex: string): Rgb {
  const match = HEX_RE.exec(hex.trim());
  if (!match) throw new Error(`无法解析颜色：${hex}`);

  let body = match[1];
  if (body.length === 3) {
    body = body
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }

  return {
    r: Number.parseInt(body.slice(0, 2), 16),
    g: Number.parseInt(body.slice(2, 4), 16),
    b: Number.parseInt(body.slice(4, 6), 16),
  };
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * sRGB 相对亮度（WCAG 定义），返回值 0 ~ 1。
 * 用线性光下的加权和，而不是 (r+g+b)/3 —— 后者会把炭黑的亮度估高一大截。
 */
export function relativeLuminance(color: string): number {
  const { r, g, b } = hexToRgb(color);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** 是否属于浅色卡纸。分界线取 0.5 的感知中灰附近。 */
export function isLightSurface(color: string): boolean {
  return relativeLuminance(color) > 0.35;
}

export interface SurfaceTone {
  luminance: number;
  isLight: boolean;
  /**
   * 附加暗部纹理的强度系数（乘算叠加）。
   * 深色卡纸的暗部纹理很容易被进一步压黑而看不见，需要压低。
   */
  shadowGain: number;
  /** 附加亮部纹理 / 反光棱的强度系数（滤色叠加）。深色表面需要更强的提亮才可见。 */
  highlightGain: number;
  /** 45° 切面背光侧的暗收边强度。浅色纸芯上要更明显才读得出厚度。 */
  bevelShadeGain: number;
}

/** 一次性算出某张卡纸的各项光效增益，避免在渲染循环里反复解析颜色。 */
export function analyzeSurface(color: string): SurfaceTone {
  const luminance = relativeLuminance(color);
  const isLight = luminance > 0.35;

  // 浅色表面：暗部纹理清晰可见，压到 1.0；深色表面压到 0.45 以免整层消失
  const shadowGain = isLight ? 1 : 0.45;
  // 深色表面：需要更强的提亮才能读出纤维
  const highlightGain = isLight ? 1 : 1.6;
  // 深色表面上的白芯对比本来就极强，暗收边反而要收敛
  const bevelShadeGain = isLight ? 1 : 0.5;

  return { luminance, isLight, shadowGain, highlightGain, bevelShadeGain };
}
