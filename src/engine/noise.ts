import type { Layout } from './layout';
import type { SurfaceTone } from './palette';

/**
 * 纯棉纸纤维微噪点（开发指南 §1 的"纸质颗粒"）。
 *
 * 相比开发指南 §3 的原始实现，这里修掉两个会让这一整层失效的问题：
 *
 * 1. **缓存忽略参数**。原实现用 `noiseTileCache` 做单例，但入参带了 intensity，
 *    于是第一次生成的强度被永久固化，之后调强度完全没反应。
 *    这里改为：瓦片本身不含强度信息（只生成一次，按极性分三种），
 *    强度通过 globalAlpha 施加 —— 缓存与参数彻底解耦。
 *
 * 2. **深色卡纸上看不见**。原实现把瓦片做成 128 中灰 + soft-light 叠加。
 *    soft-light 的公式在暗底上几乎不产生变化（底越暗，结果越贴近底色），
 *    所以炭黑展厅（#1C1C1E）上的纸纹会整层消失。
 *    这里默认改用 乘算(暗部纤维) + 滤色(亮部纤维) 双通道：两种叠加都作用于
 *    底色本身，浅色与深色卡纸都能读出纤维。原 soft-light 方案保留为可选项，
 *    材质验证台里可以实时对拍。
 */

const TILE_SIZE = 256;

/** 瓦片极性：决定噪声相对中性值的偏移方向。 */
export type FiberPolarity = 'shadow' | 'light' | 'neutral';

const tiles = new Map<FiberPolarity, HTMLCanvasElement>();

/** 三种极性各用一个固定种子，保证彼此不相关。 */
const FIBER_SEEDS: Record<FiberPolarity, number> = {
  shadow: 0x51ed2701,
  light: 0x2f9b3d05,
  neutral: 0x7a1f4c11,
};

/**
 * 坐标哈希 → [0, 1) 均匀值。
 *
 * **刻意不用 `Math.random()`**，理由有两条，都是硬需求：
 *
 * 1. **引擎要成为输入的纯函数。** 原来用 Math.random 生成瓦片，
 *    每次进程启动都换一片纤维，于是"同一张图重复导出"得到的是不同的成品。
 *    更致命的是视觉回归基线无从谈起 —— 基线比对的前提是同样的输入
 *    必须产出同样的像素，而随机瓦片让每次运行都不同。
 * 2. **跨机器一致。** 混淆全程用 `Math.imul` 做 32 位整数乘法，
 *    不经过浮点，因此在 macOS 本地与 CI 的 ubuntu 上跑出的是同一片噪声。
 *    基线才能既在本地守门、又在 CI 守门。
 *
 * 统计性质与原实现一致：独立均匀分布、无空间结构、平铺无接缝，
 * 因此"纸纹看起来是什么样"没有变化，只是从"每次不同"变成了"每次都一样"。
 */
function hash01(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d);
  h = (h + Math.imul(y | 0, 0x165667b1)) | 0;
  h = (h + seed) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * 取噪声瓦片（进程内单例，按极性缓存）。
 *
 * 瓦片是 256×256 的独立随机像素，不含任何空间结构，
 * 因此平铺时不会出现明显的接缝图案。
 *
 * **瓦片内容是确定的**：同极性每次生成的结果逐像素一致（清掉缓存重建也一样），
 * 所以"预览看到的纸纹"与"导出得到的纸纹"是同一片，跨运行也相同。
 */
export function getFiberTile(polarity: FiberPolarity): HTMLCanvasElement {
  const cached = tiles.get(polarity);
  if (cached) return cached;

  const tile = document.createElement('canvas');
  tile.width = TILE_SIZE;
  tile.height = TILE_SIZE;

  const ctx = tile.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 上下文：纸纹瓦片生成失败');

  const image = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const data = image.data;
  const seed = FIBER_SEEDS[polarity];

  for (let y = 0; y < TILE_SIZE; y += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const n = hash01(x, y, seed);
      let v: number;
      switch (polarity) {
        case 'shadow':
          // 以白为中性：只有压暗的斑点，配合 multiply
          v = 255 - n * 255;
          break;
        case 'light':
          // 以黑为中性：只有提亮的斑点，配合 screen
          v = n * 255;
          break;
        case 'neutral':
          // 以中灰为中性：双向扰动，配合 soft-light / overlay
          v = 128 + (n - 0.5) * 255;
          break;
      }
      const i = (y * TILE_SIZE + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  tiles.set(polarity, tile);
  return tile;
}

/** 纸纹叠加方式。 */
export type PaperTextureMode = 'multiply-screen' | 'soft-light';

/** 仅用于测试与验证台重建：清空瓦片缓存。 */
export function resetFiberTiles(): void {
  tiles.clear();
}

export interface PaperTextureOptions {
  /** 0.01 ~ 0.08 */
  intensity: number;
  /** 卡纸亮度分析结果 */
  surface: SurfaceTone;
  /** 叠加方式，默认双通道乘算 + 滤色 */
  mode?: PaperTextureMode;
}

/**
 * 把纸纹铺到卡纸上。
 *
 * 用 EvenOdd 环形剪裁挖空开窗区域，保证纸纹绝不污染相片画面（开发指南 §1）。
 */
export function applyPaperTexture(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  options: PaperTextureOptions,
): void {
  const { intensity, surface, mode = 'multiply-screen' } = options;
  if (intensity <= 0) return;

  const neutral = ctx.createPattern(getFiberTile('neutral'), 'repeat');
  if (!neutral) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, layout.canvasW, layout.canvasH);
  ctx.rect(layout.x, layout.y, layout.w, layout.h);
  ctx.clip('evenodd');

  if (mode === 'soft-light') {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = intensity;
    ctx.fillStyle = neutral;
    ctx.fillRect(0, 0, layout.canvasW, layout.canvasH);
    ctx.restore();
    return;
  }

  const shadow = ctx.createPattern(getFiberTile('shadow'), 'repeat');
  const light = ctx.createPattern(getFiberTile('light'), 'repeat');
  if (!shadow || !light) {
    ctx.restore();
    return;
  }

  // 暗部纤维：乘算叠加。浅色纸上清晰，深色纸上按 shadowGain 收敛
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = intensity * surface.shadowGain;
  ctx.fillStyle = shadow;
  ctx.fillRect(0, 0, layout.canvasW, layout.canvasH);

  // 亮部纤维：滤色叠加。深色纸上按 highlightGain 加强
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = intensity * 0.75 * surface.highlightGain;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, layout.canvasW, layout.canvasH);

  ctx.restore();
}
