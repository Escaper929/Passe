import { createCanvas } from '@napi-rs/canvas';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { isTextEntryTarget, useImageQueue, type ImageQueueApi } from './useImageQueue';
import { waitFor } from '@/test/waitFor';

/**
 * 输入管线的集成测试。
 *
 * 准入校验、内存守卫、顺序解码各自都有单元测试，但它们**串起来**之后
 * 才是用户真正碰到的那条路径 —— 而线接错恰恰是单元测试抓不到的那类 bug。
 * 这里用一个只读 API 的宿主组件，在 jsdom 里跑真实的 reducer + hook 生命周期。
 */

let latest: ImageQueueApi | null = null;

/**
 * 只读宿主组件：把 hook 的最新 API 交出来供断言。
 *
 * 通过 effect 而不是在渲染期赋值 —— 渲染期写外部变量是副作用，
 * lint 会（正确地）拦下来，而且 StrictMode 下行为不可预期。
 */
function Harness({
  residentLimit,
  onReady,
}: {
  residentLimit?: number;
  onReady: (api: ImageQueueApi) => void;
}) {
  const api = useImageQueue({ residentLimit });
  useEffect(() => {
    onReady(api);
  });
  return null;
}

/** 每次解码分配的位图记账，用来断言"该释放的有没有释放"。 */
let allocated: { id: number; close: () => void }[] = [];
let closedIds: number[] = [];
let bitmapSeq = 0;

/** stub 用的位图尺寸，逐用例可调。 */
let dims: [number, number] = [400, 300];
/** 非空时 createImageBitmap 会挂起，直到测试调用 releaseDecode() */
let gatePromise: Promise<void> | null = null;
let gateResolve: (() => void) | null = null;
let decodeConcurrency = 0;
let peakDecodeConcurrency = 0;

/** 让下一次（及当前）解码停在半路，用于制造"解码途中"的时间窗口。 */
function holdDecode() {
  gatePromise = new Promise<void>((resolve) => {
    gateResolve = resolve;
  });
}

function releaseDecode() {
  gateResolve?.();
  gatePromise = null;
  gateResolve = null;
}

function makeBitmap(w: number, h: number) {
  const canvas = createCanvas(w, h);
  const id = (bitmapSeq += 1);
  const record = { id, close: () => closedIds.push(id) };
  Object.defineProperty(canvas, 'close', { value: record.close, configurable: true });
  allocated.push(record);
  return canvas as unknown as ImageBitmap;
}

/**
 * 安装正常的解码替身：延时一小会儿再交出位图，以便观察并发度。
 *
 * 必须每个用例重装 —— beforeEach 里做。先前把它放进 beforeAll，
 * 结果有个用例为了模拟解码失败把它换成了抛异常的版本，之后所有用例
 * 都在对着那个抛异常的 stub 跑，失败原因还伪装成"等待超时"。
 */
function installDecodeStub() {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      decodeConcurrency += 1;
      peakDecodeConcurrency = Math.max(peakDecodeConcurrency, decodeConcurrency);
      try {
        if (gatePromise) await gatePromise;
        else await new Promise((resolve) => setTimeout(resolve, 1));
        return makeBitmap(dims[0], dims[1]);
      } finally {
        decodeConcurrency -= 1;
      }
    }),
  );
}

beforeAll(() => {
  const native = Document.prototype.createElement;
  vi.spyOn(document, 'createElement').mockImplementation(function (
    this: Document,
    tagName: string,
    options?: ElementCreationOptions,
  ) {
    if (tagName.toLowerCase() === 'canvas') {
      return createCanvas(1, 1) as unknown as HTMLElement;
    }
    return native.call(document, tagName as 'div', options);
  } as typeof document.createElement);
});

beforeEach(() => {
  installDecodeStub();
  allocated = [];
  closedIds = [];
  bitmapSeq = 0;
  dims = [400, 300];
  gatePromise = null;
  gateResolve = null;
  decodeConcurrency = 0;
  peakDecodeConcurrency = 0;
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(residentLimit?: number) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <Harness
        residentLimit={residentLimit}
        onReady={(api) => {
          latest = api;
        }}
      />,
    );
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  latest = null;
  // 还原本用例可能替换过的全局替身；下一个用例的 beforeEach 会重新装好
  vi.unstubAllGlobals();
});

/**
 * 反复刷新微任务与计时器，直到条件成立或超时。
 * 见 @/test/waitFor。
 */

function imageFile(name: string, type = 'image/jpeg', size = 4096): File {
  return new File([new Uint8Array(Math.min(size, 16))], name, { type });
}

/** File 的 size 由内容决定，这里直接改写到需要的数值，避免真造几 MB 数据。 */
function sizedFile(name: string, size: number, type = 'image/jpeg'): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size, configurable: true });
  return file;
}

async function ingest(files: File[]) {
  await act(async () => {
    latest?.ingestFiles(files);
  });
}

describe('输入管线 · 准入在 hook 层生效', () => {
  it('拖入非图片时给出拒绝原因，且队列里不留任何条目', async () => {
    await mount();
    await ingest([sizedFile('合同.pdf', 2048, 'application/pdf')]);
    await waitFor(() => latest?.notice !== null);

    expect(latest?.items).toHaveLength(0);
    expect(latest?.notice?.level).toBe('error');
    expect(latest?.notice?.lines[0]).toContain('合同.pdf');
  });

  it('空文件被拦下，且不会触发任何解码', async () => {
    await mount();
    await ingest([sizedFile('empty.jpg', 0)]);
    await waitFor(() => latest?.notice !== null);

    expect(latest?.items).toHaveLength(0);
    expect(allocated).toHaveLength(0);
  });

  it('合法图片入队并解码完成，尺寸被记录下来', async () => {
    await mount();
    dims = [1600, 1200];
    await ingest([imageFile('portra400.jpg')]);

    await waitFor(() => latest?.items[0]?.status === 'ready');

    expect(latest?.items).toHaveLength(1);
    expect(latest?.items[0].width).toBe(1600);
    expect(latest?.items[0].height).toBe(1200);
    expect(latest?.items[0].source).not.toBeNull();
    expect(latest?.activeId).toBe(latest?.items[0].id);
  });

  it('TIFF 入队但条目上带着解码能力警告', async () => {
    await mount();
    await ingest([imageFile('scan.tif', 'image/tiff')]);
    await waitFor(() => latest?.items[0]?.status === 'ready');

    expect(latest?.items[0].warning).toContain('解码支持不一致');
    // 警告是条目级的，不该再重复塞进顶部提示
    expect(latest?.notice).toBeNull();
  });

  it('解码失败时条目转为失败态并带上可读原因', async () => {
    await mount();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      }),
    );

    await ingest([imageFile('broken.heic', '')]);
    await waitFor(() => latest?.items[0]?.status === 'failed');

    expect(latest?.items[0].error).toContain('导出为 PNG 或 JPEG');
    expect(latest?.items[0].source).toBeNull();
  });
});

describe('输入管线 · 顺序解码', () => {
  it('一批多张也不并行解码 —— 峰值内存只等于单张', async () => {
    await mount();
    await ingest([imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg')]);

    await waitFor(() => latest?.items.every((item) => item.status === 'ready') === true);

    expect(latest?.items).toHaveLength(3);
    expect(peakDecodeConcurrency).toBe(1);
  });

  it('连续两批之间同样串行，不会两批同时解码', async () => {
    await mount();
    await ingest([imageFile('a.jpg')]);
    await ingest([imageFile('b.jpg')]);

    await waitFor(() => latest?.items.every((item) => item.status === 'ready') === true);
    expect(peakDecodeConcurrency).toBe(1);
  });
});

describe('输入管线 · 资源释放', () => {
  it('移除条目时释放它持有的位图', async () => {
    await mount();
    dims = [400, 300];
    await ingest([imageFile('a.jpg')]);
    await waitFor(() => latest?.items[0]?.status === 'ready');

    const id = latest?.items[0].id as string;
    await act(async () => {
      latest?.remove(id);
    });

    expect(latest?.items).toHaveLength(0);
    // 不释放就是几十 MB 级别的泄漏
    expect(closedIds).toHaveLength(1);
  });

  it('清空队列时逐张释放，一张都不留', async () => {
    await mount();
    await ingest([imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg')]);
    await waitFor(() => latest?.items.every((item) => item.status === 'ready') === true);

    await act(async () => {
      latest?.clear();
    });

    expect(latest?.items).toHaveLength(0);
    expect(closedIds).toHaveLength(3);
  });

  it('解码途中被移除的条目，其结果会被就地释放而不是泄漏', async () => {
    await mount();

    // 把解码卡住，制造"结果还没回来，图已经被删掉"的窗口
    holdDecode();

    await ingest([imageFile('slow.jpg')]);
    await waitFor(() => decodeConcurrency === 1);

    const id = latest?.items[0].id as string;
    await act(async () => {
      latest?.remove(id);
    });
    expect(latest?.items).toHaveLength(0);

    await act(async () => {
      releaseDecode();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await waitFor(() => closedIds.length > 0);

    expect(latest?.items).toHaveLength(0);
    expect(closedIds).toHaveLength(1);
  });

  it('尚未开始解码的条目被移除后，不会再浪费时间去解码', async () => {
    await mount();

    holdDecode();
    await ingest([imageFile('a.jpg'), imageFile('b.jpg')]);

    const second = latest?.items[1].id as string;
    await act(async () => {
      latest?.remove(second);
    });

    // 放行第一张，让队列继续往下走
    await act(async () => {
      releaseDecode();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => latest?.items[0]?.status === 'ready');

    // 两张文件只解码了一张
    expect(allocated).toHaveLength(1);
    expect(latest?.items).toHaveLength(1);
  });
});

describe('输入管线 · 内存守卫拦新增', () => {
  it('队列已满时拒绝新图片，并说明原因', async () => {
    // 每张 400 × 300 = 120000px ≈ 469KB，上限 1MB 时第三张就会触顶
    await mount(1_000_000);
    dims = [400, 300];

    await ingest([imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg')]);
    await waitFor(() => latest?.items.every((item) => item.status === 'ready') === true);
    expect(latest?.items).toHaveLength(3);

    await ingest([imageFile('d.jpg')]);

    expect(latest?.items).toHaveLength(3);
    expect(latest?.notice?.level).toBe('error');
    expect(latest?.notice?.lines.join()).toContain('已忽略');
    // 被守卫拦下的文件根本不该进入解码流程
    expect(allocated).toHaveLength(3);
  });

  it('内存报告随队列变化，并以上限为刻度', async () => {
    await mount(1_000_000);
    dims = [400, 300];

    const before = latest?.memory.load ?? 0;
    expect(before).toBe(0);

    await ingest([imageFile('a.jpg')]);
    await waitFor(() => latest?.items[0]?.status === 'ready');

    expect(latest?.memory.count).toBe(1);
    expect(latest?.memory.limit).toBe(1_000_000);
    expect(latest?.memory.load).toBeGreaterThan(0);
  });
});

describe('输入管线 · 队列操作', () => {
  it('选中、上移、下移都通过 API 生效', async () => {
    await mount();
    await ingest([imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg')]);
    await waitFor(() => latest?.items.every((item) => item.status === 'ready') === true);

    const ids = latest?.items.map((item) => item.id) as string[];

    await act(async () => {
      latest?.select(ids[2]);
    });
    expect(latest?.activeId).toBe(ids[2]);

    await act(async () => {
      latest?.move(ids[2], -1);
    });
    expect(latest?.items.map((item) => item.id)).toEqual([ids[0], ids[2], ids[1]]);
    // 排序不该改变焦点
    expect(latest?.activeId).toBe(ids[2]);
  });

  it('删掉当前选中项时由邻居接管焦点', async () => {
    await mount();
    await ingest([imageFile('a.jpg'), imageFile('b.jpg')]);
    await waitFor(() => latest?.items.every((item) => item.status === 'ready') === true);

    const ids = latest?.items.map((item) => item.id) as string[];
    await act(async () => {
      latest?.remove(ids[0]);
    });

    expect(latest?.activeId).toBe(ids[1]);
  });

  it('提示可被消解，不会一直挂在界面上', async () => {
    await mount();
    await ingest([sizedFile('x.pdf', 100, 'application/pdf')]);
    await waitFor(() => latest?.notice !== null);

    await act(async () => {
      latest?.dismissNotice();
    });
    expect(latest?.notice).toBeNull();
  });
});

describe('输入管线 · 粘贴入口', () => {
  it('空白处粘贴会把剪贴板里的图片送进队列', async () => {
    await mount();

    const preventDefault = vi.fn();
    const event = {
      target: document.body,
      preventDefault,
      clipboardData: { files: [imageFile('clip.png', 'image/png')] },
    } as unknown as ClipboardEvent;

    await act(async () => {
      latest?.handlePasteEvent(event);
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => latest?.items[0]?.status === 'ready');
    expect(latest?.items).toHaveLength(1);
  });

  it('焦点在输入框里时不抢粘贴事件', async () => {
    await mount();

    const input = document.createElement('input');
    document.body.appendChild(input);

    const preventDefault = vi.fn();
    const event = {
      target: input,
      preventDefault,
      clipboardData: { files: [imageFile('clip.png', 'image/png')] },
    } as unknown as ClipboardEvent;

    await act(async () => {
      latest?.handlePasteEvent(event);
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(latest?.items).toHaveLength(0);

    input.remove();
  });

  it('剪贴板里没有图片时保持静默', async () => {
    await mount();

    const preventDefault = vi.fn();
    const event = {
      target: document.body,
      preventDefault,
      clipboardData: { files: [] },
    } as unknown as ClipboardEvent;

    await act(async () => {
      latest?.handlePasteEvent(event);
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(latest?.items).toHaveLength(0);
  });

  it('输入框、文本域、可编辑区域都算文本输入目标', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const div = document.createElement('div');
    const editable = document.createElement('div');
    // jsdom 不实现 isContentEditable，这里直接定义
    Object.defineProperty(editable, 'isContentEditable', { value: true });

    expect(isTextEntryTarget(input)).toBe(true);
    expect(isTextEntryTarget(textarea)).toBe(true);
    expect(isTextEntryTarget(editable)).toBe(true);
    expect(isTextEntryTarget(div)).toBe(false);
    expect(isTextEntryTarget(document.body)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
