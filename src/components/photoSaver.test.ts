import { describe, expect, it } from 'vitest';

import { canShareFiles, fileFromBlob, shareFiles } from './photoSaver';

/**
 * 存相册这条路的验证。
 *
 * 这里最该盯住的**不是**"API 调没调对"，而是三件在真机上才会发作的事：
 *
 * 1. **`share()` 必须在点击处理器的同步段里被调用。** iOS 的瞬时激活经不起
 *    await（WebKit bug 225559），而本工具渲染 8K 成品要几秒 —— 一旦有人在
 *    `shareFiles` 前面补一句 `await`，按钮在 iOS 上就会变成"点了没反应"，
 *    桌面上却一切正常。所以下面用一条"还没 await 就已经调用过"的断言钉住它。
 * 2. **用户划掉面板不能被当成失败。** 那是 AbortError，报错会把用户正常的
 *    取消动作渲染成故障提示。
 * 3. **探测得看对地方。** 传进来的是**窗口级作用域**（默认 `globalThis`），
 *    `navigator` 要从它里面取。这条曾经写错成"直接把 target 当 navigator"，
 *    于是生产环境里功能等于关着而单元测试全绿 —— 所以下面特意有一条
 *    传 `window` 形状的用例。
 */

const jpeg = (name = 'passe.jpg'): File => new File(['x'], name, { type: 'image/jpeg' });

interface FakeShare {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

/** 造一个"窗口级作用域"，与组件里的调用形状一致（传 globalThis，不是传 navigator） */
function scope(navigator: FakeShare | null): { navigator: FakeShare | null } {
  return { navigator };
}

describe('photoSaver · 能力探测', () => {
  it('从作用域里的 navigator 上取方法 —— 别把 target 直接当 navigator', () => {
    const nav: FakeShare = { share: async () => {}, canShare: () => true };
    // 传窗口形状：必须能取到
    expect(canShareFiles([jpeg()], scope(nav))).toBe(true);
    // 传裸的 navigator 形状也该能用（向后兼容，且单测读起来更直）
    expect(canShareFiles([jpeg()], nav)).toBe(true);
  });

  it('只有 share 没有 canShare —— 那是 Level 1，塞文件进去会抛，判为不支持', () => {
    expect(canShareFiles([jpeg()], scope({ share: async () => {} }))).toBe(false);
  });

  it('什么都不支持（Firefox / 老 Safari）时安静地返回 false', () => {
    expect(canShareFiles([jpeg()], scope(null))).toBe(false);
    expect(canShareFiles([jpeg()], {})).toBe(false);
    expect(canShareFiles([jpeg()], null)).toBe(false);
  });

  it('canShare 说行才行', () => {
    expect(canShareFiles([jpeg()], scope({ share: async () => {}, canShare: () => true }))).toBe(
      true,
    );
    expect(canShareFiles([jpeg()], scope({ share: async () => {}, canShare: () => false }))).toBe(
      false,
    );
  });

  it('canShare 直接抛异常的环境也算不支持，不能把异常漏给界面', () => {
    const throwing: FakeShare = {
      share: async () => {},
      canShare: () => {
        throw new TypeError('cannot share this payload');
      },
    };
    expect(canShareFiles([jpeg()], scope(throwing))).toBe(false);
  });

  it('空文件列表不算"可以分享"', () => {
    expect(canShareFiles([], scope({ share: async () => {}, canShare: () => true }))).toBe(false);
  });
});

describe('photoSaver · 交接文件', () => {
  it('没进 await 就已经把文件交出去了 —— iOS 的瞬时激活经不起 await', async () => {
    const calls: ShareData[] = [];
    const nav: FakeShare = {
      canShare: () => true,
      share: (data) => {
        calls.push(data);
        return Promise.resolve();
      },
    };

    const pending = shareFiles([jpeg()], scope(nav));

    // 关键断言：调用方**还没 await**，share 就已经被调过了。
    // 一旦有人在 shareFiles 里补上 await，这条会红。
    expect(calls).toHaveLength(1);
    expect(calls[0].files).toHaveLength(1);

    await expect(pending).resolves.toBe('shared');
  });

  it('用户划掉面板 = AbortError，返回 cancelled 而不是失败', async () => {
    const nav: FakeShare = {
      canShare: () => true,
      share: () => Promise.reject(new DOMException('user aborted', 'AbortError')),
    };
    await expect(shareFiles([jpeg()], scope(nav))).resolves.toBe('cancelled');
  });

  it('其它异常报 failed，界面据此给退路', async () => {
    const nav: FakeShare = {
      canShare: () => true,
      share: () => Promise.reject(new Error('not allowed')),
    };
    await expect(shareFiles([jpeg()], scope(nav))).resolves.toBe('failed');
  });

  it('不支持时**根本不去调** share —— 免得界面收到一个无意义的异常', async () => {
    let called = 0;
    const nav: FakeShare = {
      share: () => {
        called += 1;
        return Promise.resolve();
      },
    };
    await expect(shareFiles([jpeg()], scope(nav))).resolves.toBe('unsupported');
    expect(called).toBe(0);
  });
});

describe('photoSaver · Blob 转 File', () => {
  it('Blob 补上文件名与类型就成 File', () => {
    const file = fileFromBlob(new Blob(['abc'], { type: 'image/png' }), 'passe-1.png');
    expect(file.name).toBe('passe-1.png');
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(3);
  });
});
