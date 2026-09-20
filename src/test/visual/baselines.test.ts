import { afterEach, describe, expect, it } from 'vitest';

import { QUANTUM_HALF_STEP, parseBaseline, serializeBaseline, updateMode } from './baselines';
import { PROFILE_SAMPLES, type SceneFingerprint } from './fingerprint';

/**
 * 基线文件的读写往返。
 *
 * 基线格式是自己拼的（数字每行 12 个折行，比"一个数字一行"好读得多），
 * 所以必须有往返用例兜底。手写序列化器的经典死法：
 *
 * 1. **尾逗号 / 漏逗号** —— 写出来的根本不是合法 JSON。真发生过：
 *    `"cells"` 是 grid 的最后一个键，却被补了逗号，于是 `],` 紧跟 `},`，
 *    10 份基线一起坏掉。这种坏法很阴：回归测试读基线时直接抛错，
 *    或（更糟）在吞掉异常时表现为"所有场景全都不一致"。
 * 2. **`null` 被写成字符串 `"null"`** —— 被钢印文字带排除的格子会变成 NaN 参与统计。
 * 3. **非有限数** —— `toFixed` 把 `NaN` 变成字面量 `NaN`，同样是非法 JSON。
 *
 * 数值上，序列化器**有意**量化到 0.1（见 `baselines.ts` 的 `QUANTUM_DECIMALS`）：
 * 量化误差 0.05 比比对容差小两个数量级，换来 diff 可读。
 * 所以往返契约是"结构全等 + 数值差不超过半个步长"，而非逐位相等。
 */

function sampleFingerprint(): SceneFingerprint {
  const cells: (number | null)[] = [];
  for (let i = 0; i < 16 * 16; i += 1) {
    cells.push(i % 7 === 0 ? null : 200 + (i % 40) / 10);
  }
  return {
    scene: 'unit-sample',
    canvas: [1536, 1178],
    grid: { cols: 16, rows: 16, cells },
    profiles: {
      'edge-left': Array.from({ length: PROFILE_SAMPLES }, (_, i) => 250 - i),
      'edge-top': Array.from({ length: PROFILE_SAMPLES }, () => 128),
      'edge-bottom': Array.from({ length: PROFILE_SAMPLES }, (_, i) => i / 3),
      'edge-right': Array.from({ length: PROFILE_SAMPLES }, (_, i) => (i % 5) * 12.5),
    },
  };
}

/**
 * 按契约比较两组数：`null` 必须逐位对齐（位置错了就是真的错），
 * 数值允许半个量化步长的误差，且要避开 `toFixed` 的十进制舍入边界
 * （0.05 的余量会把恰好落在 .x5 的值推过界，这里按 1.5 倍放宽只用于边界项）。
 */
function expectNumbersClose(
  actual: readonly (number | null)[],
  expected: readonly (number | null)[],
  where: string,
): void {
  expect(actual.length, `${where} 长度`).toBe(expected.length);
  actual.forEach((value, index) => {
    const want = expected[index];
    if (want === null) {
      expect(value, `${where}[${index}] 应为 null`).toBeNull();
      return;
    }
    expect(value, `${where}[${index}] 不该是 null`).not.toBeNull();
    expect(
      Math.abs((value as number) - want),
      `${where}[${index}]：${String(value)} vs ${want}`,
    ).toBeLessThanOrEqual(QUANTUM_HALF_STEP + 1e-9);
  });
}

describe('基线序列化', () => {
  it('往返后结构与数值都符合契约（结构全等、数值差 ≤ 半个量化步长）', () => {
    const original = sampleFingerprint();
    const parsed = parseBaseline(serializeBaseline(original));

    expect(parsed.scene).toBe(original.scene);
    expect(parsed.canvas).toEqual(original.canvas);
    expect(parsed.grid.cols).toBe(original.grid.cols);
    expect(parsed.grid.rows).toBe(original.grid.rows);

    expectNumbersClose(parsed.grid.cells, original.grid.cells, 'grid.cells');

    expect(Object.keys(parsed.profiles).sort()).toEqual(Object.keys(original.profiles).sort());
    for (const id of Object.keys(original.profiles)) {
      expectNumbersClose(parsed.profiles[id], original.profiles[id], id);
    }
  });

  it('确实做了量化（基线只留一位小数，diff 才不会每次重建都全红）', () => {
    const text = serializeBaseline(sampleFingerprint());
    // edge-bottom 的 i / 3 会产生 12.333333333333334 这类长小数。
    expect(text).toContain('12.3');
    expect(text).not.toContain('12.333333333333334');

    // 量化只允许落在半步长内 —— 若有人把步长调大（比如 0 位小数），
    // 上面那条"结构全等"的断言仍旧过，但这里的误差断言会立刻拦住。
    const parsed = parseBaseline(text);
    const worst = Math.max(
      ...parsed.profiles['edge-bottom'].map((value, index) => Math.abs((value ?? 0) - index / 3)),
    );
    expect(worst).toBeLessThanOrEqual(QUANTUM_HALF_STEP + 1e-9);
  });

  it('被排除的格子（null）能正确往返，不会被写成字符串', () => {
    const original = sampleFingerprint();
    const text = serializeBaseline(original);
    expect(text).toContain('null');
    expect(text).not.toContain('"null"');

    const parsed = parseBaseline(text);
    expect(parsed.grid.cells.filter((cell) => cell === null).length).toBe(
      original.grid.cells.filter((cell) => cell === null).length,
    );
    // 位置也必须对上 —— 只数个数会漏掉"null 整体错位"这种错。
    expect(parsed.grid.cells.map((cell) => cell === null)).toEqual(
      original.grid.cells.map((cell) => cell === null),
    );
  });

  it('数字折行但仍是合法 JSON，且每行不超过约定的个数', () => {
    const text = serializeBaseline(sampleFingerprint());
    expect(() => JSON.parse(text)).not.toThrow();

    const dataLines = text
      .split('\n')
      .filter((line) => /^\s+-?\d/.test(line))
      .map((line) => line.trim().replace(/,$/, '').split(',').length);
    expect(dataLines.length).toBeGreaterThan(0);
    for (const count of dataLines) {
      expect(count).toBeLessThanOrEqual(12);
    }
  });

  it('非有限数会点名报错，而不是写出一个读不回来的基线', () => {
    const broken = sampleFingerprint();
    broken.grid.cells[7] = Number.NaN;
    expect(() => serializeBaseline(broken)).toThrow(/第 7 项/);
    expect(() => serializeBaseline(broken)).toThrow(/拒绝写入基线/);
  });

  it('结构不对的文件会明确报错，而不是让比对拿到半个对象', () => {
    expect(() => parseBaseline('{"scene":"x"}')).toThrow(/grid\.cells/);
  });
});

describe('UPDATE_VISUAL 语义', () => {
  const original = process.env.UPDATE_VISUAL;

  afterEach(() => {
    if (original === undefined) delete process.env.UPDATE_VISUAL;
    else process.env.UPDATE_VISUAL = original;
  });

  it('未设置或关闭时为 null（正常比对）', () => {
    delete process.env.UPDATE_VISUAL;
    expect(updateMode()).toBeNull();
    process.env.UPDATE_VISUAL = '0';
    expect(updateMode()).toBeNull();
    process.env.UPDATE_VISUAL = 'false';
    expect(updateMode()).toBeNull();
  });

  it('all 重写基线，sheet 只重出拼图', () => {
    process.env.UPDATE_VISUAL = 'all';
    expect(updateMode()).toBe('all');
    process.env.UPDATE_VISUAL = 'sheet';
    expect(updateMode()).toBe('sheet');
  });

  it('其他非空值当 all 处理（兼容 UPDATE_VISUAL=1）', () => {
    process.env.UPDATE_VISUAL = '1';
    expect(updateMode()).toBe('all');
  });
});
