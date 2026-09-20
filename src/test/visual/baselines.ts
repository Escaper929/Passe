import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FingerprintDiff, SceneFingerprint } from './fingerprint';
import { summarizeDiff } from './fingerprint';
import { encodePng } from './nativeCanvas';

/**
 * 基线的读写。
 *
 * ## 为什么基线必须入库、且只能显式重建
 *
 * 测试**绝不**自动写基线 —— 那样回归就退化成"把当前结果抄一遍"，
 * 任何改动都会自动通过，等于没有回归。重建只能由人跑 `npm run visual:update`。
 *
 * ## 文件格式
 *
 * 数字按"每行 12 个"折行，而不是 `JSON.stringify(..., 2)` 的一个数字一行。
 * 500 行的数组 diff 没人看得下去；折行后一次改动只影响少数几行，
 * `git diff` 里能直接看出"是哪个格、哪一列动了"。
 *
 * 手写序列化器的两类错误都由 `baselines.test.ts` 的往返用例兜底：
 * 结构错（尾逗号、漏逗号 → 根本不是合法 JSON）与数值精度契约（见 `QUANTUM_DECIMALS`）。
 * `writeBaseline` 落盘前还会再 parse 一次，防止坏基线被写进版本库。
 */

export const BASELINE_DIR = path.resolve(process.cwd(), 'src/test/baselines');

/** 失败时的诊断产物目录，不进版本库。 */
export const DIAGNOSTIC_DIR = path.resolve(process.cwd(), 'src/test/visual/__out__');

/** 人眼评审拼图，入库。 */
export const CONTACT_SHEET = path.join(BASELINE_DIR, 'contact-sheet.png');

/** 每行放几个数字。12 个 × 约 7 字符 ≈ 90 列，读起来不费劲。 */
const NUMBERS_PER_LINE = 12;

export type UpdateMode = 'all' | 'sheet' | null;

/**
 * `UPDATE_VISUAL` 的语义：
 * - `all`（或 `1`）：重写全部基线 JSON + 重出拼图
 * - `sheet`：只重出拼图，不动基线
 * - 未设置：正常比对
 */
export function updateMode(): UpdateMode {
  const raw = process.env.UPDATE_VISUAL;
  if (!raw || raw === '0' || raw === 'false') return null;
  return raw === 'sheet' ? 'sheet' : 'all';
}

export function baselinePath(sceneId: string): string {
  return path.join(BASELINE_DIR, `${sceneId}.json`);
}

/**
 * 基线里数字的量化步长（小数位）。**这是有意的有损存储**，不是随手 `toFixed`：
 *
 * - 意义：格值/探针值是亮度均值，真实取值是任意浮点（如 `33.411764705882355`）。
 *   原样存会让每行 18 字符、且每次重建都把每个数字都改一遍 —— 12 个一行的
 *   可读性就白设计了。量化到 0.1 后一行约 5 字符一值，`git diff` 能看出动的是哪一格。
 * - 代价可忽略：比对容差是 1.5~6 个亮度级，0.1 的量化误差比它小 15~60 倍，
 *   连容差的零头都算不上，不可能因此漏报或误报。
 *
 * 因此基线**不是**像素级的逐位存档，而是"容差尺度上的参考值"。
 * 往返测试按这个契约断言（结构全等 + 数值差 ≤ 半个步长），而不是逐位相等。
 */
const QUANTUM_DECIMALS = 1;

/**
 * 量化带来的最大往返误差（半个步长 = 0.05）。
 * 导出给往返测试用：测试按这个值断言"数值近似相等"，
 * 而不是自己写一个魔法数 —— 改步长时两边一起动。
 */
export const QUANTUM_HALF_STEP = 0.5 * 10 ** -QUANTUM_DECIMALS;

function quantize(value: number): string {
  return value.toFixed(QUANTUM_DECIMALS);
}

function emitNumbers(values: readonly (number | null)[], indent: string): string {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += NUMBERS_PER_LINE) {
    const row = values.slice(i, i + NUMBERS_PER_LINE).map((value, offset) => {
      if (value === null) return 'null';
      // `NaN` / `Infinity` 的 toFixed 结果是 `"NaN"` / `"Infinity"` —— 它们是
      // **非法 JSON**，会写出一个连 JSON.parse 都读不回来的基线文件。
      // 渲染出非有限亮度本身就说明引擎坏了，这里要点名报错，而不是让它
      // 退化成"基线损坏"这种查不出根因的症状。
      if (!Number.isFinite(value)) {
        throw new Error(
          `基线数值异常：第 ${i + offset} 项是 ${String(value)}，说明渲染结果不是有限数，拒绝写入基线`,
        );
      }
      return quantize(value);
    });
    lines.push(`${indent}  ${row.join(', ')}`);
  }
  return `[\n${lines.join(',\n')}\n${indent}]`;
}

export function serializeBaseline(fingerprint: SceneFingerprint): string {
  const lines: string[] = [];
  lines.push('{');
  lines.push(`  "scene": ${JSON.stringify(fingerprint.scene)},`);
  lines.push(`  "canvas": [${fingerprint.canvas[0]}, ${fingerprint.canvas[1]}],`);
  lines.push('  "grid": {');
  lines.push(`    "cols": ${fingerprint.grid.cols},`);
  lines.push(`    "rows": ${fingerprint.grid.rows},`);
  // `cells` 是 grid 里的最后一个键 —— 这里**不能**带逗号。
  // 手写序列化器的经典死法就是给最后一个成员也补上逗号（JSON 不允许尾逗号）。
  lines.push(`    "cells": ${emitNumbers(fingerprint.grid.cells, '    ')}`);
  lines.push('  },');

  const ids = Object.keys(fingerprint.profiles).sort();
  lines.push('  "profiles": {');
  ids.forEach((id, index) => {
    const comma = index === ids.length - 1 ? '' : ',';
    lines.push(
      `    ${JSON.stringify(id)}: ${emitNumbers(fingerprint.profiles[id], '    ')}${comma}`,
    );
  });
  lines.push('  }');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export function parseBaseline(raw: string): SceneFingerprint {
  const parsed = JSON.parse(raw) as SceneFingerprint;
  if (typeof parsed.scene !== 'string' || !Array.isArray(parsed.grid?.cells)) {
    throw new Error('基线文件结构不对：缺少 scene 或 grid.cells');
  }
  return parsed;
}

export function writeBaseline(fingerprint: SceneFingerprint): string {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const file = baselinePath(fingerprint.scene);
  const text = serializeBaseline(fingerprint);

  // 落盘前自检。这条看似多余的 `JSON.parse` 挡的是一种很难查的坏结果：
  // 基线一旦写成非法 JSON，回归测试会**每次**都在读基线时抛错，
  // 或者（更糟）在调用方吞掉异常时表现为"所有场景全都不一致"。
  // 重建基线是人工动作，多花 1ms 换"坏在眼前而不是坏在下次 CI"。
  parseBaseline(text);

  writeFileSync(file, text, 'utf8');
  return file;
}

export function readBaseline(sceneId: string): SceneFingerprint | null {
  const file = baselinePath(sceneId);
  if (!existsSync(file)) return null;
  return parseBaseline(readFileSync(file, 'utf8'));
}

export function baselineExists(sceneId: string): boolean {
  return existsSync(baselinePath(sceneId));
}

/**
 * 失败时落盘诊断产物并返回路径。
 *
 * 写不出来也不算失败：诊断只是为了让人少猜，不能让它自己变成噪声源。
 */
export function writeDiagnostics(
  sceneId: string,
  canvas: HTMLCanvasElement,
  diff: FingerprintDiff,
): string[] {
  const written: string[] = [];
  try {
    mkdirSync(DIAGNOSTIC_DIR, { recursive: true });

    const png = encodePng(canvas);
    if (png) {
      const file = path.join(DIAGNOSTIC_DIR, `${sceneId}.actual.png`);
      writeFileSync(file, png);
      written.push(file);
    }

    const report = path.join(DIAGNOSTIC_DIR, `${sceneId}.diff.txt`);
    writeFileSync(report, formatDiagnosticReport(sceneId, diff), 'utf8');
    written.push(report);
  } catch {
    // 忽略：诊断失败不该影响回归结论
  }
  return written;
}

function formatDiagnosticReport(sceneId: string, diff: FingerprintDiff): string {
  const lines: string[] = [
    `场景：${sceneId}`,
    `比对点：${diff.comparedPoints}（另有 ${diff.skippedCells} 个网格被钢印文字带排除）`,
    summarizeDiff(diff),
    '',
    '不通过原因：',
    ...diff.reasons.map((reason) => `  · ${reason}`),
    '',
    `全部越界点（${diff.mismatches.length} 个，按偏差从大到小）：`,
    ...diff.mismatches.map(
      (item) =>
        `  · ${item.part}[${item.index}] ${item.where}\n` +
        `      基线 ${item.baseline.toFixed(1)} → 实际 ${item.actual.toFixed(1)}（偏 ${item.delta.toFixed(1)}）`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
