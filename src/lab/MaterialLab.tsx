import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { GalleryFramingEngine } from '@/engine/GalleryFramingEngine';
import type { PaperTextureMode } from '@/engine/noise';
import { analyzeSurface, MATBOARD_PRESETS } from '@/engine/palette';
import {
  createPreviewSource,
  decodeImageFile,
  firstImageFile,
  hasImageFile,
} from '@/engine/source';
import type { FrameConfig, LayerToggles, RenderSource } from '@/engine/types';

import { createTestPattern } from './testPattern';

/** 实时预览的短边上限。原图只用于导出，不参与交互渲染。 */
const PREVIEW_SHORT_SIDE = 900;
/** 高分辨率取样的短边上限。受限于源图实际尺寸，不会做无意义的放大。 */
const SAMPLE_SHORT_SIDE = 3200;
const LOUPE_WIDTH = 720;
const LOUPE_HEIGHT = 460;

type SampleAnchor = 'window-corner' | 'stamp' | 'paper' | 'photo-center';

const SAMPLE_ANCHORS: readonly { id: SampleAnchor; label: string; hint: string }[] = [
  { id: 'window-corner', label: '开窗左上角', hint: '白芯切面与内阴影的交界' },
  { id: 'stamp', label: '底部钢印', hint: '无墨凹凸的立体感' },
  { id: 'paper', label: '卡纸空白', hint: '纸纤维颗粒是否成立' },
  { id: 'photo-center', label: '相片中心', hint: '画面有没有被材质污染' },
] as const;

const LAYER_LABELS: readonly { key: keyof LayerToggles; label: string; hint: string }[] = [
  { key: 'mat', label: '卡纸底色', hint: '纯色底，其余四层的基底' },
  { key: 'paperTexture', label: '纸纤维颗粒', hint: 'EvenOdd 剪裁，不进入相片' },
  { key: 'bevel', label: '45° 斜切白芯', hint: '左上高光 / 右下暗收边' },
  { key: 'insetShadow', label: '相纸下落阴影', hint: '四向 Ambient Occlusion' },
  { key: 'stamp', label: '无墨立体钢印', hint: '三明治叠印的凹凸' },
];

const ASPECTS: readonly { label: string; value: number | null }[] = [
  { label: '自适应', value: null },
  { label: '4 : 3', value: 4 / 3 },
  { label: '5 : 4', value: 5 / 4 },
  { label: '1 : 1', value: 1 },
] as const;

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface SampleRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

function computeSampleRegion(
  anchor: SampleAnchor,
  layout: {
    x: number;
    y: number;
    w: number;
    h: number;
    canvasW: number;
    canvasH: number;
    marginLeft: number;
    marginTop: number;
    bottomOffset: number;
  },
  canvasW: number,
  canvasH: number,
): SampleRegion {
  const w = Math.min(LOUPE_WIDTH, canvasW);
  const h = Math.min(LOUPE_HEIGHT, canvasH);

  let x: number;
  let y: number;
  switch (anchor) {
    case 'window-corner':
      x = layout.x - w * 0.25;
      y = layout.y - h * 0.25;
      break;
    case 'stamp': {
      const stampY = layout.y + layout.h + layout.bottomOffset * 0.36;
      x = layout.x + layout.w / 2 - w / 2;
      y = stampY - h / 2;
      break;
    }
    case 'paper':
      x = canvasW - w - layout.marginLeft * 0.4;
      y = layout.marginTop * 0.3;
      break;
    case 'photo-center':
      x = layout.x + layout.w / 2 - w / 2;
      y = layout.y + layout.h / 2 - h / 2;
      break;
  }

  return {
    x: clamp(Math.round(x), 0, Math.max(0, canvasW - w)),
    y: clamp(Math.round(y), 0, Math.max(0, canvasH - h)),
    w,
    h,
  };
}

/* ─────────────────────────── 通用控件 ─────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-studio-line pt-5">
      <h3 className="mb-3 text-xs tracking-wider text-[#777] uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (next: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-xs text-[#888]">
        <span>{label}</span>
        <span className="text-[#BBB]">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
        className="h-1 w-full accent-white"
      />
    </label>
  );
}

function LayerSwitch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-white"
      />
      <span>
        <span className={`block text-xs ${checked ? 'text-[#DDD]' : 'text-[#666]'}`}>{label}</span>
        <span className="block text-[10px] text-[#555]">{hint}</span>
      </span>
    </label>
  );
}

/* ─────────────────────────── 验证台主体 ─────────────────────────── */

export default function MaterialLab() {
  // 内置测试图作为默认素材，保证打开即有所见。用惰性初始化而非 effect，
  // 否则会多出一帧空白并触发 setState-in-effect。
  const [source, setSource] = useState<RenderSource | null>(() =>
    createTestPattern({ width: 3000, height: 2000 }),
  );
  const [sourceLabel, setSourceLabel] = useState('内置合成测试图 3000 × 2000');
  const [config, setConfig] = useState<FrameConfig>(INITIAL_CONFIG);
  const [textureMode, setTextureMode] = useState<PaperTextureMode>('multiply-screen');
  const [anchor, setAnchor] = useState<SampleAnchor>('window-corner');
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sampleStatus, setSampleStatus] = useState<'idle' | 'rendering' | 'done' | 'error'>('idle');
  const [sampleNote, setSampleNote] = useState('');
  const [marker, setMarker] = useState<SampleRegion | null>(null);
  // 浏览器没有 FontFaceSet 时直接视为就绪，否则预览会永远是空白
  const [fontsReady, setFontsReady] = useState(
    () => typeof document === 'undefined' || !document.fonts,
  );

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 钢印用的是 Inter 等系统字体。字体没就绪前渲染，钢印文字会以兜底字体画进画布，
  // 那是一张错误的成品图 —— 必须等字体就绪后再渲染一次。
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

  // 实时预览：配置一变就重绘。预览走降采样副本，所以拖动滑杆不会有负担。
  useEffect(() => {
    if (!previewSource || !fontsReady) return;

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      try {
        const canvas = GalleryFramingEngine.render(
          previewSource,
          config,
          previewCanvasRef.current ?? undefined,
          { paperTextureMode: textureMode },
        );
        setFrameSize({ w: canvas.width, h: canvas.height });
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    };

    const handle = requestAnimationFrame(run);
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [previewSource, config, textureMode, fontsReady]);

  const patchConfig = useCallback((patch: Partial<FrameConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const patchLayer = useCallback((key: keyof LayerToggles, value: boolean) => {
    setConfig((prev) => ({
      ...prev,
      layers: { ...prev.layers, [key]: value },
    }));
  }, []);

  const handleFile = useCallback(async (file: Blob, label: string) => {
    try {
      const bitmap = await decodeImageFile(file);
      setSource(bitmap);
      setSourceLabel(`${label} ${bitmap.width} × ${bitmap.height}`);
      setMarker(null);
      setSampleStatus('idle');
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const renderSample = useCallback(async () => {
    if (!source) return;
    setSampleStatus('rendering');
    // 让浏览器先把 loading 状态画出来，再做同步的重活
    await new Promise((resolve) => setTimeout(resolve, 24));

    try {
      const hiSource = createPreviewSource(source, SAMPLE_SHORT_SIDE);
      const layout = GalleryFramingEngine.layout(hiSource, config);
      const canvas = GalleryFramingEngine.render(hiSource, config, undefined, {
        paperTextureMode: textureMode,
      });
      const region = computeSampleRegion(anchor, layout, canvas.width, canvas.height);

      const loupe = loupeCanvasRef.current;
      if (!loupe) return;
      loupe.width = region.w;
      loupe.height = region.h;
      const ctx = loupe.getContext('2d');
      if (!ctx) throw new Error('无法获取取样画布的 2D 上下文');
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, region.w, region.h);
      ctx.drawImage(canvas, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);

      const previewLayout = GalleryFramingEngine.layout(previewSource ?? hiSource, config);
      const ratio = (previewCanvasRef.current?.width ?? canvas.width) / canvas.width;
      setMarker({
        x: region.x * ratio,
        y: region.y * ratio,
        w: region.w * ratio,
        h: region.h * ratio,
      });

      const shortSide = Math.min(canvas.width, canvas.height);
      const sourceShortSide = Math.min(source.width, source.height);
      const limited = sourceShortSide < SAMPLE_SHORT_SIDE;
      setSampleNote(
        `画布 ${canvas.width} × ${canvas.height} · 短边 ${shortSide}px · scaleFactor ${previewLayout.scale.toFixed(2)}` +
          (limited ? ` · 源图短边仅 ${sourceShortSide}px，未做放大` : ''),
      );
      setSampleStatus('done');
    } catch (error) {
      setSampleStatus('error');
      setSampleNote(error instanceof Error ? error.message : String(error));
    }
  }, [source, config, textureMode, anchor, previewSource]);

  const tone = config.matColor ? analyzeSurface(config.matColor) : null;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-studio-bg font-sans text-[#E0E0E0]">
      {/* 视口 */}
      <main
        className="relative flex flex-1 flex-col bg-studio-viewport select-none"
        onDragOver={(event) => {
          if (!hasImageFile(event.dataTransfer)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = firstImageFile(event.dataTransfer);
          if (file) void handleFile(file, `拖入 · ${file.name}`);
        }}
      >
        <header className="flex items-center justify-between border-b border-studio-line px-6 py-3">
          <div>
            <p className="text-[10px] tracking-[0.3em] text-[#777] uppercase">Passe · 衬境</p>
            <h1 className="text-sm font-medium text-white">材质验证台 · 阶段 1</h1>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-[#666]">
            <span>{sourceLabel}</span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded border border-[#333] px-3 py-1.5 text-[#BBB] transition-colors hover:border-[#555] hover:text-white"
            >
              拖入或选择扫描件
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file, `本地 · ${file.name}`);
                event.target.value = '';
              }}
            />
          </div>
        </header>

        <div className="flex flex-1 items-center justify-center overflow-hidden p-8">
          {source ? (
            <div className="relative inline-block">
              <canvas
                ref={previewCanvasRef}
                className="h-auto w-auto max-h-[58vh] max-w-full rounded-xs shadow-[0_24px_48px_rgba(0,0,0,0.55)]"
              />
              {marker && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute border border-[#7F77DD]"
                  style={{
                    left: `${(marker.x / Math.max(1, frameSize.w)) * 100}%`,
                    top: `${(marker.y / Math.max(1, frameSize.h)) * 100}%`,
                    width: `${(marker.w / Math.max(1, frameSize.w)) * 100}%`,
                    height: `${(marker.h / Math.max(1, frameSize.h)) * 100}%`,
                  }}
                />
              )}
              {dragging && (
                <div className="absolute inset-0 flex items-center justify-center rounded-xs border border-dashed border-[#7F77DD] bg-black/50 text-xs text-white">
                  松手载入这张扫描件
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-[#666]">正在准备测试素材…</p>
          )}
        </div>

        {/* 高分辨率取样放大镜 */}
        <section className="border-t border-studio-line bg-studio-panel px-6 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span className="text-xs tracking-wider text-[#777] uppercase">1:1 取样放大镜</span>
            <div className="flex gap-1.5">
              {SAMPLE_ANCHORS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  title={item.hint}
                  onClick={() => setAnchor(item.id)}
                  className={`rounded border px-2.5 py-1 text-[11px] transition-colors ${
                    anchor === item.id
                      ? 'border-white bg-[#28282A] text-white'
                      : 'border-[#2A2A2C] bg-[#1C1C1E] text-[#888] hover:border-[#3A3A3C]'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void renderSample()}
              disabled={sampleStatus === 'rendering'}
              className={`rounded px-3 py-1.5 text-[11px] font-medium transition-colors ${
                sampleStatus === 'rendering'
                  ? 'cursor-wait bg-[#222] text-[#666]'
                  : 'bg-[#E8E6E1] text-black hover:bg-[#F1EFE8]'
              }`}
            >
              {sampleStatus === 'rendering' ? '正在渲染高分辨率样本…' : '渲染高分辨率样本'}
            </button>
            <span className="text-[11px] text-[#666]">{sampleNote}</span>
          </div>
          <div className="overflow-hidden rounded border border-studio-line bg-black">
            <canvas ref={loupeCanvasRef} className="block h-auto w-full max-w-[720px]" />
          </div>
        </section>

        {errorMessage && (
          <p className="border-t border-[#501313] bg-[#2A1212] px-6 py-2 text-xs text-[#F09595]">
            {errorMessage}
          </p>
        )}
      </main>

      {/* 控制台 */}
      <aside className="flex w-96 shrink-0 flex-col gap-5 overflow-y-auto border-l border-studio-line bg-studio-panel p-6">
        <Section title="图层逐层开关">
          <div className="-my-1">
            {LAYER_LABELS.map((item) => (
              <LayerSwitch
                key={item.key}
                label={item.label}
                hint={item.hint}
                checked={config.layers?.[item.key] ?? true}
                onChange={(next) => patchLayer(item.key, next)}
              />
            ))}
          </div>
        </Section>

        <Section title="卡纸材质">
          <div className="grid grid-cols-2 gap-2">
            {MATBOARD_PRESETS.map((preset) => {
              const active = config.matColor === preset.color;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => patchConfig({ matColor: preset.color })}
                  className={`flex items-center gap-2 rounded border p-2 text-left text-[11px] transition-colors ${
                    active
                      ? 'border-white bg-[#28282A] text-white'
                      : 'border-[#262628] bg-[#1C1C1E] text-[#999] hover:border-[#38383A]'
                  }`}
                >
                  <span
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/20"
                    style={{ background: preset.color }}
                  />
                  {preset.name}
                </button>
              );
            })}
          </div>
          {tone && (
            <p className="mt-2 text-[10px] text-[#555]">
              相对亮度 {tone.luminance.toFixed(4)} · {tone.isLight ? '浅色卡纸' : '深色卡纸'}
              {tone.isLight
                ? ''
                : ` · 纸纹暗部 ×${tone.shadowGain} / 反光 ×${tone.highlightGain} 自适应`}
            </p>
          )}
        </Section>

        <Section title="纸纹叠加方式（对拍用）">
          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                { id: 'multiply-screen', label: '乘算 + 滤色（修正）' },
                { id: 'soft-light', label: 'soft-light（指南原方案）' },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setTextureMode(option.id)}
                className={`rounded border px-2 py-1.5 text-[11px] transition-colors ${
                  textureMode === option.id
                    ? 'border-white bg-[#28282A] text-white'
                    : 'border-[#262628] bg-[#1C1C1E] text-[#888] hover:border-[#38383A]'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-[#555]">
            切到炭黑展厅对比两者：原方案在深色卡纸上几乎看不到纸纹，这就是修掉的问题。
          </p>
        </Section>

        <Section title="构图">
          <div className="mb-4 grid grid-cols-4 gap-1.5">
            {ASPECTS.map((item) => {
              const active = config.targetAspect === item.value;
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => patchConfig({ targetAspect: item.value })}
                  className={`rounded border py-1.5 text-center text-[11px] transition-colors ${
                    active
                      ? 'border-white bg-[#28282A] text-white'
                      : 'border-[#262628] bg-[#1C1C1E] text-[#888] hover:border-[#38383A]'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          <div className="space-y-4">
            <Slider
              label="卡纸边距 baseMargin"
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

        <Section title="材质参数">
          <div className="space-y-4">
            <Slider
              label="纸纤维强度"
              value={config.paperTextureIntensity ?? 0.04}
              min={0.01}
              max={0.08}
              step={0.005}
              display={(config.paperTextureIntensity ?? 0.04).toFixed(3)}
              onChange={(value) => patchConfig({ paperTextureIntensity: value })}
            />
            <Slider
              label="斜切切面宽度"
              value={config.bevelWidth ?? 2.5}
              min={1}
              max={6}
              step={0.1}
              display={(config.bevelWidth ?? 2.5).toFixed(1)}
              onChange={(value) => patchConfig({ bevelWidth: value })}
            />
            <Slider
              label="下落内阴影半径"
              value={config.insetShadowBlur ?? 6}
              min={2}
              max={16}
              step={0.5}
              display={(config.insetShadowBlur ?? 6).toFixed(1)}
              onChange={(value) => patchConfig({ insetShadowBlur: value })}
            />
            <Slider
              label="钢印下压深度"
              value={config.stampDepth ?? 1.2}
              min={0.4}
              max={3}
              step={0.1}
              display={(config.stampDepth ?? 1.2).toFixed(1)}
              onChange={(value) => patchConfig({ stampDepth: value })}
            />
          </div>
        </Section>

        <Section title="钢印内容">
          <div className="space-y-2">
            <input
              type="text"
              value={config.cameraModel ?? ''}
              placeholder="相机机型（如 LEICA M6）"
              onChange={(event) => patchConfig({ cameraModel: event.target.value })}
              className="w-full rounded border border-[#28282A] bg-[#1C1C1E] px-3 py-2 text-xs text-white focus:border-[#555] focus:outline-none"
            />
            <input
              type="text"
              value={config.filmBrand ?? ''}
              placeholder="胶卷型号（如 KODAK PORTRA 400）"
              onChange={(event) => patchConfig({ filmBrand: event.target.value })}
              className="w-full rounded border border-[#28282A] bg-[#1C1C1E] px-3 py-2 text-xs text-white focus:border-[#555] focus:outline-none"
            />
          </div>
        </Section>

        <Section title="当前状态">
          <dl className="space-y-1.5 text-[11px]">
            <div className="flex justify-between">
              <dt className="text-[#666]">预览画布</dt>
              <dd className="text-[#BBB]">
                {frameSize.w} × {frameSize.h}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[#666]">预览短边</dt>
              <dd className="text-[#BBB]">≤ {PREVIEW_SHORT_SIDE}px（降采样副本）</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[#666]">导出</dt>
              <dd className="text-[#BBB]">走原始全分辨率</dd>
            </div>
          </dl>
        </Section>

        <p className="mt-auto border-t border-studio-line pt-4 text-[10px] leading-relaxed text-[#555]">
          验证台只用于判定质感，不是最终界面。所有渲染在浏览器本地完成，照片不会上传。
        </p>
      </aside>
    </div>
  );
}
