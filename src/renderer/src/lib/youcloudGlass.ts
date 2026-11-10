interface GlassPanel {
  x: number; y: number; w: number; h: number
  radii: number[]
  clip: number[]
  fade?: number[]
  blur: number
  saturation: number
  opacity: number
}
export interface HostGlass {
  width: number
  height: number
  panels: GlassPanel[]
}

const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const vector = (value: unknown, length: number, min: number, max: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every((v) => number(v, min, max))

/** Страница задаёт только ограниченную числовую геометрию, а не CSS или разметку интерфейса. */
export function parseHostGlass(value: unknown): HostGlass | null {
  const data = value as HostGlass | null
  if (!data || !number(data.width, 1, 20_000) || !number(data.height, 1, 20_000) ||
      !Array.isArray(data.panels) || data.panels.length > 64) return null
  if (!data.panels.every((p) => p && number(p.x, -50_000, 50_000) && number(p.y, -50_000, 50_000) &&
      number(p.w, 0, 50_000) && number(p.h, 0, 50_000) && vector(p.radii, 8, 0, 50_000) &&
      vector(p.clip, 4, -50_000, 50_000) && (p.fade === undefined || vector(p.fade, 3, -50_000, 50_000)) &&
      number(p.blur, 0, 160) && number(p.saturation, 0, 5) && number(p.opacity, 0, 1))) return null
  return data
}

/** Настоящее размытие обоев выполняется в Masaki, под прозрачным webview и только под стеклом сайта. */
export function paintHostGlass(layer: HTMLDivElement | null, data: HostGlass | null): void {
  if (!layer) return
  if (!data) { layer.replaceChildren(); return }
  const sx = layer.clientWidth / data.width, sy = layer.clientHeight / data.height
  while (layer.children.length > data.panels.length) layer.lastElementChild?.remove()
  for (let i = 0; i < data.panels.length; i++) {
    const panel = data.panels[i]
    let child = layer.children[i] as HTMLDivElement | undefined
    if (!child) { child = document.createElement('div'); layer.appendChild(child) }
    const p = panel, r = p.radii
    const style = child.style
    style.left = `${p.x * sx}px`; style.top = `${p.y * sy}px`
    style.width = `${p.w * sx}px`; style.height = `${p.h * sy}px`
    style.borderRadius = `${r[0] * sx}px ${r[2] * sx}px ${r[4] * sx}px ${r[6] * sx}px / ${r[1] * sy}px ${r[3] * sy}px ${r[5] * sy}px ${r[7] * sy}px`
    style.backdropFilter = `blur(${p.blur * (sx + sy) / 2}px) saturate(${p.saturation})`
    style.opacity = String(p.opacity)
    style.clipPath = `inset(${Math.max(0, p.clip[1] - p.y) * sy}px ${Math.max(0, p.x + p.w - p.clip[2]) * sx}px ${Math.max(0, p.y + p.h - p.clip[3]) * sy}px ${Math.max(0, p.clip[0] - p.x) * sx}px)`
    if (p.fade) {
      const [top, bottom, size] = p.fade
      const stops = [[top, 0], [top + size * .2, 1 / 15], [top + size * .5, 8 / 15],
        [top + size * .8, 14 / 15], [top + size, 1], [bottom - size, 1],
        [bottom - size * .8, 14 / 15], [bottom - size * .5, 8 / 15], [bottom - size * .2, 1 / 15], [bottom, 0]]
      style.maskImage = `linear-gradient(to bottom, ${stops.map(([y, alpha]) => `rgba(0,0,0,${alpha}) ${(y - p.y) * sy}px`).join(',')})`
    } else style.maskImage = ''
  }
}
