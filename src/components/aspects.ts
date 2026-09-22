/**
 * 成品外框比例档。**调校台与材质验证台的构图行共用这一份。**
 *
 * ## 为什么数字输出要补竖屏
 *
 * 发到屏幕上时真正决定"好不好看"的是**比例**，不是像素数 ——
 * 小红书、Instagram、Story、手机壁纸吃的都是比例。而在这之前界面上
 * 只有 自适应 / 4:3 / 5:4 / 1:1，**一个竖屏档都选不到**。
 *
 * 值得注意的是：**引擎其实早就支持竖屏**。`targetAspect` 的定义是「宽 / 高」，
 * `calculateLayout` 只要求它是正数，`layout.test.ts` 里一直有 `targetAspect: 3/4`
 * 的用例在跑，预设的校验也只要求 `> 0`。所以这一版不是"加功能"，
 * 是**把引擎已经能做的事接到界面上** —— 零引擎改动。
 *
 * ## 为什么绝不该有第二份
 *
 * 这份清单从前在 `FramingStudio.tsx` 与 `lab/MaterialLab.tsx` 里各写了一遍
 * （内容当时还一致）。加档的时候就会分叉，而分叉的后果不是"少一个选项"，
 * 是**同一张图在两台机器上算出不同的外框** —— 用户会以为其中一台坏了。
 */

import type { ChoiceOption } from './controls';

/**
 * 比例档。
 *
 * `hint` 在这里被收成**必填**（`ChoiceOption` 里它是可选的）：
 * 面板上只显示得下 "4 : 3" 这种短标签，看完也不知道是干嘛用的，
 * 说明全靠悬浮提示。收成必填，调用点就没有机会把它丢了。
 */
export interface AspectOption extends ChoiceOption<number | null> {
  hint: string;
}

/**
 * 顺序是刻意排的：先"不约束"，再横向，再方形，最后竖屏。
 *
 * 4 列网格下正好断成两行 —— 第一行是"原样与横向"，第二行是"竖向"，
 * 不用额外分组标题也读得出来。
 */
export const ASPECT_OPTIONS: readonly AspectOption[] = [
  { value: null, label: '自适应', hint: '按照片自身的比例，不额外约束外框' },
  { value: 4 / 3, label: '4 : 3', hint: '横向，最常见的胶片与相机画幅' },
  { value: 5 / 4, label: '5 : 4', hint: '横向，接近大画幅 4×5 的比例' },
  { value: 1, label: '1 : 1', hint: '方形，适合网格排布的相册' },
  { value: 3 / 4, label: '3 : 4', hint: '竖图，小红书与手机竖屏常用' },
  { value: 4 / 5, label: '4 : 5', hint: '竖图，Instagram 竖版常用' },
  {
    value: 9 / 16,
    label: '9 : 16',
    hint: '竖屏壁纸与 Story。留白最宽，钢印也离照片最远',
  },
];
