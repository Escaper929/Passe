import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveBlob } from '@/engine/GalleryFramingEngine';

/**
 * `saveBlob` 的撤销时机。
 *
 * 这一组守的是一个**静默失败**：对象 URL 如果在 `anchor.click()` 的同一轮任务里
 * 就被撤销，Chromium 恰好还能下载成功，Safari / Firefox 则会直接丢掉这次下载 ——
 * 用户等半天什么都没拿到，而且没有任何报错可看。
 *
 * 所以"撤销被推后一轮"必须是被钉住的**行为**，不能让人顺手改回同步：
 * 同步版本在 Chrome 里测什么都正常，正是它最难被发现的理由。
 */

/** 让出一轮宏任务：撤销就是安排在那一轮里的。 */
const flushTasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function stubUrl(): { revoke: ReturnType<typeof vi.fn> } {
  const revoke = vi.fn();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:passe-test'),
    revokeObjectURL: revoke,
  });
  return { revoke };
}

/** jsdom 里点锚点会尝试导航并刷一堆"未实现"警告，拦掉它只看参数。 */
function stubClick(onClick?: (anchor: HTMLAnchorElement) => void): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    onClick?.(this);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('saveBlob · 撤销对象 URL 的时机', () => {
  it('不在 click() 的同一轮撤销', async () => {
    const { revoke } = stubUrl();
    const click = stubClick();

    saveBlob(new Blob(['x']), 'a.jpg');

    // 下载已经交给浏览器了……
    expect(click).toHaveBeenCalledTimes(1);
    // ……但这一轮 URL 还在，浏览器才有机会把它接过去
    expect(revoke).not.toHaveBeenCalled();

    await flushTasks();
    // 该撤的仍然要撤到：8K 成品的 blob 是几十 MB 级别，不撤销就是一直挂着
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:passe-test');
  });

  it('文件名原样写进 download 属性 —— 面板预告的名字必须就是落盘的名字', () => {
    stubUrl();
    let seen = '';
    stubClick((anchor) => {
      seen = anchor.download;
    });

    saveBlob(new Blob(['x']), 'Passe_M6_scan_4000px.jpg');

    expect(seen).toBe('Passe_M6_scan_4000px.jpg');
  });

  it('锚点用完即摘，不留在 DOM 里攒着', () => {
    stubUrl();
    stubClick();

    saveBlob(new Blob(['x']), 'a.jpg');

    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });
});
