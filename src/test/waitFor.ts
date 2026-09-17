import { act } from 'react';

export interface WaitForOptions {
  /** 轮询次数上限。默认 60 次 × 2ms ≈ 120ms 的虚时间预算 */
  attempts?: number;
  /**
   * 等待目标的描述，只用于失败时报错。
   *
   * 不带它的话，失败信息只有干巴巴的一句"等待条件超时"，
   * 而同一批断言里往往有五六个 waitFor，根本分不清是哪一个没等到 ——
   * 这类错误之前在队列还没就绪和事件压根没派发之间来回误导过好几次。
   */
  label?: string;
}

/**
 * 反复刷新微任务与计时器，直到条件成立或超时。
 *
 * 每次轮询都包在 act 里：解码是异步的，状态更新发生在 act 之外，
 * 不主动 flush 的话读到的永远是上一帧，表现为"条件永远不成立"。
 */
export async function waitFor(
  predicate: () => boolean,
  options: WaitForOptions = {},
): Promise<void> {
  const { attempts = 60, label } = options;
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
  throw new Error(label ? `等待条件超时：${label}` : '等待条件超时');
}
