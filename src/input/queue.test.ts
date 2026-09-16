import { describe, expect, it, vi } from 'vitest';

import {
  activeItem,
  createIdFactory,
  createQueuedItem,
  disposeSource,
  emptyQueue,
  queueReducer,
  readyItems,
  removedItems,
  residentSizes,
  type ImageItem,
  type ImageQueueState,
} from './queue';

function makeItem(id: string, name = `${id}.jpg`): ImageItem {
  return createQueuedItem(new File(['x'], name, { type: 'image/jpeg' }), { id });
}

/** 构造一个"已解码"的条目，便于测试后续操作。 */
function decodeItem(state: ImageQueueState, id: string): ImageQueueState {
  return queueReducer(state, {
    type: 'decoded',
    id,
    source: { width: 2400, height: 1600 } as unknown as HTMLCanvasElement,
    width: 2400,
    height: 1600,
  });
}

function withItems(...ids: string[]): ImageQueueState {
  return queueReducer(emptyQueue, { type: 'add', items: ids.map((id) => makeItem(id)) });
}

describe('队列 · 入队', () => {
  it('新建条目的初始状态是"排队中"，尚无可绘制的来源', () => {
    const item = makeItem('a');
    expect(item.status).toBe('queued');
    expect(item.source).toBeNull();
    expect(item.width).toBe(0);
    expect(item.error).toBeNull();
    expect(item.warning).toBeNull();
  });

  it('带警告入队的条目保留警告 —— 这是 TIFF 提示能显示出来的前提', () => {
    const item = createQueuedItem(new File(['x'], 'a.tif', { type: 'image/tiff' }), {
      id: 'a',
      warning: '解码支持不一致',
    });
    expect(item.warning).toBe('解码支持不一致');
  });

  it('空队列里拖进第一张时自动选中它，省掉一次点击', () => {
    const state = withItems('a', 'b');
    expect(state.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(state.activeId).toBe('a');
  });

  it('已有选中项时继续添加不会抢走焦点', () => {
    const first = withItems('a');
    const second = queueReducer(first, { type: 'add', items: [makeItem('b')] });
    expect(second.activeId).toBe('a');
  });

  it('添加空数组原样返回，不制造无意义的重渲染', () => {
    const state = withItems('a');
    expect(queueReducer(state, { type: 'add', items: [] })).toBe(state);
  });

  it('id 工厂保证唯一', () => {
    const next = createIdFactory('img');
    const ids = new Set([next(), next(), next()]);
    expect(ids.size).toBe(3);
  });
});

describe('队列 · 解码结果落库', () => {
  it('解码成功后状态转为就绪并记录尺寸', () => {
    const state = withItems('a');
    const decoding = queueReducer(state, { type: 'decoding', id: 'a' });
    expect(decoding.items[0].status).toBe('decoding');

    const done = decodeItem(decoding, 'a');
    expect(done.items[0].status).toBe('ready');
    expect(done.items[0].width).toBe(2400);
    expect(done.items[0].height).toBe(1600);
    expect(done.items[0].source).not.toBeNull();
  });

  it('解码失败时清空来源并带上原因', () => {
    const state = withItems('a');
    const failed = queueReducer(state, { type: 'failed', id: 'a', error: '无法解码' });
    expect(failed.items[0].status).toBe('failed');
    expect(failed.items[0].source).toBeNull();
    expect(failed.items[0].error).toBe('无法解码');
  });

  it('条目已被删除时，迟到的解码结果必须被丢弃', () => {
    // 这是最容易出 bug 的竞态：用户删掉一张 100MP 扫描件，
    // 1 秒后解码完成，结果回调里还握着它的 id。
    const state = withItems('a', 'b');
    const removed = queueReducer(state, { type: 'remove', id: 'a' });

    const late = queueReducer(removed, {
      type: 'decoded',
      id: 'a',
      source: { width: 1, height: 1 } as unknown as HTMLCanvasElement,
      width: 1,
      height: 1,
    });

    expect(late).toBe(removed);
    expect(late.items.map((item) => item.id)).toEqual(['b']);
  });

  it('对不存在的 id 派发任何结果都不改动状态', () => {
    const state = withItems('a');
    expect(queueReducer(state, { type: 'decoding', id: 'zzz' })).toBe(state);
    expect(queueReducer(state, { type: 'failed', id: 'zzz', error: 'x' })).toBe(state);
  });
});

describe('队列 · 移除与选中接管', () => {
  it('删掉当前选中项时由它的下一张接管', () => {
    const state = { ...withItems('a', 'b', 'c'), activeId: 'b' };
    const next = queueReducer(state, { type: 'remove', id: 'b' });
    expect(next.items.map((item) => item.id)).toEqual(['a', 'c']);
    expect(next.activeId).toBe('c');
  });

  it('删掉末尾的选中项时回退到前一张', () => {
    const state = { ...withItems('a', 'b', 'c'), activeId: 'c' };
    const next = queueReducer(state, { type: 'remove', id: 'c' });
    expect(next.activeId).toBe('b');
  });

  it('删掉非选中项不影响当前焦点', () => {
    const state = { ...withItems('a', 'b'), activeId: 'b' };
    const next = queueReducer(state, { type: 'remove', id: 'a' });
    expect(next.activeId).toBe('b');
  });

  it('删掉最后一张时焦点归零，而不是指向幽灵条目', () => {
    const state = withItems('a');
    const next = queueReducer(state, { type: 'remove', id: 'a' });
    expect(next.items).toHaveLength(0);
    expect(next.activeId).toBeNull();
    expect(activeItem(next)).toBeNull();
  });

  it('删不存在的 id 原样返回', () => {
    const state = withItems('a');
    expect(queueReducer(state, { type: 'remove', id: 'zzz' })).toBe(state);
  });

  it('选中不存在的 id 被忽略，选中当前项不产生新对象', () => {
    const state = withItems('a', 'b');
    expect(queueReducer(state, { type: 'select', id: 'zzz' })).toBe(state);
    expect(queueReducer(state, { type: 'select', id: 'a' })).toBe(state);

    const moved = queueReducer(state, { type: 'select', id: 'b' });
    expect(moved.activeId).toBe('b');
    expect(moved.items).toBe(state.items);
  });
});

describe('队列 · 排序', () => {
  it('上移与下移会交换相邻两项', () => {
    const state = withItems('a', 'b', 'c');
    const up = queueReducer(state, { type: 'move', id: 'b', delta: -1 });
    expect(up.items.map((item) => item.id)).toEqual(['b', 'a', 'c']);

    const down = queueReducer(state, { type: 'move', id: 'b', delta: 1 });
    expect(down.items.map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });

  it('越界的移动被忽略而不是把条目丢出数组', () => {
    const state = withItems('a', 'b');
    expect(queueReducer(state, { type: 'move', id: 'a', delta: -1 })).toBe(state);
    expect(queueReducer(state, { type: 'move', id: 'b', delta: 1 })).toBe(state);
  });

  it('排序不改变当前选中项', () => {
    const state = { ...withItems('a', 'b', 'c'), activeId: 'a' };
    const moved = queueReducer(state, { type: 'move', id: 'c', delta: -1 });
    expect(moved.activeId).toBe('a');
    expect(moved.items.map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('队列 · 清空与资源释放', () => {
  it('清空后回到初始状态', () => {
    const state = { ...withItems('a', 'b'), activeId: 'b' };
    const cleared = queueReducer(state, { type: 'clear' });
    expect(cleared.items).toHaveLength(0);
    expect(cleared.activeId).toBeNull();
  });

  it('前后状态求差能找出被移除的条目，供调用方释放位图', () => {
    const before = withItems('a', 'b', 'c');
    const after = queueReducer(before, { type: 'remove', id: 'b' });
    expect(removedItems(before, after).map((item) => item.id)).toEqual(['b']);
  });

  it('清空时全部条目都进入待释放列表', () => {
    const before = withItems('a', 'b');
    expect(removedItems(before, queueReducer(before, { type: 'clear' }))).toHaveLength(2);
  });

  it('纯状态变更不会误报释放 —— 否则会关掉正在显示的位图', () => {
    const before = withItems('a');
    const after = decodeItem(before, 'a');
    expect(removedItems(before, after)).toHaveLength(0);
  });

  it('disposeSource 只对持有 close 的对象调用 close', () => {
    const closable = { close: vi.fn() };
    disposeSource(closable as unknown as HTMLCanvasElement);
    expect(closable.close).toHaveBeenCalledTimes(1);

    // 普通画布没有 close，不应抛错
    expect(() => disposeSource({} as unknown as HTMLCanvasElement)).not.toThrow();
    expect(() => disposeSource(null)).not.toThrow();
  });
});

describe('队列 · 派生选择器', () => {
  it('只有解码完成的条目能参与渲染', () => {
    let state = withItems('a', 'b');
    state = decodeItem(state, 'a');
    state = queueReducer(state, { type: 'failed', id: 'b', error: '坏文件' });

    expect(readyItems(state).map((item) => item.id)).toEqual(['a']);
    expect(residentSizes(state)).toEqual([{ width: 2400, height: 1600 }]);
  });

  it('activeItem 在焦点失效时返回 null 而不是抛错', () => {
    expect(activeItem({ items: [], activeId: 'ghost' })).toBeNull();
  });
});
