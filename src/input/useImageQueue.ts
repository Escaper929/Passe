/**
 * 输入层的 React 接口。
 *
 * 把三个入口（拖放 / 文件选择 / 剪贴板粘贴）收敛到同一个 `ingestFiles`，
 * 这样准入校验、内存守卫、顺序解码只有一份实现，不会出现"拖进来能用、
 * 粘贴进来就崩"这类入口之间的行为差异。
 *
 * 解码任务走一条全局串行队列：用户连续拖两次文件时，后一批不会和前一批
 * 并行解码。并行会让峰值内存变成两批之和 —— 而这正是守卫要防的事。
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { assessResidentMemory, defaultResidentLimit, type ResidentMemoryReport } from './budget';
import { decodeInSequence, decodeWorkingCopy, describeDecodeError } from './decode';
import {
  activeItem,
  createIdFactory,
  createQueuedItem,
  disposeSource,
  emptyQueue,
  queueReducer,
  removedItems,
  residentSizes,
  type ImageItem,
  type ImageQueueState,
} from './queue';
import { inspectBatch } from './validate';

export interface IngestNotice {
  level: 'warn' | 'error';
  /** 每行一条，已去重 */
  lines: string[];
}

export interface ImageQueueApi {
  items: ImageItem[];
  activeId: string | null;
  active: ImageItem | null;
  /** 有图片正在解码 */
  busy: boolean;
  /** 当前批次的解码进度 */
  progress: { done: number; total: number } | null;
  /** 队列常驻内存评估 */
  memory: ResidentMemoryReport;
  /** 最近一次输入的问题提示，未消解前一直展示 */
  notice: IngestNotice | null;
  ingestFiles: (files: readonly File[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  select: (id: string) => void;
  move: (id: string, delta: number) => void;
  dismissNotice: () => void;
  handlePasteEvent: (event: ClipboardEvent) => void;
  /** 主动读剪贴板。需要权限，失败时静默返回 false 由调用方提示 */
  readClipboard: () => Promise<boolean>;
}

/** 从 DataTransfer 取出全部文件，不做过滤 —— 非图片也交给校验层给出说明。 */
export function filesFromTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return Array.from(transfer.files);
}

/**
 * 焦点在输入框里时不要抢粘贴事件。
 *
 * 阶段 3 的控制台会有机型、胶卷这些文本输入，用户在框里按 Ctrl+V 粘一段文字，
 * 不该变成往队列里塞张图。
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  // 必须显式比较：isContentEditable 在部分环境（如 jsdom）上是 undefined，
  // 直接 return 会让这个函数返回 undefined 而不是 false
  return target.isContentEditable === true;
}

export interface UseImageQueueOptions {
  /**
   * 队列常驻内存上限（字节）。
   * 默认按设备内存推导；显式传入便于测试与将来的手动调优。
   */
  residentLimit?: number;
}

export function useImageQueue(options: UseImageQueueOptions = {}): ImageQueueApi {
  const [queue, dispatch] = useReducer(queueReducer, emptyQueue);
  const [notice, setNotice] = useState<IngestNotice | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const nextId = useRef(createIdFactory('img')).current;
  /** 仍在队列中的条目 id。删掉之后就不必再浪费时间去解码了 */
  const aliveRef = useRef<Set<string>>(new Set());
  /** 解码任务的串行链，保证批次之间不并行 */
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const stateRef = useRef<ImageQueueState>(emptyQueue);
  const prevRef = useRef<ImageQueueState>(emptyQueue);

  const injectedLimit = options.residentLimit;
  const limit = useMemo(() => injectedLimit ?? defaultResidentLimit(), [injectedLimit]);

  // 条目被移除后释放它持有的位图。用前后状态求差，而不是在每个出口手动 close ——
  // 手动释放总有漏掉的分支，而漏掉的位图是几十 MB 级别的。
  useEffect(() => {
    for (const item of removedItems(prevRef.current, queue)) {
      disposeSource(item.source);
      aliveRef.current.delete(item.id);
    }
    prevRef.current = queue;
    stateRef.current = queue;
  }, [queue]);

  const ingestFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;

      const current = assessResidentMemory(residentSizes(stateRef.current), limit);
      if (current.level === 'blocked') {
        setNotice({
          level: 'error',
          lines: [current.message, '本次新增的图片已忽略。'],
        });
        return;
      }

      const verdict = inspectBatch(files);

      // 逐文件的警告挂在各自条目上，这里只汇总"进不了队列"的文件 ——
      // 它们没有条目可以承载原因，不说用户就不知道为什么少了几张。
      setNotice(
        verdict.rejected.length > 0
          ? { level: 'error', lines: verdict.rejected.map((entry) => entry.issue.message) }
          : null,
      );

      if (verdict.accepted.length === 0) return;

      const items = verdict.accepted.map(({ file, warning }) => {
        const item = createQueuedItem(file, { id: nextId(), warning });
        aliveRef.current.add(item.id);
        return item;
      });

      dispatch({ type: 'add', items });

      const run = async () => {
        setProgress({ done: 0, total: items.length });

        await decodeInSequence(
          items,
          async (item) => {
            dispatch({ type: 'decoding', id: item.id });
            try {
              const result = await decodeWorkingCopy(item.file);

              // 解码途中条目被移除：结果没有任何人接手，
              // 交给 reducer 只会被静默丢弃，于是这张位图就成了纯泄漏。
              // 必须在这里就地释放。
              if (!aliveRef.current.has(item.id)) {
                disposeSource(result.source);
                return;
              }

              dispatch({
                type: 'decoded',
                id: item.id,
                source: result.source,
                width: result.width,
                height: result.height,
              });
            } catch (error) {
              dispatch({
                type: 'failed',
                id: item.id,
                error: describeDecodeError(error, item.name),
              });
            } finally {
              aliveRef.current.delete(item.id);
            }
          },
          {
            shouldContinue: (item) => aliveRef.current.has(item.id),
            onProgress: (done, total) => setProgress({ done, total }),
          },
        );

        setProgress(null);
      };

      // 接到串行链尾：批次之间不并行，峰值内存只等于单张
      chainRef.current = chainRef.current.then(run, run);
    },
    [limit, nextId],
  );

  const remove = useCallback((id: string) => {
    aliveRef.current.delete(id);
    dispatch({ type: 'remove', id });
  }, []);

  const clear = useCallback(() => {
    aliveRef.current.clear();
    dispatch({ type: 'clear' });
  }, []);

  const select = useCallback((id: string) => {
    dispatch({ type: 'select', id });
  }, []);

  const move = useCallback((id: string, delta: number) => {
    dispatch({ type: 'move', id, delta });
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const handlePasteEvent = useCallback(
    (event: ClipboardEvent) => {
      if (isTextEntryTarget(event.target)) return;
      const files = filesFromTransfer(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      ingestFiles(files);
    },
    [ingestFiles],
  );

  const readClipboard = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return false;
    try {
      const entries = await navigator.clipboard.read();
      const files: File[] = [];
      for (const entry of entries) {
        const type = entry.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await entry.getType(type);
        const extension = type.split('/')[1] ?? 'png';
        files.push(new File([blob], `剪贴板图片.${extension}`, { type }));
      }
      if (files.length === 0) return false;
      ingestFiles(files);
      return true;
    } catch {
      // 用户拒绝授权或浏览器不支持，交给调用方决定要不要提示
      return false;
    }
  }, [ingestFiles]);

  // 全局粘贴：省掉"先点一下空白处"这一步
  useEffect(() => {
    const handler = (event: ClipboardEvent) => handlePasteEvent(event);
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, [handlePasteEvent]);

  const active = activeItem(queue);
  const memory = useMemo(() => assessResidentMemory(residentSizes(queue), limit), [queue, limit]);
  const busy = useMemo(
    () => queue.items.some((item) => item.status === 'queued' || item.status === 'decoding'),
    [queue],
  );

  return {
    items: queue.items,
    activeId: queue.activeId,
    active,
    busy,
    progress,
    memory,
    notice,
    ingestFiles,
    remove,
    clear,
    select,
    move,
    dismissNotice,
    handlePasteEvent,
    readClipboard,
  };
}
