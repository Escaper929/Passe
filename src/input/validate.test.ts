import { describe, expect, it } from 'vitest';

import {
  extensionOf,
  formatBytes,
  inspectBatch,
  inspectFile,
  LARGE_FILE_BYTES,
  looksLikeImage,
  MAX_FILE_BYTES,
  type FileLike,
} from './validate';

function file(name: string, size: number, type: string): FileLike {
  return { name, size, type };
}

describe('文件准入校验 · 基础判定', () => {
  it('识别扩展名，即使文件名没有后缀也不炸', () => {
    expect(extensionOf('scan.TIFF')).toBe('tiff');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });

  it('空的扫描件在进入队列前就被挡下', () => {
    const verdict = inspectFile(file('empty.jpg', 0, 'image/jpeg'));
    expect(verdict.accepted).toBe(false);
    expect(verdict.issue?.code).toBe('empty');
    expect(verdict.issue?.blocking).toBe(true);
  });

  it('拒绝非图片文件，并在文案里说明它是什么', () => {
    const verdict = inspectFile(file('合同.pdf', 1024, 'application/pdf'));
    expect(verdict.accepted).toBe(false);
    expect(verdict.issue?.code).toBe('not-image');
    expect(verdict.issue?.message).toContain('合同.pdf');
  });

  it('MIME 为空时回退到扩展名 —— 部分相机导出的 JPEG 就是空 MIME', () => {
    const verdict = inspectFile(file('DSC_0001.JPG', 4 * 1024 * 1024, ''));
    expect(verdict.accepted).toBe(true);
    expect(verdict.warning).toBeNull();
  });

  it('MIME 与扩展名都不认识才判定为非图片', () => {
    expect(looksLikeImage(file('x', 1, ''))).toBe(false);
    expect(looksLikeImage(file('x.raw', 1, ''))).toBe(false);
    expect(looksLikeImage(file('x.png', 1, ''))).toBe(true);
    // 任何 image/* 都算图片：宁可让它在解码阶段报错，也不要在这里误判
    expect(looksLikeImage(file('x', 1, 'image/whatever'))).toBe(true);
  });
});

describe('文件准入校验 · 体积', () => {
  it('超过硬上限的文件被拒绝，并报出实际体积', () => {
    const verdict = inspectFile(file('huge.tif', MAX_FILE_BYTES + 1, 'image/tiff'));
    expect(verdict.accepted).toBe(false);
    expect(verdict.issue?.code).toBe('too-large');
    expect(verdict.issue?.message).toContain('512.0 MB');
  });

  it('大体积但不越线时放行，只给一句"解码需要几秒"', () => {
    const verdict = inspectFile(file('big.png', LARGE_FILE_BYTES + 1, 'image/png'));
    expect(verdict.accepted).toBe(true);
    expect(verdict.warning).toContain('解码需要几秒');
  });

  it('字节数格式化在三个量级上都可读', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('文件准入校验 · 浏览器解码能力', () => {
  it('TIFF 放行但带警告 —— Safari 能解，Chrome 不能，直接拦掉会误伤', () => {
    const verdict = inspectFile(file('scan.tif', 40 * 1024 * 1024, 'image/tiff'));
    expect(verdict.accepted).toBe(true);
    expect(verdict.issue).toBeNull();
    expect(verdict.warning).toContain('解码支持不一致');
  });

  it('HEIC 同样放行但警告 —— 这是 iPhone 导入最常见的坑', () => {
    const verdict = inspectFile(file('IMG_0001.heic', 3 * 1024 * 1024, ''));
    expect(verdict.accepted).toBe(true);
    expect(verdict.warning).toContain('PNG 或 JPEG');
  });

  it('常规 JPEG 不产生任何警告', () => {
    const verdict = inspectFile(file('portra400.jpg', 24 * 1024 * 1024, 'image/jpeg'));
    expect(verdict.accepted).toBe(true);
    expect(verdict.warning).toBeNull();
  });
});

describe('文件准入校验 · 批量', () => {
  it('混合拖入时分开归集，通过项保留各自的警告', () => {
    const verdict = inspectBatch([
      file('a.jpg', 1024, 'image/jpeg'),
      file('b.tif', 2048, 'image/tiff'),
      file('c.pdf', 4096, 'application/pdf'),
      file('d.png', 0, 'image/png'),
    ]);

    expect(verdict.accepted.map((entry) => entry.file.name)).toEqual(['a.jpg', 'b.tif']);
    expect(verdict.accepted[0].warning).toBeNull();
    expect(verdict.accepted[1].warning).toContain('解码支持不一致');
    expect(verdict.rejected.map((entry) => entry.issue.code)).toEqual(['not-image', 'empty']);
  });

  it('被拒绝的文件都带得出原因 —— 它们没有条目可以承载说明', () => {
    const verdict = inspectBatch([
      file('a.tif', MAX_FILE_BYTES + 1, 'image/tiff'),
      file('b.pdf', 1024, 'application/pdf'),
    ]);

    expect(verdict.accepted).toHaveLength(0);
    expect(verdict.rejected).toHaveLength(2);
    for (const entry of verdict.rejected) {
      expect(entry.issue.message.length).toBeGreaterThan(0);
      expect(entry.issue.blocking).toBe(true);
    }
  });

  it('全部通过时没有拒绝项', () => {
    const verdict = inspectBatch([file('a.jpg', 1024, 'image/jpeg')]);
    expect(verdict.rejected).toHaveLength(0);
    expect(verdict.accepted[0].warning).toBeNull();
  });

  it('空列表返回空结果而不是抛错', () => {
    const verdict = inspectBatch([]);
    expect(verdict.accepted).toHaveLength(0);
    expect(verdict.rejected).toHaveLength(0);
  });
});
