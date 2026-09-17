/**
 * 图片队列状态机。
 *
 * 刻意写成纯 reducer：解码是异步的、位图是必须手动释放的资源，
 * 这两件事最容易写出 bug。把状态流转抽成纯函数之后，
 * "条目被删掉后异步解码才回来"这类竞态就能脱离 React 直接测。
 *
 * 资源释放不放在 reducer 里（纯函数不该有副作用），而是由调用方通过
 * `removedItems()` 对比前后状态拿到被移除的条目，再逐个 close。
 */

import type { RenderSource } from '@/engine/types';

export type ItemStatus =
  /** 已入队，等待解码 */
  | 'queued'
  /** 正在解码 */
  | 'decoding'
  /** 解码完成，可用于预览与导出 */
  | 'ready'
  /** 解码失败，error 字段说明原因 */
  | 'failed';

export interface ImageItem {
  id: string;
  name: string;
  size: number;
  status: ItemStatus;
  /** 工作副本尺寸。未完成解码时为 0 */
  width: number;
  height: number;
  /**
   * 原始文件尺寸。
   *
   * 与工作副本尺寸必须分开：导出时会按需重解全分辨率原图，
   * 内存守卫要评估的正是那张图 —— 用工作副本尺寸去算会严重低估。
   */
  originalWidth: number;
  originalHeight: number;
  /** 受控工作副本，供预览与交互渲染。导出时按需重解原始文件 */
  source: RenderSource | null;
  /** 原始文件引用。全分辨率导出时用它重新解码，避免常驻内存 */
  file: File;
  error: string | null;
  /** 非阻断提示（如 TIFF 解码支持不一致） */
  warning: string | null;
}

export interface ImageQueueState {
  items: ImageItem[];
  /** 当前正在编辑的条目。空队列时为 null */
  activeId: string | null;
}

export const emptyQueue: ImageQueueState = { items: [], activeId: null };

export type QueueAction =
  | { type: 'add'; items: ImageItem[] }
  | { type: 'decoding'; id: string }
  | {
      type: 'decoded';
      id: string;
      source: RenderSource;
      width: number;
      height: number;
      originalWidth: number;
      originalHeight: number;
    }
  | { type: 'failed'; id: string; error: string }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'select'; id: string }
  /** delta = -1 上移一位，+1 下移一位 */
  | { type: 'move'; id: string; delta: number };

export interface CreateItemOptions {
  id: string;
  warning?: string | null;
}

/** 构造一个待解码的队列条目。id 由调用方注入，保证可测。 */
export function createQueuedItem(file: File, options: CreateItemOptions): ImageItem {
  return {
    id: options.id,
    name: file.name,
    size: file.size,
    status: 'queued',
    width: 0,
    height: 0,
    originalWidth: 0,
    originalHeight: 0,
    source: null,
    file,
    error: null,
    warning: options.warning ?? null,
  };
}

export function queueReducer(state: ImageQueueState, action: QueueAction): ImageQueueState {
  switch (action.type) {
    case 'add': {
      if (action.items.length === 0) return state;
      const items = [...state.items, ...action.items];
      return {
        items,
        // 空队列里拖进第一张时自动选中它，省掉一次点击
        activeId: state.activeId ?? action.items[0].id,
      };
    }

    // 解码结果落库前一律确认条目还在。用户完全可能在解码途中把图删掉。
    case 'decoding':
      return patch(state, action.id, () => ({ status: 'decoding', error: null }));

    case 'decoded':
      return patch(state, action.id, () => ({
        status: 'ready',
        source: action.source,
        width: action.width,
        height: action.height,
        originalWidth: action.originalWidth,
        originalHeight: action.originalHeight,
        error: null,
      }));

    case 'failed':
      return patch(state, action.id, () => ({
        status: 'failed',
        source: null,
        error: action.error,
      }));

    case 'remove': {
      const index = state.items.findIndex((item) => item.id === action.id);
      if (index < 0) return state;

      const items = state.items.filter((item) => item.id !== action.id);
      if (state.activeId !== action.id) return { items, activeId: state.activeId };

      // 删掉当前选中项时接管它原来的位置；删的是最后一张则回退到前一张
      const next = state.items[index + 1] ?? state.items[index - 1] ?? null;
      return { items, activeId: next?.id ?? null };
    }

    case 'clear':
      return emptyQueue;

    case 'select':
      if (state.activeId === action.id) return state;
      if (!state.items.some((item) => item.id === action.id)) return state;
      return { ...state, activeId: action.id };

    case 'move': {
      const from = state.items.findIndex((item) => item.id === action.id);
      if (from < 0) return state;

      const to = from + action.delta;
      if (to < 0 || to >= state.items.length) return state;

      const items = [...state.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      return { ...state, items };
    }

    default:
      return state;
  }
}

function patch(
  state: ImageQueueState,
  id: string,
  changes: () => Partial<ImageItem>,
): ImageQueueState {
  let touched = false;
  const items = state.items.map((item) => {
    if (item.id !== id) return item;
    touched = true;
    return { ...item, ...changes() };
  });

  // 条目已被移除：丢弃这次迟到的解码结果，不改状态
  return touched ? { ...state, items } : state;
}

/** 找出从 prev 到 next 之间被移除的条目，调用方据此释放位图。 */
export function removedItems(prev: ImageQueueState, next: ImageQueueState): ImageItem[] {
  const alive = new Set(next.items.map((item) => item.id));
  return prev.items.filter((item) => !alive.has(item.id));
}

/** 释放一个来源对象持有的内存。ImageBitmap 需要显式 close。 */
export function disposeSource(source: RenderSource | null | undefined): void {
  if (!source) return;
  if ('close' in source && typeof source.close === 'function') {
    source.close();
  }
}

export function activeItem(state: ImageQueueState): ImageItem | null {
  if (!state.activeId) return null;
  return state.items.find((item) => item.id === state.activeId) ?? null;
}

export function readyItems(state: ImageQueueState): ImageItem[] {
  return state.items.filter((item) => item.status === 'ready' && item.source !== null);
}

/** 队列中可用于渲染的条目尺寸，供内存守卫求和。 */
export function residentSizes(state: ImageQueueState): { width: number; height: number }[] {
  return state.items
    .filter((item) => item.source !== null)
    .map((item) => ({ width: item.width, height: item.height }));
}

/** 简单自增 id。测试里注入固定序列，运行时用模块级计数器。 */
export function createIdFactory(prefix = 'img'): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    return `${prefix}-${seq}`;
  };
}
