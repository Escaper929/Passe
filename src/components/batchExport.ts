/**
 * 批量导出的编排。
 *
 * 整批导出最容易写错的地方是内存：顺手写成 `Promise.all` 会让峰值等于批次总和，
 * 十几张 8K 扫描件足以把标签页打死，而用户等了几分钟才看到它崩。所以这里是
 * **串行**的 —— 一张渲染完、写盘、释放，才轮到下一张。峰值就是单张的最大值。
 *
 * 另外三条：
 * - 单张失败只跳过。十张里有一张坏文件，不该让另外九张也导不出来。
 * - 失败的那张也必须释放。出错路径正是内存泄漏最喜欢躲的地方。
 * - 中断在**每张开始前**检查。一旦开始渲染就无法中途叫停（画布合成是同步的），
 *   所以正在跑的那张会跑完 —— 这是诚实的做法，不是缺陷。
 *
 * 四个会碰外部世界的动作（重解、渲染、释放、写盘）全部从外面注入，
 * 于是这套编排可以在没有浏览器、没有画布的情况下被完整验证。
 */

import type { RenderSource } from '@/engine/types';

import type { ExportMimeType } from './exportFormat';
import type { ExportSink, SinkStart } from './exportSink';

export interface BatchJob {
  id: string;
  /** 汇总里展示的名字 */
  name: string;
  file: File;
  /** 计划写入的文件名 */
  filename: string;
  /** 传给引擎的长边上限；null 表示不降采样 */
  maxDimension: number | null;
  /**
   * 编码 MIME 与质量，**随任务一起走**。
   *
   * 不放在 `render` 的闭包里读界面状态：文件名（含扩展名）是随任务一起定下的，
   * 编码参数若另从一处读，两者就有了各自变化的可能。放在同一个对象里，
   * "文件名说 .png 而实际编出 .jpg"在结构上就不可能发生。
   */
  mimeType: ExportMimeType;
  /** 无损格式为 null（该格式没有质量这一说） */
  quality: number | null;
}

export interface BatchProgress {
  /** 已完成张数 */
  done: number;
  total: number;
  /** 正在处理的张；null 表示不在处理中 */
  current: string | null;
}

export interface BatchExportedFile {
  id: string;
  name: string;
  /** 实际写入的名字。避让了文件夹里已有的同名文件时，会与计划不同 */
  filename: string;
}

export interface BatchFailure {
  id: string;
  name: string;
  reason: string;
}

export interface BatchOutcome {
  /** 是否真的开始写了。false 表示在准备阶段就停下了 */
  started: boolean;
  /** 没开始的原因 */
  blockedReason: string | null;
  exported: BatchExportedFile[];
  failed: BatchFailure[];
  /** 用户中途中断。已导出的那些仍然有效 */
  cancelled: boolean;
  /** 落盘方式，用于汇总文案 */
  sinkLabel: string;
}

export interface BatchExportDeps {
  /** 按需重解全分辨率原图 */
  reopen: (file: File) => Promise<RenderSource>;
  /**
   * 渲染并编码。
   *
   * 第二个参数是**这一张自己的**编码规格，不是"当前界面上的设置" ——
   * 队列里每张的方案是各自算出来的，串行跑的时候界面早就可能被改过了。
   */
  render: (source: RenderSource, spec: BatchRenderSpec) => Promise<Blob>;
  /** 释放重解出来的那张。**失败路径也必须走到** */
  dispose: (source: RenderSource) => void;
  sink: ExportSink;
  onProgress?: (progress: BatchProgress) => void;
  /** 每张开始前问一次是否已被打断 */
  shouldCancel?: () => boolean;
}

/** 渲染一张所需的全部编码参数，与 `BatchJob` 同源。 */
export interface BatchRenderSpec {
  maxDimension?: number;
  mimeType: ExportMimeType;
  quality?: number;
}

export async function runBatchExport(
  jobs: readonly BatchJob[],
  deps: BatchExportDeps,
): Promise<BatchOutcome> {
  const { sink, reopen, render, dispose } = deps;
  const total = jobs.length;

  const outcome: BatchOutcome = {
    started: false,
    blockedReason: null,
    exported: [],
    failed: [],
    cancelled: false,
    sinkLabel: sink.label,
  };

  if (total === 0) {
    outcome.blockedReason = '没有可导出的素材。';
    return outcome;
  }

  let ready: SinkStart;
  try {
    ready = await sink.begin(total);
  } catch (error) {
    outcome.blockedReason = error instanceof Error ? error.message : String(error);
    return outcome;
  }

  if (!ready.ok) {
    outcome.blockedReason = ready.message;
    return outcome;
  }
  outcome.started = true;

  try {
    for (const [index, job] of jobs.entries()) {
      if (deps.shouldCancel?.()) {
        outcome.cancelled = true;
        break;
      }

      deps.onProgress?.({ done: index, total, current: job.name });

      let source: RenderSource | null = null;
      try {
        // 原图不常驻内存，这一张到这一刻才重解。一次只解一张，用完必须释放。
        source = await reopen(job.file);
        const blob = await render(source, {
          maxDimension: job.maxDimension ?? undefined,
          mimeType: job.mimeType,
          quality: job.quality ?? undefined,
        });
        const actualName = await sink.write(blob, job.filename);
        outcome.exported.push({ id: job.id, name: job.name, filename: actualName });
      } catch (error) {
        // 单张失败只跳过，不中断整批
        outcome.failed.push({
          id: job.id,
          name: job.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // 出错路径同样要释放 —— 泄漏几百 MB 的正是这里
        if (source) dispose(source);
      }

      deps.onProgress?.({ done: index + 1, total, current: null });
    }
  } finally {
    // 无论成功、失败还是被中断，都给落盘出口一次收尾机会（关掉目录句柄）
    await sink.end().catch(() => undefined);
  }

  return outcome;
}
