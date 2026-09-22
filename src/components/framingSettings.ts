/**
 * 装裱设置 —— 一套配方 + 一份导出设置。
 *
 * 为什么住在 App 而不是各自的界面里：**切视图就是卸载**（App.tsx 按 view 直接分支
 * 返回，不是隐藏）。队列当初正是因为这个原因被抬上去的，但装裱配方那时留在了组件里 ——
 * 于是"去验证台看一眼放大镜、再切回来"，辛苦调好的边距、构图档、导出格式与质量
 * 全部回默认。同一个道理，这次一并抬上来。
 *
 * 两个视图共用**同一份**，而不是各持一份：验证台本来就是"1:1 放大镜 + 材质滑杆"
 * 的那一侧。在那边把纸纤维调粗、切回来看整体，这个来回是它的正当用法；
 * 要是各持一份，那边调完切回来照样丢 —— 同一个毛病换个方向再犯一次。
 *
 * 边界：这里只放**用户投入过劳动的设置**。瞬态的东西一概不进 ——
 * 拖拽高亮、量出来的盒尺寸、字体是否就绪、本次导出的提示文案……它们重挂载后
 * 本来就该重新算，抬上来只会让两个视图为一个看不见的值互相重渲染。
 */

import { useCallback, useState } from 'react';

import type { FrameConfig, LayerToggles } from '@/engine/types';

import { DEFAULT_EXPORT_FORMAT_ID, DEFAULT_QUALITY, type ExportFormatId } from './exportFormat';
import { DEFAULT_EXPORT_SIZE_ID } from './exportPlan';

/**
 * 初始配方。
 *
 * 从前在 FramingStudio 与 lab/MaterialLab 里各写了一份完全相同的 ——
 * 两个视图既然共用一套配方，它就只能有一处。
 */
export const INITIAL_CONFIG: FrameConfig = {
  matColor: '#F8F7F3',
  marginRatio: 0.14,
  bottomWeight: 1.25,
  targetAspect: null,
  paperTextureIntensity: 0.04,
  bevelWidth: 2.5,
  insetShadowBlur: 6,
  stampDepth: 1.2,
  enableStamp: true,
  cameraModel: 'LEICA M6',
  filmBrand: 'KODAK PORTRA 400',
};

export interface FramingSettingsApi {
  config: FrameConfig;
  patchConfig: (patch: Partial<FrameConfig>) => void;
  patchLayer: (key: keyof LayerToggles, value: boolean) => void;

  /** 导出长边档位的 id（见 EXPORT_SIZES） */
  sizeId: string;
  /** 手选尺寸。语义里含"作废之前的修正值"，所以只此一处能改 sizeId */
  chooseSize: (next: string) => void;
  /** 内存守卫给出的修正值或用户手动指定，优先于 sizeId */
  overrideMaxDimension: number | null;
  setOverrideMaxDimension: (next: number | null) => void;

  formatId: ExportFormatId;
  setFormatId: (next: ExportFormatId) => void;
  /**
   * JPEG 质量。单独存一份而不是塞进格式里：切到 PNG 再切回来时，
   * 用户之前选的质量应当还在，而不是被重置成默认值。
   */
  jpegQuality: number;
  setJpegQuality: (next: number) => void;

  /**
   * 有导出在跑。
   *
   * 从前是组件内部的 `isExporting || isBatching`。抬到这里是因为它不只是
   * 调校台自己的事：导出循环**不会因为组件卸载而停下**，所以切视图的入口
   * 也必须据此设防，否则进度与中断按钮凭空消失，用户可能再点一次导出，
   * 两批同时往同一个目录写（目录直写会静默覆盖）。
   */
  busy: boolean;
  /** 单张导出进行中。与 busy 分开，是因为调校台的按钮文案要区分这两件事 */
  isExporting: boolean;
  setIsExporting: (next: boolean) => void;
  /** 批量导出进行中 */
  isBatching: boolean;
  setIsBatching: (next: boolean) => void;
}

export function useFramingSettings(): FramingSettingsApi {
  const [config, setConfig] = useState<FrameConfig>(INITIAL_CONFIG);
  const [sizeId, setSizeId] = useState(DEFAULT_EXPORT_SIZE_ID);
  const [overrideMaxDimension, setOverrideMaxDimension] = useState<number | null>(null);
  const [formatId, setFormatId] = useState<ExportFormatId>(DEFAULT_EXPORT_FORMAT_ID);
  const [jpegQuality, setJpegQuality] = useState(DEFAULT_QUALITY);
  const [isExporting, setIsExporting] = useState(false);
  const [isBatching, setIsBatching] = useState(false);

  const patchConfig = useCallback((patch: Partial<FrameConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const patchLayer = useCallback((key: keyof LayerToggles, value: boolean) => {
    setConfig((prev) => ({
      ...prev,
      layers: { ...prev.layers, [key]: value },
    }));
  }, []);

  const chooseSize = useCallback((next: string) => {
    setSizeId(next);
    // 手选尺寸意味着用户改变了主意，之前守卫给的修正值应当失效
    setOverrideMaxDimension(null);
  }, []);

  return {
    config,
    patchConfig,
    patchLayer,
    sizeId,
    chooseSize,
    overrideMaxDimension,
    setOverrideMaxDimension,
    formatId,
    setFormatId,
    jpegQuality,
    setJpegQuality,
    busy: isExporting || isBatching,
    isExporting,
    setIsExporting,
    isBatching,
    setIsBatching,
  };
}
