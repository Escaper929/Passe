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
  },
});
