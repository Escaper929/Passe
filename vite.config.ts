/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 版本号的**唯一来源**就是 package.json。
 *
 * 界面顶栏要挂一个"一眼看出线上跑的是哪一版"的标记。之前那处硬编码成了
 * "阶段 4"，而阶段 5 与 v1.2 都上线之后它还挂着 —— 标记一旦硬编码就必然漂移。
 * 所以这里把它注入成编译期常量，让"改版本号"这件事只有一处可改。
 *
 * 用 `node:fs` 读而不是 `import pkg from './package.json'`：后者需要
 * `resolveJsonModule`，而那份 tsconfig 是给浏览器侧用的，不该为这点事放宽。
 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  // GitHub Pages 项目站点位于 /Passe/ 子路径下。必须显式声明 base，
  // 否则构建产物里的资源会以根路径请求而全部 404。
  base: '/Passe/',
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    // 装裱引擎要处理 8K 级画布，体积警告阈值放宽，避免噪音
    chunkSizeWarningLimit: 1200,
  },
  test: {
    /**
     * 默认环境是 jsdom，但**大部分测试文件并不需要它**。
     *
     * 代价曾经大到离谱：全量串行跑 273s，其中 `jsdom was created 25 times ·
     * 224.84s total, 87% of tracked time` —— 25 个文件各建一次环境，
     * 而 jsdom 单次建立约 9s。那些文件验的全是算术（外框比例、批量计划、
     * 导出格式、内存预算），一眼 DOM 都不碰，却白付了 87% 的时间。
     *
     * 做法是让文件**逐个自己声明**：不碰 DOM 的在文件头加一行
     * `// @vitest-environment node`。默认仍是 jsdom，所以新写的测试文件
     * 忘了声明也只是慢，不会因为缺 `document` 而炸 —— 失败方向要朝"慢"，
     * 不能朝"误报"。
     *
     * 注意**别按扩展名分流**（`.ts` 走 node、`.tsx` 走 jsdom）：大量 `.ts`
     * 测试确实要用 `document`（`render.test.ts` 直接 spy `createElement`、
     * `presets.test.ts` 读写 localStorage），按后缀切会整片报错。
     *
     * 判据是**这个文件里有没有直接出现 `document` / `window`**，
     * 不是"它测什么"。反例有两个，都是我先判错、跑挂了才改回来的：
     * `visualRegression.test.ts` 跑真实像素渲染、`scaleInvariance.test.ts`
     * 跑尺度不变性，但两者都要 DOM —— 前者在 `beforeAll` 里调
     * `installNativeCanvas()`，那函数 spy 的正是 `Document.prototype.createElement`。
     * 反过来 `queue.test.ts` 只把 `HTMLCanvasElement` 当**类型**用在断言签名里，
     * 运行期完全不碰 DOM，这种才适合走 node。
     */
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    /**
     * 默认的 5s 对做**真实画布渲染**的用例偏紧。
     *
     * CI 只有 2 个 vCPU，而 vitest 会并行跑各个测试文件：一次 4MP 渲染加 JPEG 编码
     * 要和别的 worker 抢 CPU，比本机慢好几倍。曾经有导出用例在 CI 上刚好卡在预算边缘
     * 而偶发失败 —— 它等的是一个其实正在正常完成的导出。
     *
     * 放宽到 20s 不会拖慢正常的运行：等待条件一旦成立就立刻返回，
     * 而 waitFor 自己有 5s 的墙钟预算，真卡住时先报出来的是它那条更具体的错。
     */
    testTimeout: 20_000,
    /**
     * 固定串行，别让 vitest 按 CPU 数自己决定。
     *
     * 这台机器有 12 核，默认并行会开满 worker，而每个 worker 都要建一份环境
     * （画布测试那几份是真渲染 + 编码，很吃内存）。结果是 worker 抢不到资源、
     * 来不及响应，runner 报 `[vitest-pool-runner]: Timeout waiting for worker`。
     *
     * **这种报错最坏的地方在于它长得像测试失败**：
     * 报错带 `Errors 10 errors`，但错误落在 runner 层而不是任何一个 `it` 上，
     * 而且跑完的用例数远少于总数（`Tests 210 passed` 而不是 403）——
     * 也就是"看起来红了一大片"，其实是一个字都没测。差点据此去改生产代码。
     *
     * 串行的另一笔账是划算的：环境开销降下来之后（见上面的 environment 说明），
     * 串行 137s，而并行那次跑不满 25 个文件就 70s 报错了。
     * 真要跑快点可以临时 `--no-file-parallelism` 之外再加 `--maxWorkers=N` 试，
     * 但**判断"有没有搞坏东西"一律以串行为准**。
     *
     * `--poolOptions` 在 vitest 5 的 CLI 上不认（`CACError: Unknown option`），
     * 降并发的 flag 只有这两个，所以它们只能写在这里、不能写进 npm script 的命令行。
     */
    fileParallelism: false,
    maxWorkers: 1,
  },
});
