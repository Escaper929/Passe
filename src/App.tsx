import { useState } from 'react';

import { FramingStudio } from '@/components/FramingStudio';
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
 */
export default function App() {
  const [view, setView] = useState<'studio' | 'lab'>('studio');
  const queue = useImageQueue();

  if (view === 'lab') {
    return <MaterialLab queue={queue} onBackToStudio={() => setView('studio')} />;
  }

  return <FramingStudio queue={queue} onOpenLab={() => setView('lab')} />;
}
