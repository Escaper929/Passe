/**
 * 阶段 0 占位外壳。
 *
 * 这里刻意只搭出开发指南 §4 的工作台骨架（左视口 + 右控制台），
 * 用来验证 Tailwind v4 令牌、深色主题与布局链路已经打通。
 * 真正的装裱引擎（§3）在阶段 1 接入，交互控制台（§4）在阶段 3 落地。
 */

const MAT_PRESETS = [
  { name: '博物馆暖白', hex: '#F8F7F3', token: 'bg-mat-warm-white' },
  { name: '暗房象牙色', hex: '#F4F0E6', token: 'bg-mat-ivory' },
  { name: '当代冷灰', hex: '#ECEEF0', token: 'bg-mat-cool-grey' },
  { name: '炭黑展厅', hex: '#1C1C1E', token: 'bg-mat-carbon' },
] as const;

const ROADMAP = [
  { stage: '阶段 0', label: '工程骨架与工具链', done: true },
  { stage: '阶段 1', label: '渲染引擎核心', done: false },
  { stage: '阶段 2', label: '图像输入管线', done: false },
  { stage: '阶段 3', label: '交互控制台', done: false },
] as const;

export default function App() {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-studio-bg font-sans text-[#E0E0E0]">
      <main className="relative flex flex-1 select-none items-center justify-center bg-studio-viewport p-8">
        <div className="flex max-w-lg flex-col items-center text-center">
          <p className="text-xs uppercase tracking-[0.3em] text-[#777]">Passe · 衬境</p>
          <h1 className="mt-3 text-xl font-medium text-white">工程骨架已就绪</h1>
          <p className="mt-3 text-sm leading-relaxed text-[#888]">
            Vite + React + TypeScript + Tailwind v4 工具链已贯通。
            <br />
            装裱渲染引擎将在阶段 1 接入，交互控制台在阶段 3 落地。
          </p>

          <div className="mt-8 grid w-full grid-cols-4 gap-2">
            {MAT_PRESETS.map((preset) => (
              <div
                key={preset.name}
                className="flex flex-col items-center gap-2 rounded border border-studio-line bg-[#1C1C1E] p-3"
              >
                <span
                  aria-hidden
                  className="h-8 w-full rounded-xs border border-black/20"
                  style={{ background: preset.hex }}
                />
                <span className="text-[11px] leading-tight text-[#999]">{preset.name}</span>
                <code className="text-[10px] text-[#5A5A5A]">{preset.hex}</code>
              </div>
            ))}
          </div>
        </div>
      </main>

      <aside className="hidden w-96 flex-col border-l border-studio-line bg-studio-panel p-6 lg:flex">
        <header>
          <h2 className="text-xs uppercase tracking-[0.25em] text-[#888]">开发进度</h2>
          <p className="mt-1 text-base font-medium text-white">画廊装裱调校台</p>
        </header>

        <ul className="mt-6 space-y-3">
          {ROADMAP.map((item) => (
            <li key={item.stage} className="flex items-center gap-3 text-xs">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  item.done ? 'bg-mat-cool-grey' : 'bg-[#3A3A3A]'
                }`}
              />
              <span className="w-14 shrink-0 text-[#666]">{item.stage}</span>
              <span className={item.done ? 'text-white' : 'text-[#777]'}>{item.label}</span>
            </li>
          ))}
        </ul>

        <p className="mt-auto border-t border-studio-line pt-4 text-[11px] leading-relaxed text-[#5A5A5A]">
          全部渲染在浏览器本地完成，照片不会上传到任何服务器。
        </p>
      </aside>
    </div>
  );
}
