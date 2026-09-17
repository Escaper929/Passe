import { act } from 'react';

export interface WaitForOptions {
  /**
   * 等待上限，单位是**毫秒墙钟时间**。
   *
   * 刻意按墙钟而不是按轮询次数：轮询次数换算成真实时间，在不同机器上能差好几倍 ——
   * CI 只有 2 个 vCPU，而 vitest 会并行跑各个测试文件，真实画布渲染 + JPEG 编码
   * 要和别的 worker 抢 CPU。这里曾经用"60 次轮询"当预算，本机勉强够、CI 上不够，
   * 于是用例在等一个其实正在正常完成的导出。
   */
  timeout?: number;
  /**
   * 等待目标的描述，只用于失败时报错。
   *
   * 不带它的话，失败信息只有干巴巴的一句"等待条件超时"，
   * 而同一批断言里往往有五六个 waitFor，根本分不清是哪一个没等到 ——
   * 这类错误之前在"队列还没就绪"和"事件压根没派发"之间来回误导过好几次。
   */
  label?: string;
}

/** 轮询间隔。够小以免白等，够大以免 act 的开销盖过被测逻辑。 */
const POLL_MS = 2;

/** 默认等待上限。 */
export const DEFAULT_WAIT_TIMEOUT = 5000;

/**
 * 反复刷新微任务与计时器，直到条件成立或超时。
 *
 * 每次轮询都包在 act 里：解码与渲染都是异步的，状态更新发生在 act 之外，
 * 不主动 flush 的话读到的永远是上一帧，表现为"条件永远不成立"。
 *
 * 条件一旦成立就立刻返回 —— 预算给得宽不等于每次都等满。
 */
export async function waitFor(
  predicate: () => boolean,
  options: WaitForOptions = {},
): Promise<void> {
  const { timeout = DEFAULT_WAIT_TIMEOUT, label } = options;
  const deadline = Date.now() + timeout;

  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`等待条件超时（${timeout}ms）${label ? `：${label}` : ''}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    });
  }
}
