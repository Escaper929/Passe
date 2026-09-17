/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages 项目站点位于 /Passe/ 子路径下。必须显式声明 base，
  // 否则构建产物里的资源会以根路径请求而全部 404。
  base: '/Passe/',
  plugins: [react(), tailwindcss()],
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
