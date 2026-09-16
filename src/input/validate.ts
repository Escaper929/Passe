/**
 * 文件准入校验。
 *
 * 这里只做**解码前**能判断的事：尺寸、字节数、格式能否被浏览器解码。
 * 真正的解码失败由 decode.ts 兜底 —— 两者职责不重叠。
 *
 * 几个刻意的设计：
 * 1. 校验函数收结构化对象而非 File，便于测试时不构造真实文件。
 * 2. 不信任 `file.type`：Windows 与部分相机导出的 TIFF/HEIC 的 MIME 常为空串，
 *    只靠 MIME 会把用户的扫描件误判成"非图片"。因此 MIME 为空时回退到扩展名嗅探。
 * 3. TIFF / HEIC 不阻断。Safari 能解 TIFF，Chrome 不能；HEIC 各浏览器差异更大。
 *    直接拦掉会误伤 Safari 用户，放行则 Chrome 用户会在解码阶段拿到一句看不懂的报错。
 *    解法是放行但带上明确的警告，让用户在失败前就知道该导出成 PNG。
 */

/** 文件存在但不适合进入队列的原因。 */
export type FileIssueCode =
  /** 0 字节，空文件 */
  | 'empty'
  /** 既不是图片 MIME，扩展名也不认识 */
  | 'not-image'
  /** 超出浏览器可解码的文件体积 */
  | 'too-large'
  /** TIFF / HEIC 等浏览器支持不一致的格式 */
  | 'browser-may-not-decode'
  /** 体积偏大，解码需要等待，但没有硬性风险 */
  | 'large-file';

export interface FileIssue {
  code: FileIssueCode;
  /** 是否阻断入队。阻断项不会进入图片托盘 */
  blocking: boolean;
  message: string;
}

export interface FileVerdict {
  /** 是否可以进入队列（可能带非阻断警告） */
  accepted: boolean;
  /** 阻断项；accepted 为 true 时为 null */
  issue: FileIssue | null;
  /** 非阻断问题的提示文案 */
  warning: string | null;
}

/** 校验所需的最小文件信息。 */
export interface FileLike {
  name: string;
  size: number;
  type: string;
}

/**
 * 硬上限。超过这个体积基本可以断定不是常规胶片扫描件，
 * 且解码时会直接耗尽标签页内存，不如在读盘前就拒绝。
 */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** 软阈值。超过它只是解码慢，不阻断。 */
export const LARGE_FILE_BYTES = 64 * 1024 * 1024;

/** 浏览器解码能力有分歧的扩展名。 */
const RISKY_EXTENSIONS = new Set(['tif', 'tiff', 'heic', 'heif']);

/** 认识的图片扩展名。MIME 为空时靠它兜底。 */
const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'jpe',
  'png',
  'webp',
  'avif',
  'bmp',
  'gif',
  'tif',
  'tiff',
  'heic',
  'heif',
]);

/** 文件选择框的 accept 属性。与上面的扩展名列表保持同步。 */
export const FILE_INPUT_ACCEPT =
  'image/jpeg,image/png,image/webp,image/avif,image/bmp,image/gif,image/tiff';

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** MIME 或扩展名任一命中即视为图片。 */
export function looksLikeImage(file: FileLike): boolean {
  if (file.type.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(extensionOf(file.name));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 单个文件的准入判决。 */
export function inspectFile(file: FileLike): FileVerdict {
  const reject = (code: FileIssueCode, message: string): FileVerdict => ({
    accepted: false,
    issue: { code, blocking: true, message },
    warning: null,
  });

  if (file.size <= 0) {
    return reject('empty', `${file.name}：文件是空的（0 字节）`);
  }

  if (!looksLikeImage(file)) {
    return reject(
      'not-image',
      `${file.name}：不是图片文件（${file.type || extensionOf(file.name) || '未知格式'}）`,
    );
  }

  if (file.size > MAX_FILE_BYTES) {
    return reject(
      'too-large',
      `${file.name}：${formatBytes(file.size)} 超出浏览器可解码上限 ${formatBytes(MAX_FILE_BYTES)}，` +
        `请先降到 8K 长边以内`,
    );
  }

  const ext = extensionOf(file.name);
  const warnings: string[] = [];

  if (file.type === 'image/tiff' || RISKY_EXTENSIONS.has(ext)) {
    warnings.push(
      `${file.name}：${ext.toUpperCase() || 'TIFF'} 的浏览器解码支持不一致，` +
        `若预览失败请先导出为 PNG 或 JPEG`,
    );
  }

  if (file.size > LARGE_FILE_BYTES) {
    warnings.push(`${file.name}：${formatBytes(file.size)}，解码需要几秒`);
  }

  return {
    accepted: true,
    issue: null,
    warning: warnings.length > 0 ? warnings.join('；') : null,
  };
}

export interface AcceptedFile<T extends FileLike = FileLike> {
  file: T;
  /** 该文件自己的非阻断提示，展示在对应条目上 */
  warning: string | null;
}

export interface BatchVerdict<T extends FileLike = FileLike> {
  /** 通过准入的文件，顺序与输入一致 */
  accepted: AcceptedFile<T>[];
  /** 被阻断的文件及原因。它们进不了队列，所以只有这份汇总能告诉用户为什么 */
  rejected: { file: T; issue: FileIssue }[];
}

/**
 * 批量判决。拖入一堆文件时用，避免逐个弹窗。
 *
 * 这里**不**再汇总逐文件的警告：它们已经挂在各自条目上，
 * 汇总一遍只是把同样的字又说一次。被拒绝的文件相反 —— 它们不入队、
 * 没有条目可以承载原因，必须由调用方统一告知。
 */
export function inspectBatch<T extends FileLike>(files: readonly T[]): BatchVerdict<T> {
  const accepted: AcceptedFile<T>[] = [];
  const rejected: { file: T; issue: FileIssue }[] = [];

  for (const file of files) {
    const verdict = inspectFile(file);
    if (verdict.accepted) {
      accepted.push({ file, warning: verdict.warning });
    } else if (verdict.issue) {
      rejected.push({ file, issue: verdict.issue });
    }
  }

  return { accepted, rejected };
}
