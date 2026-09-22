/// <reference types="vite/client" />

/**
 * 版本号，由 `vite.config.ts` 的 `define` 在编译期注入，来源是 package.json。
 *
 * 这样顶栏那个"一眼看出线上跑的是哪一版"的标记就只有一处可改 ——
 * 硬编码的标记必然漂移（曾经挂着"阶段 4"而阶段 5 早已上线）。
 */
declare const __APP_VERSION__: string;
