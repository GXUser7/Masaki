import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadInfo } from '../../../shared/types'
import { dayLabel, PERIODS, periodRange, startOfDay, timeOf, type Period } from '../lib/feed'
import { formatBytes } from '../lib/format'
import { shapes, type ShapeName } from '../lib/shapes'
import { useStore } from '../store'
import { VirtualDayFeed, type FeedGroup } from './FeedList'
import { Icon, type IconName } from './Icon'
import type { MenuEntry } from './Menu'
import { ProgressRing } from './parts'

// Страница загрузок (masaki://downloads, вариант A с холста): виртуализованная лента по дням,
// поиск по названию и сайту, период, «на диске / удалённые / с ошибкой», типы файлов.
// Файлы, которых уже нет, не прячутся — их можно скачать снова.

type Kind = 'doc' | 'pdf' | 'image' | 'app' | 'archive' | 'video' | 'audio' | 'other'
type Status = 'live' | 'ok' | 'gone' | 'failed'
type StatusFilter = 'all' | Exclude<Status, 'live'>
type KindFilter = 'docs' | 'images' | 'apps' | 'archives' | 'media'

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

function statusOf(d: DownloadInfo): Status {
  if (d.state === 'progressing') return 'live'
  if (d.state === 'completed') return d.exists === false ? 'gone' : 'ok'
  return 'failed'
}

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

interface IndexedDownload {
  kind: Kind
  status: Status
  site: string
  day: number
  sizeBytes: number
  retryable: boolean
  search: string
}

const downloadIndex = new WeakMap<DownloadInfo, IndexedDownload>()

function indexDownload(d: DownloadInfo): IndexedDownload {
  let info = downloadIndex.get(d)
  if (!info) {
    const kind = kindOf(d)
    const status = statusOf(d)
    const site = d.page || hostOfUrl(d.url)
    const sizeBytes = d.total || d.received
    info = {
      kind,
      status,
      site,
      day: startOfDay(d.startedAt),
      sizeBytes,
      retryable: canRetry(d),
      search: `${d.filename}\0${site}`.toLowerCase()
    }
    downloadIndex.set(d, info)
  }
  return info
}

// Миниатюры картинок: ограниченный LRU-кэш + LIFO-очередь до 4 одновременных IPC,
// чтобы при быстрой прокрутке сотен картинок система не извлекала миниатюры для пропущенных строк.
const MAX_THUMBS = 200
const MAX_THUMB_JOBS = 4
const thumbCache = new Map<string, string | null>()
const thumbListeners = new Map<string, Set<() => void>>()
const thumbQueue: string[] = []
const queuedThumbs = new Set<string>()
let activeThumbJobs = 0

function rememberThumb(id: string, url: string | null): void {
  if (thumbCache.has(id)) thumbCache.delete(id)
  else if (thumbCache.size >= MAX_THUMBS) thumbCache.delete(thumbCache.keys().next().value!)
  thumbCache.set(id, url)
}

function pumpThumbs(): void {
  while (activeThumbJobs < MAX_THUMB_JOBS && thumbQueue.length > 0) {
    const id = thumbQueue.pop()!
    queuedThumbs.delete(id)
    if (thumbCache.has(id) || !thumbListeners.get(id)?.size) continue
    activeThumbJobs++
    void window.masaki.downloads
      .thumb(id)
      .then((url) => {
        rememberThumb(id, url)
        thumbListeners.get(id)?.forEach((fn) => fn())
      })
      .catch(() => {
        rememberThumb(id, null)
      })
      .finally(() => {
        activeThumbJobs--
        pumpThumbs()
      })
  }
}

function requestThumb(id: string): void {
  if (thumbCache.has(id) || queuedThumbs.has(id)) return
  queuedThumbs.add(id)
  thumbQueue.push(id)
  pumpThumbs()
}

/** Скорость и сколько осталось — по разнице между обновлениями (сглаженно, чтобы цифры не прыгали). */
function useSpeeds(list: DownloadInfo[]): Map<string, number> {
  const last = useRef(new Map<string, { t: number; got: number; speed: number }>())
  return useMemo(() => {
    const now = performance.now()
    const out = new Map<string, number>()
    const liveIds = new Set<string>()
    for (const d of list) {
      if (d.state !== 'progressing' || d.paused) {
        last.current.delete(d.id)
        continue
      }
      liveIds.add(d.id)
      const prev = last.current.get(d.id)
      let speed = prev?.speed ?? 0
      if (prev && now > prev.t && d.received >= prev.got) {
        const inst = ((d.received - prev.got) / (now - prev.t)) * 1000
        speed = prev.speed ? prev.speed * 0.7 + inst * 0.3 : inst
      }
      last.current.set(d.id, { t: now, got: d.received, speed })
      out.set(d.id, speed)
    }
    if (last.current.size > liveIds.size) {
      for (const id of last.current.keys()) {
        if (!liveIds.has(id)) last.current.delete(id)
      }
    }
    return out
  }, [list])
}

function liveMetaOf(d: DownloadInfo, site: string, speed: number): string {
  const parts = [d.total ? `${Math.round((d.received / d.total) * 100)} % · ${formatBytes(d.received)} из ${formatBytes(d.total)}` : formatBytes(d.received)]
  if (d.paused) parts.unshift('На паузе')
  if (!d.paused && speed > 1024) {
    parts.push(formatBytes(speed) + '/с')
    if (d.total) {
      const left = Math.max(0, Math.round((d.total - d.received) / speed))
      parts.push(left < 60 ? `ещё ${left} с` : `ещё ${Math.ceil(left / 60)} мин`)
    }
  }
  if (site) parts.push(site)
  return parts.join(' · ')
}

const Tile = memo(function Tile({
  id,
  received,
  total,
  paused,
  kind,
  status
}: {
  id: string
  received: number
  total: number
  paused?: boolean
  kind: Kind
  status: Status
}): React.JSX.Element {
  const [, force] = useState(0)
  const needThumb = kind === 'image' && status === 'ok'
  const thumb = needThumb ? (thumbCache.get(id) ?? null) : null

  useEffect(() => {
    if (!needThumb) return
    let set = thumbListeners.get(id)
    if (!set) {
      set = new Set()
      thumbListeners.set(id, set)
    }
    const fn = (): void => force((n) => n + 1)
    set.add(fn)
    if (!thumbCache.has(id)) requestThumb(id)
    return () => {
      set!.delete(fn)
      if (set!.size === 0) thumbListeners.delete(id)
    }
  }, [id, needThumb])

  const look = LOOK[kind]
  if (status === 'live') {
    return (
      <ProgressRing value={total ? received / total : 0} spin={!total && !paused} className="dlp-ring">
        <Icon name={paused ? 'pause' : look.icon} />
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
})

const removeDownload = async (id: string): Promise<void> => {
  if (await window.masaki.downloads.remove(id)) useStore.getState().dropDownload(id)
}

const retryDownload = async (id: string): Promise<void> => {
  if (await window.masaki.downloads.retry(id)) useStore.getState().dropDownload(id)
}

const Row = memo(function Row({
  d,
  meta,
  speed,
  animCls,
  animDelay
}: {
  d: DownloadInfo
  meta: IndexedDownload
  speed: number
  animCls: string
  animDelay: number
}): React.JSX.Element {
  const { kind, status, retryable } = meta
  const ok = status === 'ok'
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(0)

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const copy = (): void => {
    void navigator.clipboard.writeText(d.url).then(() => {
      useStore.getState().showCopied({ title: 'Ссылка на файл скопирована', text: d.url })
      setCopied(true)
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1400)
    })
  }

  return (
    <div
      className={
        'dlp-row lift' +
        (status === 'live' ? ' live' : status === 'gone' ? ' gone' : status === 'failed' ? ' failed' : '') +
        (animCls ? ' ' + animCls : '')
      }
      style={animDelay ? { animationDelay: `${animDelay}ms` } : undefined}
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
        <Tile id={d.id} received={d.received} total={d.total} paused={d.paused} kind={kind} status={status} />
        <span className="dlp-text">
          <b className="dlp-name">{d.filename}</b>
          <span className="dlp-meta">
            {status === 'live'
              ? liveMetaOf(d, meta.site, speed)
              : [meta.sizeBytes ? formatBytes(meta.sizeBytes) : '', meta.site, timeOf(d.startedAt)].filter(Boolean).join(' · ')}
          </span>
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
      {(status === 'gone' || status === 'failed') && retryable && !d.canCancel && (
        <button className="tonal dlp-again" onClick={() => void retryDownload(d.id)}>
          <Icon name={status === 'gone' ? 'download' : 'reload'} />
          {status === 'gone' ? 'Скачать снова' : 'Повторить'}
        </button>
      )}
      {d.canCancel && ((d.state === 'progressing' && !d.paused) || d.canResume) && (
        <button
          className="ib"
          aria-label={d.canResume ? 'Возобновить загрузку' : 'Приостановить загрузку'}
          title={d.canResume ? 'Возобновить загрузку' : 'Приостановить загрузку'}
          onClick={() => void (d.canResume ? window.masaki.downloads.resume(d.id) : window.masaki.downloads.pause(d.id))}
        >
          <Icon name={d.canResume ? 'play' : 'pause'} />
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
          {retryable && (
            <button className="ib" aria-label="Копировать ссылку" title={copied ? 'Ссылка скопирована' : 'Копировать ссылку'} onClick={copy}>
              <Icon name={copied ? 'check' : 'link'} />
            </button>
          )}
          <button className="ib" aria-label="Убрать из списка" title="Убрать из списка (файл останется)" onClick={() => void removeDownload(d.id)}>
            <Icon name="close" />
          </button>
        </span>
      )}
    </div>
  )
})

interface DownloadRowItem {
  d: DownloadInfo
  meta: IndexedDownload
}

const itemKey = (item: DownloadRowItem): string => item.d.id

export function DownloadsPage(): React.JSX.Element {
  const downloads = useStore((s) => s.downloads)
  const [q, setQ] = useState('')
  const deferredQ = useDeferredValue(q)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [kinds, setKinds] = useState<KindFilter | null>(null)
  const [period, setPeriod] = useState<Period>('all')
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevPastRef = useRef<DownloadInfo[]>([])
  const s = useStore.getState

  // Отделяем активные загрузки от завершённых: частые тики прогресса не пересчитывают прошлые 20k+ записей.
  const { liveRaw, pastRaw } = useMemo(() => {
    const live: DownloadInfo[] = []
    const past: DownloadInfo[] = []
    for (let i = 0; i < downloads.length; i++) {
      const d = downloads[i]
      if (d.state === 'progressing') live.push(d)
      else past.push(d)
    }
    const prev = prevPastRef.current
    let same = past.length === prev.length
    if (same) {
      for (let i = 0; i < past.length; i++) {
        if (past[i] !== prev[i]) {
          same = false
          break
        }
      }
    }
    if (!same) prevPastRef.current = past
    return { liveRaw: live, pastRaw: prevPastRef.current }
  }, [downloads])

  const speeds = useSpeeds(liveRaw)
  const speedsRef = useRef(speeds)
  speedsRef.current = speeds

  // Удалили файл в проводнике и вернулись — отметка «удалён с диска» должна это увидеть.
  useEffect(() => {
    void s().loadDownloads()
    const onFocus = (): void => void s().loadDownloads()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [s])

  const pastIndexed = useMemo(
    () => pastRaw.map((d) => ({ d, meta: indexDownload(d) })),
    [pastRaw]
  )

  const pastCounts = useMemo(() => {
    const c = { all: 0, ok: 0, gone: 0, failed: 0, bytes: 0 }
    for (const { meta } of pastIndexed) {
      c.all++
      if (meta.status === 'ok') {
        c.ok++
        c.bytes += meta.sizeBytes
      } else if (meta.status === 'gone') {
        c.gone++
      } else if (meta.status === 'failed') {
        c.failed++
      }
    }
    return c
  }, [pastIndexed])

  const counts = useMemo(
    () => ({ ...pastCounts, all: pastCounts.all + liveRaw.length, live: liveRaw.length }),
    [pastCounts, liveRaw.length]
  )

  const needle = deferredQ.trim().toLowerCase()
  const pastGroups = useMemo<FeedGroup<DownloadRowItem>[]>(() => {
    const kf = KIND_FILTERS.find((k) => k.id === kinds)
    const now = Date.now()
    const [from, to] = periodRange(period, now)
    const today = startOfDay(now)
    const currentYear = new Date(today).getFullYear()
    const byDay = new Map<number, DownloadRowItem[]>()

    for (let i = 0; i < pastIndexed.length; i++) {
      const item = pastIndexed[i]
      const { d, meta } = item
      if (status !== 'all' && meta.status !== status) continue
      if (kf && !kf.kinds.includes(meta.kind)) continue
      if (d.startedAt < from || d.startedAt >= to) continue
      if (needle && !meta.search.includes(needle)) continue

      let list = byDay.get(meta.day)
      if (!list) {
        list = []
        byDay.set(meta.day, list)
      }
      list.push(item)
    }

    return [...byDay.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([day, items]) => {
        const [name, date] = dayLabel(day, today, currentYear)
        return { key: day, name, meta: `${date} · ${items.length}`, items }
      })
  }, [pastIndexed, status, kinds, period, needle])

  const liveGroup = useMemo<FeedGroup<DownloadRowItem> | null>(() => {
    if (!liveRaw.length || status !== 'all') return null
    const kf = KIND_FILTERS.find((k) => k.id === kinds)
    const [from, to] = periodRange(period)
    const live: DownloadRowItem[] = []
    for (let i = 0; i < liveRaw.length; i++) {
      const d = liveRaw[i]
      const meta = indexDownload(d)
      if (kf && !kf.kinds.includes(meta.kind)) continue
      if (d.startedAt < from || d.startedAt >= to) continue
      if (needle && !meta.search.includes(needle)) continue
      live.push({ d, meta })
    }
    if (!live.length) return null
    return { key: 'live', name: 'Сейчас', meta: plural(live.length, 'загрузка', 'загрузки', 'загрузок'), items: live }
  }, [liveRaw, status, kinds, period, needle])

  const groups = useMemo<FeedGroup<DownloadRowItem>[]>(
    () => (liveGroup ? [liveGroup, ...pastGroups] : pastGroups),
    [liveGroup, pastGroups]
  )

  const renderRow = useCallback(
    (item: DownloadRowItem, _i: number, anim: { cls: string; delay: number }) => (
      <Row
        key={item.d.id}
        d={item.d}
        meta={item.meta}
        speed={item.meta.status === 'live' ? (speedsRef.current.get(item.d.id) ?? 0) : 0}
        animCls={anim.cls}
        animDelay={anim.delay}
      />
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
      { kind: 'item', label: 'Открыть папку загрузок', icon: 'folderOpen', run: () => window.masaki.downloads.openFolder() },
      { kind: 'sep' },
      {
        kind: 'item',
        label: 'Очистить список',
        icon: 'delete',
        danger: true,
        disabled: counts.all === counts.live,
        run: () => {
          s().clearDownloads()
        }
      }
    ]
    s().openMenu(r.right - 240, r.bottom + 6, entries)
  }

  const filtered = needle || status !== 'all' || kinds || period !== 'all'
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? ''
  return (
    <div className="settings dlp" ref={scrollRef}>
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

        <VirtualDayFeed scrollRef={scrollRef} groups={groups} itemKey={itemKey} renderRow={renderRow} />

        {groups.length === 0 && (
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
