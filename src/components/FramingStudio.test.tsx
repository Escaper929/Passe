import { createCanvas } from '@napi-rs/canvas';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '@/App';
import { HEAVY_LOAD } from '@/input/budget';
import { useImageQueue, type ImageQueueApi } from '@/input/useImageQueue';
import { installCanvasHarness } from '@/test/canvasHarness';
import { waitFor } from '@/test/waitFor';

import { FramingStudio } from './FramingStudio';

/**
 * 调校台测试。
 *
 * 重点在**导出路径**：它是唯一会同时碰到全分辨率位图、大画布和文件下载的地方，
 * 也是唯一一处出错代价很高（用户等了几十秒才崩）的地方。
 *
 * jsdom 既没有 2D 画布也没有 createImageBitmap，还没有 URL.createObjectURL，
 * 三样都接上替身，导出的每一步才是可断言的事实。
 *
 * 另一条纪律：每个用例都必须**等到导出的终态**（状态条出现"已导出"、按钮回到可点）
 * 才算结束。导出是异步的，用例超时时它并不会停下 —— 残留回调会一边继续往 React 的
 * act 队列里塞更新（把下一个用例的 act 撞成"overlapping act()"），一边继续改共享的
 * 计数器（下一个用例于是报出 "expected 2 to be 1" 这种与它自己毫无关系的错）。
 * 三道防线：等终态、waitFor 带 label、afterEach 再做一道收尾隔离。
 * 这类污染排查过一次就够了。
 */

let latestQueue: ImageQueueApi | null = null;

function Harness({
  onQueue,
  renderLimit,
}: {
  onQueue: (queue: ImageQueueApi) => void;
  renderLimit?: number;
}) {
  const queue = useImageQueue();
  useEffect(() => {
    onQueue(queue);
  });
  return <FramingStudio queue={queue} renderLimit={renderLimit} />;
}

/** 记录每次解码分配的位图，用于断言"该释放的有没有释放"。 */
let closeCalls = 0;
/** 每次 createImageBitmap 返回的位图尺寸 */
let dims: [number, number] = [2000, 1500];
/** 下载记录 */
let downloads: string[] = [];
/** createObjectURL 的调用次数 */
let objectUrls = 0;

/**
 * 造一个"尺寸会撒谎"的位图替身。
 *
 * 真实分配一张 20000 × 15000 的画布是 1.2GB，测试跑不动。
 * 但内存守卫只看尺寸数字，所以让小画布对外声称自己是巨图即可 ——
 * 这样"超限"这条路径才能被低成本地验证。
 */
function makeBitmap(width: number, height: number, realWidth = 8, realHeight = 8) {
  const canvas = createCanvas(realWidth, realHeight);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, realWidth, realHeight);

  if (width !== realWidth || height !== realHeight) {
    Object.defineProperty(canvas, 'width', { value: width, configurable: true });
    Object.defineProperty(canvas, 'height', { value: height, configurable: true });
  }
  Object.defineProperty(canvas, 'close', {
    value: () => {
      closeCalls += 1;
    },
    configurable: true,
  });

  return canvas as unknown as ImageBitmap;
}

beforeAll(() => {
  // 让 <canvas> 既是真 DOM 元素（React 能渲染），又有真 2D 上下文（引擎能画）
  installCanvasHarness();

  // 下载链接的点击在 jsdom 里会尝试导航并打一堆"未实现"警告，
  // 这里拦下来只记录文件名 —— 文件名本身就是要断言的东西
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  closeCalls = 0;
  dims = [2000, 1500];
  downloads = [];
  objectUrls = 0;

  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => makeBitmap(dims[0], dims[1])),
  );
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => {
      objectUrls += 1;
      return 'blob:mock';
    }),
    revokeObjectURL: vi.fn(),
  });
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
}

afterEach(async () => {
  /**
   * 失败路径的隔离：用例结束时若还有导出在跑，等它收尾再拆组件。
   *
   * 导出是异步的，用例超时并不会让它停下 —— 它会继续跑完，然后调一次
   * createObjectURL、往下载记录里塞一个文件名，而下一个用例的计数器已经归零了。
   * 症状是下一个用例报出 "expected 2 to be 1" 这种与它自己毫无关系的错。
   * 这里不作为失败（真原因在它自己的用例里已经报过），只是别让它越界。
   */
  await waitFor(
    () => {
      const button = exportButtonIfAny();
      return !button || !(button.textContent ?? '').includes('正在渲染');
    },
    { timeout: 3000, label: '等仍在进行的导出收尾' },
  ).catch(() => undefined);

  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  latestQueue = null;
  vi.unstubAllGlobals();
});

function text(): string {
  return container?.textContent ?? '';
}

function findButton(label: string): HTMLButtonElement {
  const buttons = Array.from(container?.querySelectorAll('button') ?? []);
  const match = buttons.find((button) => (button.textContent ?? '').includes(label));
  if (!match) throw new Error(`找不到按钮：${label}`);
  return match as HTMLButtonElement;
}

function exportButtonIfAny(): HTMLButtonElement | null {
  const buttons = Array.from(container?.querySelectorAll('button') ?? []);
  const match = buttons.find((button) =>
    /导出画廊装裱作品|正在渲染/.test(button.textContent ?? ''),
  );
  return (match as HTMLButtonElement) ?? null;
}

function exportButton(): HTMLButtonElement {
  const match = exportButtonIfAny();
  if (!match) throw new Error('找不到导出按钮');
  return match;
}

/** 面板里展示的文件名（dd 的 title 属性，不受截断影响）。 */
function shownFilename(): string {
  const node = container?.querySelector('dl dd[title]');
  const value = node?.getAttribute('title');
  if (!value) throw new Error('读不到导出文件名');
  return value;
}

/**
 * 读导出规格里某一行的值。
 *
 * 刻意不用整段 textContent：页眉也印着"3000 × 2000"，用包含判断的话，
 * 哪怕面板里的规格算错了，断言照样会通过。
 */
function planRow(label: string): string {
  const rows = Array.from(container?.querySelectorAll('dl > div') ?? []);
  for (const row of rows) {
    if (row.querySelector('dt')?.textContent?.trim() !== label) continue;
    const value = row.querySelector('dd')?.textContent;
    if (value) return value;
  }
  throw new Error(`读不到导出规格：${label}`);
}

/** 从"外框 2849 × 2105（6.0MP）"里取出百万像素数。 */
function framedMegapixels(): number {
  const match = /（([\d.]+)MP）/.exec(planRow('装裱外框'));
  if (!match) throw new Error('读不到装裱外框像素数');
  return Number(match[1]);
}

/** 等一次导出彻底走完：状态条出现结论，按钮回到可点。 */
async function waitForExportDone(): Promise<void> {
  await waitFor(() => downloads.length > 0, { label: '下载被触发' });
  await waitFor(() => exportButton().disabled === false, { label: '导出按钮恢复可点' });
}

function file(name = 'portra400.tif', type = 'image/tiff'): File {
  return new File(['x'], name, { type });
}

async function seedImage(queue: ImageQueueApi, name?: string) {
  await act(async () => {
    queue.ingestFiles([file(name)]);
  });
  await waitFor(() => latestQueue?.items[0]?.status === 'ready', { label: '解码完成' });
}

describe('调校台 · 空态', () => {
  it('没有素材时给出拖放提示，并禁用导出', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);

    expect(text()).toContain('选择或拖拽胶片扫描件');
    expect(text()).toContain('零上传');
    expect(exportButton().disabled).toBe(true);
    // 没有素材时不该显示导出规格 —— 那会让人以为已经能导出了
    expect(text()).not.toContain('装裱外框');
  });

  it('素材就绪后显示原图分辨率与导出规格', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!, 'portra400.tif');

    expect(text()).toContain('2000 × 1500');
    expect(text()).toContain('装裱外框');
    expect(text()).toContain('portra400');
    expect(exportButton().disabled).toBe(false);
  });
});

describe('调校台 · 导出路径', () => {
  it('导出会重解全分辨率原图，用完立即释放', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    // 队列解码已经用过一次位图替身
    const before = closeCalls;

    await act(async () => {
      exportButton().click();
    });
    await waitForExportDone();

    // 下载发生了，且只发生一次
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^Passe_.*_2000px\.jpg$/);

    // 导出用的那张全分辨率位图必须被释放掉：它是几百 MB 级别的
    expect(closeCalls).toBeGreaterThan(before);
    expect(text()).toContain('已导出');
  });

  it('导出的输出尺寸按原图算，而不是按被压过的预览副本', async () => {
    // 3000 × 2000 的短边 2000 ≤ 2400，不会被降采样，适合核对尺寸换算
    dims = [3000, 2000];
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    // 默认预设是 8K，源图只有 3000，所以不放大
    expect(planRow('输出')).toBe('3000 × 2000');

    await act(async () => {
      findButton('2K').click();
    });

    // 2K = 长边 2048
    expect(planRow('输出')).toBe('2048 × 1365');

    await act(async () => {
      exportButton().click();
    });
    await waitForExportDone();
    expect(downloads[0]).toContain('2048px');
  });

  it('URL 用完即回收，不漏 objectURL', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    await act(async () => {
      exportButton().click();
    });
    await waitForExportDone();

    expect(objectUrls).toBe(1);
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledTimes(1);
  });

  it('导出过程中按钮变为不可点，避免重复触发同一张图的渲染', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    act(() => {
      exportButton().click();
    });
    // 还没 await，导出正在进行
    expect(exportButton().textContent).toContain('正在渲染');

    await waitForExportDone();
    expect(exportButton().textContent).toContain('导出画廊装裱作品');
  });

  it('切换尺寸预设后，展示的输出尺寸与实际下载的文件名一致', async () => {
    dims = [3000, 2000];
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    await act(async () => {
      findButton('2K').click();
    });
    const shown = shownFilename();

    await act(async () => {
      exportButton().click();
    });
    await waitForExportDone();

    // 面板上写的是什么，导出的就必须是什么 —— 这是用户唯一能核对的地方
    expect(downloads[0]).toBe(shown);
  });
});

/** 真实上限下的一张巨图：装裱后 4.8 亿像素，远超 1.2 亿。 */
const GIANT: [number, number] = [20000, 15000];

/**
 * 低成本场景：把画布上限压到 6MP，于是 3000 × 2000 这张很普通的图就超限了。
 *
 * 守卫给出的建议值按定义就是"刚好卡在上限"的尺寸 —— 换句话说，
 * 只要走一遍"被拦下 → 一键修正 → 导出成功"，就必然要渲一张上限大小的画布。
 * 拿真实上限（1.2 亿像素 ≈ 480MB）跑这条链路，一个测试就能把 worker 拖到超时；
 * 而上限调到 6MP 时链路一模一样，代价只有 24MB。
 * 真实上限下的拦截仍然由 GIANT 那两个用例覆盖。
 */
const TIGHT_LIMIT = 6e6;
const SMALL: [number, number] = [3000, 2000];

describe('调校台 · 内存守卫拦下导出', () => {
  it('默认的 8K 预设会主动压掉超额尺寸 —— 巨图不必一上来就报错', async () => {
    dims = GIANT;
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    // 原始装裱后约 4.8 亿像素，而默认预设会把长边压到 8192，于是落进"偏重"档
    expect(planRow('输出')).toBe('8192 × 6144');
    expect(text()).toContain('变慢');
    expect(exportButton().disabled).toBe(false);
  });

  it('同一张巨图选「原始」就会被真实上限拦下，并说明超了多少', async () => {
    dims = GIANT;
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    await act(async () => {
      findButton('原始').click();
    });

    expect(exportButton().disabled).toBe(true);
    expect(text()).toContain('超出画布安全上限 120MP');
    expect(findButton('压到长边')).toBeTruthy();
  });

  it('预设长边超过原图时不会放大，也就压不住超限', async () => {
    // 8K 的上限是 8192，但源图只有 3000 —— 预设此时等于"原始"
    dims = SMALL;
    await mount(<Harness onQueue={(q) => (latestQueue = q)} renderLimit={TIGHT_LIMIT} />);
    await seedImage(latestQueue!);

    expect(planRow('输出')).toBe('3000 × 2000');
    expect(exportButton().disabled).toBe(true);
    expect(findButton('压到长边')).toBeTruthy();
  });

  it('按建议一键修正后可以真的导出，文件名用的是修正后的长边', async () => {
    dims = SMALL;
    await mount(<Harness onQueue={(q) => (latestQueue = q)} renderLimit={TIGHT_LIMIT} />);
    await seedImage(latestQueue!);

    expect(exportButton().disabled).toBe(true);

    await act(async () => {
      findButton('压到长边').click();
    });

    expect(exportButton().disabled).toBe(false);
    expect(text()).toContain('取消尺寸修正');
    // 修正之后警告必须整条消失。只把按钮点亮是不够的 ——
    // 点完还挂着黄色"偏重"，用户会以为没修好（'ok' 档不渲染提示条，
    // 所以"读不到警告文案"本身就是信号）。
    expect(text()).not.toContain('超出画布安全上限');
    expect(text()).not.toContain('变慢');
    // 给的是"余量充足"档的尺寸，不是贴着上限的尺寸
    expect(framedMegapixels()).toBeLessThanOrEqual((TIGHT_LIMIT / 1e6) * HEAVY_LOAD);

    const planned = shownFilename();
    const longSide = Number(/_(?<side>\d+)px\.jpg$/.exec(planned)?.groups?.side);
    expect(longSide).toBeGreaterThan(1000);
    expect(longSide).toBeLessThan(3000);

    await act(async () => {
      exportButton().click();
    });
    await waitForExportDone();

    expect(downloads[0]).toBe(planned);
    expect(text()).toContain('已导出');
  });

  it('取消修正后回到被拦下的状态', async () => {
    dims = SMALL;
    await mount(<Harness onQueue={(q) => (latestQueue = q)} renderLimit={TIGHT_LIMIT} />);
    await seedImage(latestQueue!);

    await act(async () => {
      findButton('压到长边').click();
    });
    expect(exportButton().disabled).toBe(false);

    await act(async () => {
      findButton('取消尺寸修正').click();
    });
    expect(exportButton().disabled).toBe(true);
    expect(text()).toContain('超出画布安全上限');
  });

  it('切换尺寸预设会作废之前的修正值', async () => {
    dims = SMALL;
    await mount(<Harness onQueue={(q) => (latestQueue = q)} renderLimit={TIGHT_LIMIT} />);
    await seedImage(latestQueue!);

    await act(async () => {
      findButton('压到长边').click();
    });
    expect(text()).toContain('取消尺寸修正');

    // 手选 2K 之后，守卫给的修正值不该继续生效
    await act(async () => {
      findButton('2K').click();
    });
    expect(text()).not.toContain('取消尺寸修正');
    expect(exportButton().disabled).toBe(false);
    // 走的是 2K，不是修正值
    expect(shownFilename()).toContain('_2048px.jpg');
  });
});

describe('调校台 · 与验证台共享队列', () => {
  it('切到验证台再切回来，队列里的图还在', async () => {
    await mount(<App />);

    // 通过全局粘贴入口送一张图进队列，避免依赖 App 内部的 hook 实例
    await act(async () => {
      window.dispatchEvent(
        Object.assign(new Event('paste'), {
          clipboardData: { files: [file('scan.tif')] },
        }),
      );
    });
    await waitFor(() => text().includes('scan.tif'), { label: '粘贴的图进入队列' });
    await waitFor(() => exportButton().disabled === false, { label: '粘贴的图解码完成' });

    await act(async () => {
      findButton('材质验证台').click();
    });
    expect(text()).toContain('1:1 取样放大镜');
    // 队列在 App 层，切视图不该清空
    expect(text()).toContain('scan.tif');

    await act(async () => {
      findButton('回到调校台').click();
    });
    expect(text()).toContain('画廊装裱调校台');
    expect(text()).toContain('scan.tif');
    expect(exportButton().disabled).toBe(false);
  });
});
