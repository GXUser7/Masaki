import {
  argbFromHex,
  argbFromRgb,
  Hct,
  hexFromArgb,
  MaterialDynamicColors as C,
  QuantizerCelebi,
  SchemeExpressive,
  SchemeFidelity,
  SchemeMonochrome,
  SchemeTonalSpot,
  SchemeVibrant,
  Score,
  type DynamicScheme
} from '@material/material-color-utilities'

export type Tokens = Record<string, string>
export interface PalettePair {
  light: Tokens
  dark: Tokens
}

// Ручные палитры, те же, что в макете. Ключи — имена CSS-переменных без «--».
const presets: Record<'violet' | 'mint' | 'peach', PalettePair> = {
  violet: {
    light: {
      primary: '#65558F', 'on-primary': '#FFFFFF', pc: '#E9DDFF', 'on-pc': '#4D3D75', sec: '#625B71',
      sc: '#E8DEF8', 'on-sc': '#4A4458', tert: '#7D5260', tc: '#FFD8E4', 'on-tc': '#633B48',
      'on-surface': '#1D1B20', 'on-sv': '#49454F', outline: '#7A757F', wall: '#EDE4F5',
      b1: '#CBB6FF', b2: '#FFB0CA', b3: '#AABDFF', b4: '#FFD6A5'
    },
    dark: {
      primary: '#D0BCFF', 'on-primary': '#381E72', pc: '#4F378B', 'on-pc': '#EADDFF', sec: '#CCC2DC',
      sc: '#4A4458', 'on-sc': '#E8DEF8', tert: '#EFB8C8', tc: '#633B48', 'on-tc': '#FFD8E4',
      'on-surface': '#E6E0E9', 'on-sv': '#CAC4D0', outline: '#938F99', wall: '#121016',
      b1: '#5B3FA0', b2: '#8A2F55', b3: '#2D3F8F', b4: '#7A5220'
    }
  },
  mint: {
    light: {
      primary: '#006A60', 'on-primary': '#FFFFFF', pc: '#9EF2E4', 'on-pc': '#00504A', sec: '#4A635F',
      sc: '#CCE8E2', 'on-sc': '#334B47', tert: '#456179', tc: '#CCE5FF', 'on-tc': '#2D4960',
      'on-surface': '#171D1C', 'on-sv': '#3F4947', outline: '#6F7977', wall: '#E3F1EE',
      b1: '#86E0CF', b2: '#A4CFF4', b3: '#DDEFA0', b4: '#FFCFAF'
    },
    dark: {
      primary: '#82D5C8', 'on-primary': '#003731', pc: '#005048', 'on-pc': '#9EF2E4', sec: '#B1CCC6',
      sc: '#334B47', 'on-sc': '#CCE8E2', tert: '#ADCAE6', tc: '#2D4960', 'on-tc': '#CCE5FF',
      'on-surface': '#DDE4E1', 'on-sv': '#BEC9C6', outline: '#899390', wall: '#0D1513',
      b1: '#00695E', b2: '#1F4E73', b3: '#46550F', b4: '#74401C'
    }
  },
  peach: {
    light: {
      primary: '#8F4C38', 'on-primary': '#FFFFFF', pc: '#FFDBD1', 'on-pc': '#723523', sec: '#77574E',
      sc: '#FFDBCF', 'on-sc': '#5D4037', tert: '#6C5D2F', tc: '#F5E1A7', 'on-tc': '#534619',
      'on-surface': '#231917', 'on-sv': '#53433F', outline: '#85736E', wall: '#FCEDE7',
      b1: '#FFB39C', b2: '#FFD786', b3: '#F4A3C0', b4: '#C6B5FF'
    },
    dark: {
      primary: '#FFB5A0', 'on-primary': '#561F0F', pc: '#723523', 'on-pc': '#FFDBD1', sec: '#E7BDB2',
      sc: '#5D4037', 'on-sc': '#FFDBCF', tert: '#D8C58D', tc: '#534619', 'on-tc': '#F5E1A7',
      'on-surface': '#F1DFDA', 'on-sv': '#D8C2BC', outline: '#A08C87', wall: '#1A1110',
      b1: '#80391F', b2: '#6A520E', b3: '#74284A', b4: '#3D3285'
    }
  }
}

// ---------- Палитры по базовому цвету: спецификация цветов M3 Expressive (2025) ----------

export type Variant = 'tonal' | 'vibrant' | 'expressive' | 'fidelity' | 'mono'

/** Готовые палитры, которые строит сама библиотека Material по базовому цвету. */
export const seedPresets: Record<string, { name: string; seed: string; variant: Variant }> = {
  ocean: { name: 'Океан', seed: '#0061A4', variant: 'tonal' },
  sky: { name: 'Небо', seed: '#3E7BFA', variant: 'vibrant' },
  aqua: { name: 'Бирюза', seed: '#00838F', variant: 'vibrant' },
  forest: { name: 'Лес', seed: '#386A20', variant: 'tonal' },
  lime: { name: 'Лайм', seed: '#7A8A00', variant: 'vibrant' },
  amber: { name: 'Янтарь', seed: '#C77700', variant: 'tonal' },
  sunset: { name: 'Закат', seed: '#E8553B', variant: 'expressive' },
  cherry: { name: 'Вишня', seed: '#9C1C2C', variant: 'fidelity' },
  rose: { name: 'Роза', seed: '#B4235A', variant: 'tonal' },
  lavender: { name: 'Лаванда', seed: '#7E57C2', variant: 'expressive' },
  graphite: { name: 'Графит', seed: '#5F6368', variant: 'mono' }
}

export const handmadeNames: Record<'violet' | 'mint' | 'peach', string> = {
  violet: 'Фиалка',
  mint: 'Мята',
  peach: 'Персик'
}

function makeScheme(seed: number, variant: Variant, dark: boolean): DynamicScheme {
  const hct = Hct.fromInt(seed)
  switch (variant) {
    case 'vibrant':
      return new SchemeVibrant(hct, dark, 0, '2025')
    case 'expressive':
      return new SchemeExpressive(hct, dark, 0, '2025')
    case 'fidelity':
      return new SchemeFidelity(hct, dark, 0, '2025')
    case 'mono':
      return new SchemeMonochrome(hct, dark, 0, '2025')
    default:
      return new SchemeTonalSpot(hct, dark, 0, '2025')
  }
}

function tokensFromScheme(s: DynamicScheme, dark: boolean): Tokens {
  const c = (dc: typeof C.primary): string => hexFromArgb(dc.getArgb(s))
  return {
    primary: c(C.primary),
    'on-primary': c(C.onPrimary),
    pc: c(C.primaryContainer),
    'on-pc': c(C.onPrimaryContainer),
    sec: c(C.secondary),
    sc: c(C.secondaryContainer),
    'on-sc': c(C.onSecondaryContainer),
    tert: c(C.tertiary),
    tc: c(C.tertiaryContainer),
    'on-tc': c(C.onTertiaryContainer),
    'on-surface': c(C.onSurface),
    'on-sv': c(C.onSurfaceVariant),
    outline: c(C.outline),
    wall: hexFromArgb(s.neutralPalette.tone(dark ? 6 : 94)),
    b1: hexFromArgb(s.primaryPalette.tone(dark ? 30 : 80)),
    b2: hexFromArgb(s.tertiaryPalette.tone(dark ? 30 : 80)),
    b3: hexFromArgb(s.secondaryPalette.tone(dark ? 30 : 80)),
    b4: hexFromArgb(s.primaryPalette.tone(dark ? 20 : 90))
  }
}

const pairCache = new Map<string, PalettePair>()

/** Светлая и тёмная палитры по одному базовому цвету. */
export function pairFromSeed(seed: number | string, variant: Variant = 'tonal'): PalettePair {
  const argb = typeof seed === 'string' ? argbFromHex(seed) : seed
  const key = argb + '|' + variant
  let pair = pairCache.get(key)
  if (!pair) {
    pair = {
      light: tokensFromScheme(makeScheme(argb, variant, false), false),
      dark: tokensFromScheme(makeScheme(argb, variant, true), true)
    }
    pairCache.set(key, pair)
  }
  return pair
}

/** Базовый цвет по оттенку для ползунка «Свой цвет». */
export function seedFromHue(hue: number): string {
  return hexFromArgb(Hct.from(hue, 60, 50).toInt())
}

export function hueOf(hex: string): number {
  try {
    return Math.round(Hct.fromInt(argbFromHex(hex)).hue)
  } catch {
    return 280
  }
}

/** Палитра Material You из картинки, как на Pixel: главный цвет обоев → палитра M3. */
export async function paletteFromImage(src: string): Promise<PalettePair | null> {
  const img = new Image()
  img.src = src
  try {
    await img.decode()
  } catch {
    return null
  }
  const w = 112
  const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const pixels: number[] = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 255) continue
    pixels.push(argbFromRgb(data[i], data[i + 1], data[i + 2]))
  }
  // Без запасного цвета: иначе для серых обоев библиотека подставит синий Google.
  const NONE = 0
  const best = Score.score(QuantizerCelebi.quantize(pixels, 128), { desired: 1, fallbackColorARGB: NONE, filter: true })[0]
  // Серые и почти серые обои дают монохромную тему, как на Pixel.
  if (best === NONE || Hct.fromInt(best).chroma < 12) return pairFromSeed(best === NONE ? '#808080' : best, 'mono')
  return pairFromSeed(best, 'tonal')
}

export function tokensFor(palette: string, dark: boolean, fromImage: PalettePair | null, customColor: string): Tokens {
  let pair: PalettePair
  if (palette === 'wallpaper') pair = fromImage ?? presets.mint
  else if (palette === 'custom') pair = pairFromSeed(/^#[0-9a-f]{6}$/i.test(customColor) ? customColor : '#6750A4')
  else if (palette in presets) pair = presets[palette as keyof typeof presets]
  else if (palette in seedPresets) pair = pairFromSeed(seedPresets[palette].seed, seedPresets[palette].variant)
  else pair = presets.mint
  return dark ? pair.dark : pair.light
}

export function applyTokens(el: HTMLElement, tokens: Tokens): void {
  for (const [k, v] of Object.entries(tokens)) el.style.setProperty('--' + k, v)
}

/** Три цвета для кружка-образца палитры в настройках. */
export function swatchOf(palette: string): [string, string, string] {
  const t =
    palette in presets
      ? presets[palette as keyof typeof presets].light
      : pairFromSeed(seedPresets[palette].seed, seedPresets[palette].variant).light
  return [t.primary, t.b2, t.b1]
}

export const handmadeIds = Object.keys(presets) as (keyof typeof presets)[]
