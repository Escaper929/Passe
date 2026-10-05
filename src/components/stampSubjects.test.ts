// 纯逻辑，不碰 DOM —— 刻意跑 node 环境省掉 jsdom 的建立开销（见 vite.config.ts）
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CAMERA_PRESETS, FILM_PRESETS, MAX_SUBJECT_LENGTH, longestOf } from './stampSubjects';

/**
 * 候选值列表的硬约束。
 *
 * 这些条目会被原样印在 8K 成品的钢印上，而且是**逐字居中**排出来的
 * （见 `drawTrackedText`）。所以"好不好看"之外还有几条能机械检查的红线：
 * 长度、字符集、大小写。加新条目时先在这里被拦下，比跑到渲染里看像素便宜。
 */
describe('钢印候选值 · 相机机型与胶卷', () => {
  const lists = [
    ['相机机型', CAMERA_PRESETS],
    ['胶卷', FILM_PRESETS],
  ] as const;

  it('两个列表都有内容，而且条目没有重复', () => {
    for (const [name, values] of lists) {
      expect(values.length, `${name}：列表是空的`).toBeGreaterThan(0);
      expect(new Set(values).size, `${name}：有条目重复`).toBe(values.length);
    }
  });

  it('一律大写、无首尾空格、无连续空格 —— 选什么就印什么', () => {
    for (const [name, values] of lists) {
      for (const value of values) {
        // drawDeboss 会 toUpperCase()，所以给大写才能保证"选的"与"印的"一致
        expect(value, `${name}：「${value}」不是大写`).toBe(value.toUpperCase());
        expect(value, `${name}：「${value}」有首尾空白`).toBe(value.trim());
        expect(value, `${name}：「${value}」有连续空格`).not.toMatch(/ {2,}/);
      }
    }
  });

  /**
   * 字符集是这一组里最要紧的一条。
   *
   * 钢印用的是 `Inter, -apple-system, BlinkMacSystemFont, sans-serif`，
   * 本机 macOS 落到 SF Pro、CI 的 ubuntu 上落到 DejaVu —— 字形宽度本来就不同。
   * 非 ASCII 字符（`μ`、`‰`、全角字母）会落到**第三套**回退字体上，
   * 宽度差异更大；而钢印是逐字居中的，宽度一变整行就平移。
   * 版面上那一行还被视觉回归的排除带保护着，但"看起来对不对"没人能自动判。
   * 所以直接限定：只收 ASCII 大写字母、数字与钢印上常见的几个标点。
   */
  it('只含能在任何平台稳定落字的 ASCII 字符', () => {
    const allowed = /^[A-Z0-9 .&-]+$/;
    for (const [name, values] of lists) {
      for (const value of values) {
        expect(value, `${name}：「${value}」含非 ASCII 或生僻标点`).toMatch(allowed);
      }
    }
  });

  it('单条长度不超过上限 —— 钢印是一行字，越界不会换行只会顶出卡纸', () => {
    for (const [name, values] of lists) {
      for (const value of values) {
        expect(
          value.length,
          `${name}：「${value}」${value.length} 字，超过上限 ${MAX_SUBJECT_LENGTH}`,
        ).toBeLessThanOrEqual(MAX_SUBJECT_LENGTH);
      }
    }
  });

  it('longestOf 取的是最长的那条', () => {
    expect(longestOf(['A', 'CCC', 'BB'])).toBe('CCC');
    expect(longestOf(CAMERA_PRESETS).length).toBe(
      Math.max(...CAMERA_PRESETS.map((value) => value.length)),
    );
    expect(longestOf(FILM_PRESETS).length).toBe(
      Math.max(...FILM_PRESETS.map((value) => value.length)),
    );
    // 空列表不能炸
    expect(longestOf([])).toBe('');
  });

  it('默认配置里的两个值都在列表内 —— 否则初始状态那两条不会高亮', () => {
    // 初始配方是 LEICA M6 / KODAK PORTRA 400（见 framingSettings.INITIAL_CONFIG）。
    // 它们不在列表里的话，界面一打开就是"一个都没选中"的样子。
    expect(CAMERA_PRESETS).toContain('LEICA M6');
    expect(FILM_PRESETS).toContain('KODAK PORTRA 400');
  });
});
