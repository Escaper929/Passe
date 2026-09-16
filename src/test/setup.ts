/**
 * 测试环境全局设置。
 *
 * React 19 在非浏览器环境下执行 act() 前会要求显式声明
 * IS_REACT_ACT_ENVIRONMENT，否则只会打一句警告、不保证把状态更新彻底刷新，
 * 于是组件测试里读到的永远是上一帧的数据（表现为"等待条件超时"）。
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export {};
