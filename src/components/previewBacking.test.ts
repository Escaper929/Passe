import { describe, expect, it } from 'vitest';

import { MATBOARD_PRESETS } from '@/engine/palette';

import {
  contrastRatio,
  DARK_BACKING,
  LIGHT_BACKING,
  MIN_BACKING_CONTRAST,
  previewBacking,
} from './previewBacking';

describe('预览背板 · 对比度计算', () => {
  it('同色的对比度是 1', () => {
    expect(contrastRatio('#808080', '#808080')).toBeCloseTo(1, 6);
  });

  it('黑白对比度是 21（WCAG 的理论上限）', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
  });

  it('与参数顺序无关', () => {
    expect(contrastRatio('#F8F7F3', '#18181A')).toBeCloseTo(
      contrastRatio('#18181A', '#F8F7F3'),
      10,
    );
  });
});

describe('预览背板 · 跟随卡纸亮度翻转', () => {
  it('浅色卡纸配深背板 —— 这是深色工作台的默认情形', () => {
    for (const preset of MATBOARD_PRESETS.filter((p) => p.id !== 'carbon')) {
      const backing = previewBacking(preset.color);
      expect(backing.background).toBe(DARK_BACKING);
      expect(backing.inverted).toBe(false);
    }
  });

  it('炭黑卡纸翻转为浅背板 —— 否则成品边界会整个消失', () => {
    const carbon = MATBOARD_PRESETS.find((p) => p.id === 'carbon');
    const backing = previewBacking(carbon!.color);

    expect(backing.background).toBe(LIGHT_BACKING);
    expect(backing.inverted).toBe(true);
    // 炭黑配深背板几乎完全看不见，这正是要修的问题
    expect(contrastRatio(carbon!.color, DARK_BACKING)).toBeLessThan(1.2);
    expect(backing.contrast).toBeGreaterThan(10);
  });

  it('四种预设卡纸选出的背板都有足够对比度', () => {
    for (const preset of MATBOARD_PRESETS) {
      expect(previewBacking(preset.color).contrast).toBeGreaterThanOrEqual(MIN_BACKING_CONTRAST);
    }
  });

  it('描边颜色与背板明暗相反，始终能起一线分隔', () => {
    const light = previewBacking('#F8F7F3');
    const dark = previewBacking('#1C1C1E');
    expect(light.outline).toContain('255');
    expect(dark.outline).toContain('0, 0, 0');
  });
});

describe('预览背板 · 对比度下界是自动成立的', () => {
  it('扫描整条灰阶，最坏情形仍有约 3.75:1', () => {
    // 这条不变量决定了描边可以无条件渲染，而不必去判断"这次够不够分明"。
    // 最坏情形出现在卡纸亮度约为两种背板亮度的几何中点时。
    let worst = Number.POSITIVE_INFINITY;
    let worstLevel = 0;

    for (let level = 0; level <= 255; level += 1) {
      const hex = `#${level.toString(16).padStart(2, '0').repeat(3)}`;
      const { contrast } = previewBacking(hex);
      if (contrast < worst) {
        worst = contrast;
        worstLevel = level;
      }
    }

    expect(worst).toBeGreaterThanOrEqual(MIN_BACKING_CONTRAST);
    expect(worst).toBeGreaterThan(3.5);
    // 记录下界出现的位置，将来调背板颜色时能立刻看出偏移
    expect(worstLevel).toBeGreaterThan(100);
    expect(worstLevel).toBeLessThan(160);
  });

  it('对任何一个卡纸色都不抛错', () => {
    for (const color of ['#000000', '#FFFFFF', '#7F7F7F', '#f0f', '#123456']) {
      expect(() => previewBacking(color)).not.toThrow();
    }
  });
});
