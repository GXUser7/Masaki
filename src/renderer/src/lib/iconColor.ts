import { argbFromHex, argbFromRgb, Hct, hexFromArgb, QuantizerCelebi, Score, TonalPalette } from '@material/material-color-utilities'
import { useEffect, useState } from 'react'

/** Цвета плитки, взятые из значка сайта (или из выбранного пользователем цвета): заливка фигуры и цвет буквы. */
export interface TileColors {
  light: { fill: string; ink: string }
  dark: { fill: string; ink: string }
  /** Тёмная подложка значка, если значок светлый на прозрачном (иначе белое на белом). Нет поля — подложка белая. */
  plate?: string
}

const NONE = 0x00000000

/** Цвет плитки, который хранится в Shortcut.color. */
const HEX = /^#[0-9a-f]{6}$/i
export const isTileColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** Что узнали о картинке значка. */
interface IconScan {
  /** Картинка не загрузилась — вместо неё нужна буква, а не пустой кружок. */
  broken: boolean
  /** Палитра главного цвета; null — цвет определить не из чего (картинка пустая). */
  palette: TonalPalette | null
  /** Светлый значок на прозрачном фоне: на белой подложке он пропадёт, подложку нужно затемнить. */
  lightGlyph: boolean
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** Главный цвет → тональная палитра M3, как тематические иконки на Pixel. */
function paletteOf(argb: number): TonalPalette {
  // Чёрно-белые значки (GitHub, Википедия) дают нейтральную палитру, а не случайный синий.
  if (argb === NONE) return TonalPalette.fromHueAndChroma(260, 6)
  const hct = Hct.fromInt(argb)
  return hct.chroma < 10 ? TonalPalette.fromHueAndChroma(hct.hue, 6) : TonalPalette.fromInt(argb)
}

/** Одни и те же тона для значка и для выбранного цвета; подложка — тот же оттенок, но тёмный тон, как у Pixel. */
function colorsOf(palette: TonalPalette, darkPlate: boolean): TileColors {
  return {
    light: { fill: hexFromArgb(palette.tone(85)), ink: hexFromArgb(palette.tone(25)) },
    dark: { fill: hexFromArgb(palette.tone(35)), ink: hexFromArgb(palette.tone(90)) },
    ...(darkPlate ? { plate: hexFromArgb(palette.tone(18)) } : {})
  }
}

/**
 * Разбор значка: главный цвет и «пропадёт ли он на белом».
 * Рисуем его на canvas в том же окне, что покажет <img>, поэтому SVG с prefers-color-scheme
 * видится здесь так же, как на плитке.
 */
async function scanIcon(src: string): Promise<IconScan> {
  const img = await loadImage(src)
  if (!img) return { broken: true, palette: null, lightGlyph: false }
  const size = 32
  let data: Uint8ClampedArray
  try {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return { broken: false, palette: null, lightGlyph: false }
    ctx.drawImage(img, 0, 0, size, size)
    data = ctx.getImageData(0, 0, size, size).data
  } catch {
    // SVG без размеров и т. п.: картинка показывается, но разобрать её нельзя
    return { broken: false, palette: null, lightGlyph: false }
  }
  const pixels: number[] = []
  // Доли видимого: всё, что заметно глазу (с весом по непрозрачности), и из него светлое / тёмное.
  let seen = 0
  let light = 0
  let dark = 0
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a >= 32) {
      const w = a / 255
      const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
      seen += w
      if (lum > 0.8) light += w
      else if (lum < 0.35) dark += w
    }
    if (a < 200) continue
    pixels.push(argbFromRgb(data[i], data[i + 1], data[i + 2]))
  }
  // Светлый глиф на прозрачном: в кадре есть пустота, а то, что нарисовано, почти всё светлое и без тёмного знака.
  // Цветные и тёмные значки, а также белые с заметным тёмным знаком (его видно и на белом) сюда не попадают —
  // им белая подложка не мешает. Белый квадрат с прозрачным знаком внутри, наоборот, на белом пропал бы целиком.
  const coverage = seen / (size * size)
  const lightGlyph = seen > 0 && coverage < 0.92 && light / seen > 0.6 && dark / seen < 0.1
  if (!pixels.length) return { broken: false, palette: null, lightGlyph }
  const best = Score.score(QuantizerCelebi.quantize(pixels, 32), { desired: 1, fallbackColorARGB: NONE, filter: true })[0]
  return { broken: false, palette: paletteOf(best), lightGlyph }
}

/** Цвета из картинки (обложка мини-плеера); подложка тут ни к чему. */
async function colorsFromIcon(src: string): Promise<TileColors | null> {
  const scan = await scanIcon(src)
  return scan.palette ? colorsOf(scan.palette, false) : null
}

// ---------- Свой цвет плитки ----------

const colorCache = new Map<string, TileColors>()

/** Цвета плитки из выбранного цвета — теми же тонами, что из значка. */
export function tileColorsFor(hex: string, darkPlate = false): TileColors {
  const key = hex.toLowerCase() + (darkPlate ? '|p' : '')
  let colors = colorCache.get(key)
  if (!colors) {
    // Ползунок «Свой…» выдаёт сотни оттенков подряд — кэш не должен расти без конца.
    if (colorCache.size > 200) colorCache.clear()
    colors = colorsOf(paletteOf(argbFromHex(hex)), darkPlate)
    colorCache.set(key, colors)
  }
  return colors
}

/**
 * Оттенки для выбора цвета плитки: по кругу тона HCT плюс серый. Здесь хранится цвет-основа;
 * какая заливка получится в светлой и тёмной теме, считает tileColorsFor.
 */
export const tileSwatches: { name: string; hex: string }[] = [
  { name: 'Красный', hue: 25, chroma: 48 },
  { name: 'Оранжевый', hue: 55, chroma: 48 },
  { name: 'Жёлтый', hue: 100, chroma: 48 },
  { name: 'Зелёный', hue: 145, chroma: 48 },
  { name: 'Бирюзовый', hue: 190, chroma: 48 },
  { name: 'Голубой', hue: 230, chroma: 48 },
  { name: 'Синий', hue: 265, chroma: 48 },
  { name: 'Фиолетовый', hue: 305, chroma: 48 },
  { name: 'Розовый', hue: 345, chroma: 48 },
  { name: 'Серый', hue: 260, chroma: 5 }
].map(({ name, hue, chroma }) => ({ name, hex: hexFromArgb(Hct.from(hue, chroma, 50).toInt()).toLowerCase() }))

// ---------- Значки сайтов ----------

interface SiteEntry {
  src: string | null
  scan: IconScan | null
  /** Цвета из самого значка («Авто»). */
  colors: TileColors | null
}

/** Ключ — сайт; null — значок ещё грузится. */
const sites = new Map<string, SiteEntry | null>()
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((fn) => fn())

function entryOf(src: string | null, scan: IconScan | null): SiteEntry {
  return { src, scan, colors: scan?.palette ? colorsOf(scan.palette, scan.lightGlyph) : null }
}

function hostKey(url: string): string {
  try {
    const u = new URL(url)
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname.startsWith('/maps')) return 'maps.google.com'
    return u.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

async function load(url: string, key: string): Promise<void> {
  const src = await window.masaki.favicon(url)
  // Значок и его цвета показываем вместе: иначе светлый значок мигнёт белым на белом.
  sites.set(key, entryOf(src, src ? await scanIcon(src) : null))
  notify()
}

// Сайт показал во вкладке свой значок — обновляем плитки этого сайта.
window.masaki.onFaviconUpdated((host) => {
  sites.delete(host)
  notify()
})

// Тема Masaki переключается на лету, а SVG-значки умеют выглядеть по-разному (prefers-color-scheme):
// белый глиф только в тёмной теме. Поэтому при смене схемы разбираем значки заново.
async function rescanAll(): Promise<void> {
  await Promise.all(
    [...sites.entries()].map(async ([key, entry]) => {
      if (!entry?.src) return
      const scan = await scanIcon(entry.src)
      if (sites.get(key) === entry) sites.set(key, entryOf(entry.src, scan))
    })
  )
  notify()
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => void rescanAll())

/** Цвета самого значка (без выбранного цвета): для кружка «Авто» в меню плитки. */
export function siteIconColors(url: string): TileColors | null {
  return sites.get(hostKey(url))?.colors ?? null
}

/**
 * Значок сайта и цвета плитки. Пока грузится — null, плитка рисуется тоном палитры.
 * Если задан свой цвет — цвета считаются из него, а подложку значка по-прежнему решает сам значок.
 */
export function useSiteIcon(url: string, color?: string): { src: string | null; colors: TileColors | null } {
  const key = hostKey(url)
  const [, force] = useState(0)
  useEffect(() => {
    const fn = (): void => force((n) => n + 1)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])
  useEffect(() => {
    if (!sites.has(key)) {
      sites.set(key, null)
      void load(url, key)
    }
  })
  const entry = sites.get(key) ?? null
  const src = entry && !entry.scan?.broken ? entry.src : null
  const colors = isTileColor(color) ? tileColorsFor(color, !!entry?.scan?.lightGlyph) : (entry?.colors ?? null)
  return { src, colors }
}

// ---------- Цвет обложки ----------
// Мини-плеер окрашивается в цвет обложки того, что играет, — как плеер YouCloud и Android.

const artCache = new Map<string, { src: string | null; colors: TileColors | null } | null>()
const artListeners = new Set<() => void>()

async function loadArt(url: string): Promise<void> {
  const src = await window.masaki.mediaArt(url).catch(() => null)
  artCache.set(url, { src, colors: src ? await colorsFromIcon(src) : null })
  artListeners.forEach((fn) => fn())
}

/** Обложка картинкой data: и цвета из неё; пока грузится — null. */
export function useArtColors(url: string | undefined): { src: string | null; colors: TileColors | null } | null {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = (): void => force((n) => n + 1)
    artListeners.add(fn)
    return () => {
      artListeners.delete(fn)
    }
  }, [])
  useEffect(() => {
    if (!url || artCache.has(url)) return
    // Кэш не растёт без конца: обложек за вечер набирается много.
    if (artCache.size > 60) artCache.delete(artCache.keys().next().value!)
    artCache.set(url, null)
    void loadArt(url)
  }, [url])
  return url ? (artCache.get(url) ?? null) : null
}
