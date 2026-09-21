import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPORT_FORMAT_ID,
  DEFAULT_QUALITY,
  EXPORT_FORMATS,
  QUALITY_MAX,
  QUALITY_MIN,
  clampQuality,
  describeQuality,
  resolveExportFormat,
  resolveQuality,
} from './exportFormat';

const JPEG = resolveExportFormat('jpeg');
const PNG = resolveExportFormat('png');

/**
 * 导出格式与质量。
 *
 * 这个模块存在的理由只有一条：**PNG 没有质量这一说**。
 * `canvas.toBlob(cb, 'image/png', 0.9)` 的第三个参数会被静默忽略，
 * 而"静默"正是要防的东西 —— 它不会报错，只会让用户以为调了没用。
 * 所以这里的核心断言是 `resolveQuality(PNG, ...) === undefined`，
 * 界面据此整块不渲染质量控件。
 */
describe('导出格式 · 格式表', () => {
  it('默认格式是 JPEG 且扩展名为 .jpg —— 默认值必须真能解析出来', () => {
    expect(DEFAULT_EXPORT_FORMAT_ID).toBe('jpeg');
    const fallback = resolveExportFormat(DEFAULT_EXPORT_FORMAT_ID);
    expect(fallback.mimeType).toBe('image/jpeg');
    expect(fallback.extension).toBe('.jpg');
  });

  it('id 互不相同，扩展名都带点，MIME 都是 image/', () => {
    const ids = EXPORT_FORMATS.map((format) => format.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const format of EXPORT_FORMATS) {
      // 少了这个点，文件名会变成 "Passe_xxx_2048pxpng"
      expect(format.extension.startsWith('.')).toBe(true);
      expect(format.mimeType.startsWith('image/')).toBe(true);
      expect(format.hint.length).toBeGreaterThan(0);
    }
  });

  it('未知 id 退回默认格式，不抛错', () => {
    // 旧预设里存着的历史 id、或将来删掉的格式，都不该让整个面板炸掉
    expect(resolveExportFormat('webp')).toBe(JPEG);
    expect(resolveExportFormat('')).toBe(JPEG);
    expect(resolveExportFormat('PNG')).toBe(JPEG);
  });
});

describe('导出格式 · 质量', () => {
  it('JPEG 吃质量参数', () => {
    expect(resolveQuality(JPEG, 0.9)).toBe(0.9);
    expect(resolveQuality(JPEG, DEFAULT_QUALITY)).toBe(DEFAULT_QUALITY);
  });

  it('PNG 返回 undefined —— 传一个会被忽略的数字是不诚实的', () => {
    expect(PNG.lossy).toBe(false);
    expect(resolveQuality(PNG, 0.9)).toBeUndefined();
    expect(resolveQuality(PNG, DEFAULT_QUALITY)).toBeUndefined();
  });

  it('越界与非法值都夹回区间内', () => {
    expect(clampQuality(0.1)).toBe(QUALITY_MIN);
    expect(clampQuality(1.4)).toBe(QUALITY_MAX);
    expect(clampQuality(Number.NaN)).toBe(DEFAULT_QUALITY);
    expect(clampQuality(Number.POSITIVE_INFINITY)).toBe(DEFAULT_QUALITY);
    // 区间内原样返回，不要顺手四舍五入 —— 那会让滑杆手感发涩
    expect(clampQuality(0.87)).toBe(0.87);
  });

  it('夹取发生在**传给编码器**这一步，而不只是滑杆上', () => {
    // 若只在界面上夹，从别处（旧链接、预设、将来的 API）进来的越界值会直接落到编码器
    expect(resolveQuality(JPEG, 0.1)).toBe(QUALITY_MIN);
    expect(resolveQuality(JPEG, 2)).toBe(QUALITY_MAX);
  });

  it('读数分四档，边界值归上一档', () => {
    expect(describeQuality(1)).toBe('100% · 接近无损');
    expect(describeQuality(0.95)).toBe('95% · 接近无损');
    expect(describeQuality(0.94)).toBe('94% · 高质量');
    expect(describeQuality(0.85)).toBe('85% · 高质量');
    expect(describeQuality(0.84)).toBe('84% · 通用');
    expect(describeQuality(0.75)).toBe('75% · 通用');
    expect(describeQuality(0.74)).toBe('74% · 明显压缩');
  });

  it('读数与编码器拿到的是同一个值', () => {
    // 读数用夹取后的值，否则会显示"10%"而实际传了 0.6
    expect(describeQuality(0.1)).toBe('60% · 明显压缩');
    expect(describeQuality(0.1)).toBe(describeQuality(clampQuality(0.1)));
  });
});
