import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createExportSink,
  nextAvailableName,
  supportsDirectorySink,
  type ExportSink,
  type SinkStart,
} from './exportSink';

/**
 * 落盘出口的验证。
 *
 * 目录直写这段代码碰的都是浏览器 API，但**最该盯住的不是 API 调没调对，
 * 而是它会不会悄悄覆盖用户的文件**。File System Access 的写入没有"目标已存在"
 * 这道拦截，同名即覆盖且不留提示；一次导十张、目录里已经躺着一份上次的成果，
 * 用户会以为只是重导了一遍，实际拿到的是混在一起的新旧文件。
 *
 * 顺带钉住两个容易漏的生命周期：写入抛错时流仍然要关闭，以及用户取消选目录
 * 要能和真正的错误区分开（前者安静停下，后者要报出来）。
 */

interface FakeDirectory {
  handle: { getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown> };
  files: Map<string, string>;
  log: { created: string[]; written: string[]; closed: string[] };
}

function fakeDirectory(options: { existing?: string[]; failWrite?: string } = {}): FakeDirectory {
  const files = new Map<string, string>((options.existing ?? []).map((name) => [name, 'old']));
  const log = { created: [] as string[], written: [] as string[], closed: [] as string[] };

  const handle = {
    async getFileHandle(name: string, call: { create?: boolean } = {}) {
      if (!files.has(name)) {
        // 与浏览器一致：不带 create 时，不存在就抛 NotFoundError
        if (!call.create) throw new DOMException(`${name} not found`, 'NotFoundError');
        files.set(name, '');
      }
      return {
        async createWritable() {
          log.created.push(name);
          return {
            async write() {
              if (options.failWrite === name) throw new Error('磁盘已满');
              files.set(name, 'new');
              log.written.push(name);
            },
            async close() {
              log.closed.push(name);
            },
          };
        },
      };
    },
  };

  return { handle, files, log };
}

function directoryWindow(picker: () => Promise<unknown>): unknown {
  return { showDirectoryPicker: picker };
}

/** 下载出口会去点一个 <a>，jsdom 里那会尝试导航并打警告，拦下来即可。 */
let downloads: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  downloads = [];
});

function stubAnchor(): void {
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
}

describe('supportsDirectorySink', () => {
  it('没有 showDirectoryPicker 就是不支持', () => {
    expect(supportsDirectorySink({})).toBe(false);
    expect(supportsDirectorySink(undefined)).toBe(false);
    expect(supportsDirectorySink({ showDirectoryPicker: 'yes' })).toBe(false);
  });

  it('有函数才算支持', () => {
    expect(supportsDirectorySink({ showDirectoryPicker: () => undefined })).toBe(true);
  });
});

describe('createExportSink', () => {
  it('不支持目录直写时退回浏览器下载', async () => {
    const sink = createExportSink({});
    expect(sink.label).toBe('浏览器下载');

    stubAnchor();
    const started = await sink.begin(3);
    expect(started.ok).toBe(true);

    await sink.write(new Blob(['x']), 'Passe_a.jpg');
    await sink.end();
    expect(downloads).toEqual(['Passe_a.jpg']);
  });

  it('支持时用目录直写', () => {
    const { handle } = fakeDirectory();
    const sink = createExportSink(directoryWindow(async () => handle));
    expect(sink.label).toBe('所选文件夹');
  });
});

describe('nextAvailableName', () => {
  it('序号插在扩展名前', () => {
    expect(nextAvailableName('a.tif', 2)).toBe('a-2.tif');
  });

  it('没有扩展名就直接追加', () => {
    expect(nextAvailableName('scan', 2)).toBe('scan-2');
  });

  it('隐藏文件不把整名当扩展名', () => {
    expect(nextAvailableName('.gitignore', 2)).toBe('.gitignore-2');
  });
});

/** 取出失败结果里给人看的那句话。 */
function failureMessage(start: SinkStart): string {
  if (start.ok) throw new Error('这一步本应失败');
  return start.message;
}

describe('目录直写', () => {
  async function readySink(
    options: { existing?: string[]; failWrite?: string } = {},
  ): Promise<{ sink: ExportSink; directory: FakeDirectory }> {
    const directory = fakeDirectory(options);
    const sink = createExportSink(directoryWindow(async () => directory.handle));
    const started = await sink.begin(1);
    expect(started.ok).toBe(true);
    return { sink, directory };
  }

  it('目录里已有同名文件时自动避让，绝不静默覆盖', async () => {
    const { sink, directory } = await readySink({ existing: ['Passe_a_2000px.jpg'] });

    const actual = await sink.write(new Blob(['x']), 'Passe_a_2000px.jpg');

    expect(actual).toBe('Passe_a_2000px-2.jpg');
    expect(directory.log.written).toEqual(['Passe_a_2000px-2.jpg']);
    // 原来那份没被动过
    expect(directory.files.get('Passe_a_2000px.jpg')).toBe('old');
  });

  it('连着几个名字都被占用时继续往后找', async () => {
    const { sink } = await readySink({
      existing: ['a.jpg', 'a-2.jpg', 'a-3.jpg'],
    });

    expect(await sink.write(new Blob(['x']), 'a.jpg')).toBe('a-4.jpg');
  });

  it('没有冲突时用原名', async () => {
    const { sink, directory } = await readySink();

    expect(await sink.write(new Blob(['x']), 'a.jpg')).toBe('a.jpg');
    expect(directory.log.created).toEqual(['a.jpg']);
  });

  it('写入抛错时流仍然被关闭 —— 不能握着一个半开的文件', async () => {
    const { sink, directory } = await readySink({ failWrite: 'a.jpg' });

    await expect(sink.write(new Blob(['x']), 'a.jpg')).rejects.toThrow('磁盘已满');
    expect(directory.log.closed).toEqual(['a.jpg']);
  });

  it('用户取消选目录时安静停下，并说清是没有导出', async () => {
    const sink = createExportSink(
      directoryWindow(async () => {
        throw new DOMException('用户取消', 'AbortError');
      }),
    );

    const started = await sink.begin(2);

    expect(started.ok).toBe(false);
    expect(failureMessage(started)).toContain('已取消');
  });

  it('其它错误如实透出，别把权限问题说成用户取消', async () => {
    const sink = createExportSink(
      directoryWindow(async () => {
        throw new DOMException('需要用户手势', 'SecurityError');
      }),
    );

    const started = await sink.begin(2);

    expect(started.ok).toBe(false);
    expect(failureMessage(started)).toContain('需要用户手势');
    expect(failureMessage(started)).not.toContain('已取消');
  });

  it('没选目录就写，直接报错而不是静默丢弃', async () => {
    const { handle } = fakeDirectory();
    const sink = createExportSink(directoryWindow(async () => handle));

    await expect(sink.write(new Blob(['x']), 'a.jpg')).rejects.toThrow('尚未选择导出文件夹');
  });
});
