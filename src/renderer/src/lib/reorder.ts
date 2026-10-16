import { useLayoutEffect, useRef, useState } from 'react'
import type { Shortcut } from '../../../shared/types'
import { isShape, shapeCycle } from './shapes'

/** Ключи плиток: по адресу, а повтор одного адреса — с номером. Не по месту в списке: после
 *  перестановки ключ остаётся за плиткой, и React переносит её, а не создаёт заново (значок не мигает). */
export function tileKeys(items: { url: string }[]): string[] {
  const seen = new Map<string, number>()
  return items.map((it) => {
    const n = seen.get(it.url) ?? 0
    seen.set(it.url, n + 1)
    return n ? `${it.url}#${n}` : it.url
  })
}

type Drag = { from: number; to: number }

export interface Reorder {
  box: React.RefObject<HTMLDivElement | null>
  /** Номер плитки, которую тянут. */
  dragging: number | null
  item: (i: number, url: string) => React.HTMLAttributes<HTMLElement> & { draggable: boolean; 'data-rk': string }
  boxProps: Pick<React.HTMLAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDrop'>
}

const MOVE = 'transform 0.45s var(--spring)'

/** Куда встаёт плитка i, если плитку from перенесли на место to. */
function slotOf(i: number, { from, to }: Drag): number {
  if (i === from) return to
  const j = i - (i > from ? 1 : 0)
  return j + (j >= to ? 1 : 0)
}

/**
 * Перестановка плиток перетаскиванием. Пока тянут, узлы DOM стоят на месте — плитки только едут
 * transform'ом в ячейки нового порядка (вёрстка не пересчитывается, а перетаскиваемый узел не уходит из-под
 * жеста Chromium). Порядок меняется один раз — при отпускании.
 * Ячейка выбирается по ближайшему центру в вёрстке (offset* не зависят от transform), а не по элементу под
 * курсором: плитка, которая ещё едет, иначе перехватила бы курсор, и порядок качался бы туда-сюда.
 * Ячейки — дети `box` с `data-rk` в порядке списка; `box` должен быть `position: relative`.
 */
export function useReorder(keys: string[], onMove: (from: number, to: number) => void): Reorder {
  const box = useRef<HTMLDivElement>(null)
  const [drag, setDragState] = useState<Drag | null>(null)
  // То же, что drag, но без ожидания отрисовки: dragend приходит сразу за drop.
  const live = useRef<Drag | null>(null)
  // Отпустили в списке: новый порядок уже на экране, сдвиги снимаются без анимации.
  const dropped = useRef(false)
  const setDrag = (d: Drag | null): void => {
    live.current = d
    setDragState(d)
  }

  const cells = (): HTMLElement[] => (box.current ? Array.from(box.current.querySelectorAll<HTMLElement>(':scope > [data-rk]')) : [])

  useLayoutEffect(() => {
    const els = cells()
    if (drag) {
      const at = (p: number): HTMLElement => els[Math.min(p, els.length - 1)]
      for (const [i, el] of els.entries()) {
        const dx = at(slotOf(i, drag)).offsetLeft - el.offsetLeft
        const dy = at(slotOf(i, drag)).offsetTop - el.offsetTop
        el.style.transition = MOVE
        el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : ''
      }
      return
    }
    const instant = dropped.current
    dropped.current = false
    for (const el of els) {
      if (!el.style.transform) continue
      if (instant) {
        // Узлы уже переставлены в новый порядок — плитка стоит там же, где её показывал сдвиг.
        el.style.transition = 'none'
        el.style.transform = ''
        void el.offsetWidth
        el.style.transition = ''
        continue
      }
      // Отпустили мимо или Esc — плитки пружиной возвращаются на свои места.
      el.style.transition = MOVE
      el.style.transform = ''
      const done = (e: TransitionEvent): void => {
        if (e.target !== el) return
        el.style.transition = ''
        el.removeEventListener('transitionend', done)
      }
      el.addEventListener('transitionend', done)
    }
  }, [drag, keys.join('\n')])

  const target = (x: number, y: number): number | null => {
    const el = box.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const px = x - r.left - el.clientLeft + el.scrollLeft
    const py = y - r.top - el.clientTop + el.scrollTop
    let best = -1
    let dist = Infinity
    for (const [p, c] of cells().entries()) {
      const d = Math.hypot(c.offsetLeft + c.offsetWidth / 2 - px, c.offsetTop + c.offsetHeight / 2 - py)
      if (d < dist) {
        dist = d
        best = p
      }
    }
    return best < 0 ? null : best
  }

  return {
    box,
    dragging: drag?.from ?? null,
    item: (i, url) => ({
      draggable: true,
      'data-rk': keys[i],
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = 'copyMove'
        // Плитку можно бросить и на страницу или в другую программу — это ссылка.
        e.dataTransfer.setData('text/uri-list', url)
        e.dataTransfer.setData('text/plain', url)
        const tile = e.currentTarget.querySelector<HTMLElement>('.tile')
        if (tile) e.dataTransfer.setDragImage(tile, tile.offsetWidth / 2, tile.offsetHeight / 2)
        dropped.current = false
        setDrag({ from: i, to: i })

      },
      onDragEnd: () => {
        if (live.current) setDrag(null)
      }
    }),
    boxProps: {
      // Без отмены dragenter Chromium (по спецификации) не считает плитку целью и перестаёт слать ей dragover.
      onDragEnter: (e) => {
        if (live.current) e.preventDefault()
      },
      onDragOver: (e) => {
        const d = live.current
        if (!d) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const to = target(e.clientX, e.clientY)
        if (to !== null && to !== d.to) setDrag({ ...d, to })
      },
      onDrop: (e) => {
        const d = live.current
        if (!d) return
        e.preventDefault()
        dropped.current = d.from !== d.to
        setDrag(null)
        if (d.from !== d.to) onMove(d.from, d.to)
      }
    }
  }
}

/** Новый список: элемент `from` переехал на место `to`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice()
  const [it] = next.splice(from, 1)
  next.splice(to, 0, it)
  return next
}

/** Перестановка плиток: форма по умолчанию зависит от места, поэтому сдвинутые плитки забирают свою
 *  форму с собой — что тянули, то и приехало, а не перетекло в форму чужой ячейки. */
export function moveTiles(list: Shortcut[], from: number, to: number): Shortcut[] {
  const fixed = list.map((it, i) =>
    isShape(it.shape) || i < Math.min(from, to) || i > Math.max(from, to) ? it : { ...it, shape: shapeCycle[i % shapeCycle.length] }
  )
  return moveItem(fixed, from, to)
}
