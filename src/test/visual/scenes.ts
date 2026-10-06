import { GalleryFramingEngine } from '@/engine/GalleryFramingEngine';
import type { Layout } from '@/engine/layout';
import type { FrameConfig, RenderSource } from '@/engine/types';

import { createNativeCanvas } from './nativeCanvas';

/**
 * 视觉回归的场景矩阵。
 *
 * 分组原则：**每个材质层的"看得见"与"边界"都要有场景**，
 * 而不是穷举参数组合。场景矩阵覆盖：
 *
 * - 三层材质全都正常表达的基准（浅色卡纸）
 * - 材质通道整体翻转的极端（炭黑卡纸：纸纹换乘算+滤色、钢印收阴影强反光）
 * - 全层关闭的纯净几何（任何纹理渗漏到这里都会露馅）
 * - 底边加权、边距两端、纸纹强度上限
 * - 尺度两端：scaleFactor < 1 的小图下限、超大源图
 * - 长机型名（最宽的一行钢印字）
 * - 固定外框比例下的裁切路径
 *
 * ## 竖屏档为什么单独占三个场景
 *
 * `targetAspect` 是这个引擎里**唯一会反过来决定画布尺寸**的入参：照片给定，
 * 画布被撑到那个比例，所以横图套竖档时上下要补出几百像素留白。
 * 而 v1.3 才补上 3:4 / 4:5 / 9:16，此前这里只有 1:1 一个固定比例 ——
 * 竖屏档走的是同一段代码却没有任何基线，改坏了没人拦得住。
 *
 * 三个场景各钉一个方向，不是凑数：
 * - `aspect-portrait-3-4`：最常被用到的竖档，基准；
 * - `aspect-portrait-9-16`：最窄的档，横图套上去上下留白最极端
 *   （底边带占到画布高 38%），那是这条分支上最容易崩的地方；
 * - `aspect-portrait-9-16-native`：**给竖图**配 9:16，比例本就接近，
 *   底边带回到 18.9%。留着是为了跟前两条形成对照 ——
 *   "底边带变宽"是横图套竖档的固有结果，不是回归；
 *   有了竖图这条，就分不清"留白被算错"和"外框比例本来就会这样"。
 *
 * ### 为什么竖图那条不配 4:5（真踩过的坑）
 *
 * 原本第三条是"竖图配 4:5"，本地全绿，**CI 上判死**：
 * `候选列表里最长的机型 + 最长的胶卷……留在相片宽度内` 那条断言红在
 * `aspect-portrait-4-5-native：左缘压到卡纸上`（CI 179.2 < 相片边 181）。
 *
 * 根因是**跨平台字体宽度差**，不是几何算错。实测 CI（ubuntu 无
 * Arial/Helvetica，字体回退到 DejaVu 系）的墨迹比本机宽 **1.187 倍**：
 * 本机墨迹 677px / 相片 800px = **0.846**，乘 1.187 正好 **1.004** 越界 0.4%。
 *
 * 而**改相片尺寸不解决**：字号按 `min(画布宽高)/1200` 缩放，画布与相片同比，
 * 所以"墨迹 / 相片宽"这个比值与尺寸无关（试算 600×900 到 1900×2850 全是 1.004）。
 * 换句话说 **4:5 这个比例对 44 字长行就是装不下**，这是比例的固有性质。
 *
 * 改用 9:16 配竖图：墨迹占比降到 0.70，CI 下余量 11.6%，守的仍是
 * "竖档给竖图补足留白"这条路径（画布 1024×1820，与横图那条 1424×2532 完全不同，
 * 覆盖互补）。**教训：给视觉回归加场景时，新场景也要过"最长预设不越界"那条**——
 * 它是唯一会因宿主字体而失败的断言，本地绿不代表 CI 绿。
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
    note: '长机型名 + 长胶卷名：最宽的一行字，相片宽度与底边带都要容得下',
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
  {
    id: 'aspect-portrait-3-4',
    note: '固定外框 3:4（横图套竖档）：画布被撑高、左右只剩 112px，照片不裁',
    photo: { width: 1200, height: 800 },
    config: { matColor: '#F8F7F3', targetAspect: 3 / 4 },
  },
  {
    id: 'aspect-portrait-9-16',
    note: '固定外框 9:16（横图套最窄的竖档）：上下各撑到 770/962，底边带占画布高 38%',
    photo: { width: 1200, height: 800 },
    config: { matColor: '#F8F7F3', targetAspect: 9 / 16 },
  },
  {
    id: 'aspect-portrait-9-16-native',
    note: '固定外框 9:16 配竖图 800×1200：比例本就接近，底边带回到 18.9%',
    photo: { width: 800, height: 1200 },
    config: { matColor: '#F8F7F3', targetAspect: 9 / 16 },
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
