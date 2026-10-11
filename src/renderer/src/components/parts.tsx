import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Shortcut } from '../../../shared/types'
import { useSiteIcon } from '../lib/iconColor'
import { isShape, shapeCycle, shapes } from '../lib/shapes'
import { displayUrl, hostOf, letterOf, searchQueryOf } from '../lib/url'
import { internalPages, type Tab, useStore } from '../store'
import { Icon } from './Icon'

/** Матовое зерно поверх стекла. */

const internalIcon = { settings: 'settings', addons: 'extension', passwords: 'key' } as const

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
export function ShapeTile({ item, index }: { item: Shortcut; index: number }): React.JSX.Element {
  const { src, colors } = useSiteIcon(item.url, item.color)
  // Картинка, которую не удалось показать, — не пустой кружок, а буква, как без значка.
  const [bad, setBad] = useState<string | null>(null)
  const shape = isShape(item.shape) ? item.shape : shapeCycle[index % shapeCycle.length]
  const vars = colors
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
    <span className="tile" style={vars}>
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
  const cls = `fav ${className}${loading ? ' loading' : ''}`
  // Загрузка — индикатор M3 Expressive: фигура за значком перетекает из формы в форму и вращается.
  const loader = loading ? (
    <svg className="fav-load" viewBox="0 0 200 200" aria-hidden="true">
      <path />
    </svg>
  ) : null
  if (favicon && broken !== favicon) {
    return (
      <span className={cls + ' img'}>
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
  if (tab.kind === 'settings' || tab.kind === 'addons' || tab.kind === 'passwords') {
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
  if (tab.kind === 'settings' || tab.kind === 'addons' || tab.kind === 'passwords') {
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
