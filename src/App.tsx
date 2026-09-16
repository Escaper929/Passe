import MaterialLab from '@/lab/MaterialLab';

/**
 * 阶段 1 的入口是材质验证台，用来判定四层材质的质感是否成立。
 * 正式的「画廊装裱调校台」（开发指南 §4）会在阶段 3 接管这个位置。
 */
export default function App() {
  return <MaterialLab />;
}
