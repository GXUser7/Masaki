import { useEffect, useMemo, useState } from 'react'
import type { HistoryEntry } from '../../../shared/types'
import { shapes } from '../lib/shapes'
import { useStore } from '../store'
import type { MenuEntry } from './Menu'
import { Icon } from './Icon'
import { hostOf } from '../lib/url'

// Страница истории (masaki://history): лента по дням, поиск, период, удаление записи крестиком.
// Как страница загрузок — та же «лента» (классы dlp), чтобы страницы Masaki выглядели одинаково.

type Period = 'all' | 'today' | 'yesterday' | 'week' | 'month'

const PERIODS: { id: Period; label: string }[] = [
  { id: 'all', label: 'За всё время' },
  { id: 'today', label: 'Сегодня' },
  { id: 'yesterday', label: 'Вчера' },
  { id: 'week', label: 'За неделю' },
  { id: 'month', label: 'За месяц' }
]

const DAY = 24 * 60 * 60 * 1000
const startOfDay = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function inPeriod(t: number, p: Period): boolean {
  const today = startOfDay(Date.now())
  switch (p) {
    case 'today':
      return t >= today
    case 'yesterday':
      return t >= today - DAY && t < today
    case 'week':
      return t >= today - 6 * DAY
    case 'month':
      return t >= today - 29 * DAY
    default:
      return true
  }
}

function dayLabel(day: number): [string, string] {
  const today = startOfDay(Date.now())
  const d = new Date(day)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
  if (day === today) return ['Сегодня', date]
  if (day === today - DAY) return ['Вчера', date]
  const wd = d.toLocaleDateString('ru-RU', { weekday: 'long' })
  return [wd.charAt(0).toUpperCase() + wd.slice(1), date]
}

const timeOf = (t: number): string => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

// Значки сайтов копией data: (в интерфейсу нужны пиксели, а адреса повторяются) — кэш на страницу.
const favicons = new Map<string, string | null>()
const faviconListeners = new Set<() => void>()

async function loadFavicon(url: string): Promise<void> {
  const host = hostOf(url)
  if (favicons.has(host)) return
  favicons.set(host, null)
  const src = await window.masaki.favicon(url).catch(() => null)
  favicons.set(host, src)
  faviconListeners.forEach((fn) => fn())
}

function SiteBadge({ url, title }: { url: string; title: string }): React.JSX.Element {
  const src = favicons.get(hostOf(url)) ?? null
  const [, force] = useState(0)
  useEffect(() => {
    void loadFavicon(url)
    const fn = (): void => force((n) => n + 1)
    faviconListeners.add(fn)
    return () => {
      faviconListeners.delete(fn)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])
  if (src) {
    return (
      <span className="fav fv1 hp-fav">
        <img src={src} alt="" draggable={false} />
      </span>
    )
  }
  const letter = (title.trim() || hostOf(url)).replace(/^www\./, '').charAt(0).toUpperCase() || '•'
  return (
    <span className="fav fv1 hp-fav">
      <b>{letter}</b>
    </span>
  )
}

function Row({ h }: { h: HistoryEntry }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const remove = (): void => {
    window.masaki.history.remove(h)
    useStore.setState((st) => ({ history: st.history.filter((x) => !(x.url === h.url && x.time === h.time)) }))
  }
  const copy = (): void => {
    void navigator.clipboard.writeText(h.url).then(() => {
      useStore.getState().showCopied({ title: 'Ссылка скопирована', text: h.url })
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <div className="dlp-row lift">
      <button className="dlp-main" title={h.url} onClick={() => useStore.getState().navigate(h.url, { raw: true, target: 'new' })}>
        <SiteBadge url={h.url} title={h.title} />
        <span className="dlp-text">
          <b className="dlp-name">{h.title || hostOf(h.url)}</b>
          <span className="dlp-meta">{hostOf(h.url)} · {timeOf(h.time)}</span>
        </span>
      </button>
      <span className="dlp-acts">
        <button className="ib" aria-label="Копировать ссылку" title={copied ? 'Ссылка скопирована' : 'Копировать ссылку'} onClick={copy}>
          <Icon name={copied ? 'check' : 'link'} />
        </button>
        <button className="ib" aria-label="Убрать из истории" title="Убрать из истории" onClick={remove}>
          <Icon name="close" />
        </button>
      </span>
    </div>
  )
}

export function HistoryPage(): React.JSX.Element {
  const history = useStore((s) => s.history)
  const [q, setQ] = useState('')
  const [period, setPeriod] = useState<Period>('all')
  const s = useStore.getState

  const needle = q.trim().toLowerCase()
  const shown = useMemo(
    () =>
      [...history].reverse().filter((h) => {
        if (!inPeriod(h.time, period)) return false
        if (needle && !(h.title + ' ' + h.url + ' ' + hostOf(h.url)).toLowerCase().includes(needle)) return false
        return true
      }),
    [history, period, needle]
  )

  const groups = useMemo(() => {
    const out: { day: number; items: HistoryEntry[] }[] = []
    for (const h of shown) {
      const day = startOfDay(h.time)
      const g = out[out.length - 1]
      if (g && g.day === day) g.items.push(h)
      else out.push({ day, items: [h] })
    }
    return out
  }, [shown])

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
    <div className="settings dlp">
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

        {groups.map((g) => {
          const [name, date] = dayLabel(g.day)
          return (
            <div key={g.day} className="dlp-group">
              <div className="dlp-day">
                <b>{name}</b>
                <span>
                  {date} · {g.items.length}
                </span>
              </div>
              <div className="dlp-card">
                {g.items.map((h) => (
                  <Row key={h.url + h.time} h={h} />
                ))}
              </div>
            </div>
          )
        })}

        {shown.length === 0 && (
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
