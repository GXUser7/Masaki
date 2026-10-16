// «Магнит» (эффект наведения, выбран пользователем 2026-10-16): кнопки окна и капсулы дока чуть тянутся
// за курсором — до MAX px — и пружиной возвращаются. Двигаем свойство translate, а не transform: transform
// у кнопок занят их собственными пружинами (наведение, нажатие).

const SEL = '.ib.wb, .capsule > .ib, .dk-add, .lbl-add'
const PULL = 0.3
const MAX = 6

interface Spring {
  x: number
  y: number
  tx: number
  ty: number
}

export function startMagnet(): () => void {
  const springs = new Map<HTMLElement, Spring>()
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  let hot: HTMLElement | null = null
  let hotRect: DOMRect | null = null
  let raf = 0
  let poll: number | undefined

  const loop = (): void => {
    raf = 0
    for (const [node, s] of springs) {
      s.x += (s.tx - s.x) * 0.2
      s.y += (s.ty - s.y) * 0.2
      if (node !== hot && Math.abs(s.x) < 0.05 && Math.abs(s.y) < 0.05) {
        node.style.translate = ''
        springs.delete(node)
        continue
      }
      node.style.translate = `${s.x.toFixed(2)}px ${s.y.toFixed(2)}px`
    }
    if (springs.size) raf = requestAnimationFrame(loop)
  }
  const kick = (): void => {
    if (!raf) raf = requestAnimationFrame(loop)
  }
  const release = (): void => {
    window.clearInterval(poll)
    poll = undefined
    if (!hot) return
    const s = springs.get(hot)
    if (s) {
      s.tx = 0
      s.ty = 0
    }
    hot = null
    hotRect = null
    kick()
  }
  const clamp = (v: number): number => Math.max(-MAX, Math.min(MAX, v * PULL))

  const onMove = (e: PointerEvent): void => {
    if (reduce.matches) return
    const node = e.target instanceof Element ? e.target.closest<HTMLElement>(SEL) : null
    if (node !== hot) {
      release()
      if (!node || (node instanceof HTMLButtonElement && node.disabled)) return
      hot = node
      const s = springs.get(node) ?? { x: 0, y: 0, tx: 0, ty: 0 }
      springs.set(node, s)
      // Центр — без текущего сдвига, иначе кнопка «убегала» бы от курсора.
      const r = node.getBoundingClientRect()
      hotRect = new DOMRect(r.x - s.x, r.y - s.y, r.width, r.height)
      // Курсор может уйти с кнопки прямо на страницу во вкладке — окно этого не заметит: сверяемся
      // с настоящим курсором, как useHoverOverPage.
      poll = window.setInterval(async () => {
        const rect = hotRect
        if (!rect) return
        const { x, y } = await window.masaki.cursor()
        if (x < rect.left - 8 || x > rect.right + 8 || y < rect.top - 8 || y > rect.bottom + 8) release()
      }, 120)
    }
    if (!hot || !hotRect) return
    const s = springs.get(hot)
    if (!s) return
    s.tx = clamp(e.clientX - (hotRect.left + hotRect.width / 2))
    s.ty = clamp(e.clientY - (hotRect.top + hotRect.height / 2))
    kick()
  }

  document.addEventListener('pointermove', onMove, { passive: true })
  document.documentElement.addEventListener('mouseleave', release)
  window.addEventListener('blur', release)
  return () => {
    release()
    document.removeEventListener('pointermove', onMove)
    document.documentElement.removeEventListener('mouseleave', release)
    window.removeEventListener('blur', release)
    cancelAnimationFrame(raf)
    for (const node of springs.keys()) node.style.translate = ''
    springs.clear()
  }
}
