/**
 * 图片托盘：输入层唯一可见的界面。
 *
 * 三种入口（拖放、文件选择、剪贴板）最终都落到同一个列表上，
 * 用户看到的状态也就只有一份真相 —— 不会出现"粘贴进来的图不在列表里"
 * 这种让人怀疑工具坏了的错觉。
 *
 * 缩略图直接用工作副本画到小画布上，不走 objectURL。
 * objectURL 需要成对 revoke，漏一次就泄漏一整张图的字节，而画布方案没有这个生命周期。
 */

import { useEffect, useRef, useState } from 'react';

import { formatMemory } from './budget';
import type { ImageItem } from './queue';
import type { ImageQueueApi } from './useImageQueue';
import { FILE_INPUT_ACCEPT, formatBytes } from './validate';

const THUMB_W = 56;
const THUMB_H = 42;

const STATUS_STYLE: Record<ImageItem['status'], { label: string; className: string }> = {
  queued: { label: '排队中', className: 'border-[#333] text-[#888]' },
  decoding: { label: '解码中', className: 'border-[#4A4478] text-[#9B93E8]' },
  ready: { label: '就绪', className: 'border-[#2F4A36] text-[#86C48B]' },
  failed: { label: '失败', className: 'border-[#5A2222] text-[#F09595]' },
};

const MEMORY_FILL: Record<string, string> = {
  ok: 'bg-[#5E5E62]',
  heavy: 'bg-[#C9A961]',
  blocked: 'bg-[#C97A7A]',
};

/** 把工作副本按 contain 方式画进固定尺寸的小画布。 */
function Thumbnail({ item }: { item: ImageItem }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, THUMB_W, THUMB_H);
    const source = item.source;
    if (!source || item.width < 1 || item.height < 1) return;

    const scale = Math.min(THUMB_W / item.width, THUMB_H / item.height);
    const w = Math.max(1, Math.round(item.width * scale));
    const h = Math.max(1, Math.round(item.height * scale));
    const x = Math.round((THUMB_W - w) / 2);
    const y = Math.round((THUMB_H - h) / 2);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(source, x, y, w, h);
  }, [item.source, item.width, item.height, item.status]);

  return (
    <canvas
      ref={ref}
      width={THUMB_W}
      height={THUMB_H}
      className="shrink-0 rounded-xs border border-[#2A2A2C] bg-[#141416]"
    />
  );
}

function ItemRow({
  item,
  isActive,
  canMoveUp,
  canMoveDown,
  onSelect,
  onRemove,
  onMove,
}: {
  item: ImageItem;
  isActive: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const status = STATUS_STYLE[item.status];
  const failed = item.status === 'failed';

  return (
    <li
      className={`group rounded border px-2 py-2 transition-colors ${
        isActive
          ? 'border-white/70 bg-[#28282A]'
          : 'border-[#262628] bg-[#1C1C1E] hover:border-[#38383A]'
      }`}
    >
      <div className="flex items-start gap-2">
        <button type="button" onClick={onSelect} className="shrink-0 cursor-pointer">
          <Thumbnail item={item} />
        </button>

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onSelect}
            className="block w-full cursor-pointer truncate text-left text-[11px] text-[#DDD]"
            title={item.name}
          >
            {item.name}
          </button>

          <div className="mt-1 flex items-center gap-2 text-[10px] text-[#777]">
            <span>{item.width > 0 ? `${item.width} × ${item.height}` : '—'}</span>
            <span className="text-[#3A3A3C]">·</span>
            <span>{formatBytes(item.size)}</span>
          </div>

          <div className="mt-1.5 flex items-center gap-1.5">
            <span className={`rounded-xs border px-1.5 py-0.5 text-[9px] ${status.className}`}>
              {status.label}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => onMove(-1)}
                disabled={!canMoveUp}
                title="上移"
                className="rounded-xs px-1 text-[10px] text-[#777] transition-colors hover:text-white disabled:cursor-not-allowed disabled:text-[#333]"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => onMove(1)}
                disabled={!canMoveDown}
                title="下移"
                className="rounded-xs px-1 text-[10px] text-[#777] transition-colors hover:text-white disabled:cursor-not-allowed disabled:text-[#333]"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={onRemove}
                title="移除"
                className="rounded-xs px-1 text-[10px] text-[#777] transition-colors hover:text-[#F09595]"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      </div>

      {failed && item.error ? (
        <p className="mt-2 border-t border-[#3A1E1E] pt-1.5 text-[10px] leading-relaxed text-[#F09595]">
          {item.error}
        </p>
      ) : null}

      {!failed && item.warning ? (
        <p className="mt-2 border-t border-[#2E2A1C] pt-1.5 text-[10px] leading-relaxed text-[#C9A961]">
          {item.warning}
        </p>
      ) : null}
    </li>
  );
}

export default function ImageTray({
  queue,
  className = '',
}: {
  queue: ImageQueueApi;
  className?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [clipboardHint, setClipboardHint] = useState<string | null>(null);

  const { items, activeId, progress, memory, notice } = queue;
  const empty = items.length === 0;

  const memoryPercent = Math.min(100, Math.round(memory.load * 100));

  return (
    <section
      className={`flex flex-col gap-3 ${className}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(event) => {
        // 只在真正离开托盘时收起高亮，否则子元素之间的移动会反复闪烁
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        queue.ingestFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="flex items-center justify-between">
        <h3 className="text-xs tracking-wider text-[#777] uppercase">
          图片队列{items.length > 0 ? ` · ${items.length}` : ''}
        </h3>
        {items.length > 0 ? (
          <button
            type="button"
            onClick={queue.clear}
            className="text-[10px] text-[#666] transition-colors hover:text-[#F09595]"
          >
            清空
          </button>
        ) : null}
      </header>

      {notice ? (
        <div
          className={`flex items-start gap-2 rounded border px-2.5 py-2 text-[10px] leading-relaxed ${
            notice.level === 'error'
              ? 'border-[#501313] bg-[#2A1212] text-[#F09595]'
              : 'border-[#4A3F1E] bg-[#241F12] text-[#C9A961]'
          }`}
        >
          <ul className="flex-1 space-y-0.5">
            {notice.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={queue.dismissNotice}
            className="shrink-0 text-[10px] opacity-60 transition-opacity hover:opacity-100"
            title="知道了"
          >
            ✕
          </button>
        </div>
      ) : null}

      {progress && progress.total > 1 ? (
        <p className="text-[10px] text-[#9B93E8]">
          正在解码 {progress.done} / {progress.total}（逐张进行，避免内存峰值叠加）
        </p>
      ) : null}

      {empty ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={`flex h-32 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 text-center transition-colors ${
            dragging
              ? 'border-[#7F77DD] bg-[#1E1C2A]'
              : 'border-[#333] bg-[#1A1A1C] hover:border-[#555]'
          }`}
        >
          <span className="text-xs tracking-widest text-[#888] uppercase">
            {dragging ? '松手即入队' : '选择或拖拽胶片扫描件'}
          </span>
          <span className="mt-2 text-[10px] leading-relaxed text-[#555]">
            支持无损 JPEG / PNG / TiFF 与中画幅扫描件
            <br />
            也可直接 Ctrl / ⌘ + V 粘贴
          </span>
        </button>
      ) : (
        <ul
          className={`max-h-[46vh] space-y-2 overflow-y-auto rounded transition-colors ${
            dragging ? 'ring-1 ring-[#7F77DD]' : ''
          }`}
        >
          {items.map((item, index) => (
            <ItemRow
              key={item.id}
              item={item}
              isActive={item.id === activeId}
              canMoveUp={index > 0}
              canMoveDown={index < items.length - 1}
              onSelect={() => queue.select(item.id)}
              onRemove={() => queue.remove(item.id)}
              onMove={(delta) => queue.move(item.id, delta)}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded border border-[#333] px-3 py-1.5 text-[11px] text-[#BBB] transition-colors hover:border-[#555] hover:text-white"
        >
          {empty ? '选择图片' : '继续添加'}
        </button>

        <button
          type="button"
          onClick={async () => {
            const ok = await queue.readClipboard();
            setClipboardHint(ok ? null : '未能读取剪贴板，请改用拖放或 ⌘ + V');
          }}
          className="rounded border border-[#333] px-3 py-1.5 text-[11px] text-[#BBB] transition-colors hover:border-[#555] hover:text-white"
        >
          从剪贴板
        </button>

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
      </div>

      {clipboardHint ? <p className="text-[10px] text-[#C9A961]">{clipboardHint}</p> : null}

      {items.length > 0 ? (
        <div className="border-t border-[#262628] pt-3">
          <div className="flex items-baseline justify-between text-[10px] text-[#666]">
            <span>常驻内存</span>
            <span className={memory.level === 'blocked' ? 'text-[#F09595]' : 'text-[#BBB]'}>
              {formatMemory(memory.estimatedBytes)}
            </span>
          </div>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[#262628]">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${
                MEMORY_FILL[memory.level] ?? MEMORY_FILL.ok
              }`}
              style={{ width: `${Math.max(2, memoryPercent)}%` }}
            />
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-[#555]">
            工作副本已压到短边 2400px、900 万像素以内，原图不常驻内存，导出时按需重解。
            {memory.level === 'blocked' ? ' 已达上限，请先移除部分图片。' : ''}
          </p>
        </div>
      ) : null}
    </section>
  );
}
