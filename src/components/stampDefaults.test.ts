// 纯逻辑，不碰 DOM —— 刻意跑 node 环境省掉 jsdom 的建立开销（见 vite.config.ts）
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { resolveConfig } from '@/engine/GalleryFramingEngine';
import { calculateLayout } from '@/engine/layout';
import { DEFAULT_STAMP_DEPTH, stampGeometry } from '@/engine/materials';

// 源码文本用 Vite 的 `?raw` 拿，**不要用 node:fs**。
// 这个测试住在 `src/components/` 下，归 tsconfig.app.json 管，那份配置的
// `types` 里只有浏览器与 vitest 的全局，`import 'node:fs'` 会直接编译不过。
// 项目里另一条路是"把用到 Node 内置模块的测试排除出 app 项目、并进
// tsconfig.visual.json"，但那是给真的需要文件系统的测试准备的
// （基线读写、拼图输出），这里只是要读两段文本，不值得动用。
import materialLabSource from '../lab/MaterialLab.tsx?raw';
import framingStudioSource from './FramingStudio.tsx?raw';

import { INITIAL_CONFIG } from './framingSettings';
import { BUILTIN_PRESETS } from './presets';

/**
 * 默认下压深度只允许有一处出处。
 *
 * 这里的动机不是洁癖。`1.2` 原先分别写在**五处**：引擎的 `DEFAULT_CONFIG`、
 * 界面的 `INITIAL_CONFIG`、出厂预设"博物馆标准"，以及两个界面里给滑杆用的
 * `?? 1.2` 兜底。而初始配方恰好与博物馆标准预设逐字段相同 ——
 * 于是"改默认值"这件事在代码里没有一个能改对的地方：
 * 改了引擎的，滑杆上显示的仍是旧值；两处一旦分叉，界面写着的数与画出来的数
 * 就不是一回事，而这种分叉平时看不出来（兜底值只在字段缺失时才生效）。
 *
 * 钢印放大 1.46 倍那一次顺手把五处并成一处，这组断言负责让它不再散开。
 */
describe('默认下压深度只有一处出处', () => {
  it('引擎默认、界面初始配方、博物馆标准预设三者一致', () => {
    // 引擎的兜底：不传 stampDepth 时渲染用的是这个数
    expect(resolveConfig({}).stampDepth).toBe(DEFAULT_STAMP_DEPTH);
    // 界面的初始状态
    expect(INITIAL_CONFIG.stampDepth).toBe(DEFAULT_STAMP_DEPTH);
    // 初始配方与"博物馆标准"是同一种样子，这一条是那个约定的守卫
    expect(BUILTIN_PRESETS[0].style.stampDepth).toBe(DEFAULT_STAMP_DEPTH);
  });

  it('几何计算默认也取这个常量，不另存一份', () => {
    const layout = calculateLayout(1200, 800, {
      marginRatio: 0.14,
      bottomWeight: 1.25,
      targetAspect: null,
    });

    // 不传 depth 与显式传 DEFAULT_STAMP_DEPTH 必须走出同一个位移
    expect(stampGeometry(layout).offset).toBe(stampGeometry(layout, DEFAULT_STAMP_DEPTH).offset);
    // 而默认值本身不是 0 或未定义 —— 滑杆的每一档都应当产生真的位移
    expect(stampGeometry(layout).offset).toBeGreaterThan(0.5);
  });

  it('两个界面里的滑杆兜底值也走同一个常量，没有写死的数字', () => {
    const files = {
      FramingStudio: framingStudioSource,
      MaterialLab: materialLabSource,
    };

    for (const [name, source] of Object.entries(files)) {
      // 兜底值写死是这条链里最难发现的一环 —— 它只在字段缺失时生效
      expect(source, `${name} 里还有写死的 stampDepth 兜底值`).not.toMatch(
        /stampDepth\s*\?\?\s*\d/,
      );
      // 同时确认扫描的是对的地方：这个常量确实被引用了
      expect(source, `${name} 没有引用 DEFAULT_STAMP_DEPTH`).toContain('DEFAULT_STAMP_DEPTH');
    }
  });
});
