import { describe, expect, it } from 'vitest';

import type { RenderSource } from '@/engine/types';

import { runBatchExport, type BatchJob, type BatchProgress } from './batchExport';
import type { ExportSink, SinkStart } from './exportSink';

/**
 * 批量编排的验证。
 *
 * 重点只有两个词：**串行**和**释放**。前者用"同时活着的位图数"来钉 ——
 * 顺手改成 Promise.all 峰值就会变成 2 甚至 3，而这在真实世界里意味着
 * 峰值内存等于批次总和，标签页直接崩。后者要求连**失败路径**都释放，
 * 因为出错的那条路正是几百 MB 泄漏最爱躲的地方。
 *
 * 四个 IO 动作全部注入，所以这里不需要浏览器、不需要画布，跑得飞快。
 */

function job(id: string, name = `${id}.tif`, filename = `Passe_${id}_2000px.jpg`): BatchJob {
  return {
    id,
    name,
    file: new File(['x'], name, { type: 'image/tiff' }),
    filename,
    maxDimension: 8192,
  };
}

interface Harness {
  alive: number;
  peakAlive: number;
  opened: string[];
  disposed: string[];
  events: string[];
  written: { filename: string; size: number }[];
  progress: BatchProgress[];
  begun: number;
  ended: number;
  /** 收尾是否发生在所有写入之后 */
  eventsAtEnd: string[];
}

function makeHarness(options: {
  /** 指定的张在 reopen 时抛错 */
  failReopen?: string;
  /** 指定的张在 render 时抛错 */
  failRender?: string;
  begin?: () => SinkStart | Promise<SinkStart>;
  /** write 返回的实际文件名换算是 */
  rename?: (filename: string) => string;
  cancelAfter?: number;
}): { harness: Harness; deps: Parameters<typeof runBatchExport>[1] } {
  const harness: Harness = {
    alive: 0,
    peakAlive: 0,
    opened: [],
    disposed: [],
    events: [],
    written: [],
    progress: [],
    begun: 0,
    ended: 0,
    eventsAtEnd: [],
  };

  const named = (source: RenderSource): string => (source as unknown as { name: string }).name;

  const sink: ExportSink = {
    label: '测试出口',
    async begin(): Promise<SinkStart> {
      harness.begun += 1;
      return options.begin ? options.begin() : { ok: true };
    },
    async write(blob, filename) {
      harness.written.push({ filename, size: blob.size });
      harness.events.push(`write:${filename}`);
      return options.rename ? options.rename(filename) : filename;
    },
    async end() {
      harness.ended += 1;
      harness.eventsAtEnd = [...harness.events];
    },
  };

  const deps = {
    async reopen(file: File): Promise<RenderSource> {
      if (options.failReopen === file.name) throw new Error(`${file.name} 解码失败`);
      harness.alive += 1;
      harness.peakAlive = Math.max(harness.peakAlive, harness.alive);
      harness.opened.push(file.name);
      harness.events.push(`open:${file.name}`);
      return { name: file.name } as unknown as RenderSource;
    },
    async render(source: RenderSource): Promise<Blob> {
      if (options.failRender === named(source)) throw new Error(`${named(source)} 渲染失败`);
      harness.events.push(`render:${named(source)}`);
      return new Blob(['rendered']);
    },
    dispose(source: RenderSource): void {
      harness.alive -= 1;
      harness.disposed.push(named(source));
      harness.events.push(`dispose:${named(source)}`);
    },
    sink,
    onProgress: (progress: BatchProgress) => {
      harness.progress.push(progress);
    },
    // 注意别写成真值判断：cancelAfter 为 0 表示"一张都别开"，那是有效配置
    shouldCancel:
      options.cancelAfter === undefined
        ? undefined
        : () => harness.written.length >= options.cancelAfter!,
  };

  return { harness, deps };
}

describe('runBatchExport · 正常路径', () => {
  it('逐张导出，每张都写盘', async () => {
    const jobs = [job('a'), job('b'), job('c')];
    const { harness, deps } = makeHarness({});

    const outcome = await runBatchExport(jobs, deps);

    expect(outcome.started).toBe(true);
    expect(outcome.exported.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(outcome.failed).toEqual([]);
    expect(outcome.cancelled).toBe(false);
    expect(harness.written.map((entry) => entry.filename)).toEqual([
      'Passe_a_2000px.jpg',
      'Passe_b_2000px.jpg',
      'Passe_c_2000px.jpg',
    ]);
  });

  it('任何时刻只有一张全分辨率位图活着 —— 改成并行就会在这里失败', async () => {
    const jobs = [job('a'), job('b'), job('c'), job('d')];
    const { harness, deps } = makeHarness({});

    await runBatchExport(jobs, deps);

    expect(harness.peakAlive).toBe(1);
    // 每张都是：重解 → 渲染 → 写盘 → 释放，四步不交叠
    expect(harness.events).toEqual([
      'open:a.tif',
      'render:a.tif',
      'write:Passe_a_2000px.jpg',
      'dispose:a.tif',
      'open:b.tif',
      'render:b.tif',
      'write:Passe_b_2000px.jpg',
      'dispose:b.tif',
      'open:c.tif',
      'render:c.tif',
      'write:Passe_c_2000px.jpg',
      'dispose:c.tif',
      'open:d.tif',
      'render:d.tif',
      'write:Passe_d_2000px.jpg',
      'dispose:d.tif',
    ]);
  });

  it('每张都被释放，结束时没有遗留', async () => {
    const jobs = [job('a'), job('b'), job('c')];
    const { harness, deps } = makeHarness({});

    await runBatchExport(jobs, deps);

    expect(harness.disposed).toHaveLength(3);
    expect(harness.alive).toBe(0);
  });

  it('进度走完最后一格，且中途报出正在处理的张', async () => {
    const jobs = [job('a'), job('b')];
    const { harness, deps } = makeHarness({});

    await runBatchExport(jobs, deps);

    expect(harness.progress[0]).toEqual({ done: 0, total: 2, current: 'a.tif' });
    expect(harness.progress[harness.progress.length - 1]).toEqual({
      done: 2,
      total: 2,
      current: null,
    });
  });

  it('落盘出口拿到收尾机会，且发生在本批结束之前', async () => {
    const { harness, deps } = makeHarness({});
    await runBatchExport([job('a')], deps);

    expect(harness.begun).toBe(1);
    expect(harness.ended).toBe(1);
    // 收尾时该写的都已经写完了 —— 否则关了目录句柄还在往里写
    expect(harness.eventsAtEnd).toContain('write:Passe_a_2000px.jpg');
  });

  it('汇总里用的是实际写入名 —— 避让了已有文件时名字会变', async () => {
    const { deps } = makeHarness({ rename: (filename) => filename.replace('.jpg', '-3.jpg') });

    const outcome = await runBatchExport([job('a')], deps);

    expect(outcome.exported[0].filename).toBe('Passe_a_2000px-3.jpg');
  });
});

describe('runBatchExport · 出错只跳过，不中断整批', () => {
  it('中间一张渲染失败，后面的照跑', async () => {
    const jobs = [job('a'), job('b'), job('c')];
    const { harness, deps } = makeHarness({ failRender: 'b.tif' });

    const outcome = await runBatchExport(jobs, deps);

    expect(outcome.exported.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(outcome.failed).toEqual([{ id: 'b', name: 'b.tif', reason: 'b.tif 渲染失败' }]);
    // 十张里有一张坏文件，不该让另外九张也导不出来
    expect(harness.written).toHaveLength(2);
  });

  it('失败的那张也必须释放 —— 出错路径正是泄漏爱躲的地方', async () => {
    const jobs = [job('a'), job('b'), job('c')];
    const { harness, deps } = makeHarness({ failRender: 'b.tif' });

    await runBatchExport(jobs, deps);

    expect(harness.disposed).toContain('b.tif');
    expect(harness.alive).toBe(0);
    expect(harness.peakAlive).toBe(1);
  });

  it('重解就失败的那张，没有东西可释放，但也不影响后面', async () => {
    const jobs = [job('a'), job('b'), job('c')];
    const { harness, deps } = makeHarness({ failReopen: 'b.tif' });

    const outcome = await runBatchExport(jobs, deps);

    expect(outcome.exported.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(outcome.failed[0].reason).toBe('b.tif 解码失败');
    expect(harness.disposed).toEqual(['a.tif', 'c.tif']);
    expect(harness.alive).toBe(0);
  });

  it('写盘失败也算这一张失败，不往上抛', async () => {
    const jobs = [job('a'), job('b')];
    const { harness, deps } = makeHarness({});
    const failing: typeof deps = {
      ...deps,
      sink: {
        ...deps.sink,
        write: async () => {
          throw new Error('磁盘已满');
        },
      },
    };

    const outcome = await runBatchExport(jobs, failing);

    expect(outcome.started).toBe(true);
    expect(outcome.failed.map((entry) => entry.reason)).toEqual(['磁盘已满', '磁盘已满']);
    // 写失败的那张同样是重解出来的，必须释放
    expect(harness.alive).toBe(0);
  });

  it('落盘出口的收尾失败不会把已经导出的事实抹掉', async () => {
    const jobs = [job('a')];
    const { harness, deps } = makeHarness({});
    const failing: typeof deps = {
      ...deps,
      sink: {
        ...deps.sink,
        end: async () => {
          throw new Error('句柄已失效');
        },
      },
    };

    const outcome = await runBatchExport(jobs, failing);

    expect(outcome.exported).toHaveLength(1);
    expect(harness.alive).toBe(0);
  });
});

describe('runBatchExport · 中断', () => {
  it('中断后不再开新的一张，已导出的仍然算数', async () => {
    const jobs = [job('a'), job('b'), job('c')];
    const { harness, deps } = makeHarness({ cancelAfter: 1 });

    const outcome = await runBatchExport(jobs, deps);

    expect(outcome.cancelled).toBe(true);
    expect(outcome.exported.map((entry) => entry.id)).toEqual(['a']);
    expect(harness.opened).toEqual(['a.tif']);
    // 中断也要把手里那张释放掉
    expect(harness.alive).toBe(0);
    expect(harness.ended).toBe(1);
  });

  it('第一张之前就被打断，则一张都不开', async () => {
    const { harness, deps } = makeHarness({ cancelAfter: 0 });
    // cancelAfter: 0 时 written.length >= 0 恒真，等于一开始就被打断

    const outcome = await runBatchExport([job('a'), job('b')], deps);

    expect(outcome.cancelled).toBe(true);
    expect(outcome.exported).toEqual([]);
    expect(harness.opened).toEqual([]);
    // 目录已经选好了，所以收尾还是要做
    expect(harness.ended).toBe(1);
  });
});

describe('runBatchExport · 准备阶段', () => {
  it('用户取消选目录时一张都不导，也不退回逐张下载', async () => {
    const { harness, deps } = makeHarness({
      begin: () => ({ ok: false, message: '已取消选择文件夹，本次没有导出。' }),
    });

    const outcome = await runBatchExport([job('a'), job('b')], deps);

    expect(outcome.started).toBe(false);
    expect(outcome.blockedReason).toBe('已取消选择文件夹，本次没有导出。');
    expect(harness.opened).toEqual([]);
    expect(harness.written).toEqual([]);
  });

  it('准备阶段抛错时如实报告，不装作开始过了', async () => {
    const { deps } = makeHarness({
      begin: () => {
        throw new Error('当前上下文不允许选择文件夹');
      },
    });

    const outcome = await runBatchExport([job('a')], deps);

    expect(outcome.started).toBe(false);
    expect(outcome.blockedReason).toBe('当前上下文不允许选择文件夹');
  });

  it('没有素材时直接说明，连目录都不问', async () => {
    const { harness, deps } = makeHarness({});

    const outcome = await runBatchExport([], deps);

    expect(outcome.started).toBe(false);
    expect(outcome.blockedReason).toBe('没有可导出的素材。');
    expect(harness.begun).toBe(0);
  });
});
