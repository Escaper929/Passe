import { describe, expect, it } from 'vitest';

import {
  analyzeSurface,
  hexToRgb,
  isLightSurface,
  MATBOARD_PRESETS,
  relativeLuminance,
} from '@/engine/palette';

describe('hexToRgb', () => {
  it('支持 6 位写法', () => {
    expect(hexToRgb('#F8F7F3')).toEqual({ r: 248, g: 247, b: 243 });
  });

  it('支持 3 位缩写与省略井号', () => {
    expect(hexToRgb('#FFF')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('1C1C1E')).toEqual({ r: 28, g: 28, b: 30 });
  });

  it('无法解析时抛错，不静默兜底', () => {
    expect(() => hexToRgb('#GGG')).toThrow();
    expect(() => hexToRgb('暖白')).toThrow();
  });
});

describe('relativeLuminance', () => {
  it('边界值正确', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1);
  });

  it('使用感知加权，而非通道均值', () => {
    // 纯绿在感知上远比纯蓝亮；(r+g+b)/3 会给出完全相同的错误答案
    expect(relativeLuminance('#00FF00')).toBeGreaterThan(relativeLuminance('#0000FF'));
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 3);
  });
});

describe('四种卡纸的明暗判定', () => {
  it('三种浅色卡纸判定为浅色，炭黑展厅判定为深色', () => {
    const byId = Object.fromEntries(MATBOARD_PRESETS.map((p) => [p.id, p.color]));
    expect(isLightSurface(byId['warm-white'])).toBe(true);
    expect(isLightSurface(byId['ivory'])).toBe(true);
    expect(isLightSurface(byId['cool-grey'])).toBe(true);
    expect(isLightSurface(byId['carbon'])).toBe(false);
  });

  it('炭黑展厅的亮度远低于浅色卡纸（说明必须走自适应分支）', () => {
    const carbon = relativeLuminance('#1C1C1E');
    const ivory = relativeLuminance('#F4F0E6');
    expect(carbon).toBeLessThan(0.02);
    expect(ivory / carbon).toBeGreaterThan(40);
  });
});

describe('analyzeSurface', () => {
  it('深色卡纸压低暗部纹理、加强反光', () => {
    const carbon = analyzeSurface('#1C1C1E');
    const ivory = analyzeSurface('#F4F0E6');

    expect(carbon.isLight).toBe(false);
    expect(carbon.shadowGain).toBeLessThan(ivory.shadowGain);
    expect(carbon.highlightGain).toBeGreaterThan(ivory.highlightGain);
    expect(carbon.bevelShadeGain).toBeLessThan(ivory.bevelShadeGain);
  });

  it('浅色卡纸保持原始增益（不改变开发指南 §3 的观感）', () => {
    const ivory = analyzeSurface('#F4F0E6');
    expect(ivory.shadowGain).toBe(1);
    expect(ivory.highlightGain).toBe(1);
    expect(ivory.bevelShadeGain).toBe(1);
  });
});
