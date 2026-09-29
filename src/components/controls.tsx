/**
 * 工作台通用控件。
 *
 * 材质验证台与正式调校台共用同一套控件，不是图省事 —— 两边的滑杆、开关、
 * 选择格如果各写一份，改一处忘一处，同一个参数在两边的手感就会不一样。
 */

import type { ReactNode } from 'react';

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  /** 标题右侧的补充说明 */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-studio-line pt-5">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-xs tracking-wider text-[#777] uppercase">{title}</h3>
        {hint ? <span className="text-[10px] text-[#555]">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (next: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-xs text-[#888]">
        <span>{label}</span>
        <span className="text-[#BBB]">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
        className="h-1 w-full accent-white"
      />
    </label>
  );
}

export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-white"
      />
      <span>
        <span className={`block text-xs ${checked ? 'text-[#DDD]' : 'text-[#666]'}`}>{label}</span>
        <span className="block text-[10px] text-[#555]">{hint}</span>
      </span>
    </label>
  );
}

export interface ChoiceOption<T extends string | number | null> {
  value: T;
  label: string;
  /** 悬浮说明 */
  hint?: string;
  /** 色块预览，如卡纸配色 */
  swatch?: string;
}

/**
 * 单行/网格选择。
 *
 * 用泛型保住 value 的具体类型（null 表示"自适应"这种语义），
 * 否则调用方拿到的是 string | number | null，比较起来处处要断言。
 */
export function ChoiceGrid<T extends string | number | null>({
  options,
  value,
  onChange,
  columns = 2,
}: {
  options: readonly ChoiceOption<T>[];
  value: T;
  onChange: (next: T) => void;
  columns?: number;
}) {
  const gridClass = columns === 4 ? 'grid-cols-4' : columns === 3 ? 'grid-cols-3' : 'grid-cols-2';

  return (
    <div className={`grid gap-1.5 ${gridClass}`}>
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={`flex items-center gap-2 rounded border py-1.5 text-[11px] transition-colors ${
              option.swatch ? 'p-2 text-left' : 'justify-center'
            } ${
              active
                ? 'border-white bg-[#28282A] text-white'
                : 'border-[#262628] bg-[#1C1C1E] text-[#888] hover:border-[#38383A]'
            }`}
          >
            {option.swatch ? (
              <span
                aria-hidden
                className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/20"
                style={{ background: option.swatch }}
              />
            ) : null}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TextField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] tracking-wider text-[#666] uppercase">{label}</span>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded border border-[#28282A] bg-[#1C1C1E] px-3 py-2 text-xs text-white transition-colors focus:border-[#555] focus:outline-none"
      />
    </label>
  );
}

/**
 * 一段文本字段的候选值列表。
 *
 * 给"相机机型""胶卷型号"这类**该自由填写、但绝大多数人只会填那几个值**的字段用：
 * 点一下等于替用户敲一遍字，填完仍然可以随便改 —— 它不接管那个字段，
 * 只是省掉打字与拼错。
 *
 * 两个细节是刻意的：
 *
 * 1. **限高可滚，不折叠。** 16 条一列排开会把侧栏撑得很长，藏进"展开"又让
 *    这个功能没人发现。给一个约 5 行高的滚动区，既一眼看得出有什么、
 *    也不会把底下的滑杆挤到看不见。
 * 2. **高亮按大小写不敏感比。** 用户手敲了 `leica m6`，钢印印出来仍是大写
 *    （`drawDeboss` 会 `toUpperCase()`），所以按原样比会让"明明填的就是这个"
 *    的那一条不亮 —— 看起来像没生效。
 */
export function PresetChips({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly string[];
  /** 该字段当前的值（可能是用户手敲的任意大小写） */
  value: string;
  onPick: (next: string) => void;
}) {
  const current = value.trim().toUpperCase();

  return (
    <div className="mt-1.5">
      {/* 条数标在右侧：列表是限高可滚的，只露 5 行 —— 不报总数的话
          用户不会知道后面还有 11 条。写法与 Section 的「标题 + 补充」一致。 */}
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[10px] tracking-wider text-[#555] uppercase">{label}</span>
        <span className="text-[10px] text-[#444]">{options.length} 个</span>
      </span>
      <div className="max-h-[138px] space-y-1 overflow-y-auto pr-1">
        {options.map((option) => {
          const active = current !== '' && current === option;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onPick(option)}
              title={active ? '正在用这一条' : `填入「${option}」`}
              className={`block w-full truncate rounded border px-2 py-1 text-left text-[11px] transition-colors ${
                active
                  ? 'border-white bg-[#28282A] text-white'
                  : 'border-[#262628] bg-[#1C1C1E] text-[#888] hover:border-[#38383A] hover:text-white'
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}
