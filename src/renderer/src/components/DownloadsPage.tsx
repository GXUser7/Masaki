import { useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadInfo } from '../../../shared/types'
import { formatBytes } from '../lib/format'
import { shapes, type ShapeName } from '../lib/shapes'
import { useStore } from '../store'
import type { MenuEntry } from './Menu'
import { Icon, type IconName } from './Icon'
import { ProgressRing } from './parts'

// Страница загрузок (masaki://downloads, вариант A с холста): лента по дням, поиск по названию и сайту,
// период, «на диске / удалённые / с ошибкой», типы файлов. Файлы, которых уже нет, не прячутся —
// их можно скачать снова.

type Kind = 'doc' | 'pdf' | 'image' | 'app' | 'archive' | 'video' | 'audio' | 'other'
type Status = 'live' | 'ok' | 'gone' | 'failed'
type StatusFilter = 'all' | Exclude<Status, 'live'>
type KindFilter = 'docs' | 'images' | 'apps' | 'archives' | 'media'
type Period = 'all' | 'today' | 'yesterday' | 'week' | 'month'

const EXT: [RegExp, Kind][] = [
  [/\.pdf$/i, 'pdf'],
  [/\.(docx?|odt|rtf|txt|md|xlsx?|ods|csv|pptx?|odp|epub|fb2|djvu)$/i, 'doc'],
  [/\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|ico|tiff?)$/i, 'image'],
  [/\.(exe|msi|msix|appx|dmg|pkg|apk|deb|rpm|appimage|bat|cmd|ps1|crx)$/i, 'app'],
  [/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|iso)$/i, 'archive'],
  [/\.(mp4|mkv|webm|mov|avi|wmv|m4v)$/i, 'video'],
  [/\.(mp3|flac|wav|ogg|opus|m4a|aac)$/i, 'audio']
]

function kindOf(d: DownloadInfo): Kind {
  for (const [re, k] of EXT) if (re.test(d.filename)) return k
  if (d.mime?.startsWith('image/')) return 'image'
  if (d.mime?.startsWith('video/')) return 'video'
  if (d.mime?.startsWith('audio/')) return 'audio'
  return 'other'
}

/** Плитка типа: форма M3 и тон темы, как у плиток избранного. */
const LOOK: Record<Kind, { icon: IconName; shape: ShapeName }> = {
  doc: { icon: 'doc', shape: 'clover4' },
  pdf: { icon: 'pdf', shape: 'sunny8' },
  image: { icon: 'image', shape: 'flower6' },
  app: { icon: 'computer', shape: 'cookie9' },
  archive: { icon: 'archive', shape: 'cookie6' },
  video: { icon: 'movie', shape: 'clover8' },
  audio: { icon: 'music', shape: 'burst' },
  other: { icon: 'download', shape: 'squircle' }
}

const KIND_FILTERS: { id: KindFilter; label: string; icon: IconName; kinds: Kind[] }[] = [
  { id: 'docs', label: 'Документы', icon: 'doc', kinds: ['doc', 'pdf'] },
  { id: 'images', label: 'Картинки', icon: 'image', kinds: ['image'] },
  { id: 'apps', label: 'Программы', icon: 'computer', kinds: ['app'] },
  { id: 'archives', label: 'Архивы', icon: 'archive', kinds: ['archive'] },
  { id: 'media', label: 'Видео и звук', icon: 'movie', kinds: ['video', 'audio'] }
]

const PERIODS: { id: Period; label: string }[] = [
  { id: 'all', label: 'За всё время' },
  { id: 'today', label: 'Сегодня' },
  { id: 'yesterday', label: 'Вчера' },
  { id: 'week', label: 'За неделю' },
  { id: 'month', label: 'За месяц' }
]

function statusOf(d: DownloadInfo): Status {
  if (d.state === 'progressing') return 'live'
  if (d.state === 'completed') return d.exists === false ? 'gone' : 'ok'
  return 'failed'
}

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

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const canRetry = (d: DownloadInfo): boolean => /^https?:\/\//i.test(d.url)

function plural(n: number, one: string, few: string, many: string): string {
  const a = n % 10
  const b = n % 100
  return n + ' ' + (a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many)
}

/** Скорость и сколько осталось — по разнице между обновлениями (сглаженно, чтобы цифры не прыгали). */
function useSpeeds(list: DownloadInfo[]): Map<string, number> {
  const last = useRef(new Map<string, { t: number; got: number; speed: number }>())
  return useMemo(() => {
    const now = performance.now()
    const out = new Map<string, number>()
    for (const d of list) {
      if (d.state !== 'progressing') {
        last.current.delete(d.id)
        continue
      }
      const prev = last.current.get(d.id)
      let speed = prev?.speed ?? 0
      if (prev && now > prev.t && d.received >= prev.got) {
        const inst = ((d.received - prev.got) / (now - prev.t)) * 1000
        speed = prev.speed ? prev.speed * 0.7 + inst * 0.3 : inst
      }
      last.current.set(d.id, { t: now, got: d.received, speed })
      out.set(d.id, speed)
    }
    return out
  }, [list])
}

function metaOf(d: DownloadInfo, status: Status, speed: number): string {
  const site = d.page || hostOfUrl(d.url)
  const size = d.total || d.received
  if (status === 'live') {
    const parts = [d.total ? `${Math.round((d.received / d.total) * 100)} % · ${formatBytes(d.received)} из ${formatBytes(d.total)}` : formatBytes(d.received)]
    if (speed > 1024) {
      parts.push(formatBytes(speed) + '/с')
      if (d.total) {
        const left = Math.max(0, Math.round((d.total - d.received) / speed))
        parts.push(left < 60 ? `ещё ${left} с` : `ещё ${Math.ceil(left / 60)} мин`)
      }
    }
    if (site) parts.push(site)
    return parts.join(' · ')
  }
  return [size ? formatBytes(size) : '', site, timeOf(d.startedAt)].filter(Boolean).join(' · ')
}

function Tile({ d, kind, status }: { d: DownloadInfo; kind: Kind; status: Status }): React.JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    if (kind !== 'image' || status !== 'ok') return
    let alive = true
    void window.masaki.downloads.thumb(d.id).then((t) => alive && setThumb(t))
    return () => {
      alive = false
    }
  }, [d.id, kind, status])
  const look = LOOK[kind]
  if (status === 'live') {
    return (
      <ProgressRing value={d.total ? d.received / d.total : 0} spin={!d.total} className="dlp-ring">
        <Icon name={look.icon} />
      </ProgressRing>
    )
  }
  if (thumb) return <img className="dlp-thumb" src={thumb} alt="" draggable={false} />
  return (
    <span className={`dlp-tile k-${kind}` + (status === 'ok' ? '' : ' off')}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <path d={shapes[look.shape]} />
      </svg>
      <Icon name={look.icon} />
    </span>
  )
}

function Row({ d, speed }: { d: DownloadInfo; speed: number }): React.JSX.Element {
  const kind = kindOf(d)
  const status = statusOf(d)
  const ok = status === 'ok'
  const [copied, setCopied] = useState(false)
  const remove = async (): Promise<void> => {
    if (await window.masaki.downloads.remove(d.id)) useStore.getState().dropDownload(d.id)
  }
  const retry = async (): Promise<void> => {
    if (await window.masaki.downloads.retry(d.id)) useStore.getState().dropDownload(d.id)
  }
  const copy = (): void => {
    void navigator.clipboard.writeText(d.url).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <div
      className={'dlp-row lift' + (status === 'gone' ? ' gone' : status === 'failed' ? ' failed' : '')}
      draggable={ok}
      onDragStart={(e) => {
        // Файл перетаскивает сама система — в проводник, мессенджер или на сайт.
        e.preventDefault()
        window.masaki.downloads.drag(d.path)
      }}
    >
      <button
        className="dlp-main"
        disabled={!ok}
        title={ok ? 'Открыть · можно перетащить в папку или на сайт' : d.filename}
        onClick={() => window.masaki.downloads.open(d.path)}
      >
        <Tile d={d} kind={kind} status={status} />
        <span className="dlp-text">
          <b className="dlp-name">{d.filename}</b>
          <span className="dlp-meta">{metaOf(d, status, speed)}</span>
        </span>
      </button>
      {status === 'gone' && (
        <span className="dlp-pill">
          <Icon name="delete" />
          Удалён с диска
        </span>
      )}
      {status === 'failed' && (
        // Отменили сами — не ошибка, без красного; оборвалась — да.
        <span className={'dlp-pill' + (d.state === 'cancelled' ? ' soft' : '')}>
          <Icon name={d.state === 'cancelled' ? 'close' : 'warn'} />
          {d.state === 'cancelled' ? 'Отменено' : 'Прервано'}
        </span>
      )}
      {(status === 'gone' || status === 'failed') && canRetry(d) && !d.canCancel && (
        <button className="tonal dlp-again" onClick={() => void retry()}>
          <Icon name={status === 'gone' ? 'download' : 'reload'} />
          {status === 'gone' ? 'Скачать снова' : 'Повторить'}
        </button>
      )}
      {d.canCancel && (
        <button className="ib" aria-label="Отменить загрузку" title="Отменить загрузку" onClick={() => void window.masaki.downloads.cancel(d.id)}>
          <Icon name="close" />
        </button>
      )}
      {!d.canCancel && (
        <span className="dlp-acts">
          {ok && (
            <button className="ib" aria-label="Показать в папке" title="Показать в папке" onClick={() => window.masaki.downloads.showInFolder(d.path)}>
              <Icon name="folder" />
            </button>
          )}
          {canRetry(d) && (
            <button className="ib" aria-label="Копировать ссылку" title={copied ? 'Ссылка скопирована' : 'Копировать ссылку'} onClick={copy}>
              <Icon name={copied ? 'check' : 'link'} />
            </button>
          )}
          <button className="ib" aria-label="Убрать из списка" title="Убрать из списка (файл останется)" onClick={() => void remove()}>
            <Icon name="close" />
          </button>
        </span>
      )}
    </div>
  )
}

export function DownloadsPage(): React.JSX.Element {
  const downloads = useStore((s) => s.downloads)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [kinds, setKinds] = useState<KindFilter | null>(null)
  const [period, setPeriod] = useState<Period>('all')
  const speeds = useSpeeds(downloads)
  const s = useStore.getState

  // Удалили файл в проводнике и вернулись — отметка «удалён с диска» должна это увидеть.
  useEffect(() => {
    void s().loadDownloads()
    const onFocus = (): void => void s().loadDownloads()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [s])

  const counts = useMemo(() => {
    const c = { all: 0, ok: 0, gone: 0, failed: 0, bytes: 0 }
    for (const d of downloads) {
      const st = statusOf(d)
      c.all++
      if (st === 'ok') {
        c.ok++
        c.bytes += d.total || d.received
      } else if (st !== 'live') c[st]++
    }
    return c
  }, [downloads])

  const needle = q.trim().toLowerCase()
  const shown = useMemo(() => {
    const kf = KIND_FILTERS.find((k) => k.id === kinds)
    return downloads.filter((d) => {
      const st = statusOf(d)
      if (status !== 'all' && st !== status) return false
      if (kf && !kf.kinds.includes(kindOf(d))) return false
      if (!inPeriod(d.startedAt, period)) return false
      if (needle && !(d.filename + ' ' + (d.page ?? '') + ' ' + hostOfUrl(d.url)).toLowerCase().includes(needle)) return false
      return true
    })
  }, [downloads, status, kinds, period, needle])

  const live = shown.filter((d) => statusOf(d) === 'live')
  const groups = useMemo(() => {
    const out: { day: number; items: DownloadInfo[] }[] = []
    for (const d of shown) {
      if (statusOf(d) === 'live') continue
      const day = startOfDay(d.startedAt)
      const g = out[out.length - 1]
      if (g && g.day === day) g.items.push(d)
      else out.push({ day, items: [d] })
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
      { kind: 'item', label: 'Открыть папку загрузок', icon: 'folderOpen', run: () => window.masaki.downloads.openFolder() },
      { kind: 'sep' },
      {
        kind: 'item',
        label: 'Очистить список',
        icon: 'delete',
        danger: true,
        disabled: counts.all === live.length,
        run: () => {
          window.masaki.downloads.clear()
          useStore.setState((st) => ({ downloads: st.downloads.filter((d) => d.canCancel) }))
        }
      }
    ]
    s().openMenu(r.right - 240, r.bottom + 6, entries)
  }

  const filtered = needle || status !== 'all' || kinds || period !== 'all'
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? ''
  return (
    <div className="settings dlp">
      <div className="set-inner">
        <div className="dlp-head">
          <div className="dlp-title">
            <h1>Загрузки</h1>
            <span className="hint">
              {counts.ok ? `На диске ${plural(counts.ok, 'файл', 'файла', 'файлов')} · ${formatBytes(counts.bytes)}` : 'Папка «Загрузки»'}
            </span>
          </div>
          <button className="dlp-fab halo" onClick={() => window.masaki.downloads.openFolder()}>
            <Icon name="folderOpen" />
            Открыть папку
          </button>
          <button className="ib dlp-more" aria-label="Ещё" title="Ещё" onClick={more}>
            <Icon name="more" />
          </button>
        </div>

        <label className="dlp-search">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название файла или сайт" aria-label="Найти загрузку" spellCheck={false} />
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

        <div className="dlp-chips" role="toolbar" aria-label="Фильтры">
          {(
            [
              ['all', 'Все', counts.all],
              ['ok', 'На диске', counts.ok],
              ['gone', 'Удалённые', counts.gone],
              ['failed', 'С ошибкой', counts.failed]
            ] as [StatusFilter, string, number][]
          ).map(([id, label, n]) => (
            <button key={id} className={'dlp-chip' + (status === id ? ' on' : '')} aria-pressed={status === id} onClick={() => setStatus(id)}>
              {status === id && <Icon name="check" />}
              {label} <i>{n}</i>
            </button>
          ))}
          <span className="dlp-sep" />
          {KIND_FILTERS.map((k) => (
            <button
              key={k.id}
              className={'dlp-chip' + (kinds === k.id ? ' on' : '')}
              aria-pressed={kinds === k.id}
              onClick={() => setKinds(kinds === k.id ? null : k.id)}
            >
              <Icon name={kinds === k.id ? 'check' : k.icon} />
              {k.label}
            </button>
          ))}
        </div>

        {live.length > 0 && (
          <div className="dlp-group">
            <div className="dlp-day">
              <b>Сейчас</b>
              <span>{plural(live.length, 'загрузка', 'загрузки', 'загрузок')}</span>
            </div>
            <div className="dlp-card">
              {live.map((d) => (
                <Row key={d.id} d={d} speed={speeds.get(d.id) ?? 0} />
              ))}
            </div>
          </div>
        )}

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
                {g.items.map((d) => (
                  <Row key={d.id} d={d} speed={0} />
                ))}
              </div>
            </div>
          )
        })}

        {shown.length === 0 && (
          <div className="dlp-empty">
            <span className="dlp-empty-art">
              <svg viewBox="0 0 200 200" aria-hidden="true">
                <path d={shapes.cookie9} />
              </svg>
              <Icon name={filtered ? 'search' : 'download'} />
            </span>
            <b>{filtered ? 'Ничего не нашлось' : 'Здесь появится всё, что вы скачаете'}</b>
            <span>{filtered ? 'Попробуйте другое название, период или фильтр' : 'Даже если файл потом удалить, запись останется — его можно будет скачать снова'}</span>
            {filtered && (
              <button
                className="tonal"
                onClick={() => {
                  setQ('')
                  setStatus('all')
                  setKinds(null)
                  setPeriod('all')
                }}
              >
                Сбросить фильтры
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
