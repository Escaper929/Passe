/**
 * 画廊装裱调校台 —— 正式工作界面。
 *
 * 与材质验证台的分工：验证台用来判断"材质像不像真的"（逐层开关、1:1 放大镜），
 * 调校台用来把一张照片调成成品并导出。两者共用同一个引擎和同一份输入队列。
 *
 * 相比开发指南 §4 的原始版本，这里做了五处必要的改动：
 * 1. 预览走降采样副本。原版把原图直接交给渲染器，8K 扫描件拖一次滑杆要重绘上亿像素。
 * 2. 补上 §4 遗漏的三个参数：纸张颗粒强度、内阴影半径、斜切宽度 —— FrameConfig 里
 *    定义了却没有控件，等于用户永远调不到。
 * 3. 预览背板跟随卡纸亮度翻转。深色工作台配炭黑卡纸时成品边界会整个消失。
 * 4. 导出前过一遍内存守卫，并在导出时按需重解原图、用完立刻释放。
 * 5. 预览画布的显示尺寸自己算。原版指望 CSS 的 max-height/max-width 把它压进容器，
 *    但画布是替换元素、而外层高度是按内容撑开的（详见 previewFit.ts），
 *    结果是成品把整列顶出 h-screen，底部连同状态条一起掉到视口外。
 *
 * 阶段 4 又加了两块：装裱预设（presets.ts）与批量导出（batchPlan / batchExport /
 * exportSink）。两者都以"不越权"为原则 —— 预设不碰机型与胶卷，批量导出按开始时
 * 的队列清单办事，并在进行期间把队列编辑锁上。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChoiceGrid, Section, Slider, TextField, ToggleRow } from '@/components/controls';
import { GalleryFramingEngine, saveBlob } from '@/engine/GalleryFramingEngine';
import { analyzeSurface, MATBOARD_PRESETS } from '@/engine/palette';
import { createPreviewSource, hasImageFile } from '@/engine/source';
import type { FrameConfig, LayerToggles, RenderSource } from '@/engine/types';
import { reopenFullResolution } from '@/input/decode';
import { formatMemory } from '@/input/budget';
import ImageTray from '@/input/ImageTray';
import { disposeSource } from '@/input/queue';
import type { ImageQueueApi } from '@/input/useImageQueue';
import { FILE_INPUT_ACCEPT } from '@/input/validate';

import { buildBatchPlan } from './batchPlan';
import {
  runBatchExport,
  type BatchJob,
  type BatchOutcome,
  type BatchProgress,
} from './batchExport';
import { ASPECT_OPTIONS } from './aspects';
import {
  DEFAULT_EXPORT_FORMAT_ID,
  DEFAULT_QUALITY,
  EXPORT_FORMATS,
  QUALITY_MAX,
  QUALITY_MIN,
  QUALITY_STEP,
  describeQuality,
  resolveExportFormat,
  type ExportFormatId,
} from './exportFormat';
import { buildExportPlan, DEFAULT_EXPORT_SIZE_ID, EXPORT_SIZES } from './exportPlan';
import { createExportSink } from './exportSink';
import { previewBacking } from './previewBacking';
import { fitPreview } from './previewFit';
import {
  allPresets,
  applyPreset,
  createUserPreset,
  loadUserPresets,
  nextPresetId,
  saveUserPresets,
  type StudioPreset,
} from './presets';

/**
 * 实时预览的短边上限。
 *
 * 与导出尺寸完全解耦：所有线宽都由 scaleFactor 推导，
 * 所以 1200px 预览和 8K 成品的比例严格一致。
 */
const PREVIEW_SHORT_SIDE = 1200;

/**
 * 成品与背板之间强行留出的余量（每一侧）。
 *
 * 描边和投影是画在元素盒子**外面**的，背板的 `overflow-hidden` 会把贴着边的那一侧
 * 整条裁掉 —— 而贴着边的那一侧恰恰是成品与背板相接的地方，正是最需要那条 1px
 * 中性描边来分界的位置。留 4px 就足够让它露出来。
 */
export const PREVIEW_INSET = 4;

const INITIAL_CONFIG: FrameConfig = {
  matColor: '#F8F7F3',
  marginRatio: 0.14,
  bottomWeight: 1.25,
  targetAspect: null,
  paperTextureIntensity: 0.04,
  bevelWidth: 2.5,
  insetShadowBlur: 6,
  stampDepth: 1.2,
  enableStamp: true,
  cameraModel: 'LEICA M6',
  filmBrand: 'KODAK PORTRA 400',
};

export interface FramingStudioProps {
  queue: ImageQueueApi;
  /** 切到材质验证台。用户判断质感时要用那台 1:1 放大镜 */
  onOpenLab?: () => void;
  /**
   * 画布像素安全上限，默认 MAX_CANVAS_PIXELS（1.2 亿）。
   *
   * 与 `assessFrame` / `buildExportPlan` 的 `limit` 是同一个口径，
   * 在这里接出来是为了两条路：小内存设备可以调低；
   * 测试可以把它调小，从而用一张几十像素的替身图走完
   * "被守卫拦下 → 一键修正 → 真的导出成功"这条全链路 ——
   * 否则要触发一次真实的拦截，就得老老实实渲一张 1.2 亿像素的画布。
   */
  renderLimit?: number;
}

export function FramingStudio({ queue, onOpenLab, renderLimit }: FramingStudioProps) {
  const [config, setConfig] = useState<FrameConfig>(INITIAL_CONFIG);
  const [sizeId, setSizeId] = useState(DEFAULT_EXPORT_SIZE_ID);
  /**
   * 导出格式与 JPEG 质量。
   *
   * 质量单独存一份（而不是塞进格式里）：切到 PNG 再切回来时，用户之前选的质量
   * 应当还在，而不是被重置成默认值 —— 那是同一个"别抹掉用户输入"的原则。
   * 切换格式**不**重置质量，是因为 PNG 下没有质量可调，重置等于凭空丢一次设置。
   */
  const [formatId, setFormatId] = useState<ExportFormatId>(DEFAULT_EXPORT_FORMAT_ID);
  const [jpegQuality, setJpegQuality] = useState(DEFAULT_QUALITY);
  /** 守卫的建议值或用户手动指定，优先于 sizeId */
  const [overrideMaxDimension, setOverrideMaxDimension] = useState<number | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  /** 批量导出的进行状态。null 表示没在批量 */
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [isBatching, setIsBatching] = useState(false);
  /** 批量导出的汇总。跑完一次就一直留着，直到下次导出 */
  const [batchOutcome, setBatchOutcome] = useState<BatchOutcome | null>(null);
  const [userPresets, setUserPresets] = useState<StudioPreset[]>(() => loadUserPresets());
  const [presetName, setPresetName] = useState('');
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  /** 预览背板能给成品的净空间（CSS 像素）。0 表示还没量出来 */
  const [previewBox, setPreviewBox] = useState({ w: 0, h: 0 });
  // 钢印用的是系统字体。字体没就绪前渲染，文字会以兜底字体画进画布 —— 那是一张错的成品图
  const [fontsReady, setFontsReady] = useState(
    () => typeof document === 'undefined' || !document.fonts,
  );

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 预览背板本身。量的是它，而不是画布 —— 画布尺寸由这个结果决定，量它会形成回环 */
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * 批量导出的中断标志。
   *
   * 用 ref 而不是 state：循环每张开始前读一次，走 state 会读到闭包里的旧值，
   * 于是"点了中断却继续导完剩下八张"。而且改它不需要触发重渲染。
   */
  const cancelBatchRef = useRef(false);

  const activeItem = queue.active;
  const activeFile = activeItem?.file ?? null;
  const source: RenderSource | null = activeItem?.status === 'ready' ? activeItem.source : null;
  /**
   * 界面用的格式对象，只用来判断"要不要给质量控件"和取文案。
   * 真正的编码参数取自 `plan`（`mimeType` / `quality`）—— 那里与文件名同源。
   * 两者都由 `resolveExportFormat` 解析，不存在第三处口径。
   */
  const exportFormat = resolveExportFormat(formatId);

  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) return;

    let cancelled = false;
    const markReady = () => {
      if (!cancelled) setFontsReady(true);
    };
    fonts.ready.then(markReady).catch(markReady);

    return () => {
      cancelled = true;
    };
  }, []);

  const previewSource = useMemo(
    () => (source ? createPreviewSource(source, PREVIEW_SHORT_SIDE) : null),
    [source],
  );

  /**
   * 量出成品可用的净空间。
   *
   * 量的是背板 —— 它的尺寸由 flex 布局决定，和画布无关。反过来量画布会形成回环：
   * 画布一大就把测量对象一起撑大，于是永远缩不下去，这正是原先的故障。
   */
  useEffect(() => {
    const box = previewBoxRef.current;
    if (!box) return;

    const measure = () => setPreviewBox({ w: box.clientWidth, h: box.clientHeight });
    measure();

    // jsdom 与老浏览器没有 ResizeObserver，退回监听窗口尺寸
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  /**
   * 画布最终的显示尺寸。
   *
   * frameSize 是引擎渲染出来的画布像素尺寸（短边 1200），按可用空间等比缩小后，
   * 成品必然落在背板之内 —— "整幅画面都看得到"由这段算术保证，而不是指望浏览器
   * 把那串百分比高度解开。
   */
  const previewFit = useMemo(
    () =>
      fitPreview({
        boxWidth: Math.max(0, previewBox.w - PREVIEW_INSET * 2),
        boxHeight: Math.max(0, previewBox.h - PREVIEW_INSET * 2),
        imageWidth: frameSize.w,
        imageHeight: frameSize.h,
      }),
    [previewBox, frameSize],
  );

  useEffect(() => {
    if (!previewSource || !fontsReady) return;

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const canvas = previewCanvasRef.current;
      if (!canvas) return;

      try {
        const rendered = GalleryFramingEngine.render(previewSource, config, canvas);
        setFrameSize({ w: rendered.width, h: rendered.height });
        setRenderError(null);
      } catch (error) {
        setRenderError(error instanceof Error ? error.message : String(error));
      }
    };

    const handle = requestAnimationFrame(run);
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [previewSource, config, fontsReady]);

  const patchConfig = useCallback((patch: Partial<FrameConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const patchLayer = useCallback((key: keyof LayerToggles, value: boolean) => {
    setConfig((prev) => ({
      ...prev,
      layers: { ...prev.layers, [key]: value },
    }));
  }, []);

  const backing = useMemo(() => previewBacking(config.matColor ?? '#F8F7F3'), [config.matColor]);
  const tone = useMemo(
    () => (config.matColor ? analyzeSurface(config.matColor) : null),
    [config.matColor],
  );

  const plan = useMemo(() => {
    if (!activeItem || activeItem.status !== 'ready') return null;
    return buildExportPlan({
      // 必须用**原始**尺寸：导出走的是按需重解的全分辨率原图，
      // 而工作副本已被压到 9MP 以内，拿它去算会低估一个数量级，
      // 守卫就会放行一次注定失败的全分辨率渲染。
      source: { width: activeItem.originalWidth, height: activeItem.originalHeight },
      config,
      sizeId,
      overrideMaxDimension,
      formatId,
      quality: jpegQuality,
      cameraModel: config.cameraModel,
      sourceName: activeItem.name,
      limit: renderLimit,
    });
  }, [activeItem, config, sizeId, overrideMaxDimension, formatId, jpegQuality, renderLimit]);

  const chooseSize = useCallback((next: string) => {
    setSizeId(next);
    // 手选尺寸意味着用户改变了主意，之前守卫给的修正值应当失效
    setOverrideMaxDimension(null);
  }, []);

  /** 导出进行中。队列编辑在此期间必须冻结，理由见 ImageTray 的 locked。 */
  const frozen = isExporting || isBatching;

  /**
   * 整队列的导出方案。
   *
   * 只有一条素材时不算 —— 那种情况的答案单张导出面板已经给了，
   * 而这份方案要遍历整队列，没必要在每拖动一次滑杆时都重算一遍。
   */
  const batchPlan = useMemo(() => {
    if (queue.items.length < 2) return null;
    return buildBatchPlan({
      items: queue.items,
      config,
      sizeId,
      overrideMaxDimension,
      formatId,
      quality: jpegQuality,
      cameraModel: config.cameraModel,
      limit: renderLimit,
    });
  }, [queue.items, config, sizeId, overrideMaxDimension, formatId, jpegQuality, renderLimit]);

  const presets = useMemo(() => allPresets(userPresets), [userPresets]);

  /**
   * 改动用户预设的唯一出口：改状态的同时落盘。
   *
   * 新增与删除都走这里，于是不会出现"加了没存"或"删了没存"这种只发生在一半
   * 路径上的疏漏。写不进去（配额满 / 隐私模式）时如实说，不让用户以为存住了。
   *
   * 刻意不放在 effect 里：那会变成"渲染后同步 setState"，既触发级联渲染，
   * 也会在首次挂载时白白覆盖一次存储。
   */
  const commitPresets = useCallback((next: StudioPreset[]) => {
    setUserPresets(next);
    if (!saveUserPresets(next)) {
      setPresetNote('浏览器拒绝写入本地存储，预设只在本次会话有效。');
    }
  }, []);

  const handleSavePreset = useCallback(() => {
    commitPresets([
      ...userPresets,
      // id 由**现有集合**推导：模块级自增计数器一刷新就从 1 重来，
      // 会和上次存下的那条撞 id
      createUserPreset(
        presetName,
        config,
        nextPresetId(userPresets),
        `我的预设 ${userPresets.length + 1}`,
      ),
    ]);
    setPresetName('');
  }, [commitPresets, presetName, config, userPresets]);

  const handleDeletePreset = useCallback(
    (id: string) => {
      commitPresets(userPresets.filter((preset) => preset.id !== id));
    },
    [commitPresets, userPresets],
  );

  /** 批量中断。只置标志，循环会在下一张开始前退出 —— 正在渲染的那张会跑完。 */
  const handleCancelBatch = useCallback(() => {
    cancelBatchRef.current = true;
  }, []);

  const handleExport = useCallback(async () => {
    if (!plan || !plan.canExport || !source) return;

    setIsExporting(true);
    setExportNote(null);
    // 合成一张 8K 成品是同步的重活，先让浏览器把 loading 状态画出来
    await new Promise((resolve) => setTimeout(resolve, 24));

    let fullResolution: RenderSource | null = null;
    try {
      // 原图不常驻内存，导出这一刻才重新解码。一次只解一张，用完必须释放。
      fullResolution = activeFile ? await reopenFullResolution(activeFile) : source;

      const blob = await GalleryFramingEngine.exportBlob(fullResolution, config, {
        // 编码参数取自 plan，而不是组件 state —— 面板上展示的文件名就是同一个
        // plan 算出来的，两者同源才不会出现"写着 .png、导出却是个 .jpg"
        format: plan.mimeType,
        quality: plan.quality,
        maxDimension: plan.maxDimension ?? undefined,
      });

      saveBlob(blob, plan.filename);
      setExportNote(
        `已导出 ${plan.filename} · 成品 ${plan.framedW} × ${plan.framedH} · ${formatMemory(blob.size)}`,
      );
    } catch (error) {
      setExportNote(error instanceof Error ? error.message : String(error));
    } finally {
      // 只释放我们重解出来的那张；若直接把预览副本当作来源，则不能关
      if (fullResolution && fullResolution !== source) disposeSource(fullResolution);
      setIsExporting(false);
    }
  }, [plan, config, activeFile, source]);

  const handleExportAll = useCallback(async () => {
    if (!batchPlan || batchPlan.exportable.length === 0 || frozen) return;

    const jobs: BatchJob[] = batchPlan.exportable.map((entry) => ({
      id: entry.item.id,
      name: entry.item.name,
      file: entry.item.file,
      filename: entry.filename,
      maxDimension: entry.plan.maxDimension,
      // 编码参数与文件名同源：都来自这一张自己的 plan
      mimeType: entry.plan.mimeType,
      quality: entry.plan.quality ?? null,
    }));

    cancelBatchRef.current = false;
    setBatchOutcome(null);
    setIsBatching(true);
    setBatchProgress({ done: 0, total: jobs.length, current: null });
    // 选文件夹必须落在用户手势的有效期内。这个 await 只有 24ms，
    // 远短于浏览器的瞬时激活窗口，但它同时让按钮的进行态有机会画出来。
    await new Promise((resolve) => setTimeout(resolve, 24));

    try {
      const outcome = await runBatchExport(jobs, {
        sink: createExportSink(),
        reopen: reopenFullResolution,
        render: (source, spec) =>
          GalleryFramingEngine.exportBlob(source, config, {
            format: spec.mimeType,
            quality: spec.quality,
            maxDimension: spec.maxDimension,
          }),
        dispose: disposeSource,
        onProgress: setBatchProgress,
        shouldCancel: () => cancelBatchRef.current,
      });
      setBatchOutcome(outcome);
    } finally {
      setBatchProgress(null);
      setIsBatching(false);
    }
  }, [batchPlan, config, frozen]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-studio-bg font-sans text-[#E0E0E0]">
      {/* 视口 */}
      <main
        className="relative flex min-w-0 flex-1 flex-col select-none"
        onDragOver={(event) => {
          if (frozen || !hasImageFile(event.dataTransfer)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          // 导出期间不接收新素材：批量方案是按开始那一刻的队列算出来的，
          // 中途加进来的图既不会被导出，还会占掉一份内存
          if (frozen || !hasImageFile(event.dataTransfer)) return;
          event.preventDefault();
          setDragging(false);
          queue.ingestFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <header className="flex items-center justify-between border-b border-studio-line px-6 py-3">
          <div>
            <p className="text-[10px] tracking-[0.3em] text-[#777] uppercase">Passe · 衬境</p>
            {/* 版本标记挂在入口界面上，用来一眼确认线上跑的是哪一版。
                值来自 package.json（见 vite.config.ts 的 define）——
                硬编码的标记一定会漂移，这里不留第二处可改的地方。 */}
            <h1 className="text-sm font-medium text-white">画廊装裱调校台 · v{__APP_VERSION__}</h1>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-[#666]">
            {activeItem && activeItem.status === 'ready' ? (
              <span className="max-w-[30ch] truncate" title={activeItem.name}>
                {activeItem.name} · {activeItem.originalWidth} × {activeItem.originalHeight}
              </span>
            ) : null}
            {onOpenLab ? (
              <button
                type="button"
                onClick={onOpenLab}
                className="rounded border border-[#333] px-3 py-1.5 text-[#BBB] transition-colors hover:border-[#555] hover:text-white"
              >
                材质验证台
              </button>
            ) : null}
          </div>
        </header>

        {/* 预览背板。浅色卡纸配深背板、深色卡纸配浅背板，成品才读得出边界 */}
        {/* min-h-0 是必需的：flex 子项默认 min-height: auto，会被超大内容顶着长高，
            整列于是溢出 h-screen，把底部状态条推出视口 */}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6">
          <div
            ref={previewBoxRef}
            className="flex h-full w-full items-center justify-center overflow-hidden rounded-sm border border-studio-line transition-colors duration-200"
            style={{ background: backing.background }}
          >
            {source ? (
              <div className="relative inline-flex items-center justify-center">
                {/* 尺寸由 fitPreview 算出后直接钉住，不再依赖 CSS 百分比上限。
                    未量出可用区域时给 0，宁可空白一帧也不让画面溢出去 */}
                <canvas
                  ref={previewCanvasRef}
                  className="rounded-xs transition-all duration-75"
                  style={{
                    width: `${previewFit.width}px`,
                    height: `${previewFit.height}px`,
                    outline: `1px solid ${backing.outline}`,
                    boxShadow: '0 24px 48px rgba(0, 0, 0, 0.45)',
                  }}
                />
                {dragging && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-xs border border-dashed border-[#7F77DD] bg-black/55 text-xs text-white">
                    松手即入队
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={`flex h-64 w-96 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 text-center transition-colors ${
                  dragging
                    ? 'border-[#7F77DD] bg-[#1E1C2A]'
                    : 'border-[#3A3A3C] bg-black/20 hover:border-[#555]'
                }`}
              >
                <span className="text-sm tracking-widest text-[#BBB] uppercase">
                  {dragging ? '松手即入队' : '选择或拖拽胶片扫描件'}
                </span>
                <span className="mt-3 text-[11px] leading-relaxed text-[#777]">
                  {queue.busy ? '正在解码…' : '支持无损 JPEG / PNG / TiFF 与中画幅扫描件'}
                  <br />
                  零上传，全部在本地浏览器内完成
                </span>
              </button>
            )}
          </div>
        </div>

        {/* 状态条 */}
        <footer className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-studio-line bg-studio-panel px-6 py-2 text-[10px] text-[#666]">
          {source ? (
            <>
              <span>
                外框{' '}
                <span className="text-[#BBB]">
                  {frameSize.w} × {frameSize.h}
                </span>
              </span>
              <span>
                scaleFactor{' '}
                <span className="text-[#BBB]">
                  {(Math.min(frameSize.w, frameSize.h) / 1200).toFixed(3)}
                </span>
              </span>
              <span>
                卡纸亮度 <span className="text-[#BBB]">{tone?.luminance.toFixed(4)}</span> ·{' '}
                {tone?.isLight ? '浅色' : '深色'}（背板
                {backing.inverted ? '已翻转为浅色' : '保持深色'}）
              </span>
            </>
          ) : (
            <span>等待素材</span>
          )}
          {renderError && <span className="text-[#F09595]">{renderError}</span>}
          {exportNote && <span className="text-[#BBB]">{exportNote}</span>}
        </footer>
      </main>

      {/* 控制台 */}
      <aside className="flex w-96 shrink-0 flex-col gap-5 overflow-y-auto border-l border-studio-line bg-studio-panel p-6">
        <ImageTray queue={queue} variant="compact" locked={frozen} />

        <Section title="装裱预设" hint="存的是装裱样式，不含机型与胶卷">
          <div className="space-y-1.5">
            {presets.map((preset) => (
              <div key={preset.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    patchConfig(applyPreset(config, preset));
                    setPresetNote(null);
                  }}
                  title={preset.builtin ? '出厂预设' : '我的预设'}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded border border-[#2A2A2C] bg-[#1C1C1E] px-2 py-1.5 text-left text-[11px] text-[#CCC] transition-colors hover:border-[#48484A] hover:text-white"
                >
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-xs border border-black/40"
                    style={{ background: preset.style.matColor ?? '#F8F7F3' }}
                  />
                  <span className="truncate">{preset.name}</span>
                </button>
                {preset.builtin ? null : (
                  <button
                    type="button"
                    onClick={() => handleDeletePreset(preset.id)}
                    title="删除这条预设"
                    className="rounded-xs px-1 text-[10px] text-[#666] transition-colors hover:text-[#F09595]"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField
                label="新预设名"
                placeholder={`我的预设 ${userPresets.length + 1}`}
                value={presetName}
                onChange={setPresetName}
              />
            </div>
            <button
              type="button"
              onClick={handleSavePreset}
              className="shrink-0 rounded border border-[#333] px-3 py-2 text-[11px] text-[#BBB] transition-colors hover:border-[#555] hover:text-white"
            >
              存为预设
            </button>
          </div>

          {presetNote ? (
            <p className="mt-2 text-[10px] leading-relaxed text-[#C9A961]">{presetNote}</p>
          ) : null}
        </Section>

        <Section title="卡纸材质">
          <ChoiceGrid
            columns={2}
            value={config.matColor ?? null}
            onChange={(next) => patchConfig({ matColor: next ?? undefined })}
            options={MATBOARD_PRESETS.map((preset) => ({
              value: preset.color,
              label: preset.name,
              swatch: preset.color,
            }))}
          />
        </Section>

        <Section title="画框构图">
          <ChoiceGrid
            columns={4}
            value={config.targetAspect ?? null}
            onChange={(next) => patchConfig({ targetAspect: next })}
            options={ASPECT_OPTIONS}
          />
        </Section>

        <Section title="构图">
          <div className="space-y-4">
            <Slider
              label="卡纸边距"
              value={config.marginRatio ?? 0.14}
              min={0.06}
              max={0.3}
              step={0.005}
              display={`${Math.round((config.marginRatio ?? 0.14) * 100)}%`}
              onChange={(value) => patchConfig({ marginRatio: value })}
            />
            <Slider
              label="底边视觉加权"
              value={config.bottomWeight ?? 1.25}
              min={1}
              max={1.7}
              step={0.01}
              display={`+${Math.round(((config.bottomWeight ?? 1.25) - 1) * 100)}%`}
              onChange={(value) => patchConfig({ bottomWeight: value })}
            />
          </div>
        </Section>

        <Section title="材质参数" hint="滑杆归零即关闭该层">
          <div className="space-y-4">
            <Slider
              label="纸张颗粒强度"
              value={config.paperTextureIntensity ?? 0.04}
              min={0}
              max={0.1}
              step={0.005}
              display={(config.paperTextureIntensity ?? 0.04).toFixed(3)}
              onChange={(value) => patchConfig({ paperTextureIntensity: value })}
            />
            <Slider
              label="45° 斜切宽度"
              value={config.bevelWidth ?? 2.5}
              min={0}
              max={8}
              step={0.1}
              display={`${(config.bevelWidth ?? 2.5).toFixed(1)}px @1200`}
              onChange={(value) => patchConfig({ bevelWidth: value })}
            />
            <Slider
              label="相纸下落阴影"
              value={config.insetShadowBlur ?? 6}
              min={0}
              max={20}
              step={0.5}
              display={`${(config.insetShadowBlur ?? 6).toFixed(1)}px @1200`}
              onChange={(value) => patchConfig({ insetShadowBlur: value })}
            />
          </div>
        </Section>

        <Section title="纸张钢印">
          <ToggleRow
            label="无墨立体钢印"
            hint="底部留白区的压凹，比印字更像真装裱"
            checked={config.enableStamp ?? true}
            onChange={(next) => patchConfig({ enableStamp: next })}
          />
          {config.enableStamp ? (
            <div className="mt-3 space-y-3">
              <TextField
                label="相机机型"
                placeholder="如 LEICA M6"
                value={config.cameraModel ?? ''}
                onChange={(next) => patchConfig({ cameraModel: next })}
              />
              <TextField
                label="胶卷型号"
                placeholder="如 KODAK PORTRA 400"
                value={config.filmBrand ?? ''}
                onChange={(next) => patchConfig({ filmBrand: next })}
              />
              <Slider
                label="下压深度"
                value={config.stampDepth ?? 1.2}
                min={0.2}
                max={3}
                step={0.1}
                display={`${(config.stampDepth ?? 1.2).toFixed(1)}px @1200`}
                onChange={(value) => patchConfig({ stampDepth: value })}
              />
            </div>
          ) : null}
        </Section>

        <Section title="图层（调校用）" hint="导出前建议全部开启">
          <div className="-my-1">
            {[
              { key: 'mat' as const, label: '卡纸底色', hint: '其余四层的基底' },
              { key: 'paperTexture' as const, label: '纸纤维颗粒', hint: '不进入相片画面' },
              { key: 'bevel' as const, label: '45° 斜切白芯', hint: '左上高光 / 右下暗收边' },
              {
                key: 'insetShadow' as const,
                label: '相纸下落阴影',
                hint: '四向 Ambient Occlusion',
              },
              { key: 'stamp' as const, label: '无墨立体钢印', hint: '三明治叠印的凹凸' },
            ].map((item) => (
              <ToggleRow
                key={item.key}
                label={item.label}
                hint={item.hint}
                checked={config.layers?.[item.key] ?? true}
                onChange={(next) => patchLayer(item.key, next)}
              />
            ))}
          </div>
        </Section>

        {/* 导出 */}
        <section className="border-t border-studio-line pt-5">
          <h3 className="mb-3 text-xs tracking-wider text-[#777] uppercase">导出</h3>

          <ChoiceGrid
            columns={4}
            value={sizeId}
            onChange={chooseSize}
            options={EXPORT_SIZES.map((option) => ({
              value: option.id,
              label: option.label,
              hint: option.hint,
            }))}
          />

          {/* 格式是数字输出的另一个独立轴：它不改变画面，只改变编码方式 */}
          <p className="mt-3 mb-1 text-[10px] tracking-wider text-[#666] uppercase">格式</p>
          <ChoiceGrid
            columns={2}
            value={formatId}
            onChange={setFormatId}
            options={EXPORT_FORMATS.map((format) => ({
              value: format.id,
              label: format.label,
              hint: format.hint,
            }))}
          />

          {/* PNG 下整块不渲染：`toBlob` 会静默忽略质量参数，留一个拖了没反应的
              滑杆比不留更糟 —— 用户会以为"拖到 90% 文件就小了"（见 exportFormat.ts） */}
          {exportFormat.lossy ? (
            <div className="mt-2">
              <Slider
                label="质量"
                value={jpegQuality}
                min={QUALITY_MIN}
                max={QUALITY_MAX}
                step={QUALITY_STEP}
                display={describeQuality(jpegQuality)}
                onChange={setJpegQuality}
              />
            </div>
          ) : null}

          {plan ? (
            <dl className="mt-3 space-y-1 text-[10px] text-[#666]">
              <div className="flex justify-between">
                <dt>输出</dt>
                <dd className="text-[#BBB]">
                  {plan.outputW} × {plan.outputH}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>装裱外框</dt>
                <dd className="text-[#BBB]">
                  {plan.framedW} × {plan.framedH}（{plan.budget.megapixels.toFixed(1)}MP）
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>预计峰值</dt>
                <dd className="text-[#BBB]">{formatMemory(plan.budget.estimatedBytes)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0">文件名</dt>
                <dd className="truncate text-[#888]" title={plan.filename}>
                  {plan.filename}
                </dd>
              </div>
            </dl>
          ) : null}

          {plan && plan.budget.level !== 'ok' ? (
            <p
              className={`mt-3 rounded border px-2.5 py-2 text-[10px] leading-relaxed ${
                plan.canExport
                  ? 'border-[#4A3F1E] bg-[#241F12] text-[#C9A961]'
                  : 'border-[#501313] bg-[#2A1212] text-[#F09595]'
              }`}
            >
              {plan.budget.message}
            </p>
          ) : null}

          {plan && !plan.canExport && plan.suggestedMaxDimension ? (
            <button
              type="button"
              onClick={() => setOverrideMaxDimension(plan.suggestedMaxDimension)}
              className="mt-2 w-full rounded border border-[#501313] px-3 py-2 text-[11px] text-[#F09595] transition-colors hover:border-[#7A2020] hover:text-white"
            >
              压到长边 {plan.suggestedMaxDimension}px 导出
            </button>
          ) : null}

          {overrideMaxDimension !== null ? (
            <button
              type="button"
              onClick={() => setOverrideMaxDimension(null)}
              className="mt-2 w-full rounded border border-[#333] px-3 py-2 text-[11px] text-[#888] transition-colors hover:border-[#555] hover:text-white"
            >
              取消尺寸修正，回到「{EXPORT_SIZES.find((o) => o.id === sizeId)?.label ?? sizeId}」
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={!plan || !plan.canExport || frozen}
            className={`mt-3 w-full rounded py-3 text-xs font-medium tracking-widest uppercase transition-all ${
              plan?.canExport && !isExporting
                ? 'bg-white text-black hover:bg-[#EAEAEA] active:scale-[0.99]'
                : 'cursor-not-allowed bg-[#222] text-[#555]'
            }`}
          >
            {isExporting ? '正在渲染超清装裱大图…' : '导出画廊装裱作品'}
          </button>

          {batchPlan ? (
            <section className="mt-6 border-t border-studio-line pt-5">
              <h3 className="mb-3 text-xs tracking-wider text-[#777] uppercase">批量</h3>

              <p className="text-[10px] leading-relaxed text-[#666]">
                队列 {batchPlan.entries.length} 张 ·{' '}
                <span className="text-[#BBB]">可导出 {batchPlan.exportable.length} 张</span>
                {batchPlan.skipped.length > 0 ? ` · 跳过 ${batchPlan.skipped.length} 张` : ''}
              </p>

              {batchPlan.exportable.length > 0 ? (
                <p className="mt-1.5 text-[10px] leading-relaxed text-[#666]">
                  逐张串行导出，峰值按最大的一张算：
                  <span className="text-[#BBB]">{formatMemory(batchPlan.peakBytes)}</span>
                  {batchPlan.peakName ? `（${batchPlan.peakName}）` : ''}
                </p>
              ) : null}

              {batchPlan.skipped.length > 0 ? (
                <ul className="mt-2 space-y-1.5 text-[10px] leading-relaxed text-[#666]">
                  {batchPlan.skipped.map((entry) => (
                    <li key={entry.item.id} className="border-l border-[#3A2A2A] pl-2">
                      <span className="text-[#C9A961]">{entry.item.name}</span>：{entry.message}
                    </li>
                  ))}
                </ul>
              ) : null}

              {batchPlan.unifiedMaxDimension !== null ? (
                <button
                  type="button"
                  onClick={() => setOverrideMaxDimension(batchPlan.unifiedMaxDimension)}
                  className="mt-2 w-full rounded border border-[#4A3F1E] px-3 py-2 text-[11px] text-[#C9A961] transition-colors hover:border-[#6A5A2E] hover:text-white"
                >
                  统一压到长边 {batchPlan.unifiedMaxDimension}px，整批都能导出
                </button>
              ) : null}

              {isBatching ? (
                <button
                  type="button"
                  onClick={handleCancelBatch}
                  className="mt-3 w-full rounded border border-[#501313] px-3 py-2.5 text-[11px] text-[#F09595] transition-colors hover:border-[#7A2020] hover:text-white"
                >
                  中断导出（正在渲染的那张会跑完）
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleExportAll()}
                  disabled={batchPlan.exportable.length === 0 || frozen}
                  className={`mt-3 w-full rounded py-3 text-xs font-medium tracking-widest uppercase transition-all ${
                    batchPlan.exportable.length > 0 && !frozen
                      ? 'border border-white/80 text-white hover:bg-white/10 active:scale-[0.99]'
                      : 'cursor-not-allowed border border-[#222] text-[#555]'
                  }`}
                >
                  {batchPlan.exportable.length > 0
                    ? `导出全部 ${batchPlan.exportable.length} 张`
                    : '本批没有可导出的素材'}
                </button>
              )}

              {batchProgress ? (
                <div className="mt-3">
                  <div className="flex items-baseline justify-between gap-2 text-[10px] text-[#666]">
                    <span className="truncate">
                      {batchProgress.current ? `正在导出 ${batchProgress.current}` : '准备中…'}
                    </span>
                    <span className="shrink-0 text-[#BBB]">
                      {batchProgress.done} / {batchProgress.total}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[#262628]">
                    <div
                      className="h-full rounded-full bg-[#7F77DD] transition-[width] duration-300"
                      style={{
                        width: `${
                          batchProgress.total > 0
                            ? Math.round((batchProgress.done / batchProgress.total) * 100)
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}

              {batchOutcome ? (
                <div className="mt-3 space-y-1.5 text-[10px] leading-relaxed">
                  {batchOutcome.blockedReason ? (
                    <p className="rounded border border-[#4A3F1E] bg-[#241F12] px-2.5 py-2 text-[#C9A961]">
                      {batchOutcome.blockedReason}
                    </p>
                  ) : (
                    <p className="rounded border border-[#2F4A36] bg-[#16231A] px-2.5 py-2 text-[#86C48B]">
                      已导出 {batchOutcome.exported.length} 张，写入{batchOutcome.sinkLabel}
                      {batchOutcome.cancelled ? '（已中断，没导完）' : ''}
                      {batchOutcome.failed.length > 0
                        ? ` · ${batchOutcome.failed.length} 张失败`
                        : ''}
                    </p>
                  )}

                  {batchOutcome.failed.map((failure) => (
                    <p
                      key={failure.id}
                      className="rounded border border-[#501313] bg-[#2A1212] px-2.5 py-1.5 text-[#F09595]"
                    >
                      {failure.name}：{failure.reason}
                    </p>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_INPUT_ACCEPT}
            className="hidden"
            onChange={(event) => {
              // FileList 是活引用，清空 value 前先复制一份
              const files = event.target.files ? Array.from(event.target.files) : [];
              event.target.value = '';
              queue.ingestFiles(files);
            }}
          />
        </section>
      </aside>
    </div>
  );
}

export default FramingStudio;
