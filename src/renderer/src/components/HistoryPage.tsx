import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryEntry } from '../../../shared/types'
import { dayLabel, PERIODS, periodRange, startOfDay, timeOf, type Period } from '../lib/feed'
import { shapes } from '../lib/shapes'
import { hostOf, letterOf } from '../lib/url'
import { useStore } from '../store'
import { VirtualDayFeed, type FeedGroup } from './FeedList'
import { Icon } from './Icon'
import type { MenuEntry } from './Menu'

// Страница истории (masaki://history): виртуализованная лента по дням, поиск, период,
// удаление записи крестиком. Класс dlp общий со страницей загрузок.

interface IndexedHistory {
  host: string
  day: number
  search: string
}

interface HistoryRowItem {
  key: number
  entry: HistoryEntry
  info: IndexedHistory
}

const historyIndex = new WeakMap<HistoryEntry, IndexedHistory>()
const historyIds = new WeakMap<HistoryEntry, number>()
let nextHistoryId = 1

function idOfHistory(h: HistoryEntry): number {
  let id = historyIds.get(h)
  if (!id) {
    id = nextHistoryId++
    historyIds.set(h, id)
  }
  return id
}

function indexHistory(h: HistoryEntry): IndexedHistory {
  let info = historyIndex.get(h)
  if (!info) {
    const host = hostOf(h.url)
    info = {
      host,
      day: startOfDay(h.time),
      search: `${h.title}\0${h.url}\0${host}`.toLowerCase()
    }
    historyIndex.set(h, info)
  }
  return info
}

// Значки сайтов: кэш по хосту (ограниченный) + подписка строго на свой хост + LIFO-очередь
// с ограничением параллельных IPC, чтобы быстрая прокрутка не спамила главный процесс и сеть.
const MAX_FAVICONS = 2000
const MAX_FAVICON_JOBS = 6
const favicons = new Map<string, string | null>()
const hostListeners = new Map<string, Set<() => void>>()
const faviconQueue: { host: string; url: string }[] = []
const queuedHosts = new Set<string>()
let activeFaviconJobs = 0

function rememberFavicon(host: string, src: string | null): void {
  if (favicons.has(host)) favicons.delete(host)
  else if (favicons.size >= MAX_FAVICONS) favicons.delete(favicons.keys().next().value!)
  favicons.set(host, src)
}

function notifyHost(host: string): void {
  hostListeners.get(host)?.forEach((fn) => fn())
}

// Если открытая вкладка узнала свежий значок сайта — сбрасываем кэш и обновляем только видимые строки этого хоста.
let subscribedUpdate = false
function ensureFaviconListener(): void {
  if (subscribedUpdate) return
  subscribedUpdate = true
  window.masaki.onFaviconUpdated((host) => {
    if (!favicons.has(host) && !hostListeners.has(host)) return
    favicons.delete(host)
    notifyHost(host)
  })
}

function pumpFavicons(): void {
  while (activeFaviconJobs < MAX_FAVICON_JOBS && faviconQueue.length > 0) {
    const task = faviconQueue.pop()!
    queuedHosts.delete(task.host)
    if (favicons.has(task.host) || !hostListeners.get(task.host)?.size) continue
    activeFaviconJobs++
    void window.masaki
      .favicon(task.url)
      .then((src) => {
        rememberFavicon(task.host, src)
        notifyHost(task.host)
      })
      .catch(() => {
        rememberFavicon(task.host, null)
      })
      .finally(() => {
        activeFaviconJobs--
        pumpFavicons()
      })
  }
}

function requestFavicon(host: string, url: string): void {
  ensureFaviconListener()
  if (!host || favicons.has(host) || queuedHosts.has(host)) return
  queuedHosts.add(host)
  faviconQueue.push({ host, url })
  pumpFavicons()
}

const SiteBadge = memo(function SiteBadge({ url, title, host }: { url: string; title: string; host: string }): React.JSX.Element {
  const [, force] = useState(0)
  const cached = favicons.get(host)

  useEffect(() => {
    let set = hostListeners.get(host)
    if (!set) {
      set = new Set()
      hostListeners.set(host, set)
    }
    const fn = (): void => force((n) => n + 1)
    set.add(fn)
    if (!favicons.has(host)) requestFavicon(host, url)
    return () => {
      set!.delete(fn)
      if (set!.size === 0) hostListeners.delete(host)
    }
  }, [host, url])

  // Если onFaviconUpdated очистил запись у видимой строки — перезапрашиваем значок.
  useEffect(() => {
    if (cached === undefined && !favicons.has(host)) requestFavicon(host, url)
  }, [cached, host, url])

  if (cached) {
    return (
      <span className="fav fv1 hp-fav">
        <img src={cached} alt="" draggable={false} />
      </span>
    )
  }
  return (
    <span className="fav fv1 hp-fav">
      <b>{letterOf(title, url)}</b>
    </span>
  )
})

const openEntry = (url: string): void => {
  useStore.getState().navigate(url, { raw: true, target: 'new' })
}

const removeEntry = (h: HistoryEntry): void => {
  window.masaki.history.remove(h)
  useStore.setState((st) => ({ history: st.history.filter((x) => !(x.url === h.url && x.time === h.time)) }))
}

const Row = memo(function Row({
  item,
  animCls,
  animDelay
}: {
  item: HistoryRowItem
  animCls: string
  animDelay: number
}): React.JSX.Element {
  const { entry: h, info } = item
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(0)

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const copy = (): void => {
    void navigator.clipboard.writeText(h.url).then(() => {
      useStore.getState().showCopied({ title: 'Ссылка скопирована', text: h.url })
      setCopied(true)
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1400)
    })
  }

  return (
    <div
      className={'dlp-row lift' + (animCls ? ' ' + animCls : '')}
      style={animDelay ? { animationDelay: `${animDelay}ms` } : undefined}
    >
      <button className="dlp-main" title={h.url} onClick={() => openEntry(h.url)}>
        <SiteBadge url={h.url} title={h.title} host={info.host} />
        <span className="dlp-text">
          <b className="dlp-name">{h.title || info.host}</b>
          <span className="dlp-meta">
            {info.host} · {timeOf(h.time)}
          </span>
        </span>
      </button>
      <span className="dlp-acts">
        <button className="ib" aria-label="Копировать ссылку" title={copied ? 'Ссылка скопирована' : 'Копировать ссылку'} onClick={copy}>
          <Icon name={copied ? 'check' : 'link'} />
        </button>
        <button className="ib" aria-label="Убрать из истории" title="Убрать из истории" onClick={() => removeEntry(h)}>
          <Icon name="close" />
        </button>
      </span>
    </div>
  )
})

const itemKey = (item: HistoryRowItem): number => item.key

export function HistoryPage(): React.JSX.Element {
  const history = useStore((s) => s.history)
  const [q, setQ] = useState('')
  const deferredQ = useDeferredValue(q)
  const [period, setPeriod] = useState<Period>('all')
  const scrollRef = useRef<HTMLDivElement>(null)
  const s = useStore.getState

  // Разворачиваем и индексируем записи один раз при изменении history.
  const indexed = useMemo(() => {
    const out: HistoryRowItem[] = new Array(history.length)
    let k = 0
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      out[k++] = { key: idOfHistory(entry), entry, info: indexHistory(entry) }
    }
    return out
  }, [history])

  const needle = deferredQ.trim().toLowerCase()
  const groups = useMemo<FeedGroup<HistoryRowItem>[]>(() => {
    const now = Date.now()
    const [from, to] = periodRange(period, now)
    const today = startOfDay(now)
    const currentYear = new Date(today).getFullYear()
    const byDay = new Map<number, HistoryRowItem[]>()

    for (let i = 0; i < indexed.length; i++) {
      const item = indexed[i]
      const t = item.entry.time
      if (t < from || t >= to) continue
      if (needle && !item.info.search.includes(needle)) continue
      let list = byDay.get(item.info.day)
      if (!list) {
        list = []
        byDay.set(item.info.day, list)
      }
      list.push(item)
    }

    return [...byDay.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([day, items]) => {
        const [name, date] = dayLabel(day, today, currentYear)
        return { key: day, name, meta: `${date} · ${items.length}`, items }
      })
  }, [indexed, period, needle])

  const renderRow = useCallback(
    (item: HistoryRowItem, _i: number, anim: { cls: string; delay: number }) => (
      <Row key={item.key} item={item} animCls={anim.cls} animDelay={anim.delay} />
    ),
    []
  )

  const pickPeriod = (e: React.MouseEvent): void => {
    const r = e.currentTarget.getBoundingClientRect()
    s().openMenu(
      r.left,
      r.bottom + 6,
      PERIODS.map((p) => ({ kind: 'item', label: p.label, icon: p.id === period ? 'check' : 'calendar', run: () => setPeriod(p.id) }))
    )
  }
  const more = (e: React.MouseEvent): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const entries: MenuEntry[] = [
      {
        kind: 'item',
        label: 'Очистить историю',
        icon: 'delete',
        danger: true,
        disabled: !history.length,
        run: () => {
          window.masaki.history.clear()
          useStore.setState({ history: [] })
        }
      }
    ]
    s().openMenu(r.right - 240, r.bottom + 6, entries)
  }

  const filtered = needle || period !== 'all'
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? ''
  return (
    <div className="settings dlp" ref={scrollRef}>
      <div className="set-inner">
        <div className="dlp-head">
          <div className="dlp-title">
            <h1>История</h1>
            <span className="hint">{history.length ? `Записей: ${history.length}` : 'Где вы бывали в интернете'}</span>
          </div>
          <button className="ib dlp-more" aria-label="Ещё" title="Ещё" onClick={more}>
            <Icon name="more" />
          </button>
        </div>

        <label className="dlp-search">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название или адрес страницы" aria-label="Найти в истории" spellCheck={false} />
          {q && (
            <button className="ib" aria-label="Очистить поиск" onClick={() => setQ('')}>
              <Icon name="close" />
            </button>
          )}
          <button className={'dlp-date' + (period !== 'all' ? ' on' : '')} aria-label={'Период: ' + periodLabel} onClick={pickPeriod}>
            <Icon name="calendar" />
            {periodLabel}
            <Icon name="down" />
          </button>
        </label>

        <VirtualDayFeed scrollRef={scrollRef} groups={groups} itemKey={itemKey} renderRow={renderRow} />

        {groups.length === 0 && (
          <div className="dlp-empty">
            <span className="dlp-empty-art">
              <svg viewBox="0 0 200 200" aria-hidden="true">
                <path d={shapes.clover4} />
              </svg>
              <Icon name={filtered ? 'search' : 'history'} />
            </span>
            <b>{filtered ? 'Ничего не нашлось' : 'История пуста'}</b>
            <span>{filtered ? 'Попробуйте другой запрос или период' : 'Здесь появится всё, что вы откроете'}</span>
          </div>
        )}
      </div>
    </div>
  )
}
