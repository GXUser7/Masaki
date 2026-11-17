import { useLayoutEffect, useMemo, useRef, useState } from 'react'

// Виртуализованная лента по дням для истории и загрузок: рендерит только группы и строки,
// попадающие в окно просмотра (+ запас сверху/снизу), а строки за краем экрана мягко
// появляются при прокрутке. Геометрия точно совпадает с .dlp-group / .dlp-day / .dlp-card / .dlp-row.

export interface FeedGroup<T> {
  key: string | number
  name: string
  meta: string
  items: T[]
}

export interface RowAnim {
  /** Классы состояния появления (dlp-off / dlp-enter-*). */
  cls: string
  /** Задержка каскада (мс) при быстром прыжке прокруткой. */
  delay: number
}

const GROUP_GAP = 22
const DAY_H = 20
const DAY_MB = 8
const DAY_BLOCK = DAY_H + DAY_MB
const CARD_PAD = 6
const ROW_H = 64
const ROW_GAP = 2
const ROW_STEP = ROW_H + ROW_GAP
const OVERSCAN = 360

interface LaidGroup<T> {
  group: FeedGroup<T>
  top: number
  bottom: number
  cardHeight: number
}

function findFirstGroup<T>(laid: LaidGroup<T>[], viewTop: number): number {
  let lo = 0
  let hi = laid.length - 1
  let ans = laid.length
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (laid[mid].bottom >= viewTop) {
      ans = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return ans
}

function offsetInside(el: HTMLElement, root: HTMLElement): number {
  let top = 0
  let cur: HTMLElement | null = el
  while (cur && cur !== root) {
    top += cur.offsetTop
    cur = cur.offsetParent as HTMLElement | null
  }
  if (cur === root) return top
  return el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
}

function sameGroupStructure<T>(a: FeedGroup<T>[], b: FeedGroup<T>[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].items.length !== b[i].items.length) return false
  }
  return true
}

export function VirtualDayFeed<T>({
  scrollRef,
  groups,
  itemKey,
  renderRow
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  groups: FeedGroup<T>[]
  itemKey: (item: T, index: number) => string | number
  renderRow: (item: T, index: number, anim: RowAnim) => React.ReactNode
}): React.JSX.Element | null {
  const feedRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ scrollTop: 0, vh: 0, feedTop: 0 })
  const viewRef = useRef(view)
  viewRef.current = view

  // Какие ключи уже были в видимой области (visTop..visBottom) в прошлом коммите и какие сейчас доигрывают входную анимацию.
  const visibleKeysRef = useRef<Set<string | number>>(new Set())
  const enteredAnimRef = useRef<Map<string | number, { dir: 'down' | 'up'; delay: number }>>(new Map())

  const prevGroupsRef = useRef(groups)
  const prevScrollTopRef = useRef(0)
  const scrollingRef = useRef<{ active: boolean; dir: 'down' | 'up' }>({ active: false, dir: 'down' })
  const measureRef = useRef<() => void>(() => {})
  const attachedScrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTick, setScrollTick] = useState(0)

  const layout = useMemo(() => {
    const laid: LaidGroup<T>[] = []
    let y = 0
    for (const group of groups) {
      const n = group.items.length
      if (!n) continue
      const cardHeight = 12 + n * ROW_H + (n - 1) * ROW_GAP
      const height = DAY_BLOCK + cardHeight
      laid.push({ group, top: y, bottom: y + height, cardHeight })
      y += height + GROUP_GAP
    }
    return { laid, totalHeight: Math.max(0, y - GROUP_GAP) }
  }, [groups])

  useLayoutEffect(() => {
    // На первом коммите child useLayoutEffect бежит раньше, чем родитель повесит ref={scrollRef},
    // поэтому при необходимости находим прокручиваемый контейнер через ближайший .dlp от feedRef.
    const scrollEl = scrollRef.current ?? (feedRef.current?.closest('.dlp') as HTMLDivElement | null)
    if (!scrollEl) return
    attachedScrollRef.current = scrollEl

    const measure = (): void => {
      const feedEl = feedRef.current
      if (!feedEl) return
      const nextTop = scrollEl.scrollTop
      const nextVh = scrollEl.clientHeight
      const nextFeedTop = offsetInside(feedEl, scrollEl)
      const prev = viewRef.current
      if (nextTop !== prev.scrollTop || nextVh !== prev.vh || nextFeedTop !== prev.feedTop) {
        setView({ scrollTop: nextTop, vh: nextVh, feedTop: nextFeedTop })
      }
    }
    measureRef.current = measure
    prevScrollTopRef.current = scrollEl.scrollTop
    measure()

    let raf = 0
    let idle = 0
    const onScroll = (): void => {
      const nowTop = scrollEl.scrollTop
      const delta = nowTop - prevScrollTopRef.current
      if (Math.abs(delta) >= 0.5) {
        scrollingRef.current = { active: true, dir: delta > 0 ? 'down' : 'up' }
        prevScrollTopRef.current = nowTop
        window.clearTimeout(idle)
        idle = window.setTimeout(() => {
          scrollingRef.current.active = false
        }, 160)
      }
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        measure()
      })
    }

    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(scrollEl)
    if (feedRef.current?.parentElement) ro.observe(feedRef.current.parentElement)

    return () => {
      attachedScrollRef.current = null
      scrollEl.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (raf) window.cancelAnimationFrame(raf)
      window.clearTimeout(idle)
    }
  }, [scrollRef, scrollTick])

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current
    if (scrollEl && attachedScrollRef.current !== scrollEl) {
      setScrollTick((n) => n + 1)
    }
    if (!sameGroupStructure(prevGroupsRef.current, groups)) {
      scrollingRef.current.active = false
      if (scrollEl) prevScrollTopRef.current = scrollEl.scrollTop
    }
    prevGroupsRef.current = groups
    measureRef.current()
  }, [scrollRef, groups])

  // Ограничиваем scrollTop снизу новой длиной списка, чтобы при фильтрации кадр не пустовал.
  const maxTop = view.vh > 0 ? Math.max(0, view.feedTop + layout.totalHeight - view.vh) : view.scrollTop
  const effScrollTop = Math.min(view.scrollTop, maxTop)
  const measured = view.vh > 0
  const visTop = effScrollTop - view.feedTop
  const visBottom = visTop + (measured ? view.vh : 900)
  const rangeTop = visTop - OVERSCAN
  const rangeBottom = visBottom + OVERSCAN

  const nextVisible = new Set<string | number>()
  const nextEntered = new Map<string | number, { dir: 'down' | 'up'; delay: number }>()
  const prevVisible = visibleKeysRef.current
  const prevEntered = enteredAnimRef.current
  const sameStructure = sameGroupStructure(prevGroupsRef.current, groups)
  const scrollActive = sameStructure && scrollingRef.current.active
  const scrollDir = scrollingRef.current.dir

  let enterBatch = 0
  const classify = (key: string | number, top: number, bottom: number, isRow: boolean): RowAnim => {
    const inView = !measured || (bottom > visTop && top < visBottom)
    if (!inView) {
      return { cls: bottom <= visTop ? 'dlp-off dlp-off-top' : 'dlp-off dlp-off-bot', delay: 0 }
    }
    nextVisible.add(key)
    if (prevVisible.has(key)) {
      const kept = prevEntered.get(key)
      if (kept) {
        nextEntered.set(key, kept)
        return { cls: kept.dir === 'down' ? 'dlp-enter-down' : 'dlp-enter-up', delay: kept.delay }
      }
      return { cls: '', delay: 0 }
    }
    if (scrollActive) {
      const delay = isRow ? Math.min(enterBatch++ * 14, 64) : 0
      nextEntered.set(key, { dir: scrollDir, delay })
      return { cls: scrollDir === 'down' ? 'dlp-enter-down' : 'dlp-enter-up', delay }
    }
    return { cls: '', delay: 0 }
  }

  const rendered: React.JSX.Element[] = []
  if (layout.laid.length > 0) {
    const startGroup = findFirstGroup(layout.laid, rangeTop)
    for (let gi = startGroup; gi < layout.laid.length; gi++) {
      const lg = layout.laid[gi]
      if (lg.top > rangeBottom) break
      const { group, top, cardHeight } = lg
      const cardRowsTop = top + DAY_BLOCK + CARD_PAD
      const startIdx = Math.max(0, Math.floor((rangeTop - cardRowsTop) / ROW_STEP))
      const endIdx = Math.min(group.items.length, Math.ceil((rangeBottom - cardRowsTop) / ROW_STEP))
      const dayAnim = classify(`day:${group.key}`, top, top + DAY_H, false)
      const hasRows = endIdx > startIdx
      const cardPadTop = CARD_PAD + (hasRows ? startIdx * ROW_STEP : 0)

      const rows: React.ReactNode[] = []
      for (let i = startIdx; i < endIdx; i++) {
        const item = group.items[i]
        const key = itemKey(item, i)
        const rTop = cardRowsTop + i * ROW_STEP
        rows.push(renderRow(item, i, classify(key, rTop, rTop + ROW_H, true)))
      }

      rendered.push(
        <div key={group.key} className="dlp-group" style={{ top }}>
          <div className={'dlp-day' + (dayAnim.cls ? ' ' + dayAnim.cls : '')}>
            <b>{group.name}</b>
            <span>{group.meta}</span>
          </div>
          <div className="dlp-card" style={{ height: cardHeight, paddingTop: cardPadTop }}>
            {rows}
          </div>
        </div>
      )
    }
  }

  useLayoutEffect(() => {
    visibleKeysRef.current = nextVisible
    enteredAnimRef.current = nextEntered
  })

  if (!layout.laid.length) return null
  return (
    <div ref={feedRef} className="dlp-feed" style={{ height: layout.totalHeight }}>
      {rendered}
    </div>
  )
}
