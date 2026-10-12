import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  closeFind,
  findInPage,
  goBack,
  goForward,
  printPage,
  reloadOrStop,
  toggleDevtools,
  toggleFavorite,
  toggleMute,
  zoom
} from '../actions'
import { shapes } from '../lib/shapes'
import QRCode from 'qrcode'
import { hostOf } from '../lib/url'
import type { ExtAction, ExtensionInfo, TabGroup, UpdateState } from '../../../shared/types'
import { actionFor, actionIcon, badgeColor, pressAction, STORE_URL, togglePin, useExtensions } from '../lib/extensions'
import { useStore, type Tab } from '../store'
import { Icon } from './Icon'
import { AddressLabel, Grain, ShapeTile, TabFav, useHoverOverPage } from './parts'
import { LoadFill, MiniPlayer, WinButtons } from './Extras'
import { openYouCloud } from '../lib/youcloud'
import { syncHint, syncStatusText } from './SyncSection'
import { ProfilesBlock } from './Profiles'
import { openExtMenu, openGroupMenu, openTabMenu, openTileMenu } from '../menus'

/** Есть что сказать об обновлении: скачано и ждёт перезапуска, или вышла версия, которую предлагаем скачать. */
const updateNews = (u: UpdateState | null): boolean => u?.status === 'ready' || u?.status === 'available'

/** Кнопка меню; точка на ней — обновление ждёт (как у Chrome), сам пункт — первым в меню. */
function MenuButton({ className }: { className: string }): React.JSX.Element {
  const news = useStore((s) => updateNews(s.update))
  return (
    <button
      className={className + (news ? ' has-update' : '')}
      aria-label={news ? 'Меню — есть обновление Masaki' : 'Меню'}
      title={news ? 'Меню · есть обновление Masaki' : 'Меню'}
      onClick={() => useStore.getState().setPopover('menu')}
    >
      <Icon name="more" />
    </button>
  )
}

function useActive(): Tab {
  return useStore((s) => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0])
}

/**
 * Адресная капсула: «назад» и «вперёд» живут внутри неё и выезжают пружиной, только когда есть куда
 * идти, — никаких бледных «призраков». Звёздочка видна при наведении или если страница в избранном.
 */
function AddressBar({ where }: { where: 'side' | 'cap' }): React.JSX.Element {
  const t = useActive()
  const fav = useStore((s) => s.settings.favorites.some((f) => f.url === t.url))
  const s = useStore.getState
  const web = t.kind === 'web'
  return (
    <div className={'abar abar-' + where + (t.canBack ? ' can-back' : '') + (t.canFwd ? ' can-fwd' : '')}>
      <LoadFill key={t.id} loading={web && t.loading} />
      <span className="abar-nav">
        <button className="ib an-b" tabIndex={t.canBack ? 0 : -1} aria-hidden={!t.canBack} aria-label="Назад" title="Назад · Alt+←" onClick={goBack}>
          <Icon name="back" />
        </button>
        <button className="ib an-f" tabIndex={t.canFwd ? 0 : -1} aria-hidden={!t.canFwd} aria-label="Вперёд" title="Вперёд · Alt+→" onClick={goForward}>
          <Icon name="forward" />
        </button>
      </span>
      <button className="addr" aria-label="Адрес и поиск" title="Адрес и поиск · Ctrl+L" onClick={() => s().openPalette(true)}>
        {where === 'cap' && <TabFav tab={t} className="addr-fav" />}
        <AddressLabel tab={t} />
      </button>
      {web && (
        <button
          className={'ib a-star' + (fav ? ' on' : '')}
          aria-label={fav ? 'Убрать из избранного' : 'Добавить в избранное'}
          title={fav ? 'Убрать из избранного · Ctrl+D' : 'В избранное · Ctrl+D'}
          onClick={toggleFavorite}
        >
          <Icon name={fav ? 'starFilled' : 'star'} />
        </button>
      )}
      <ExtButtons />
      <button className="ib a-rel" aria-label={t.loading ? 'Остановить' : 'Обновить'} title={t.loading ? 'Остановить' : 'Обновить · Ctrl+R'} disabled={!web} onClick={() => reloadOrStop()}>
        <Icon name={t.loading ? 'close' : 'reload'} />
      </button>
    </div>
  )
}

// ---------- Кнопки расширений ----------

/** Где стояла кнопка «Расширения», когда открыли список: у неё же откроется окно расширения. */
let extAnchor: DOMRect | null = null

function ExtActionButton({ action, tabId, info }: { action: ExtAction; tabId: number; info?: ExtensionInfo }): React.JSX.Element {
  const a = actionFor(action, tabId)
  const name = a.title || info?.name || 'Расширение'
  return (
    <button
      className="ib ext-act"
      aria-label={name}
      title={name}
      onClick={(e) => pressAction(action.id, tabId, e.currentTarget.getBoundingClientRect())}
      onContextMenu={(e) => {
        e.preventDefault()
        openExtMenu(e.clientX, e.clientY, action.id, info)
      }}
    >
      <img src={actionIcon(action.id, tabId, a.iconModified)} alt="" draggable={false} />
      {a.text && (
        <b className="ext-badge" style={{ background: badgeColor(a.color) }}>
          {a.text}
        </b>
      )}
    </button>
  )
}

/** Закреплённые кнопки расширений и «Расширения» со всеми остальными — как справа от адреса в Chrome. */
function ExtButtons(): React.JSX.Element | null {
  const { actions, list, tabId } = useExtensions()
  const pinned = useStore((s) => s.settings.addons.pinnedExtensions)
  const open = useStore((s) => s.popover === 'extensions')
  if (!actions.length) return null
  const shown = pinned.map((id) => actions.find((a) => a.id === id)).filter((a): a is ExtAction => !!a)
  return (
    <span className="a-ext">
      {shown.map((a) => (
        <ExtActionButton key={a.id} action={a} tabId={tabId} info={list.find((x) => x.id === a.id)} />
      ))}
      <button
        className={'ib a-ext-menu' + (open ? ' on' : '')}
        aria-label="Расширения"
        aria-expanded={open}
        title="Расширения"
        onClick={(e) => {
          extAnchor = e.currentTarget.getBoundingClientRect()
          useStore.getState().setPopover(open ? null : 'extensions')
        }}
      >
        <Icon name="extension" />
      </button>
    </span>
  )
}

/** Список расширений у кнопки «Расширения»: открыть, закрепить, перейти к управлению или в магазин. */
function ExtensionsMenu({ close }: { close: () => void }): React.JSX.Element {
  const { actions, list, tabId } = useExtensions()
  const pinned = useStore((s) => s.settings.addons.pinnedExtensions)
  const s = useStore.getState
  return (
    <>
      <div className="pop-h">Расширения</div>
      {actions.map((action) => {
        const info = list.find((x) => x.id === action.id)
        const a = actionFor(action, tabId)
        const on = pinned.includes(action.id)
        const name = info?.name || a.title || action.id
        return (
          <div key={action.id} className="ext-row">
            <button
              className="ext-row-main"
              title={a.title || name}
              onClick={() => {
                close()
                if (extAnchor) pressAction(action.id, tabId, extAnchor)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                openExtMenu(e.clientX, e.clientY, action.id, info)
              }}
            >
              <span className="ext-row-ic">
                <img src={actionIcon(action.id, tabId, a.iconModified)} alt="" draggable={false} />
                {a.text && (
                  <b className="ext-badge" style={{ background: badgeColor(a.color) }}>
                    {a.text}
                  </b>
                )}
              </span>
              <span className="ext-row-t">{name}</span>
            </button>
            <button
              className={'ib ext-pin' + (on ? ' on' : '')}
              aria-label={on ? `Открепить «${name}»` : `Закрепить «${name}» у адреса`}
              aria-pressed={on}
              title={on ? 'Открепить' : 'Закрепить у адреса'}
              onClick={() => togglePin(action.id)}
            >
              <Icon name="pin" />
            </button>
          </div>
        )
      })}
      <div className="cm-sep" />
      <button className="mi" onClick={() => (close(), s().openAddons())}>
        <Icon name="extension" /> Управление расширениями
      </button>
      <button className="mi" onClick={() => (close(), s().newTab(STORE_URL))}>
        <Icon name="openInNew" /> Chrome Web Store
      </button>
    </>
  )
}

/** Место списка расширений: под кнопкой в панели, над ней в доке; не выходит за окно. */
function extPopStyle(): React.CSSProperties | undefined {
  if (!extAnchor) return undefined
  const w = 320
  const left = Math.max(8, Math.min(extAnchor.right - w, window.innerWidth - w - 8))
  return useStore.getState().settings.sidebarCollapsed
    ? { left, right: 'auto', top: 'auto', bottom: window.innerHeight - extAnchor.top + 8, width: w }
    : { left: Math.max(8, Math.min(extAnchor.left - 8, window.innerWidth - w - 8)), right: 'auto', top: extAnchor.bottom + 8, bottom: 'auto', width: w }
}

function DownloadsButton(): React.JSX.Element {
  const downloads = useStore((s) => s.downloads)
  const busy = downloads.filter((d) => d.state === 'progressing')
  const progress = busy.length
    ? busy.reduce((a, d) => a + (d.total ? d.received / d.total : 0), 0) / busy.length
    : 0
  return (
    <button
      className={'ib dl-btn' + (busy.length ? ' busy' : '')}
      aria-label={busy.length ? `Загрузки, идёт ${busy.length}` : 'Загрузки'}
      title="Загрузки"
      onClick={() => useStore.getState().setPopover('downloads')}
      style={{ '--p': progress } as React.CSSProperties}
    >
      <Icon name="download" />
    </button>
  )
}

/** Аккаунт внизу панели: аватар Google и состояние синхронизации вместо голой иконки. */
function AccountChip(): React.JSX.Element {
  const accounts = useStore((s) => s.accounts)
  const sync = useStore((s) => s.sync)
  const profiles = useStore((s) => s.profiles)
  const a = accounts[0]
  const me = profiles.length > 1 ? profiles.find((p) => p.current) : undefined
  const status = sync?.account ? syncStatusText(sync) : a ? a.email : 'в Google'
  // Когда профилей несколько, видно, чьё это окно.
  const sub = me ? `${me.name} · ${status}` : status
  return (
    <button
      className={'achip' + (sync?.status === 'error' || sync?.status === 'signin' ? ' warn' : '')}
      aria-label={a ? `Аккаунт Google: ${a.email}` : 'Войти в аккаунт Google'}
      onClick={() => {
        useStore.getState().loadAccounts()
        useStore.getState().setPopover('accounts')
      }}
    >
      <span className="achip-ava">{a?.photo ? <img src={a.photo} alt="" referrerPolicy="no-referrer" draggable={false} /> : <Icon name="person" />}</span>
      <span className="achip-t">
        <b>{a ? a.name || a.email : 'Войти'}</b>
        <small>{sub}</small>
      </span>
    </button>
  )
}

// ---------- Боковая панель ----------

/** Сколько плиток избранного видно в свёрнутом виде (два ряда по четыре). */
const FAV_SHOWN = 8

function GroupHeader({ group, count }: { group: TabGroup; count: number }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const s = useStore.getState
  return (
    <div
      className={'grp' + (group.collapsed ? ' closed' : '')}
      style={{ '--gc': group.color } as React.CSSProperties}
      onContextMenu={(e) => {
        e.preventDefault()
        openGroupMenu(e.clientX, e.clientY, group.id, () => setEditing(true))
      }}
    >
      {editing ? (
        <input
          className="grp-in"
          defaultValue={group.name}
          autoFocus
          aria-label="Название группы"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            s().updateGroup(group.id, { name: e.currentTarget.value.trim() || group.name })
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <button
          className="grp-main"
          aria-expanded={!group.collapsed}
          title="Свернуть или развернуть · двойной щелчок — переименовать"
          onClick={() => s().updateGroup(group.id, { collapsed: !group.collapsed })}
          onDoubleClick={() => setEditing(true)}
        >
          <i className="grp-dot" />
          <span className="grp-name">{group.name}</span>
          <span className="grp-n">{count}</span>
          <Icon name="down" className="grp-chev" />
        </button>
      )}
    </div>
  )
}

function TabList(): React.JSX.Element {
  // Перетаскивание вкладок: куда встанет вкладка (индекс «перед кем»).
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null)
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeId)
  const groups = useStore((s) => s.groups)
  const split = useStore((s) => s.split)
  const s = useStore.getState
  const hover = useRef<number | undefined>(undefined)

  const rows: React.JSX.Element[] = []
  let prev: string | undefined
  tabs.forEach((tab, idx) => {
    const g = tab.group ? groups.find((x) => x.id === tab.group) : undefined
    if (g && tab.group !== prev) rows.push(<GroupHeader key={'g-' + g.id + '-' + idx} group={g} count={tabs.filter((t) => t.group === g.id).length} />)
    prev = tab.group
    if (g?.collapsed) return
    const inSplit = !!split && (split.a === tab.id || split.b === tab.id)
    rows.push(
      <div
        key={tab.id}
        className={
          'tab' +
          (tab.id === activeId ? ' on' : '') +
          (g ? ' in-grp' : '') +
          (inSplit ? ' in-split' : '') +
          (drag?.id === tab.id ? ' dragging' : '') +
          (drag && drag.over === idx && drag.id !== tab.id ? ' drop-above' : '') +
          (drag && drag.over === tabs.length && idx === tabs.length - 1 ? ' drop-below' : '')
        }
        style={g ? ({ '--gc': g.color } as React.CSSProperties) : undefined}
        draggable
        onDragStart={(e) => {
          window.clearTimeout(hover.current)
          useStore.setState({ preview: null })
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/uri-list', tab.url)
          setDrag({ id: tab.id, over: idx })
        }}
        onDragOver={(e) => {
          if (!drag) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          const over = idx + (e.clientY > r.top + r.height / 2 ? 1 : 0)
          if (over !== drag.over) setDrag({ ...drag, over })
        }}
        onDrop={(e) => {
          e.preventDefault()
          if (drag) s().moveTab(drag.id, drag.over)
          setDrag(null)
        }}
        onDragEnd={() => setDrag(null)}
        onMouseEnter={(e) => {
          window.clearTimeout(hover.current)
          if (tab.id === activeId || tab.kind !== 'web') return
          const r = e.currentTarget.getBoundingClientRect()
          hover.current = window.setTimeout(() => useStore.setState({ preview: { tabId: tab.id, x: r.right + 14, y: r.top } }), 650)
        }}
        onMouseLeave={() => {
          window.clearTimeout(hover.current)
          if (useStore.getState().preview) useStore.setState({ preview: null })
        }}
        onAuxClick={(e) => e.button === 1 && s().closeTab(tab.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          window.clearTimeout(hover.current)
          openTabMenu(e.clientX, e.clientY, tab.id)
        }}
      >
        <button className="tab-main" title={tab.title} onClick={() => s().activate(tab.id)}>
          <TabFav tab={tab} />
          <span className="tt">{tab.title || hostOf(tab.url)}</span>
        </button>
        {(tab.audible || tab.muted) && (
          <button className="ib aud" aria-label={tab.muted ? 'Включить звук' : 'Выключить звук'} onClick={() => toggleMute(tab.id)}>
            <Icon name={tab.muted ? 'volumeOff' : 'volume'} />
          </button>
        )}
        <button className="ib x" aria-label={`Закрыть вкладку «${tab.title}»`} onClick={() => s().closeTab(tab.id)}>
          <Icon name="close" />
        </button>
      </div>
    )
  })
  return <div className="tablist">{rows}</div>
}

export function Sidebar(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const favorites = useStore((s) => s.settings.favorites)
  // Избранного может быть много (например, после переноса закладок): сначала видны два ряда.
  const [allFavs, setAllFavs] = useState(false)
  const more = favorites.length > FAV_SHOWN
  const shownFavs = more && !allFavs ? favorites.slice(0, FAV_SHOWN - 1) : favorites
  const s = useStore.getState

  return (
    <aside className="glass side" aria-label="Боковая панель">
      <Grain />
      <div className="side-top" title="Двойной щелчок — развернуть окно, тянуть — двигать">
        <span className="brand" aria-hidden="true">
          <svg viewBox="0 0 200 200">
            <path d={shapes.cookie9} />
          </svg>
          Masaki
        </span>
        <div className="sp" />
        <button className="ib wb" aria-label="Свернуть панель" title="Свернуть панель · Ctrl+B" onClick={() => s().toggleSidebar()}>
          <Icon name="sidebar" />
        </button>
        <span className="wsep" />
        <WinButtons />
      </div>

      <AddressBar where="side" />

      {favorites.length > 0 && (
        <div className={'favs' + (allFavs ? ' all' : '')}>
          {shownFavs.map((f, i) => (
            <button
              key={f.url + i}
              className="fvt"
              title={f.title}
              aria-label={f.title}
              onClick={() => s().navigate(f.url, { raw: true })}
              onContextMenu={(e) => {
                e.preventDefault()
                openTileMenu(e.clientX, e.clientY, 'favorites', i)
              }}
            >
              <ShapeTile item={f} index={i} />
            </button>
          ))}
          {more && (
            <button
              className="fvt fvt-more"
              title={allFavs ? 'Свернуть избранное' : `Ещё ${favorites.length - shownFavs.length}`}
              aria-label={allFavs ? 'Свернуть избранное' : `Показать всё избранное, ещё ${favorites.length - shownFavs.length}`}
              aria-expanded={allFavs}
              onClick={() => setAllFavs(!allFavs)}
            >
              <span className="fvt-more-in">{allFavs ? <Icon name="up" /> : '+' + (favorites.length - shownFavs.length)}</span>
            </button>
          )}
        </div>
      )}

      <div className="lbl-row">
        <span className="lbl">Вкладки · {tabs.length}</span>
        <button className="lbl-add" aria-label="Новая вкладка" title="Новая вкладка · Ctrl+T" onClick={() => s().newTab()}>
          <Icon name="add" />
        </button>
      </div>
      <TabList />

      <MiniPlayer />
      <div className="side-bottom">
        <AccountChip />
        <DownloadsButton />
        <button className="ib" aria-label="История" title="История · Ctrl+H, поиск по вкладкам · Ctrl+Shift+A" onClick={() => s().openPalette(false)}>
          <Icon name="history" />
        </button>
        <MenuButton className="ib" />
      </div>
    </aside>
  )
}

// ---------- Док (когда боковая свёрнута) ----------

/** Шаг вкладки-значка: кнопка 40 px и промежуток 4 px. */
const DK_STEP = 44
/** Поля острова вкладок (отступы и рамка), кнопка «+» с промежутком, «ещё N» с промежутком. */
const DK_PAD = 14
const DK_ADD = 44
const DK_MORE = 60
/** Вкладка с названием не уже этого — иначе названия не прочесть, и остров переходит на значки. */
const DK_TITLED_MIN = 150
/** В сжатом доке (страницу листают вниз): значки 22 px через 6 px, без «+». */
const DK_TINY_STEP = 28

/**
 * Вкладки дока — слева от капсулы, в свободном месте, а не над страницей. Сколько влезает, решает
 * ширина колонки: просторно — с названиями, тесно — значками, совсем тесно — значки вокруг активной
 * и «ещё N» со списком всех вкладок. Колесо над островом сдвигает видимое окно.
 */
function DockTabs({ tiny, hot }: { tiny: boolean; hot: boolean }): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeId)
  const groups = useStore((s) => s.groups)
  const listOpen = useStore((s) => s.popover === 'tabs')
  const s = useStore.getState
  const box = useRef<HTMLDivElement>(null)
  const hover = useRef<number | undefined>(undefined)
  const wheel = useRef(0)
  const [room, setRoom] = useState(0)
  const [start, setStart] = useState(0)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setRoom(el.clientWidth))
    ro.observe(el)
    setRoom(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const n = tabs.length
  const titledW = Math.floor((room - DK_PAD - DK_ADD) / Math.max(1, n)) - 4
  const titled = !tiny && titledW >= DK_TITLED_MIN
  const step = tiny ? DK_TINY_STEP : DK_STEP
  const free = room - DK_PAD - (tiny ? 0 : DK_ADD)
  const all = titled || Math.floor(free / step) >= n
  const fit = all ? n : Math.max(1, Math.floor((free - DK_MORE) / step))
  const from = Math.min(Math.max(0, start), Math.max(0, n - fit))
  const ai = tabs.findIndex((t) => t.id === activeId)

  // Переключились на скрытую вкладку — окно доезжает до неё; колесом активную можно и увести из виду.
  useEffect(() => {
    if (ai < 0) return
    setStart((st) => (ai < st ? ai : ai >= st + fit ? ai - fit + 1 : st))
  }, [ai, fit])
  // Курсор ушёл с дока (в том числе прямо на страницу) — превью вкладки не должно остаться висеть.
  useEffect(() => {
    if (hot) return
    window.clearTimeout(hover.current)
    if (useStore.getState().preview?.above) useStore.setState({ preview: null })
  }, [hot])

  const shown = all ? tabs : tabs.slice(from, from + fit)
  return (
    <div className="dk-left" ref={box}>
      <div
        className={'glass dk-tabs' + (titled ? ' titled' : '')}
        style={titled ? ({ '--dk-tw': Math.min(220, titledW) + 'px' } as React.CSSProperties) : undefined}
        role="tablist"
        aria-label="Вкладки"
        onWheel={(e) => {
          if (all) return
          // Тачпад шлёт много мелких шагов — копим, чтобы окно не пролетало мимо.
          wheel.current += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
          if (Math.abs(wheel.current) < 50) return
          const d = wheel.current > 0 ? 1 : -1
          wheel.current = 0
          setStart(Math.min(Math.max(0, from + d), n - fit))
        }}
      >
        <Grain />
        {shown.map((tab) => {
          const g = tab.group ? groups.find((x) => x.id === tab.group) : undefined
          const name = tab.title || hostOf(tab.url)
          return (
            <div
              key={tab.id}
              className={'dk-t' + (tab.id === activeId ? ' on' : '')}
              style={g ? ({ '--gc': g.color } as React.CSSProperties) : undefined}
              role="tab"
              aria-selected={tab.id === activeId}
              onAuxClick={(e) => e.button === 1 && s().closeTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                window.clearTimeout(hover.current)
                openTabMenu(e.clientX, e.clientY, tab.id)
              }}
              onMouseEnter={(e) => {
                window.clearTimeout(hover.current)
                if (tiny || tab.id === activeId || tab.kind !== 'web') return
                const r = e.currentTarget.getBoundingClientRect()
                hover.current = window.setTimeout(
                  () => useStore.setState({ preview: { tabId: tab.id, x: r.left + r.width / 2, y: r.top, above: true } }),
                  650
                )
              }}
              onMouseLeave={() => {
                window.clearTimeout(hover.current)
                if (useStore.getState().preview) useStore.setState({ preview: null })
              }}
            >
              <button className="dk-main" title={name} aria-label={name} onClick={() => s().activate(tab.id)}>
                <TabFav tab={tab} />
                {titled && <span className="dk-tt">{name}</span>}
              </button>
              {titled && (
                <button className="dk-x" aria-label={`Закрыть вкладку «${name}»`} onClick={() => s().closeTab(tab.id)}>
                  <Icon name="close" />
                </button>
              )}
              {g && <i className="dk-g" />}
            </div>
          )
        })}
        {!all && (
          <button
            className={'dk-more' + (listOpen ? ' on' : '')}
            aria-label={`Все вкладки, скрыто ${n - fit}`}
            aria-expanded={listOpen}
            title="Все вкладки"
            onClick={() => s().setPopover(listOpen ? null : 'tabs')}
          >
            +{n - fit}
          </button>
        )}
        <button className="ib dk-add" aria-label="Новая вкладка" title="Новая вкладка · Ctrl+T" onClick={() => s().newTab()}>
          <Icon name="add" />
        </button>
      </div>
    </div>
  )
}

/**
 * Док вместо боковой панели (вариант A редизайна дока): вкладки слева, капсула с адресом по центру,
 * плеер справа — всё в свободном месте и видно сразу. Пока страницу листают вниз, док худеет целиком;
 * наведи — вернётся.
 */
export function Dock(): React.JSX.Element {
  const small = useStore((st) => st.capsuleSmall)
  const [ref, hot, enter] = useHoverOverPage()
  const s = useStore.getState
  const tiny = small && !hot
  return (
    <div ref={ref} className={'capz' + (tiny ? ' small' : '')} onPointerEnter={enter} onPointerMove={hot ? undefined : enter}>
      <DockTabs tiny={tiny} hot={hot} />
      <div className="glass capsule">
        <Grain />
        <button className="ib cap-side" aria-label="Показать панель" title="Показать панель · Ctrl+B" onClick={() => s().toggleSidebar()}>
          <Icon name="sidebar" />
        </button>
        <AddressBar where="cap" />
        <MenuButton className="ib cap-more" />
        <span className="vdiv cap-div" />
        <WinButtons className="cap-w" />
      </div>
      <div className="dk-right">
        <MiniPlayer dock />
      </div>
    </div>
  )
}

/** Все вкладки дока («ещё N»): поиск и список; Enter открывает первую найденную. */
function TabsList({ close }: { close: () => void }): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeId)
  const [q, setQ] = useState('')
  const s = useStore.getState
  const needle = q.trim().toLowerCase()
  const list = needle ? tabs.filter((t) => (t.title + ' ' + t.url).toLowerCase().includes(needle)) : tabs
  const pick = (id: string): void => {
    close()
    s().activate(id)
  }
  return (
    <>
      <label className="dkl-q">
        <Icon name="search" />
        <input
          autoFocus
          value={q}
          placeholder={`Найти среди ${tabs.length} вкладок`}
          aria-label="Найти вкладку"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list[0]) pick(list[0].id)
            if (e.key === 'Escape') close()
          }}
        />
      </label>
      <div className="dkl-list">
        {list.map((t) => (
          <div key={t.id} className={'dkl-row' + (t.id === activeId ? ' on' : '')} onAuxClick={(e) => e.button === 1 && s().closeTab(t.id)}>
            <button className="dkl-main" title={t.title} onClick={() => pick(t.id)}>
              <TabFav tab={t} />
              <span className="dkl-t">{t.title || hostOf(t.url)}</span>
            </button>
            <button className="ib dkl-x" aria-label={`Закрыть вкладку «${t.title}»`} onClick={() => s().closeTab(t.id)}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        {!list.length && <div className="pop-empty">Ничего не нашлось</div>}
      </div>
    </>
  )
}

// ---------- Всплывающие меню ----------

function formatBytes(n: number): string {
  if (n < 1024) return n + ' Б'
  if (n < 1024 ** 2) return (n / 1024).toFixed(0) + ' КБ'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' МБ'
  return (n / 1024 ** 3).toFixed(2) + ' ГБ'
}

export function Popover(): React.JSX.Element | null {
  const popover = useStore((s) => s.popover)
  const downloads = useStore((s) => s.downloads)
  const accounts = useStore((s) => s.accounts)
  const syncSt = useStore((s) => s.sync)
  const qrUrl = useStore((s) => s.qrUrl)
  const update = useStore((s) => s.update)
  const t = useActive()
  const s = useStore.getState
  if (!popover) return null
  const close = (): void => s().setPopover(null)
  const run = (fn: () => void) => () => {
    close()
    fn()
  }

  return (
    <>
      <button className="pop-scrim" aria-label="Закрыть меню" onClick={close} />
      <div className={'glass pop ' + popover} role="menu" style={popover === 'extensions' ? extPopStyle() : undefined}>
        <Grain />
        {popover === 'qr' ? (
          <QrCode url={qrUrl} />
        ) : popover === 'tabs' ? (
          <TabsList close={close} />
        ) : popover === 'extensions' ? (
          <ExtensionsMenu close={close} />
        ) : popover === 'accounts' ? (
          <>
            <div className="pop-h">Аккаунты Google</div>
            {accounts.length === 0 && (
              <div className="pop-empty">Вы не вошли. После входа Gmail, YouTube и AI Mode будут знать вас.</div>
            )}
            {accounts.map((a) => (
              <button
                key={a.email}
                className="acc-row"
                onClick={run(() => s().newTab(`https://myaccount.google.com/?authuser=${a.index}`))}
              >
                {a.photo ? <img src={a.photo} alt="" referrerPolicy="no-referrer" /> : <span className="acc-ph"><Icon name="person" /></span>}
                <span className="acc-t">
                  <b>{a.name || a.email}</b>
                  <small>{a.email}</small>
                </span>
                <Icon name="openInNew" />
              </button>
            ))}
            <div className="cm-sep" />
            <button
              className="mi"
              onClick={run(() =>
                s().newTab(
                  accounts.length
                    ? 'https://accounts.google.com/AddSession?continue=https%3A%2F%2Fwww.google.com%2F'
                    : 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2F'
                )
              )}
            >
              <Icon name="personAdd" /> {accounts.length ? 'Добавить аккаунт' : 'Войти в аккаунт Google'}
            </button>
            {accounts.length > 0 && (
              <button className="mi" onClick={run(() => s().newTab('https://accounts.google.com/Logout'))}>
                <Icon name="logout" /> Выйти из всех аккаунтов
              </button>
            )}
            <div className="cm-sep" />
            <ProfilesBlock close={close} />
            <div className="cm-sep" />
            <button
              className={'mi sy-mi ' + (syncSt?.status ?? '')}
              title={syncSt?.account ? 'Аккаунт синхронизации: ' + syncSt.account.email : undefined}
              onClick={run(() => {
                // Ключ уже есть (встроенный или свой) — настраивать нечего — сразу вход; итог (и ошибки) покажут настройки.
                if (syncSt && !syncSt.account && (syncSt.client || syncSt.builtinKey) && syncSt.status !== 'waiting') {
                  void window.masaki.sync.signIn(false, syncHint(accounts))
                } else s().openSettings()
              })}
            >
              <Icon name={syncSt?.status === 'error' || syncSt?.status === 'signin' ? 'warn' : 'sync'} />
              <span className="sy-mi-t">
                {syncSt?.account ? 'Синхронизация' : 'Включить синхронизацию'}
                <small>{syncSt?.account ? syncStatusText(syncSt) : 'Избранное, история и вкладки на всех компьютерах'}</small>
              </span>
            </button>
          </>
        ) : popover === 'downloads' ? (
          <>
            <div className="pop-h">Загрузки</div>
            {downloads.length === 0 && <div className="pop-empty">Пока ничего не скачано</div>}
            {downloads.map((d) => (
              <div
                key={d.id}
                className="dl"
                draggable={d.state === 'completed'}
                title={d.state === 'completed' ? 'Открыть · можно перетащить в папку или на сайт' : undefined}
                onDragStart={(e) => {
                  // Файл перетаскивает сама система — в проводник, мессенджер или на сайт.
                  e.preventDefault()
                  window.masaki.downloads.drag(d.path)
                }}
              >
                <button className="dl-main" onClick={() => d.state === 'completed' && window.masaki.downloads.open(d.path)}>
                  <span className="dl-name">{d.filename}</span>
                  <span className="dl-sub">
                    {d.state === 'progressing'
                      ? `${formatBytes(d.received)}${d.total ? ' из ' + formatBytes(d.total) : ''}`
                      : d.state === 'completed'
                        ? formatBytes(d.total || d.received) + ' · готово'
                        : d.state === 'cancelled'
                          ? 'Отменено'
                          : 'Прервано'}
                  </span>
                  {d.state === 'progressing' && (
                    <span className="dl-bar">
                      <span style={{ width: `${d.total ? (d.received / d.total) * 100 : 30}%` }} />
                    </span>
                  )}
                </button>
                <button className="ib" aria-label="Показать в папке" onClick={() => window.masaki.downloads.showInFolder(d.path)}>
                  <Icon name="folder" />
                </button>
              </div>
            ))}
          </>
        ) : (
          <>
            {update && updateNews(update) && (
              <>
                <button className="mi sy-mi upd-mi" onClick={run(() => window.masaki.update.install())}>
                  <Icon name="update" />
                  <span className="sy-mi-t">
                    {update.status === 'ready' ? 'Обновить Masaki' : `Доступна версия ${update.version}`}
                    <small>{update.status === 'ready' ? `Версия ${update.version} — перезапуск, вкладки вернутся` : 'Скачать с GitHub'}</small>
                  </span>
                </button>
                <div className="cm-sep" />
              </>
            )}
            <button className="mi" onClick={run(() => s().newTab())}>
              <Icon name="add" /> Новая вкладка <span className="kbd">Ctrl T</span>
            </button>
            <button className="mi" disabled={t.kind !== 'web'} onClick={run(() => s().setFind({ open: true, focusTick: s().find.focusTick + 1 }))}>
              <Icon name="search" /> Найти на странице <span className="kbd">Ctrl F</span>
            </button>
            <div className="mi zoom-row">
              <span className="mi-l">Масштаб</span>
              <button className="ib" aria-label="Уменьшить" disabled={t.kind !== 'web'} onClick={() => zoom(-1)}>
                <Icon name="zoomOut" />
              </button>
              <span className="zoom-v">{Math.round(Math.pow(1.2, t.zoom) * 100)}%</span>
              <button className="ib" aria-label="Увеличить" disabled={t.kind !== 'web'} onClick={() => zoom(1)}>
                <Icon name="zoomIn" />
              </button>
            </div>
            <button className="mi" onClick={run(() => s().setPopover('downloads'))}>
              <Icon name="download" /> Загрузки <span className="kbd">Ctrl J</span>
            </button>
            <button className="mi" disabled={t.kind !== 'web'} onClick={run(printPage)}>
              <Icon name="print" /> Печать <span className="kbd">Ctrl P</span>
            </button>
            <button className="mi" disabled={t.kind !== 'web'} onClick={run(toggleDevtools)}>
              <Icon name="code" /> Инструменты разработчика <span className="kbd">F12</span>
            </button>
            <button className="mi" onClick={run(() => openYouCloud())}>
              <Icon name="music" /> YouCloud
            </button>
            <button className="mi" onClick={run(() => s().openPasswords())}>
              <Icon name="key" /> Пароли
            </button>
            <button className="mi" onClick={run(() => s().openTabSearch())}>
              <Icon name="tab" /> Поиск по вкладкам <span className="kbd">Ctrl Shift A</span>
            </button>
            <button className="mi" onClick={run(() => s().openAddons())}>
              <Icon name="extension" /> Аддоны
            </button>
            <button className="mi" onClick={run(() => s().openSettings())}>
              <Icon name="settings" /> Настройки <span className="kbd">Ctrl ,</span>
            </button>
          </>
        )}
      </div>
    </>
  )
}

/** QR-код адреса страницы — как «Создать QR-код» в Chrome. */
function QrCode({ url }: { url: string }): React.JSX.Element {
  const [src, setSrc] = useState('')
  useEffect(() => {
    void QRCode.toDataURL(url, { margin: 1, width: 560, color: { dark: '#1d1b20', light: '#ffffff' } }).then(setSrc)
  }, [url])
  return (
    <>
      <div className="pop-h">QR-код страницы</div>
      <div className="qr-box">{src && <img src={src} alt={`QR-код для ${url}`} />}</div>
      <div className="qr-url">{url}</div>
      <button
        className="mi"
        onClick={() => {
          const a = document.createElement('a')
          a.href = src
          a.download = 'qr-код.png'
          a.click()
        }}
      >
        <Icon name="download" /> Скачать картинку
      </button>
    </>
  )
}

// ---------- Поиск на странице ----------

export function FindBar(): React.JSX.Element {
  const find = useStore((s) => s.find)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [find.focusTick])
  return (
    <div className="glass findbar">
      <Grain />
      <Icon name="search" />
      <input
        ref={input}
        value={find.text}
        placeholder="Найти на странице"
        aria-label="Найти на странице"
        onChange={(e) => {
          useStore.getState().setFind({ text: e.target.value })
          findInPage(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') findInPage(find.text, !e.shiftKey, true)
          if (e.key === 'Escape') closeFind()
        }}
      />
      <span className="find-n">{find.text ? `${find.active}/${find.matches}` : ''}</span>
      <button className="ib" aria-label="Предыдущее" onClick={() => findInPage(find.text, false, true)}>
        <Icon name="up" />
      </button>
      <button className="ib" aria-label="Следующее" onClick={() => findInPage(find.text, true, true)}>
        <Icon name="down" />
      </button>
      <button className="ib" aria-label="Закрыть поиск" onClick={closeFind}>
        <Icon name="close" />
      </button>
    </div>
  )
}

// ---------- Ошибка загрузки ----------

export function ErrorView({ tab }: { tab: Tab }): React.JSX.Element {
  const e = tab.error!
  const offline = e.code === -106
  return (
    <div className="err">
      <div className="glass err-card">
        <Grain />
        <svg viewBox="0 0 200 200" className="err-shape">
          <path d={shapes.clover4} />
        </svg>
        <h2>{offline ? 'Нет подключения к интернету' : 'Не удалось открыть страницу'}</h2>
        <p>
          <b>{hostOf(e.url)}</b> — {e.desc || 'неизвестная ошибка'}
        </p>
        <button className="tonal" onClick={() => reloadOrStop()}>
          <Icon name="reload" /> Повторить
        </button>
      </div>
    </div>
  )
}
