/**
 * 把成品图交给**系统相册**（iPhone / iPad）。
 *
 * ## 为什么不能"一键直接存进相册"
 *
 * iOS —— 以及所有 WKWebView 内核的浏览器 —— **没有**任何能写系统相册的 Web API：
 * Safari 至今不支持 `showSaveFilePicker`，也没有 Android 那种 MediaStore 桥。
 * 网页能做的只是"把文件交出去"，最后那一步写相册的动作只能由**系统**完成。
 * 这也解释了用户看到的现象：`<a download>` 在 iOS Safari 上会把文件塞进
 * 「文件」App 的下载目录，相册里自然找不到。
 *
 * 能走通的有两条，两条都靠系统去写：
 *
 * 1. **分享面板**：`navigator.share({ files })`（Web Share Level 2，
 *    iOS/iPadOS Safari 15+）。面板里的「存储图像」就是往相册存。
 * 2. **长按图片**：把成品渲染成 `<img src="blob:…">`，长按出现「存储图像」。
 *    这条不依赖任何 API，任何 iOS 版本都成立，是本工具最稳的兜底。
 *
 * ## 为什么流程非得分两步（先生成、再存）
 *
 * `navigator.share()` 会**消耗**用户的瞬时激活（transient activation），
 * 而 iOS 上激活是"按下后几秒内有效、且经不起 await"的东西。WebKit 自己的
 * bug 225559 记着这个现象：先 await 一个 fetch 或解密、再 share，
 * 会随耗时快慢时灵时不灵（报 `NotAllowedError`）。本工具渲染一张 8K 成品要几秒，
 * 硬塞进一次点击里必然踩上。
 *
 * 所以界面拆成两步：点「存到相册」先渲染、把 blob 攥在手里；再点「存储到照片」时
 * **同步**交出。这样第二步永远不会因为慢而失效 —— 它不是妥协，而是把
 * "渲染要花时间"这件事诚实地摆到界面上。
 *
 * 推论：`shareFiles` 必须挂在点击处理器的**最前面**，它前面不能有 `await`。
 */

export type ShareOutcome =
  /** 面板弹出来了、用户走完了流程 */
  | 'shared'
  /** 用户划掉了面板 —— 不是错误，别报错 */
  | 'cancelled'
  /** 这套环境不支持分享文件（老 Safari、Firefox…）*/
  | 'unsupported'
  /** 支持，但真的失败了（权限、文件类型…）*/
  | 'failed';

interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

/**
 * 从"作用域"里取出 navigator 上那两个方法。
 *
 * `target` 收的是**窗口级**的东西（默认 `globalThis`），与我们探测别的能力时的
 * 口径一致 —— 否则会出现"传 window 的函数能用、传 navigator 的函数不能用"
 * 这种要读两遍才看明白的分叉。
 *
 * 踩过的坑：这里原来直接把 `target` 当 navigator 用，于是默认参数下
 * `globalThis.share` 永远是 undefined —— **生产环境的功能等于关着**，
 * 而单元测试因为每次都传了个假 navigator，一路全绿。
 * 是界面测试（按钮没出现）把它揪出来的。
 */
function shareNavigatorOf(target: unknown): ShareNavigator | null {
  if (!target || typeof target !== 'object') return null;

  const scope = target as { navigator?: unknown };
  const nav = (scope.navigator ?? target) as ShareNavigator | null;
  return nav && typeof nav === 'object' ? nav : null;
}

/**
 * 这套环境能不能把**文件**交给分享面板。
 *
 * 只判断 `typeof navigator.share === 'function'` 是不够的 —— 只支持分享链接的
 * 环境同样有 `share`，但塞 `files` 进去会抛 `TypeError`。
 * 所以先看有没有 `canShare`（Level 2 的标记），再拿**真实文件**问它一次。
 */
export function canShareFiles(files: readonly File[], target: unknown = globalThis): boolean {
  if (files.length === 0) return false;

  const nav = shareNavigatorOf(target);
  const share = nav?.share;
  const canShare = nav?.canShare;
  if (typeof share !== 'function' || typeof canShare !== 'function') return false;

  try {
    return canShare.call(nav, { files: [...files] }) === true;
  } catch {
    // 有些实现对不认识的 payload 直接抛 —— 当作不支持
    return false;
  }
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * 把文件交给系统分享面板。
 *
 * **调用点前面不能有 `await`**（见文件头）。返回值区分"用户取消"与"真失败"：
 * 取消要安静，失败才需要给用户一条退路。
 */
export async function shareFiles(
  files: readonly File[],
  target: unknown = globalThis,
): Promise<ShareOutcome> {
  if (!canShareFiles(files, target)) return 'unsupported';

  const nav = shareNavigatorOf(target);
  const share = nav?.share;
  if (typeof share !== 'function') return 'unsupported';

  try {
    await share.call(nav, { files: [...files] });
    return 'shared';
  } catch (error) {
    return isAbort(error) ? 'cancelled' : 'failed';
  }
}

/** 分享面板收的是 `File`，而引擎交出来的是 `Blob` —— 补上文件名与类型。 */
export function fileFromBlob(blob: Blob, filename: string): File {
  return new File([blob], filename, { type: blob.type });
}
