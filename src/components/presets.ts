/**
 * 装裱预设。
 *
 * 一个刻意的取舍：预设**不含机型与胶卷**。
 *
 * `cameraModel` / `filmBrand` 在 FrameConfig 里，但它们描述的是"拍的是什么"，
 * 而预设描述的是"怎么装裱"。把机型塞进预设会有两个后果：切预设时把用户刚填的
 * 机型悄悄改掉；同一次批量里混着两台相机的扫描件时，预设一应用就全被统一成一台。
 * 所以预设只保存样式，应用时把机型与胶卷原样留下（见 applyPreset）。
 *
 * 存 localStorage：纯前端、无账号，这是唯一合理的落点。但 localStorage
 * 可能整个不可用（隐私模式、禁用 Cookie），也可能存着上个版本的脏数据，
 * 所以读写两头都做了防护 —— 坏数据丢掉即可，绝不能让设置面板整个打不开。
 */

import type { FrameConfig, LayerToggles } from '@/engine/types';

/** 预设保存的样式部分。机型与胶卷刻意排除在外。 */
export type PresetStyle = Omit<FrameConfig, 'cameraModel' | 'filmBrand'>;

export interface StudioPreset {
  id: string;
  name: string;
  style: PresetStyle;
  /** 出厂预设：随代码发布，不可删除、不进本地存储 */
  builtin: boolean;
}

export const PRESET_STORAGE_KEY = 'passe.presets.v1';

/** 预设名长度上限。侧栏宽度有限，长名字会把按钮撑破。 */
export const MAX_PRESET_NAME = 24;

/** 只用到 localStorage 的这三个方法，收窄成自定义接口便于注入替身。 */
export interface PresetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 出厂预设。卡纸与 palette.ts 的 MATBOARD_PRESETS 一一对应。 */
export const BUILTIN_PRESETS: readonly StudioPreset[] = [
  {
    id: 'builtin-warm-white',
    name: '博物馆标准',
    builtin: true,
    style: {
      matColor: '#F8F7F3',
      marginRatio: 0.14,
      bottomWeight: 1.25,
      targetAspect: null,
      paperTextureIntensity: 0.04,
      bevelWidth: 2.5,
      insetShadowBlur: 6,
      stampDepth: 1.2,
      enableStamp: true,
    },
  },
  {
    id: 'builtin-ivory',
    name: '暗房象牙',
    builtin: true,
    style: {
      matColor: '#F4F0E6',
      marginRatio: 0.13,
      bottomWeight: 1.3,
      targetAspect: null,
      paperTextureIntensity: 0.055,
      bevelWidth: 2.5,
      insetShadowBlur: 7,
      stampDepth: 1.4,
      enableStamp: true,
    },
  },
  {
    id: 'builtin-cool-grey',
    name: '当代冷灰',
    builtin: true,
    style: {
      matColor: '#ECEEF0',
      marginRatio: 0.16,
      bottomWeight: 1.15,
      targetAspect: null,
      paperTextureIntensity: 0.028,
      bevelWidth: 2,
      insetShadowBlur: 5,
      stampDepth: 1,
      enableStamp: true,
    },
  },
  {
    id: 'builtin-carbon',
    name: '炭黑展厅',
    builtin: true,
    style: {
      matColor: '#1C1C1E',
      marginRatio: 0.18,
      bottomWeight: 1.2,
      targetAspect: null,
      // 深色卡纸上的颗粒要更明显才读得出来，否则整块像一块纯色板
      paperTextureIntensity: 0.065,
      bevelWidth: 3,
      insetShadowBlur: 8,
      stampDepth: 1.6,
      enableStamp: true,
    },
  },
];

/**
 * 数值字段的取值范围。**与侧栏滑杆的区间一致** ——
 * 存进来的值若超出（比如上个版本的区间不同），钳进范围而不是原样带着走，
 * 否则滑杆显示的值和实际生效的值会对不上，用户拖动一次才知道。
 */
const NUMBER_FIELDS = [
  { key: 'marginRatio', min: 0.06, max: 0.3 },
  { key: 'bottomWeight', min: 1, max: 1.7 },
  { key: 'paperTextureIntensity', min: 0, max: 0.1 },
  { key: 'bevelWidth', min: 0, max: 8 },
  { key: 'insetShadowBlur', min: 0, max: 20 },
  { key: 'stampDepth', min: 0.2, max: 3 },
] as const;

const STRING_FIELDS = ['matColor', 'bevelColor'] as const;
const BOOLEAN_FIELDS = ['enableStamp'] as const;
const LAYER_FIELDS: readonly (keyof LayerToggles)[] = [
  'mat',
  'paperTexture',
  'bevel',
  'insetShadow',
  'stamp',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeLayers(value: unknown): Partial<LayerToggles> | null {
  if (!isPlainObject(value)) return null;
  const layers: Partial<LayerToggles> = {};
  let found = false;
  for (const field of LAYER_FIELDS) {
    if (typeof value[field] === 'boolean') {
      layers[field] = value[field];
      found = true;
    }
  }
  return found ? layers : null;
}

/**
 * 把一段来路不明的数据收成样式对象。
 *
 * 认不出的键一律丢掉（向前兼容：旧版本存的字段不该让新版本崩），
 * 类型不对的字段也丢掉而不是填默认值 —— 填默认值等于替用户改了样式，
 * 而这里根本没有判断"用户想要什么"的依据。
 */
export function sanitizeStyle(value: unknown): PresetStyle | null {
  if (!isPlainObject(value)) return null;

  const style: Record<string, unknown> = {};

  for (const field of NUMBER_FIELDS) {
    const raw = value[field.key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      style[field.key] = clamp(raw, field.min, field.max);
    }
  }

  for (const field of STRING_FIELDS) {
    const raw = value[field];
    if (typeof raw === 'string' && raw.trim() !== '') style[field] = raw;
  }

  for (const field of BOOLEAN_FIELDS) {
    const raw = value[field];
    if (typeof raw === 'boolean') style[field] = raw;
  }

  // targetAspect 允许 null（自适应），所以不能进 NUMBER_FIELDS
  if (value.targetAspect === null) {
    style.targetAspect = null;
  } else if (typeof value.targetAspect === 'number' && value.targetAspect > 0) {
    style.targetAspect = value.targetAspect;
  }

  const layers = sanitizeLayers(value.layers);
  if (layers) style.layers = layers;

  return style as PresetStyle;
}

/** 把一条记录收成预设；认不出来就返回 null 由调用方丢掉。 */
export function sanitizePreset(value: unknown): StudioPreset | null {
  if (!isPlainObject(value)) return null;

  const { id, name } = value;
  if (typeof id !== 'string' || id.trim() === '') return null;
  if (typeof name !== 'string' || name.trim() === '') return null;

  const style = sanitizeStyle(value.style);
  if (!style) return null;

  return {
    id: id.trim(),
    name: name.trim().slice(0, MAX_PRESET_NAME),
    style,
    // 从存储里读回来的一律算用户预设，出厂预设不走存储
    builtin: false,
  };
}

/** 取默认存储。不可用时返回 null —— 隐私模式、禁用 Cookie 都会走到这里。 */
export function defaultPresetStorage(): PresetStorage | null {
  try {
    const storage = globalThis.localStorage as PresetStorage | undefined;
    if (!storage) return null;

    // 有些环境 getItem 能用、setItem 直接抛（配额为 0），所以真要写一次才知道
    const probe = '__passe_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function loadUserPresets(
  storage: PresetStorage | null = defaultPresetStorage(),
): StudioPreset[] {
  if (!storage) return [];

  let raw: string | null;
  try {
    raw = storage.getItem(PRESET_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 存进去的不是 JSON（被别的程序写坏了），当作没有预设
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const presets: StudioPreset[] = [];
  for (const entry of parsed) {
    const preset = sanitizePreset(entry);
    // id 撞了就以先出现的为准，否则 React 列表的 key 会重复
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    presets.push(preset);
  }
  return presets;
}

/** 写入用户预设。写不进去（配额满、隐私模式）时静默忽略，不打断正在做的事。 */
export function saveUserPresets(
  presets: readonly StudioPreset[],
  storage: PresetStorage | null = defaultPresetStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      PRESET_STORAGE_KEY,
      JSON.stringify(presets.filter((preset) => !preset.builtin)),
    );
    return true;
  } catch {
    return false;
  }
}

/** 出厂预设在前，用户预设按保存顺序在后。 */
export function allPresets(userPresets: readonly StudioPreset[]): StudioPreset[] {
  return [...BUILTIN_PRESETS, ...userPresets];
}

/**
 * 生成一个不与现有预设冲突的 id。
 *
 * 刻意不用"模块级自增计数器"：它每次刷新页面都从 1 重新开始，
 * 而预设是**跨会话**存在 localStorage 里的 —— 于是刷新一次就会和上次存的那条撞 id，
 * 应用预设时改到的可能是另一条。
 */
export function nextPresetId(existing: readonly StudioPreset[]): string {
  const taken = new Set(existing.map((preset) => preset.id));
  let index = 1;
  while (taken.has(`user-${index}`)) index += 1;
  return `user-${index}`;
}

export function normalizePresetName(name: string, fallback: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ').slice(0, MAX_PRESET_NAME);
  return trimmed === '' ? fallback : trimmed;
}

/**
 * 由当前配置生成一条用户预设。
 *
 * 走的是与读存储**同一个**收敛函数，于是有两条好处：
 * - 机型与胶卷在这条路上自然被剥掉（它们不在任何字段表里），不需要额外的省略逻辑；
 * - 存下去的样子就是读得回来的样子，不存在"存得进、读出来变了"的字段。
 */
export function createUserPreset(
  name: string,
  config: FrameConfig,
  id: string,
  fallbackName = '未命名预设',
): StudioPreset {
  return {
    id,
    name: normalizePresetName(name, fallbackName),
    style: sanitizeStyle(config) ?? {},
    builtin: false,
  };
}

/**
 * 把预设应用到配置上。
 *
 * 机型与胶卷**原样保留** —— 见文件头的取舍说明。预设里本来也不会有它们，
 * 这里显式写出来是为了让"为什么不覆盖"这件事在代码里看得见。
 */
export function applyPreset(config: FrameConfig, preset: StudioPreset): FrameConfig {
  return {
    ...preset.style,
    cameraModel: config.cameraModel,
    filmBrand: config.filmBrand,
  };
}
