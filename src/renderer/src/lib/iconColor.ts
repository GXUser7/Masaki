import { argbFromRgb, Hct, hexFromArgb, QuantizerCelebi, Score, TonalPalette } from '@material/material-color-utilities'
import { useEffect, useState } from 'react'

/** Цвета плитки, взятые из значка сайта: заливка фигуры и цвет буквы, если значка нет. */
export interface TileColors {
  light: { fill: string; ink: string }
  dark: { fill: string; ink: string }
}

const NONE = 0x00000000
const colorCache = new Map<string, TileColors | null>()
const iconCache = new Map<string, string | null>()
const listeners = new Set<() => void>()

/** Главный цвет значка → тональная палитра M3, как тематические иконки на Pixel. */
async function colorsFromIcon(src: string): Promise<TileColors | null> {
  const img = new Image()
  img.src = src
  try {
    await img.decode()
  } catch {
    return null
  }
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, size, size)
  const data = ctx.getImageData(0, 0, size, size).data
  const pixels: number[] = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue
    pixels.push(argbFromRgb(data[i], data[i + 1], data[i + 2]))
  }
  if (!pixels.length) return null
  const best = Score.score(QuantizerCelebi.quantize(pixels, 32), { desired: 1, fallbackColorARGB: NONE, filter: true })[0]
  // Чёрно-белые значки (GitHub, Википедия) дают нейтральную палитру, а не случайный синий.
  const palette =
    best === NONE || Hct.fromInt(best).chroma < 10
      ? TonalPalette.fromHueAndChroma(best === NONE ? 260 : Hct.fromInt(best).hue, 6)
      : TonalPalette.fromInt(best)
  return {
    light: { fill: hexFromArgb(palette.tone(85)), ink: hexFromArgb(palette.tone(25)) },
    dark: { fill: hexFromArgb(palette.tone(35)), ink: hexFromArgb(palette.tone(90)) }
  }
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
  iconCache.set(key, src)
  colorCache.set(key, src ? await colorsFromIcon(src) : null)
  listeners.forEach((fn) => fn())
}

// Сайт показал во вкладке свой значок — обновляем плитки этого сайта.
window.masaki.onFaviconUpdated((host) => {
  iconCache.delete(host)
  colorCache.delete(host)
  listeners.forEach((fn) => fn())
})

/** Значок сайта и цвета плитки. Пока грузится — null, плитка рисуется тоном палитры. */
export function useSiteIcon(url: string): { src: string | null; colors: TileColors | null } {
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
    if (!iconCache.has(key)) {
      iconCache.set(key, null)
      void load(url, key)
    }
  })
  return { src: iconCache.get(key) ?? null, colors: colorCache.get(key) ?? null }
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
