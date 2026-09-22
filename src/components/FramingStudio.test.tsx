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
import { PREVIEW_INSET } from './previewFit';
import { ASPECT_OPTIONS } from './aspects';
import { DEFAULT_QUALITY, EXPORT_FORMATS, type ExportFormatId } from './exportFormat';
import { useFramingSettings } from './framingSettings';
import { PRESET_STORAGE_KEY } from './presets';

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
  // 装裱设置住在 App（framingSettings.ts），测试里由这个薄壳替 App 提供同一份
  const settings = useFramingSettings();
  useEffect(() => {
    onQueue(queue);
  });
  return <FramingStudio queue={queue} settings={settings} renderLimit={renderLimit} />;
}

/** 记录每次解码分配的位图，用于断言"该释放的有没有释放"。 */
let closeCalls = 0;
/** 每次 createImageBitmap 返回的位图尺寸 */
let dims: [number, number] = [2000, 1500];
/** 下载记录 */
let downloads: string[] = [];
/** createObjectURL 的调用次数 */
let objectUrls = 0;
/** 解码替身本体。单个用例可以改它的某一次返回值 */
let decodeBitmap: ReturnType<typeof vi.fn>;

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

  // 留住引用：单个用例要按顺序换掉其中某一次的返回值（比如让第二张解码失败）
  decodeBitmap = vi.fn(async () => makeBitmap(dims[0], dims[1]));
  vi.stubGlobal('createImageBitmap', decodeBitmap);
  // 预设存在 localStorage 里，用例之间必须清干净，否则上一条的预设会出现在下一条的列表里
  window.localStorage.clear();
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

  // 批量导出同样是异步的，超时不会让它停下 —— 拆组件前也得等它收尾
  await waitFor(() => !text().includes('中断导出'), {
    timeout: 8000,
    label: '等仍在进行的批量导出收尾',
  }).catch(() => undefined);

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

/** 从状态条读出引擎渲染出来的成品画布尺寸。 */
function frameBox(): { w: number; h: number } {
  const match = /外框\s+(\d+)\s*×\s*(\d+)/.exec(text());
  if (!match) throw new Error('读不到成品外框尺寸');
  return { w: Number(match[1]), h: Number(match[2]) };
}

/** 等一次导出彻底走完：状态条出现结论，按钮回到可点。 */
async function waitForExportDone(): Promise<void> {
  await waitFor(() => downloads.length > 0, { label: '下载被触发' });
  await waitFor(() => exportButton().disabled === false, { label: '导出按钮恢复可点' });
}

function batchButton(): HTMLButtonElement {
  const buttons = Array.from(container?.querySelectorAll('button') ?? []);
  const match = buttons.find((button) =>
    /导出全部|中断导出|没有可导出的素材/.test(button.textContent ?? ''),
  );
  if (!match) throw new Error('找不到批量导出按钮');
  return match as HTMLButtonElement;
}

/** 整批只有一段进行中的文案，等它消失就是收尾了。 */
async function waitForBatchSettled(expected: number): Promise<void> {
  await waitFor(() => downloads.length >= expected || text().includes('张失败'), {
    label: '批量导出产生结果',
  });
  await waitFor(() => !text().includes('中断导出'), { timeout: 8000, label: '批量收尾' });
}

/** 连喂 N 张，等到全部就绪。 */
async function seedImages(queue: ImageQueueApi, count: number): Promise<void> {
  const files = Array.from({ length: count }, (_, index) => file(`scan-${index + 1}.tif`));
  await act(async () => {
    queue.ingestFiles(files);
  });
  await waitFor(() => latestQueue?.items.every((item) => item.status === 'ready') === true, {
    label: `${count} 张全部解码完成`,
  });
}

function file(name = 'portra400.tif', type = 'image/tiff'): File {
  return new File(['x'], name, { type });
}

/**
 * 按 Slider 的名字定位它的 range。
 *
 * 面板里有十几个 range（边距、纹理、钢印…），只能按它所在 label 的名字定位。
 * `Slider` 的结构是 `label > span > span` 为名字，所以取第一个嵌套 span。
 */
function sliderByLabel(label: string): HTMLInputElement | null {
  for (const node of Array.from(container?.querySelectorAll('label') ?? [])) {
    if (node.querySelector('span > span')?.textContent?.trim() !== label) continue;
    const input = node.querySelector<HTMLInputElement>('input[type="range"]');
    if (input) return input;
  }
  return null;
}

/** 读某个 Slider 右上角的读数（名字右边那个 span），用来断言值真的变了。 */
function sliderReadout(label: string): string {
  for (const node of Array.from(container?.querySelectorAll('label') ?? [])) {
    if (node.querySelector('span > span')?.textContent?.trim() !== label) continue;
    const spans = node.querySelectorAll('span > span');
    const readout = spans[spans.length - 1]?.textContent?.trim();
    if (readout) return readout;
  }
  throw new Error(`读不到滑杆读数：${label}`);
}

/**
 * 拖动滑杆。
 *
 * 受控 input 不能直接赋 `.value` —— React 在元素实例上装了 value 的 setter，
 * 直接赋值会被它记成"没变过"，onChange 根本不触发。必须绕到原型上的原生
 * setter，再派发 input 事件。
 */
async function dragSlider(label: string, value: number): Promise<void> {
  const input = sliderByLabel(label);
  if (!input) throw new Error(`找不到滑杆：${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('拿不到 value 的原生 setter');
  await act(async () => {
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * 通过全局粘贴入口送一张图进队列。
 *
 * 走粘贴而不是 App 内部的 hook 实例：这条路径不依赖任何组件内部结构，
 * 与用户真实的入口一致。
 */
async function pasteImage(name = 'scan.tif'): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      Object.assign(new Event('paste'), {
        clipboardData: { files: [file(name)] },
      }),
    );
  });
  await waitFor(() => text().includes(name), { label: '粘贴的图进入队列' });
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

  /**
   * 顶栏的版本标记。
   *
   * 它存在的唯一目的是"一眼看出线上跑的是哪一版"，所以两件事都不能错：
   * 值必须来自注入（与 package.json 同源），且不能再出现写死的阶段编号 ——
   * 上一版就挂着"阶段 4"，而阶段 5 与 v1.2 都上线了它还没变。
   *
   * 说明一句：这条断言能挡住"又把标记写死回去"，但挡不住"写死的值恰好等于
   * 版本号"。单源性靠的是 vite.config.ts 里那处 define，不是这条测试。
   */
  it('顶栏挂的是注入的版本号，不是写死的阶段编号', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);

    expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+$/);
    expect(text()).toContain(`画廊装裱调校台 · v${__APP_VERSION__}`);
    expect(text()).not.toContain('阶段');
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

describe('调校台 · 预览尺寸', () => {
  /**
   * 复现用户报的"整个画面下边看不到"。
   *
   * 引擎渲出来的画布是按像素尺寸定的（短边 1200，成品约 1450 × 1180），
   * 直接交给 CSS 就是一张比视口还高的图：它会把整列撑出 h-screen，
   * 底部连同状态条一起掉出可视区。
   */
  it('成品按可用区域缩放，画布的显示尺寸绝不超出背板', async () => {
    // jsdom 没有布局引擎，clientWidth/clientHeight 恒为 0。
    // 给它两个确定的数才谈得上验证"量出来的空间真的被用上了"。
    // 用覆盖自身属性而不是 spyOn：这两个 getter 挂在 Element.prototype 上，
    // 在 HTMLElement.prototype 上加一层再删掉，语义最直白。
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });

    try {
      await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
      await seedImage(latestQueue!);
      await waitFor(() => frameBox().w > 0, { label: '预览渲染出成品' });

      const canvas = container?.querySelector('canvas');
      if (!canvas) throw new Error('找不到预览画布');

      const frame = frameBox();
      // 画布自身的像素尺寸在这一档是短边 1200，远大于可用区域
      expect(canvas.width).toBeGreaterThan(800);

      const shownW = Number.parseFloat(canvas.style.width);
      const shownH = Number.parseFloat(canvas.style.height);
      // 背板每侧还要留出描边与投影的余量，那条 1px 描边才不会被裁掉
      const availableW = 800 - PREVIEW_INSET * 2;
      const availableH = 600 - PREVIEW_INSET * 2;

      expect(shownW).toBeGreaterThan(0);
      expect(shownW).toBeLessThanOrEqual(availableW);
      expect(shownH).toBeLessThanOrEqual(availableH);
      // 受限的那一条边要用满，否则是白白浪费背板空间
      expect(shownW === availableW || shownH === availableH).toBe(true);
      // 等比缩放，画面不会被拉变形
      expect(Math.abs(shownW / shownH - frame.w / frame.h)).toBeLessThan(0.005);
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }
  });
});

/**
 * 画框构图档（含竖屏）。
 *
 * 竖屏是这一版的重点：引擎一直支持（`targetAspect` 就是「宽 / 高」，只要求为正），
 * 缺的只是界面入口。所以这里要防的不是"算不出来"，而是**入口接错** ——
 * 比例值写反、只有预览转了而导出规格没转、或者构图档顺手把输出像素也改了。
 */
describe('调校台 · 画框构图（横竖）', () => {
  /** 比例按钮的标签是 "3 : 4" 这种短串，按 hint 值精确找（hint 就在 title 上）。 */
  function aspectButton(label: string): HTMLButtonElement {
    const option = ASPECT_OPTIONS.find((entry) => entry.label === label);
    if (!option) throw new Error(`没有这个比例档：${label}`);
    const match = container?.querySelector<HTMLButtonElement>(`button[title="${option.hint}"]`);
    if (!match) throw new Error(`找不到比例按钮：${label}`);
    return match;
  }

  /** 从面板的「装裱外框」行取出 W / H。 */
  function plannedFramedRatio(): number {
    const [w, h] = planRow('装裱外框')
      .split('（')[0]
      .split('×')
      .map((part) => Number(part.trim()));
    return w / h;
  }

  it('选 3 : 4 后成品转成竖的，面板规格与预览是同一个比例', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);
    await waitFor(() => frameBox().w > 0, { label: '预览渲染出成品' });

    // 默认自适应：3:2 的横片装出来还是横的
    expect(frameBox().w).toBeGreaterThan(frameBox().h);

    await act(async () => {
      aspectButton('3 : 4').click();
    });
    await waitFor(() => frameBox().h > frameBox().w, { label: '外框转成竖的' });

    const preview = frameBox();
    expect(preview.w / preview.h).toBeCloseTo(0.75, 2);
    // 面板上的导出规格要是同一个比例 —— 两处各算一遍的话，用户会看到
    // "预览是竖的、导出规格却是横的"这种自相矛盾的画面
    expect(plannedFramedRatio()).toBeCloseTo(0.75, 2);

    // 构图档改的是外框，不是输出像素 —— 素材还是那个素材
    expect(planRow('输出')).toBe('2000 × 1500');
  });

  it('9 : 16 把底边留白撑得很宽，但照片本身不被裁', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);
    await waitFor(() => frameBox().w > 0, { label: '预览渲染出成品' });

    await act(async () => {
      aspectButton('9 : 16').click();
    });
    await waitFor(() => frameBox().h > frameBox().w * 1.5, { label: '外框变成很长的竖条' });

    expect(plannedFramedRatio()).toBeCloseTo(9 / 16, 2);
    // 外框变高了，而输出像素没变 —— 多出来的全是卡纸，照片完整无裁切
    expect(planRow('输出')).toBe('2000 × 1500');
  });

  it('切回自适应能回到原始比例', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);
    await waitFor(() => frameBox().w > 0, { label: '预览渲染出成品' });

    await act(async () => {
      aspectButton('3 : 4').click();
    });
    await waitFor(() => frameBox().h > frameBox().w, { label: '外框转成竖的' });

    await act(async () => {
      aspectButton('自适应').click();
    });
    await waitFor(() => frameBox().w > frameBox().h, { label: '外框回到横向' });
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

/**
 * 调校台 · 导出格式与质量（数字输出）。
 *
 * 断言分两层，缺一层都不算钉住：
 * 1. **界面上**：选 PNG 之后质量滑杆必须消失 —— `toBlob` 会静默忽略 PNG 的
 *    质量参数，留一个拖了没反应的控件会让用户以为"调到 90% 文件就小了"。
 * 2. **到编码器**：真正交给 `toBlob` 的 MIME 与质量，必须就是面板上那一个。
 *    只断言下载文件名是不够的 —— 文件名说 .png、编码却编成 JPEG 也照样"过"。
 */
describe('调校台 · 导出格式与质量', () => {
  /**
   * 按 `title` 精确找按钮。
   *
   * 格式按钮的标签只有 "JPEG" / "PNG" 四个字符，用 `findButton` 的文字包含匹配
   * 迟早会撞上别处的文案；而 `ChoiceGrid` 恰好把说明挂在 `title` 上。
   * 这里直接从 `EXPORT_FORMATS` 取说明，于是**改文案不会弄坏测试**，精确性也保住了。
   */
  function formatButton(id: ExportFormatId): HTMLButtonElement {
    const format = EXPORT_FORMATS.find((entry) => entry.id === id);
    if (!format) throw new Error(`没有这个格式：${id}`);
    const match = container?.querySelector<HTMLButtonElement>(`button[title="${format.hint}"]`);
    if (!match) throw new Error(`找不到格式按钮：${id}`);
    return match;
  }

  /**
   * 质量滑杆。
   *
   * PNG 下整块不渲染，所以这里要能表达"它不存在" —— 返回 null 而不是抛错。
   */
  function qualitySlider(): HTMLInputElement | null {
    return sliderByLabel('质量');
  }

  /** 拖动质量滑杆。受控 range 的拖法见模块层的 dragSlider。 */
  async function dragQuality(value: number): Promise<void> {
    await dragSlider('质量', value);
  }

  /** 最近一次编码实际用的 MIME 与质量。canvasHarness 已把 toBlob 换成了 spy。 */
  function lastEncoding(): { type: string | undefined; quality: number | undefined } {
    const calls = vi.mocked(HTMLCanvasElement.prototype.toBlob).mock.calls;
    if (calls.length === 0) throw new Error('没有发生任何画布编码');
    const last = calls[calls.length - 1];
    return { type: last[1], quality: last[2] };
  }

  beforeEach(() => {
    // 同文件里多个用例共用这一个 spy，不清就会读到上一条的调用
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockClear();
  });

  it('默认 JPEG：滑杆在，文件名 .jpg，编码器拿到 image/jpeg', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    expect(formatButton('jpeg').className).toContain('border-white');
    expect(qualitySlider()).not.toBeNull();
    expect(shownFilename().endsWith('.jpg')).toBe(true);

    await act(async () => {
      exportButton().click();
    });
    await waitForExportDone();

    expect(downloads[0]).toBe(shownFilename());
    expect(lastEncoding()).toEqual({ type: 'image/jpeg', quality: DEFAULT_QUALITY });
  });

  it('选 PNG：文件名变 .png、质量滑杆消失、编码走无损', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    await act(async () => {
      formatButton('png').click();
    });

    expect(shownFilename().endsWith('.png')).toBe(true);
    // 拖了没反应的控件比不摆更糟，所以这里断言的是"它不存在"
    expect(qualitySlider()).toBeNull();

    await act(async () => {
      exportButton().click();
    });
    await waitForExportDone();

    expect(downloads[0].endsWith('.png')).toBe(true);
    expect(downloads[0]).toBe(shownFilename());
    /*
     * 这里只断言 MIME，不断言质量。
     *
     * PNG 确实拿到了一个质量数字（0.98），但它来自**引擎自己的默认值**：
     * 那边写的是 `const { quality = 0.98 } = exportOpts`，而解构默认值连显式
     * 传入的 undefined 也会补上。规范规定 PNG 忽略这个参数，所以画面不受影响。
     * 把它钉在这里只会变成一条"改动引擎默认值就红"的噪音 ——
     * "无损格式没有质量"这条契约的观察点在 `ExportPlan.quality`，
     * 由 exportPlan.test.ts 断言。
     */
    expect(lastEncoding().type).toBe('image/png');
  });

  it('拖质量滑杆，传给编码器的就是那个值', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    await dragQuality(0.72);
    expect(text()).toContain('72%');

    await act(async () => {
      exportButton().click();
    });
    await waitForExportDone();

    expect(lastEncoding().quality).toBe(0.72);
    // 质量不影响文件名与尺寸，面板上写的名字仍然要能对上
    expect(downloads[0]).toBe(shownFilename());
  });

  it('PNG 来回切一次，之前调好的质量还在', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    await dragQuality(0.72);

    await act(async () => {
      formatButton('png').click();
    });
    expect(qualitySlider()).toBeNull();

    await act(async () => {
      formatButton('jpeg').click();
    });
    // 切格式不该顺手丢掉用户的设置 —— PNG 下没有质量可调，重置等于凭空扣一次
    expect(text()).toContain('72%');
  });

  it('批量导出也跟着格式走，整批一起变 .png', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImages(latestQueue!, 2);

    await act(async () => {
      formatButton('png').click();
    });

    await act(async () => {
      batchButton().click();
    });
    await waitForBatchSettled(2);

    expect(downloads).toHaveLength(2);
    // 面板写着 PNG、点"导出全部"却拿到一批 .jpg —— 这是最尴尬的一种不一致
    expect(downloads.every((name) => name.endsWith('.png'))).toBe(true);
    expect(new Set(downloads).size).toBe(2);
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

describe('调校台 · 批量导出', () => {
  it('队列里三张一次导完，每张都写盘、都释放', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImages(latestQueue!, 3);

    expect(text()).toContain('可导出 3 张');
    expect(text()).not.toContain('跳过');

    const closesBefore = closeCalls;

    await act(async () => {
      batchButton().click();
    });
    await waitForBatchSettled(3);

    expect(downloads).toHaveLength(3);
    // 三个文件名互不相同 —— 同名扫描件进同一个目录会互相覆盖
    expect(new Set(downloads).size).toBe(3);
    expect(downloads.every((name) => name.endsWith('_2000px.jpg'))).toBe(true);

    // 每张各自重解一次原图、各自释放一次。
    // 少一次就是泄漏，多一次就是重复释放，两种都会在这里现形。
    expect(closeCalls - closesBefore).toBe(3);
    expect(objectUrls).toBe(3);
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledTimes(3);

    expect(text()).toContain('已导出 3 张');
    expect(text()).toContain('浏览器下载');
  });

  it('中间一张坏掉时只跳过它，后面的照导', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImages(latestQueue!, 3);

    const closesBefore = closeCalls;

    // 队列解码已经用掉三次；下面三次依次是这三张的导出重解
    decodeBitmap.mockImplementationOnce(async () => makeBitmap(dims[0], dims[1]));
    decodeBitmap.mockImplementationOnce(async () => {
      throw new Error('文件已损坏，无法重解');
    });
    decodeBitmap.mockImplementationOnce(async () => makeBitmap(dims[0], dims[1]));

    await act(async () => {
      batchButton().click();
    });
    await waitForBatchSettled(2);

    expect(downloads).toHaveLength(2);
    expect(text()).toContain('已导出 2 张');
    expect(text()).toContain('1 张失败');
    expect(text()).toContain('scan-2.tif');
    expect(text()).toContain('文件已损坏，无法重解');
    // 失败的那张根本没解出位图，所以只应该有两次释放；
    // 若多出一次，说明我们在给一张不存在的东西做释放
    expect(closeCalls - closesBefore).toBe(2);
    expect(exportButton().disabled).toBe(false);
  });

  it('导出进行中锁住队列编辑，结束后恢复', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImages(latestQueue!, 2);

    act(() => {
      batchButton().click();
    });

    // 还没 await，批量正在进行
    expect(text()).toContain('队列已锁定');
    expect(findButton('清空').disabled).toBe(true);
    const lockedRemove = container?.querySelector<HTMLButtonElement>('button[title="导出进行中"]');
    expect(lockedRemove?.disabled).toBe(true);
    // 单张导出也一并挡住：两条路径同时渲染会直接把内存翻倍
    expect(exportButton().disabled).toBe(true);

    await waitForBatchSettled(2);

    expect(text()).not.toContain('队列已锁定');
    expect(findButton('清空').disabled).toBe(false);
    expect(exportButton().disabled).toBe(false);
    expect(latestQueue!.items).toHaveLength(2);
  });

  it('中断后不再开新的一张，已导出的仍然算数', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImages(latestQueue!, 3);

    act(() => {
      batchButton().click();
    });
    // 第一张还没开始渲染，此刻中断
    act(() => {
      batchButton().click();
    });

    await waitForBatchSettled(0);

    expect(downloads).toHaveLength(0);
    expect(text()).toContain('已导出 0 张');
    expect(text()).toContain('已中断');
    expect(text()).not.toContain('中断导出');
  });

  it('整批里有一张超标时给出统一修正，点完两张都能导', async () => {
    // 一张普通、一张巨幅：6MP 上限下只有前者过得去
    decodeBitmap.mockImplementationOnce(async () => makeBitmap(2000, 1500));
    decodeBitmap.mockImplementationOnce(async () => makeBitmap(8000, 6000));

    await mount(<Harness onQueue={(q) => (latestQueue = q)} renderLimit={TIGHT_LIMIT} />);
    await act(async () => {
      latestQueue!.ingestFiles([file('small.tif'), file('giant.tif')]);
    });
    await waitFor(() => latestQueue?.items.every((item) => item.status === 'ready') === true, {
      label: '两张都解码完成',
    });

    expect(text()).toContain('可导出 1 张');
    expect(text()).toContain('跳过 1 张');

    const unified = findButton('统一压到长边');
    await act(async () => {
      unified.click();
    });

    // 同一份修正值要同时满足两张
    expect(text()).toContain('可导出 2 张');
    expect(text()).not.toContain('跳过');

    await act(async () => {
      batchButton().click();
    });
    await waitForBatchSettled(2);
    expect(downloads).toHaveLength(2);
  });
});

describe('调校台 · 预设', () => {
  it('应用预设会换掉整套样式', async () => {
    // 卡纸亮度那一行只在有素材时渲染，所以要先喂一张，断言才有落点
    dims = [3000, 2000];
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    // 默认是博物馆暖白
    expect(text()).toContain('浅色');

    await act(async () => {
      findButton('炭黑展厅').click();
    });

    expect(text()).toContain('深色');
    // 连带把边距等其它参数也一并换掉 —— 预设是整套样式，不是只换颜色
    expect(text()).toContain('18%');
  });

  it('换预设不会抹掉机型与胶卷 —— 那是素材的身份，不是装裱样式', async () => {
    dims = [3000, 2000];
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await seedImage(latestQueue!);

    await act(async () => {
      findButton('炭黑展厅').click();
    });

    await act(async () => {
      exportButton().click();
    });
    await waitForExportDone();

    // 机型还在导出文件名里，说明预设只换了样式
    expect(downloads[0]).toContain('LEICA-M6');
  });

  it('出厂预设不可删除，用户预设可存可删', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);

    // 四条出厂预设，一条删除按钮都没有
    expect(text()).toContain('博物馆标准');
    expect(text()).toContain('炭黑展厅');
    expect(container?.querySelectorAll('button[title="删除这条预设"]')).toHaveLength(0);

    await act(async () => {
      findButton('存为预设').click();
    });

    // 没填名字时用兜底名
    expect(text()).toContain('我的预设 1');
    const deletions =
      container?.querySelectorAll<HTMLButtonElement>('button[title="删除这条预设"]');
    expect(deletions).toHaveLength(1);

    // 存下去就该真的落盘
    const stored = JSON.parse(window.localStorage.getItem(PRESET_STORAGE_KEY) ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('我的预设 1');

    await act(async () => {
      deletions![0].click();
    });
    expect(text()).not.toContain('我的预设 1');
    expect(JSON.parse(window.localStorage.getItem(PRESET_STORAGE_KEY) ?? '[]')).toEqual([]);
  });

  it('刷新后（重新挂载）上次存的预设还在', async () => {
    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    await act(async () => {
      findButton('存为预设').click();
    });
    expect(text()).toContain('我的预设 1');

    // 模拟一次刷新：拆掉再装一份
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;

    await mount(<Harness onQueue={(q) => (latestQueue = q)} />);
    expect(text()).toContain('我的预设 1');
  });
});

describe('调校台 · 与验证台共享队列', () => {
  it('切到验证台再切回来，队列里的图还在', async () => {
    await mount(<App />);

    // 通过全局粘贴入口送一张图进队列，避免依赖 App 内部的 hook 实例
    await pasteImage();
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

describe('调校台 · 与验证台共享装裱设置', () => {
  /**
   * 这一组是"切视图丢设置"的验收条件。
   *
   * 切视图在 App 里是**卸载重建**（按 view 直接分支返回），队列早就因此被抬到了
   * App，但装裱配方与导出设置那时留在组件里 —— 去验证台看一眼放大镜再回来，
   * 边距、构图档、导出尺寸、格式、质量全部回默认。四处断言分别盯住四种 state，
   * 且都通过**真实算出来的结果**观察（导出行、文件名、滑杆读数），
   * 而不是"某个 state 变量还在不在"。
   */
  it('切到验证台再切回来，装裱配方与导出设置都还在', async () => {
    // 3000 × 2000 才让"2K 档"与"8K 档"的导出行不同，否则只降不升，两者都是 3000
    dims = [3000, 2000];
    await mount(<App />);
    await pasteImage();
    expect(planRow('输出')).toBe('3000 × 2000');

    // 四样分属不同 state 的设置，一次改齐
    await act(async () => {
      findButton('1 : 1').click();
    });
    await dragSlider('卡纸边距', 0.22);
    await dragSlider('质量', 0.72);
    await act(async () => {
      findButton('2K').click();
    });
    expect(planRow('输出')).toBe('2048 × 1365');
    await act(async () => {
      findButton('PNG').click();
    });
    expect(shownFilename().endsWith('.png')).toBe(true);

    await act(async () => {
      findButton('材质验证台').click();
    });
    expect(text()).toContain('1:1 取样放大镜');
    await act(async () => {
      findButton('回到调校台').click();
    });

    // 从前这四行分别是：3000 × 2000、14%、.jpg、自适应
    expect(planRow('输出')).toBe('2048 × 1365');
    expect(sliderReadout('卡纸边距')).toBe('22%');
    expect(shownFilename().endsWith('.png')).toBe(true);
    expect(findButton('1 : 1').className).toContain('border-white');

    // 质量在 PNG 下没有控件（toBlob 会静默忽略它），切回 JPEG 才看得见 —— 它也必须还在。
    // 这一条同时证明了"切格式不重置质量"在跨视图之后依然成立。
    await act(async () => {
      findButton('JPEG').click();
    });
    expect(sliderReadout('质量')).toBe('72% · 明显压缩');
  });

  it('在验证台里调材质，切回调校台跟着变 —— 两边是同一份配方', async () => {
    await mount(<App />);
    expect(sliderReadout('纸张颗粒强度')).toBe('0.040');

    await act(async () => {
      findButton('材质验证台').click();
    });
    // 验证台的滑杆上限只到 0.08，调校台到 0.1 —— 取一个两边都成立的值
    await dragSlider('纸纤维强度', 0.075);
    expect(sliderReadout('纸纤维强度')).toBe('0.075');

    await act(async () => {
      findButton('回到调校台').click();
    });
    // 从前这里是 0.040：验证台自己一份 config，那边调完切回来就丢
    expect(sliderReadout('纸张颗粒强度')).toBe('0.075');
  });

  it('导出进行中不能切到验证台 —— 导出循环不会随视图切换停下', async () => {
    dims = [3000, 2000];
    await mount(<App />);
    await pasteImage();
    await waitFor(() => exportButton().disabled === false, { label: '粘贴的图解码完成' });
    await act(async () => {
      findButton('2K').click();
    });

    const entry = findButton('材质验证台');
    expect(entry.disabled).toBe(false);

    // 同步的 act：导出内部先 await 一个 24ms 的 setTimeout，
    // 而它不会在同步冲刷里被推进 —— 这里读到的必然是"导出进行中"那一帧
    act(() => {
      exportButton().click();
    });
    expect(text()).toContain('正在渲染');

    const busyEntry = findButton('材质验证台');
    expect(busyEntry.disabled).toBe(true);
    expect(busyEntry.getAttribute('title')).toContain('导出进行中');

    // 等终态再结束，否则残留的导出回调会污染后续用例
    await waitForExportDone();
    expect(findButton('材质验证台').disabled).toBe(false);
  });
});
