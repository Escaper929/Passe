import { describe, expect, it } from 'vitest';

import { calculateLayout } from '@/engine/layout';

import { ASPECT_OPTIONS } from './aspects';

const CONFIG = { marginRatio: 0.14, bottomWeight: 1.25 };
const baseMargin = (w: number, h: number): number => Math.min(w, h) * CONFIG.marginRatio;

/**
 * 两个方向的照片都要试。
 *
 * 竖屏档最该防的错是"只对横向照片成立" —— 而这件事光看某一个方向发现不了：
 * `calculateLayout` 在比例分支里要取「两个方向都不低于基准边距」的尺寸下限，
 * 哪个方向先撞到下限，取决于照片本身是横是竖。
 */
const PHOTOS = [
  { name: '横向 3:2', w: 3000, h: 2000 },
  { name: '竖向 2:3', w: 2000, h: 3000 },
] as const;

/**
 * 画框比例档。
 *
 * 这一档的存在理由是"把引擎已经能做、但界面上选不到的事接出来"：
 * `targetAspect` 的定义是「宽 / 高」，只要求为正数，所以 0.75 这种竖屏值
 * 本来就是合法的。这里是**入口那一侧**的保证 —— 每个档都能真的算出那个比例，
 * 且不会把边距压到低于基准。
 */
describe('画框比例档', () => {
  it('每个比例都能真的算出那个比例的外框（误差 1px 内）', () => {
    for (const option of ASPECT_OPTIONS) {
      if (option.value === null) continue;
      for (const photo of PHOTOS) {
        const layout = calculateLayout(photo.w, photo.h, {
          ...CONFIG,
          targetAspect: option.value,
        });
        const actual = layout.canvasW / layout.canvasH;
        expect(Math.abs(actual - option.value), `${photo.name} × ${option.label}`).toBeLessThan(
          1e-3,
        );
      }
    }
  });

  it('三个竖屏档真的产出竖的外框，横向档也真的产出横的', () => {
    // 光看 label 写着 "3 : 4" 说明不了什么 —— 值写成 4/3 也一样能通过上面的比例断言
    const portrait = [3 / 4, 4 / 5, 9 / 16];
    const landscape = [4 / 3, 5 / 4];

    for (const aspect of portrait) {
      const layout = calculateLayout(3000, 2000, { ...CONFIG, targetAspect: aspect });
      expect(layout.canvasH).toBeGreaterThan(layout.canvasW);
    }
    for (const aspect of landscape) {
      const layout = calculateLayout(3000, 2000, { ...CONFIG, targetAspect: aspect });
      expect(layout.canvasW).toBeGreaterThan(layout.canvasH);
    }
  });

  it('竖屏档下四边边距都不低于基准 —— 照片不会被挤出画布', () => {
    for (const option of ASPECT_OPTIONS) {
      // 自适应不走比例分支，基准边距由它自己的分支保证
      if (option.value === null) continue;
      for (const photo of PHOTOS) {
        const layout = calculateLayout(photo.w, photo.h, {
          ...CONFIG,
          targetAspect: option.value,
        });
        const base = Math.floor(baseMargin(photo.w, photo.h));
        const where = `${photo.name} × ${option.label}`;
        expect(layout.marginLeft, where).toBeGreaterThanOrEqual(base);
        expect(layout.marginRight, where).toBeGreaterThanOrEqual(base);
        expect(layout.marginTop, where).toBeGreaterThanOrEqual(base);
        expect(layout.marginBottom, where).toBeGreaterThanOrEqual(base);
      }
    }
  });

  it('底边加权在竖屏下同样成立', () => {
    // 装裱语义不该因为外框转了方向就变
    for (const option of ASPECT_OPTIONS) {
      if (option.value === null) continue;
      const layout = calculateLayout(3000, 2000, { ...CONFIG, targetAspect: option.value });
      expect(layout.marginBottom, option.label).toBeGreaterThan(layout.marginTop);
    }
  });

  it('value 互不重复，且只有"自适应"是 null', () => {
    const values = ASPECT_OPTIONS.map((option) => option.value);
    const nulls = values.filter((value) => value === null);
    expect(nulls).toHaveLength(1);
    // null 是"不做约束"的哨兵值，重复的 null 会让两个档位互相抢选中态
    expect(new Set(values.filter((value) => value !== null)).size).toBe(
      values.filter((value) => value !== null).length,
    );
  });

  it('每档都带 label 与 hint —— hint 是唯一的说明来源', () => {
    // 从前两处调用点各自 map 时把 hint 丢掉了，面板上就只剩下"4 : 3"这种
    // 看不出来干嘛用的标签。断在数据上，调用点就再也没机会丢。
    for (const option of ASPECT_OPTIONS) {
      expect(option.label.length, String(option.value)).toBeGreaterThan(0);
      expect(option.hint.length, option.label).toBeGreaterThan(0);
    }
  });

  it('9:16 是二进制精确值，不需要浮点补偿', () => {
    // 与印刷档那个 25.4 的坑对照着记一笔：分母是 2 的幂时没有误差可补
    expect(9 / 16).toBe(0.5625);
    expect(ASPECT_OPTIONS.find((option) => option.label === '9 : 16')?.value).toBe(0.5625);
  });

  it('竖屏确实把底边留白撑宽了 —— 这是已接受的取舍，不是待修的缺陷', () => {
    // 钢印位置是「照片底边 + 底边留白 × 0.36」，所以留白一宽，钢印就会离照片更远。
    // 2026-09-22 已与用户确认：先接受，看真实效果再决定要不要改成按自身尺寸锚定。
    // 这条用例把"变宽了多少"钉住 —— 将来有人动它时会先在这里看到这个事实。
    const auto = calculateLayout(3000, 2000, { ...CONFIG, targetAspect: null });
    const story = calculateLayout(3000, 2000, { ...CONFIG, targetAspect: 9 / 16 });

    expect(story.marginBottom).toBeGreaterThan(auto.marginBottom * 3);
  });
});
