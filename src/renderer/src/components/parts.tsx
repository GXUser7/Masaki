import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Shortcut } from '../../../shared/types'
import { isTileColor, useLightGlyph, useSiteIcon } from '../lib/iconColor'
import { isShape, shapeCycle, shapes } from '../lib/shapes'
import { displayUrl, hostOf, letterOf, searchQueryOf } from '../lib/url'
import { internalPages, type Tab, useStore } from '../store'
import { Icon } from './Icon'

/** Матовое зерно поверх стекла. */

const internalIcon = { settings: 'settings', addons: 'extension', passwords: 'key', downloads: 'download' } as const

export function Grain(): React.JSX.Element {
  return (
    <svg className="grain" aria-hidden="true">
      <rect width="100%" height="100%" filter="url(#masaki-grain)" />
    </svg>
  )
}

export function toneOf(key: string): number {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0
  return (Math.abs(h) % 4) + 1
}

/**
 * Плитка ярлыка или избранного: форма M3 Expressive, окрашенная в главный цвет значка сайта
 * (или в цвет, который выбрал пользователь), и сам значок на кружке: белом, а для светлых значков — тёмном.
 * Смена формы и цвета плавно перетекает (у всех форм одинаковое число точек).
 */
export function ShapeTile({ item, index, themed = false }: { item: Shortcut; index: number; themed?: boolean }): React.JSX.Element {
  const { src, colors } = useSiteIcon(item.url, item.color)
  // Картинка, которую не удалось показать, — не пустой кружок, а буква, как без значка.
  const [bad, setBad] = useState<string | null>(null)
  const shape = isShape(item.shape) ? item.shape : shapeCycle[index % shapeCycle.length]
  // «В цвете темы»: заливка — тональный цвет палитры (на панели не приглушается, см. .tile.themed);
  // свой цвет плитки по-прежнему главнее.
  const theme = themed && !isTileColor(item.color)
  const vars = theme
    ? ({
        '--tl': 'var(--sc)',
        '--td': 'var(--sc)',
        '--il': 'var(--on-sc)',
        '--id': 'var(--on-sc)',
        ...(colors?.plate ? { '--plate': colors.plate } : {})
      } as CSSProperties)
    : colors
      ? ({
          '--tl': colors.light.fill,
          '--td': colors.dark.fill,
          '--il': colors.light.ink,
          '--id': colors.dark.ink,
          // Подложка значка живёт во внешнем стиле плитки, а рисует её .site-ic.
          ...(colors.plate ? { '--plate': colors.plate } : {})
        } as CSSProperties)
      : undefined
  return (
    <span className={'tile' + (theme ? ' themed' : '')} style={vars}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <path className={'tile-shape t' + ((index % 4) + 1)} style={{ d: `path("${shapes[shape]}")` } as CSSProperties} />
      </svg>
      {src && bad !== src ? (
        <span className={'site-ic' + (colors?.plate ? ' dk' : '')}>
          <img src={src} alt="" draggable={false} onError={() => setBad(src)} />
        </span>
      ) : (
        <b className="tile-letter">{letterOf(item.title, item.url)}</b>
      )}
    </span>
  )
}

// Волнистая окружность M3 Expressive в поле 48×48: радиус 19, 10 волн высотой 1.6, от верхней точки по часовой.
const WAVY_RING = (() => {
  let d = ''
  for (let i = 0; i <= 240; i++) {
    const t = (i / 240) * Math.PI * 2
    const r = 19 + 1.6 * Math.sin(10 * t)
    d += (i ? 'L' : 'M') + (24 + r * Math.sin(t)).toFixed(2) + ' ' + (24 - r * Math.cos(t)).toFixed(2)
  }
  return d + 'Z'
})()

/**
 * Круговой индикатор прогресса M3 Expressive: волнистая активная дуга с круглыми концами, зазор и тихая
 * дорожка. value — 0…1; spin — сколько осталось, неизвестно (дуга крутится). Внутри — значок.
 */
export function ProgressRing({
  value,
  spin = false,
  className = '',
  children
}: {
  value: number
  spin?: boolean
  className?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const v = spin ? 28 : Math.max(0, Math.min(1, value)) * 100
  // Зазор между дугой и дорожкой — с запасом на круглые концы линии.
  const gap = v > 0 && v < 100 ? 7 : 0
  const track = Math.max(0, 100 - v - gap * 2)
  return (
    <span className={'pring' + (spin ? ' spin' : '') + (className ? ' ' + className : '')}>
      <svg className="pring-svg" viewBox="0 0 48 48" aria-hidden="true">
        <circle
          className="pring-track"
          cx="24"
          cy="24"
          r="19"
          pathLength={100}
          transform="rotate(-90 24 24)"
          style={{ strokeDasharray: `${track} 100`, strokeDashoffset: -(v + gap) }}
        />
        <path className="pring-wave" d={WAVY_RING} pathLength={100} style={{ strokeDasharray: `${v} 100`, opacity: v > 0 ? 1 : 0 }} />
      </svg>
      {children}
    </span>
  )
}

/** Аватар аккаунта Google, как в Chrome; без входа — значок человека. */
export function AccountButton(): React.JSX.Element {
  const accounts = useStore((s) => s.accounts)
  const a = accounts[0]
  return (
    <button
      className={'ib acc' + (a ? ' on' : '')}
      aria-label={a ? `Аккаунт Google: ${a.email}` : 'Войти в аккаунт Google'}
      title={a ? `${a.name}\n${a.email}` : 'Аккаунты Google'}
      onClick={() => {
        useStore.getState().loadAccounts()
        useStore.getState().setPopover('accounts')
      }}
    >
      {a?.photo ? <img src={a.photo} alt="" referrerPolicy="no-referrer" draggable={false} /> : <Icon name="person" />}
    </button>
  )
}

/** Фавиконка сайта или буква на тональном фоне, если иконки нет. */
export function Fav({
  favicon,
  title,
  url,
  className = '',
  loading = false
}: {
  favicon?: string
  title: string
  url: string
  className?: string
  loading?: boolean
}): React.JSX.Element {
  const [broken, setBroken] = useState<string | null>(null)
  const lightGlyph = useLightGlyph(favicon && broken !== favicon ? favicon : undefined)
  const cls = `fav ${className}${loading ? ' loading' : ''}`
  // Загрузка — индикатор M3 Expressive: фигура за значком перетекает из формы в форму и вращается.
  const loader = loading ? (
    <svg className="fav-load" viewBox="0 0 200 200" aria-hidden="true">
      <path />
    </svg>
  ) : null
  if (favicon && broken !== favicon) {
    return (
      <span className={cls + ' img' + (lightGlyph ? ' dk' : '')}>
        {loader}
        <img src={favicon} alt="" draggable={false} onError={() => setBroken(favicon)} />
      </span>
    )
  }
  return (
    <span className={`${cls} fv${toneOf(hostOf(url) || title)}`}>
      {loader}
      <b className="fav-l">{letterOf(title, url)}</b>
    </span>
  )
}

export function TabFav({ tab, className }: { tab: Tab; className?: string }): React.JSX.Element {
  if (tab.kind === 'settings' || tab.kind === 'addons' || tab.kind === 'passwords' || tab.kind === 'downloads') {
    return (
      <span className={`fav fv4 ${className ?? ''}`}>
        <Icon name={internalIcon[tab.kind]} />
      </span>
    )
  }
  if (tab.kind === 'newtab') {
    return (
      <span className={`fav fv1 ${className ?? ''}`}>
        <Icon name="sparkle" />
      </span>
    )
  }
  return <Fav favicon={tab.favicon} title={tab.title} url={tab.url} className={className} loading={tab.loading} />
}

/**
 * Наведение над элементом, который лежит поверх страницы. Когда курсор уходит с него прямо
 * на страницу во вкладке, окно не получает события ухода мыши и :hover залипает.
 * Поэтому, пока курсор «внутри», сверяемся с его настоящим положением из главного процесса.
 */
export function useHoverOverPage(): [React.RefObject<HTMLDivElement | null>, boolean, () => void] {
  const ref = useRef<HTMLDivElement>(null)
  const [hot, setHot] = useState(false)
  useEffect(() => {
    if (!hot) return
    let alive = true
    const timer = window.setInterval(async () => {
      const el = ref.current
      if (!el) return
      const { x, y } = await window.masaki.cursor()
      const r = el.getBoundingClientRect()
      const pad = 6
      const inside = x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
      if (alive && !inside) setHot(false)
    }, 120)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [hot])
  return [ref, hot, () => setHot(true)]
}

/** Содержимое адресной строки: значок безопасности + адрес, запрос или подсказка. */
export function AddressLabel({ tab }: { tab: Tab }): React.JSX.Element {
  if (tab.kind === 'settings' || tab.kind === 'addons' || tab.kind === 'passwords' || tab.kind === 'downloads') {
    return (
      <>
        <Icon name={internalIcon[tab.kind]} />
        <span className="addr-t">{internalPages[tab.kind].title}</span>
      </>
    )
  }
  if (tab.kind === 'newtab') {
    // Поиск на новой вкладке уже есть на самой странице, здесь только название вкладки.
    return (
      <>
        <Icon name="sparkle" />
        <span className="addr-t dim">Новая вкладка</span>
      </>
    )
  }
  // Страница расширения (параметры, окно мастера): вместо длинного chrome-extension://<id> — её название.
  if (tab.url.startsWith('chrome-extension://')) {
    return (
      <>
        <Icon name="extension" />
        <span className="addr-t">{tab.title || 'Страница расширения'}</span>
      </>
    )
  }
  const query = searchQueryOf(tab.url)
  if (query) {
    return (
      <>
        <Icon name={query.ai ? 'sparkle' : 'search'} />
        <span className="addr-t">{query.q}</span>
      </>
    )
  }
  const secure = tab.url.startsWith('https:')
  const insecure = tab.url.startsWith('http:')
  let rest = ''
  try {
    const u = new URL(tab.url)
    rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash
    try {
      rest = decodeURI(rest)
    } catch {
      // битая последовательность — показываем как есть
    }
  } catch {
    rest = ''
  }
  const host = hostOf(tab.url)
  return (
    <>
      <Icon name={secure ? 'lock' : insecure ? 'warn' : 'globe'} />
      <span className="addr-t">
        {host && host !== tab.url ? (
          <>
            <b>{host}</b>
            <span className="dim">{rest}</span>
          </>
        ) : (
          displayUrl(tab.url)
        )}
      </span>
    </>
  )
}
