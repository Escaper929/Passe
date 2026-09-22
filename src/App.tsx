import { useState } from 'react';

import { FramingStudio } from '@/components/FramingStudio';
import { useFramingSettings } from '@/components/framingSettings';
import MaterialLab from '@/lab/MaterialLab';
import { useImageQueue } from '@/input/useImageQueue';

/**
 * 应用入口。
 *
 * 队列放在这一层，而不是各自的界面里 —— 用户从调校台切到材质验证台看放大镜，
 * 再切回来时，拖进来的十几张扫描件必须还在。如果两边各持一份队列，
 * 切一次视图就等于清空一次，那是很难忍的。
 *
 * 同理，粘贴监听也只在队列这一层注册一次，两个视图共享。
 *
 * 装裱设置（配方 + 导出尺寸 + 格式与质量）也在这一层，理由一模一样：切视图是
 * **卸载重建**，留在组件里就等于切一次回一次默认。它与队列的区别是——
 * 队列是"用户拖进来的素材"，设置是"用户调出来的参数"，但两者的价值是同一种：
 * 都是用户投入了劳动、不该被一次无关的点击抹掉的东西。
 * 两个视图共用同一份设置，验证台那一侧的材质调整才能带回来。
 */
export default function App() {
  const [view, setView] = useState<'studio' | 'lab'>('studio');
  const queue = useImageQueue();
  const settings = useFramingSettings();

  if (view === 'lab') {
    return (
      <MaterialLab queue={queue} settings={settings} onBackToStudio={() => setView('studio')} />
    );
  }

  return <FramingStudio queue={queue} settings={settings} onOpenLab={() => setView('lab')} />;
}
