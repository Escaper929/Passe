/**
 * 批量导出的落盘出口。
 *
 * 两条路，同一套接口：
 * - **目录直写**（Chromium 的 File System Access API）：让用户选一个文件夹，
 *   十张图直接写进去，不经过下载栏、不弹十次"是否保留"。
 * - **逐张下载**（Safari / Firefox）：退回最老实的做法，一张一次下载。
 *
 * 为什么不做 zip：打包要多占一份与整批等量的内存，而"内存"正是这个工具最在意的东西。
 * 每张成功即落盘还有个好处 —— 中途崩了，前面已经导出的还在手里。
 *
 * 这里有个容易忽略的坑：**目录直写是会静默覆盖的**。同名文件连提示都没有就没了，
 * 用户最后拿到 9 张而不是 10 张。同批次内部的重名由 batchPlan 提前解掉，
 * 与文件夹里**已有**的文件撞名则由这里避开。
 */

import { saveBlob } from '@/engine/GalleryFramingEngine';

export type SinkStart = { ok: true } | { ok: false; message: string };

export interface ExportSink {
  /** 落盘方式的说明，用于汇总文案 */
  readonly label: string;
  /**
   * 开始前的一次性准备（选目录等）。
   *
   * 返回 ok: false 表示不应该开始 —— 用户取消了选目录，或者环境根本写不进去。
   * 这两种情况都**不**回退成逐张下载：用户刚说了"不要"，紧接着弹十个下载会更糟。
   */
  begin(total: number): Promise<SinkStart>;
  /** 写入一张。返回**实际使用**的文件名（避让了已有文件时与原计划不同） */
  write(blob: Blob, filename: string): Promise<string>;
  /** 收尾 */
  end(): Promise<void>;
}

interface WritableStreamLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<WritableStreamLike>;
}

interface DirectoryHandleLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

/** `showDirectoryPicker` 目前不在 lib.dom 里，按需声明最小可用面。 */
interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<DirectoryHandleLike>;
}

export function supportsDirectorySink(target: unknown = globalThis): boolean {
  return typeof (target as DirectoryPickerWindow | null)?.showDirectoryPicker === 'function';
}

/** 把 `a/b.tif` 变成 `a/b-2.tif`。与 batchPlan 的重名规则保持一致。 */
export function nextAvailableName(filename: string, index: number): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return `${filename}-${index}`;
  return `${filename.slice(0, dot)}-${index}${filename.slice(dot)}`;
}

class DirectorySink implements ExportSink {
  /** 与下载出口区分开，汇总文案里要说清文件到底去了哪 */
  readonly label = '所选文件夹';

  private handle: DirectoryHandleLike | null = null;

  // 不用构造函数参数属性：tsconfig 开了 erasableSyntaxOnly，那种写法不允许
  private readonly target: DirectoryPickerWindow;

  constructor(target: DirectoryPickerWindow) {
    this.target = target;
  }

  async begin(): Promise<SinkStart> {
    const picker = this.target.showDirectoryPicker;
    if (!picker) return { ok: false, message: '当前浏览器不支持选择文件夹。' };

    try {
      this.handle = await picker.call(this.target, { id: 'passe-export', mode: 'readwrite' });
      return { ok: true };
    } catch (error) {
      // 用户按了取消：这不是错误，安静地停下
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, message: '已取消选择文件夹，本次没有导出。' };
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 目录里已经有同名文件时往后找一个空位，绝不静默覆盖用户已导出的成果。 */
  private async freeName(filename: string): Promise<string> {
    const handle = this.handle;
    if (!handle) return filename;

    const taken = async (name: string): Promise<boolean> => {
      try {
        await handle.getFileHandle(name);
        return true;
      } catch {
        // NotFoundError 才是"不存在"，其它错误一律当作已被占用，宁可换个名字
        return false;
      }
    };

    if (!(await taken(filename))) return filename;

    for (let index = 2; index < 1000; index += 1) {
      const candidate = nextAvailableName(filename, index);
      if (!(await taken(candidate))) return candidate;
    }
    return filename;
  }

  async write(blob: Blob, filename: string): Promise<string> {
    const handle = this.handle;
    if (!handle) throw new Error('尚未选择导出文件夹。');

    const name = await this.freeName(filename);
    const file = await handle.getFileHandle(name, { create: true });
    const stream = await file.createWritable();
    try {
      await stream.write(blob);
    } finally {
      // 写失败也要把流关掉，否则浏览器会一直握着一个半开的文件
      await stream.close();
    }
    return name;
  }

  async end(): Promise<void> {
    this.handle = null;
  }
}

class DownloadSink implements ExportSink {
  readonly label = '浏览器下载';

  async begin(): Promise<SinkStart> {
    return { ok: true };
  }

  async write(blob: Blob, filename: string): Promise<string> {
    saveBlob(blob, filename);
    // 下载由浏览器接管，重名它会自己加序号，名字按原计划报告
    return filename;
  }

  async end(): Promise<void> {
    // 没有需要收尾的资源
  }
}

/** 有目录直写就用它，没有就退回逐张下载。 */
export function createExportSink(target: unknown = globalThis): ExportSink {
  return supportsDirectorySink(target)
    ? new DirectorySink(target as DirectoryPickerWindow)
    : new DownloadSink();
}
