import { GalleryFramingEngine } from '@/engine/GalleryFramingEngine';
import type { Layout } from '@/engine/layout';
import type { FrameConfig, RenderSource } from '@/engine/types';

import { createNativeCanvas } from './nativeCanvas';

/**
 * 视觉回归的场景矩阵。
 *
 * 分组原则：**每个材质层的"看得见"与"边界"都要有场景**，
 * 而不是穷举参数组合。十个场景覆盖：
 *
 * - 三层材质全都正常表达的基准（浅色卡纸）
 * - 材质通道整体翻转的极端（炭黑卡纸：纸纹换乘算+滤色、钢印收阴影强反光）
 * - 全层关闭的纯净几何（任何纹理渗漏到这里都会露馅）
 * - 底边加权、边距两端、纸纹强度上限
 * - 尺度两端：scaleFactor < 1 的小图下限、超大源图
 * - 长机型名（压钢印文字带的排除范围）
 * - 固定外框比例下的裁切路径
 *
 * 场景本身**不做任何断言**，它只是"输入"；期望值全部在 baseline JSON 里。
 */

/** 中性灰源图：回归要量的是卡纸怎么表现，不是照片好不好看。 */
export const PHOTO_FILL = '#808080';

export interface PhotoSize {
  width: number;
  height: number;
}

export interface VisualScene {
  id: string;
  /** 这个场景是在守什么 —— 失败信息里要打出来。 */
  note: string;
  photo: PhotoSize;
  config: Partial<FrameConfig>;
}

export const VISUAL_SCENES: readonly VisualScene[] = [
  {
    id: 'baseline-light',
    note: '基准：博物馆暖白 + 四层材质全开（1200×800 横构图）',
    photo: { width: 1200, height: 800 },
    config: { matColor: '#F8F7F3' },
  },
  {
    id: 'dark-gallery',
    note: '炭黑展厅：纸纹走乘算+滤色通道、钢印收阴影强反光',
    photo: { width: 1200, height: 800 },
    config: { matColor: '#1C1C1E' },
  },
  {
    id: 'layers-off',
    note: '四层材质全关：卡纸只剩纯色，任何纹理渗漏都会露馅',
    photo: { width: 1200, height: 800 },
    config: {
      matColor: '#F8F7F3',
      layers: {
        mat: true,
        paperTexture: false,
        bevel: false,
        insetShadow: false,
        stamp: false,
      },
    },
  },
  {
    id: 'portrait-weighted',
    note: '竖构图 800×1200：底边加权 1.25 与钢印纵向定位',
    photo: { width: 800, height: 1200 },
    config: { matColor: '#F8F7F3' },
  },
  {
    id: 'margin-tight',
    note: '窄边距 0.05：倒角与内阴影挤在一起，尺度系数最吃紧',
    photo: { width: 1200, height: 800 },
    config: { matColor: '#F8F7F3', marginRatio: 0.05 },
  },
  {
    id: 'margin-wide',
    note: '宽边距 0.30：大量留白，钢印与底边距的位置关系被拉开',
    photo: { width: 1200, height: 800 },
    config: { matColor: '#F8F7F3', marginRatio: 0.3 },
  },
  {
    id: 'texture-strong',
    note: '纸纹强度拉到 0.12：纤维清晰可见，强度与叠加方式都在这条上',
    photo: { width: 1200, height: 800 },
    config: { matColor: '#F8F7F3', paperTextureIntensity: 0.12 },
  },
  {
    id: 'small-source',
    note: '小源图 300×200：scaleFactor < 1，线宽/字号的钳位下限',
    photo: { width: 300, height: 200 },
    config: { matColor: '#F8F7F3' },
  },
  {
    id: 'stamp-long-name',
    note: '长机型名 + 长胶卷名：钢印文字带的宽度上限',
    photo: { width: 1200, height: 800 },
    config: {
      matColor: '#F8F7F3',
      cameraModel: 'HASSELBLAD 907X & CFV II 50C',
      filmBrand: 'KODAK PORTRA 400',
    },
  },
  {
    id: 'aspect-square',
    note: '固定外框 1:1：走的是 targetAspect 那条裁切分支',
    photo: { width: 1200, height: 800 },
    config: { matColor: '#F8F7F3', targetAspect: 1 },
  },
];

export function findScene(id: string): VisualScene {
  const scene = VISUAL_SCENES.find((item) => item.id === id);
  if (!scene) throw new Error(`没有这个视觉回归场景：${id}`);
  return scene;
}

/** 造源图。尺寸可覆盖 —— 尺度不变性比对就是靠同一场景换尺寸。 */
export function createPhoto(size: PhotoSize): RenderSource {
  const canvas = createNativeCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`创建场景源图失败：${size.width}×${size.height}`);
  ctx.fillStyle = PHOTO_FILL;
  ctx.fillRect(0, 0, size.width, size.height);
  return canvas;
}

export interface RenderedScene {
  canvas: HTMLCanvasElement;
  layout: Layout;
}

/**
 * 渲染一个场景。
 *
 * @param photo          覆盖源图尺寸（尺度不变性比对就是靠它换尺寸）
 * @param configOverride 覆盖场景配置（负向对照靠它把某一层改坏）
 */
export function renderScene(
  scene: VisualScene,
  photo: PhotoSize = scene.photo,
  configOverride: Partial<FrameConfig> = {},
): RenderedScene {
  const config: Partial<FrameConfig> = { ...scene.config, ...configOverride };
  const source = createPhoto(photo);
  // 指纹要按 layout 定位取样点，而 render 内部用的是同一套 resolveConfig +
  // calculateLayout，所以这里单独求一次是安全的（两边不会分叉）。
  const layout = GalleryFramingEngine.layout(source, config);
  const canvas = GalleryFramingEngine.render(source, config);
  return { canvas, layout };
}

/**
 * 拼图用的缩略源图尺寸：短边固定，长边按原比例推。
 *
 * 拼图只是给人看一眼的评审材料，没必要按全尺寸渲染十个场景 ——
 * 引擎的线宽都绑在 scaleFactor 上，缩略渲染的比例与全尺寸一致。
 *
 * 短边取 320 而不是更小：钢印的字号有 8px 下限、图标有 20px 下限，
 * 而边距是跟着 scaleFactor 缩的，画布短边低于 300px 时钢印会顶出下沿被裁掉。
 * 那个下限本身是为了"小图上线条不消失"，是有意为之；
 * 拼图没必要踩到它，换个尺寸就能看清真正的观感。
 */
export function sheetPhotoSize(scene: VisualScene, shortSide = 320): PhotoSize {
  const { width, height } = scene.photo;
  if (width >= height) {
    return { width: Math.round((shortSide * width) / height), height: shortSide };
  }
  return { width: shortSide, height: Math.round((shortSide * height) / width) };
}
