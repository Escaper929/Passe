import { describe, expect, it, vi } from 'vitest';

import {
  allPresets,
  applyPreset,
  BUILTIN_PRESETS,
  createUserPreset,
  defaultPresetStorage,
  loadUserPresets,
  MAX_PRESET_NAME,
  normalizePresetName,
  PRESET_STORAGE_KEY,
  sanitizePreset,
  sanitizeStyle,
  saveUserPresets,
  type PresetStorage,
  type PresetStyle,
  type StudioPreset,
} from './presets';

/** 内存版存储。坏数据与写失败两种环境都要能造出来，所以不直接用 localStorage。 */
function memoryStorage(initial: Record<string, string> = {}): PresetStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

/** 收敛出样式，并当场断言这一步本应成功。 */
function styleOf(value: unknown): PresetStyle {
  const style = sanitizeStyle(value);
  if (!style) throw new Error('本应能收敛出样式');
  return style;
}

/** 写入必定失败：模拟隐私模式 / 配额为 0。 */
const deadStorage: PresetStorage = {
  getItem: () => null,
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => undefined,
};

describe('出厂预设', () => {
  it('四份，且与四种卡纸一一对应', () => {
    expect(BUILTIN_PRESETS).toHaveLength(4);
    expect(BUILTIN_PRESETS.map((preset) => preset.style.matColor)).toEqual([
      '#F8F7F3',
      '#F4F0E6',
      '#ECEEF0',
      '#1C1C1E',
    ]);
  });

  it('全部标了 builtin，且 id 互不相同', () => {
    const ids = new Set(BUILTIN_PRESETS.map((preset) => preset.id));
    expect(ids.size).toBe(BUILTIN_PRESETS.length);
    expect(BUILTIN_PRESETS.every((preset) => preset.builtin)).toBe(true);
  });

  it('不带机型与胶卷 —— 那是素材的身份，不是样式', () => {
    for (const preset of BUILTIN_PRESETS) {
      expect(preset.style).not.toHaveProperty('cameraModel');
      expect(preset.style).not.toHaveProperty('filmBrand');
    }
  });

  it('每一份的数值都落在滑杆区间内，应用后不会和控件打架', () => {
    for (const preset of BUILTIN_PRESETS) {
      const style = sanitizeStyle(preset.style);
      expect(style).toEqual(preset.style);
    }
  });
});

describe('sanitizeStyle', () => {
  it('认不出的键一律丢掉', () => {
    const style = sanitizeStyle({ matColor: '#F8F7F3', futureField: 42 });
    expect(style).toEqual({ matColor: '#F8F7F3' });
  });

  it('机型与胶卷也在这个函数里被剥掉', () => {
    const style = sanitizeStyle({ matColor: '#F8F7F3', cameraModel: 'LEICA M6', filmBrand: 'X' });
    expect(style).not.toHaveProperty('cameraModel');
    expect(style).not.toHaveProperty('filmBrand');
  });

  it('越界的数值被钳进滑杆区间，而不是原样带着走', () => {
    const style = styleOf({
      marginRatio: 5,
      bottomWeight: -3,
      paperTextureIntensity: 99,
      bevelWidth: -1,
      insetShadowBlur: 1e6,
      stampDepth: 0,
    });
    expect(style.marginRatio).toBe(0.3);
    expect(style.bottomWeight).toBe(1);
    expect(style.paperTextureIntensity).toBe(0.1);
    expect(style.bevelWidth).toBe(0);
    expect(style.insetShadowBlur).toBe(20);
    expect(style.stampDepth).toBe(0.2);
  });

  it('类型不对的字段被丢掉，而不是填成默认值', () => {
    const style = sanitizeStyle({ marginRatio: '0.2', matColor: 42, enableStamp: 'yes' });
    expect(style).toEqual({});
  });

  it('NaN / Infinity 不算数', () => {
    expect(
      sanitizeStyle({ marginRatio: Number.NaN, bevelWidth: Number.POSITIVE_INFINITY }),
    ).toEqual({});
  });

  it('targetAspect 允许 null（自适应），但不收 0 与负数', () => {
    expect(sanitizeStyle({ targetAspect: null })).toEqual({ targetAspect: null });
    expect(sanitizeStyle({ targetAspect: 4 / 3 })).toEqual({ targetAspect: 4 / 3 });
    expect(sanitizeStyle({ targetAspect: 0 })).toEqual({});
    expect(sanitizeStyle({ targetAspect: -1 })).toEqual({});
  });

  it('图层开关只收布尔值，且至少认出一个才带上', () => {
    expect(sanitizeStyle({ layers: { mat: false, paperTexture: 'yes' } })).toEqual({
      layers: { mat: false },
    });
    expect(sanitizeStyle({ layers: { 无关: true } })).toEqual({});
    expect(sanitizeStyle({ layers: 'all' })).toEqual({});
  });

  it('不是对象就返回 null', () => {
    expect(sanitizeStyle(null)).toBeNull();
    expect(sanitizeStyle('preset')).toBeNull();
    expect(sanitizeStyle([1, 2])).toBeNull();
  });
});

describe('sanitizePreset', () => {
  it('缺 id 或名字就丢掉', () => {
    expect(sanitizePreset({ name: 'x', style: {} })).toBeNull();
    expect(sanitizePreset({ id: 'a', style: {} })).toBeNull();
    expect(sanitizePreset({ id: 'a', name: '   ', style: {} })).toBeNull();
  });

  it('样式不是对象就丢掉', () => {
    expect(sanitizePreset({ id: 'a', name: 'x', style: 'nope' })).toBeNull();
    expect(sanitizePreset({ id: 'a', name: 'x' })).toBeNull();
  });

  it('从存储读回来的一律算用户预设，出厂预设不走存储', () => {
    const preset = sanitizePreset({ id: 'a', name: 'x', style: {}, builtin: true });
    expect(preset?.builtin).toBe(false);
  });

  it('名字过长会被截断', () => {
    const preset = sanitizePreset({ id: 'a', name: '名'.repeat(80), style: {} });
    expect(preset?.name).toHaveLength(MAX_PRESET_NAME);
  });
});

describe('本地存储', () => {
  it('存进去再读回来是同一条', () => {
    const storage = memoryStorage();
    const preset = createUserPreset('我的', { matColor: '#F8F7F3', marginRatio: 0.2 }, 'u1');

    expect(saveUserPresets([preset], storage)).toBe(true);
    expect(loadUserPresets(storage)).toEqual([preset]);
  });

  it('出厂预设不进存储 —— 它们随代码发布', () => {
    const storage = memoryStorage();
    saveUserPresets([...BUILTIN_PRESETS], storage);
    expect(loadUserPresets(storage)).toEqual([]);
  });

  it('存储里不是 JSON 时当作没有预设，不抛错', () => {
    expect(loadUserPresets(memoryStorage({ [PRESET_STORAGE_KEY]: '这不是 JSON{{' }))).toEqual([]);
  });

  it('存储里是对象而不是数组时也当作没有', () => {
    expect(
      loadUserPresets(memoryStorage({ [PRESET_STORAGE_KEY]: '{"id":"a","name":"x"}' })),
    ).toEqual([]);
  });

  it('数组里混着坏条目时，好的留下、坏的丢掉', () => {
    const raw = JSON.stringify([
      null,
      42,
      { name: '没有 id', style: {} },
      { id: 'ok', name: '好的', style: { matColor: '#ECEEF0' } },
      { id: 'bad-style', name: '样式坏了', style: 'nope' },
    ]);
    const presets = loadUserPresets(memoryStorage({ [PRESET_STORAGE_KEY]: raw }));

    expect(presets).toHaveLength(1);
    expect(presets[0].id).toBe('ok');
    expect(presets[0].style.matColor).toBe('#ECEEF0');
  });

  it('id 撞车时只留先出现的那条 —— 否则列表 key 会重复', () => {
    const raw = JSON.stringify([
      { id: 'same', name: '先来的', style: { matColor: '#111111' } },
      { id: 'same', name: '后来的', style: { matColor: '#222222' } },
    ]);
    const presets = loadUserPresets(memoryStorage({ [PRESET_STORAGE_KEY]: raw }));

    expect(presets).toHaveLength(1);
    expect(presets[0].name).toBe('先来的');
  });

  it('没有存储时读出空数组、写入报失败，都不抛错', () => {
    expect(loadUserPresets(null)).toEqual([]);
    expect(saveUserPresets([], null)).toBe(false);
  });

  it('写入抛错（配额满 / 隐私模式）时返回 false，不打断调用方', () => {
    expect(saveUserPresets([], deadStorage)).toBe(false);
  });

  it('读取抛错时也当作没有预设', () => {
    const throwing: PresetStorage = {
      ...deadStorage,
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(loadUserPresets(throwing)).toEqual([]);
  });

  it('真实的 localStorage 也是可用的（jsdom 提供）', () => {
    // 顺带确认 defaultPresetStorage 的探测逻辑在标准环境里不会误判为不可用
    window.localStorage.clear();
    const preset = createUserPreset('经存储往返', { matColor: '#F4F0E6' }, 'local-1');
    expect(saveUserPresets([preset])).toBe(true);
    expect(loadUserPresets()).toEqual([preset]);
    window.localStorage.clear();
  });
});

describe('createUserPreset', () => {
  it('保存时剥掉机型与胶卷', () => {
    const preset = createUserPreset(
      '我的',
      { matColor: '#F8F7F3', cameraModel: 'LEICA M6', filmBrand: 'PORTRA 400' },
      'u1',
    );
    expect(preset.style).not.toHaveProperty('cameraModel');
    expect(preset.style).not.toHaveProperty('filmBrand');
    expect(preset.style.matColor).toBe('#F8F7F3');
  });

  it('存下去的字段与读得回来的字段完全一致', () => {
    const storage = memoryStorage();
    const preset = createUserPreset(
      '往返',
      {
        matColor: '#1C1C1E',
        marginRatio: 0.9, // 越界，保存时就该被钳住
        layers: { mat: true, bevel: false },
        cameraModel: 'X',
      },
      'u2',
    );
    saveUserPresets([preset], storage);

    const [loaded] = loadUserPresets(storage);
    expect(loaded.style).toEqual(preset.style);
    expect(loaded.style.marginRatio).toBe(0.3);
    expect(loaded.style.layers).toEqual({ mat: true, bevel: false });
  });

  it('名字为空时用兜底名', () => {
    const preset = createUserPreset('   ', {}, 'u3', '预设 3');
    expect(preset.name).toBe('预设 3');
  });
});

describe('normalizePresetName', () => {
  it('收掉多余空白、截断超长', () => {
    expect(normalizePresetName('  我   的  预设 ', 'x')).toBe('我 的 预设');
    expect(normalizePresetName('名'.repeat(50), 'x')).toHaveLength(MAX_PRESET_NAME);
  });

  it('空名字用兜底', () => {
    expect(normalizePresetName('   ', '兜底')).toBe('兜底');
  });
});

describe('applyPreset', () => {
  const preset: StudioPreset = {
    id: 'p',
    name: '冷灰',
    builtin: false,
    style: { matColor: '#ECEEF0', marginRatio: 0.16, enableStamp: false },
  };

  it('样式被整套换掉', () => {
    const next = applyPreset({ matColor: '#F8F7F3', marginRatio: 0.1, bevelWidth: 5 }, preset);
    expect(next.matColor).toBe('#ECEEF0');
    expect(next.marginRatio).toBe(0.16);
    expect(next.enableStamp).toBe(false);
    // 预设没提的字段不保留 —— 预设是整套样式，不是补丁
    expect(next.bevelWidth).toBeUndefined();
  });

  it('机型与胶卷原样保留 —— 换预设不该把用户刚填的机型抹掉', () => {
    const next = applyPreset({ cameraModel: 'LEICA M6', filmBrand: 'KODAK PORTRA 400' }, preset);
    expect(next.cameraModel).toBe('LEICA M6');
    expect(next.filmBrand).toBe('KODAK PORTRA 400');
  });
});

describe('allPresets', () => {
  it('出厂在前、用户在后', () => {
    const user = createUserPreset('我的', {}, 'u1');
    const list = allPresets([user]);
    expect(list.slice(0, BUILTIN_PRESETS.length)).toEqual([...BUILTIN_PRESETS]);
    expect(list[list.length - 1]).toEqual(user);
  });
});

describe('defaultPresetStorage 的探测', () => {
  it('标准环境下能拿到存储，且探测不留痕迹', () => {
    window.localStorage.clear();
    expect(defaultPresetStorage()).not.toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it('写不进去的环境（配额为 0 / 隐私模式）返回 null', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(defaultPresetStorage()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
