import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { handleCommand } from '../actions'
import { commandFor } from '../../../shared/shortcuts'
import { shapes } from '../lib/shapes'
import { applyTokens, paletteFromImage, tokensFor, type PalettePair } from '../lib/theme'
import { captureThumb, takeStageBefore, useStore } from '../store'
import { Dock, ErrorView, FindBar, Popover, Sidebar } from './Chrome'
import { ContextMenu } from './Menu'
import { AddonsPage } from './AddonsPage'
import { PasswordsPage } from './PasswordsPage'
import { AutofillMenu, PasskeySheet, PasswordBar } from './PasswordUi'
import { matchesPanel, syncGlassAll } from '../lib/glass'
import { Grain } from './parts'
import { PermissionBar } from './Permissions'
import { openInputMenu, openPageMenu } from '../menus'
import { NewTab } from './NewTab'
import { Palette } from './Palette'
import { SettingsPage } from './SettingsPage'
import { WebView } from './WebView'
import { Glance, MorphKeyframes, PageProgress, SnapPicker, SplitDivider, SwipeArrow, TabPreview } from './Extras'

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (): void => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

function Background({ wallpaper }: { wallpaper: string | null }): React.JSX.Element {
  return (
    <div className="wall" aria-hidden="true">
      {wallpaper ? (
        <>
          <img className="wall-img" src={wallpaper} alt="" />
          <div className="wall-tint" />
        </>
      ) : (
        <>
          <svg viewBox="0 0 200 200" className="blob b-a">
            <path d={shapes.cookie9} className="s1" />
          </svg>
          <svg viewBox="0 0 200 200" className="blob b-b">
            <path d={shapes.sunny8} className="s3" />
          </svg>
          <svg viewBox="0 0 200 200" className="blob b-c">
            <path d={shapes.clover4} className="s2" />
          </svg>
          <svg viewBox="0 0 200 200" className="blob b-d">
            <path d={shapes.flower6} className="s4" />
          </svg>
        </>
      )}
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <filter id="masaki-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </svg>
    </div>
  )
}

export function App(): React.JSX.Element {
  const booted = useStore((s) => s.booted)
  const settings = useStore((s) => s.settings)
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeId)
  const paletteOpen = useStore((s) => s.palette.open)
  const paletteAnchor = useStore((s) => s.palette.anchor)
  const findOpen = useStore((s) => s.find.open)
  const htmlFullscreen = useStore((s) => s.htmlFullscreen)
  const maximized = useStore((s) => s.winMaximized)
  const split = useStore((s) => s.split)
  const capSmall = useStore((s) => s.capsuleSmall)
  const systemDark = useSystemDark()
  const dark = settings.scheme === 'dark' || (settings.scheme === 'system' && systemDark)
  const [wallpaper, setWallpaper] = useState<string | null>(null)
  const [dynamic, setDynamic] = useState<PalettePair | null>(null)

  useEffect(() => {
    void (async () => {
      const [s, session, history] = await Promise.all([
        window.masaki.settings.get(),
        window.masaki.session.load(),
        window.masaki.history.list()
      ])
      useStore.getState().boot(s, session, history)
      useStore.getState().loadAccounts()
      useStore.setState({ sync: await window.masaki.sync.state() })
    })()
    // Запасной путь для хоткеев: обычно их ловит главный процесс и до окна они не доходят.
    const onKey = (e: KeyboardEvent): void => {
      const c = commandFor({ code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey })
      if (!c) return
      e.preventDefault()
      handleCommand(c)
    }
    window.addEventListener('keydown', onKey)
    // Своё меню для полей ввода интерфейса; у остального интерфейса меню нет.
    const onContext = (e: MouseEvent): void => {
      const t = e.target
      if (e.defaultPrevented) return
      e.preventDefault()
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) openInputMenu(e.clientX, e.clientY, t)
    }
    window.addEventListener('contextmenu', onContext)
    const offs = [
      () => window.removeEventListener('contextmenu', onContext),
      window.masaki.onPageMenu(openPageMenu),
      window.masaki.permissions.onPrompt((p) => useStore.getState().addPermission(p)),
      window.masaki.permissions.onDismiss((id) => useStore.getState().dropPermission(id)),
      () => window.removeEventListener('keydown', onKey),
      window.masaki.onCommand(handleCommand),
      window.masaki.downloads.onUpdate((d) => useStore.getState().upsertDownload(d)),
      window.masaki.win.onState((st) => useStore.setState({ winMaximized: st.maximized })),
      // Синхронизация: пришедшие с Диска настройки и история просто встают в состояние (без отправки обратно).
      window.masaki.settings.onChanged((settings) => useStore.setState({ settings })),
      window.masaki.history.onChanged((history) => useStore.setState({ history })),
      window.masaki.sync.onState((sync) => useStore.setState({ sync })),
      window.masaki.passwords.onOffer((o) =>
        useStore.setState((st) => ({ pwOffers: [...st.pwOffers.filter((x) => x.id !== o.id), o] }))
      ),
      // Панель загрузок открылась сама при скачивании — убираем её, иначе первый клик по плашке уйдёт в неё.
      window.masaki.passwords.onCsv((c) =>
        useStore.setState((st) => ({ pwCsv: [...st.pwCsv, c], popover: st.popover === 'downloads' ? null : st.popover }))
      ),
      window.masaki.passwords.onChanged(() => useStore.setState((st) => ({ pwRev: st.pwRev + 1 }))),
      window.masaki.passkeys.onChanged(() => useStore.setState((st) => ({ pwRev: st.pwRev + 1 }))),
      window.masaki.passkeys.onPrompt((p) => useStore.setState((st) => ({ pkPrompts: [...st.pkPrompts.filter((x) => x.id !== p.id), p] }))),
      window.masaki.passkeys.onPromptClose((id) => useStore.setState((st) => ({ pkPrompts: st.pkPrompts.filter((x) => x.id !== id) })))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Картинка нужна и для фона, и для палитры «из обоев» (Material You, как на Pixel).
  // Своя картинка из файла важнее обоев Windows.
  const wallpaperRev = useStore((s) => s.wallpaperRev)
  const imageSource =
    settings.background === 'custom'
      ? 'custom'
      : settings.background === 'wallpaper' || settings.palette === 'wallpaper'
        ? 'windows'
        : null
  useEffect(() => {
    if (!imageSource) return
    let alive = true
    const load = imageSource === 'custom' ? window.masaki.customWallpaper() : window.masaki.wallpaper()
    void load.then(async (w) => {
      if (!alive) return
      setWallpaper(w)
      setDynamic(w ? await paletteFromImage(w) : null)
    })
    return () => {
      alive = false
    }
  }, [imageSource, wallpaperRev])

  useLayoutEffect(() => {
    applyTokens(document.documentElement, tokensFor(settings.palette, dark, dynamic, settings.customColor))
  }, [settings.palette, settings.customColor, dark, dynamic])

  // Сворачивание панели: страница сразу встаёт на новое место (один пересчёт вёрстки сайта),
  // а плавность даёт сдвиг уже готовой картинки — его считает видеокарта.
  useLayoutEffect(() => {
    const before = takeStageBefore()
    const stage = document.querySelector<HTMLElement>('.stage')
    const app = document.querySelector<HTMLElement>('.app')
    if (!before || !stage || !app) return
    const after = stage.getBoundingClientRect()
    const dx = before.left - after.left
    if (!dx) return
    app.classList.add('animating')
    const anim = stage.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], {
      duration: 520,
      easing: 'cubic-bezier(0.38, 1.21, 0.22, 1)'
    })
    anim.onfinish = anim.oncancel = () => app.classList.remove('animating')
  }, [settings.sidebarCollapsed])

  // Аддон «Прозрачные сайты»: включили, выключили или сменили силу — применяем ко всем вкладкам.
  // В режиме «как у панели» шапки сайтов красятся цветом панели — он меняется вместе с темой.
  const g = settings.addons.glass
  const glassKey = `${g.enabled}|${g.strength}|${g.match}|${g.exclude.join(',')}|${g.match ? `${dark}|${settings.palette}|${settings.customColor}|${dynamic ? 1 : 0}` : ''}`
  useEffect(() => {
    if (booted) syncGlassAll()
  }, [glassKey, booted, dynamic])

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const activeKind = active?.kind
  useEffect(() => {
    if (!activeId) return
    if (activeKind === 'web') {
      const el = document.querySelector<HTMLElement>(`webview[data-tab="${activeId}"]`)
      el?.focus()
    } else {
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      window.focus()
    }
  }, [activeId, activeKind])
  // Архив: раз в 10 минут убираем вкладки, которые давно не открывали (если включено в настройках).
  useEffect(() => {
    const t = window.setInterval(() => useStore.getState().archiveStale(), 10 * 60_000)
    return () => window.clearInterval(t)
  }, [])

  // Снимок активной вкладки для превью — раз в 15 секунд, пока окно в фокусе.
  useEffect(() => {
    const t = window.setInterval(() => {
      const st = useStore.getState()
      if (document.hasFocus() && st.active()?.kind === 'web') captureThumb(st.activeId)
    }, 15_000)
    return () => window.clearInterval(t)
  }, [])

  // Webview рисуем в порядке создания: перестановка узла в DOM перезагрузила бы страницу.
  const webTabs = useMemo(
    () => tabs.filter((t) => t.kind === 'web').sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))),
    [tabs]
  )

  if (!booted || !active) return <div className={'app ' + (dark ? 'dark' : 'light')} />

  const cls = [
    'app',
    dark ? 'dark' : 'light',
    'blur-' + settings.glass,
    settings.sidebarCollapsed ? 'collapsed' : '',
    maximized ? 'max' : '',
    capSmall && settings.sidebarCollapsed ? 'cap-small' : '',
    settings.background !== 'shapes' && wallpaper ? 'wallbg' : '',
    active.kind === 'newtab' ? 'on-ntp' : '',
    paletteOpen ? 'pal-src-' + paletteAnchor : '',
    htmlFullscreen ? 'htmlfs' : ''
  ].join(' ')

  // Две вкладки рядом показываются, только когда активна одна из них.
  const sp = split && (split.a === active.id || split.b === active.id) ? split : null
  const pane = (id: string): 'a' | 'b' | undefined => (sp ? (sp.a === id ? 'a' : sp.b === id ? 'b' : undefined) : undefined)
  // Новая вкладка с картинкой фона: картинка чёткая, как экран блокировки Pixel, а не серое пятно.
  const photo = active.kind === 'newtab' && settings.background !== 'shapes' && wallpaper

  return (
    <div className={cls}>
      <MorphKeyframes />
      <Background wallpaper={settings.background !== 'shapes' ? wallpaper : null} />
      <div className="lay">
        <div className="side-wrap">
          <Sidebar />
        </div>
        <div className="stage">
          <main
            className={
              'card' +
              (active.kind === 'web' ? ' page' : ' glass') +
              (active.kind === 'web' && active.glassBg ? ' glassy' : '') +
              (active.kind === 'web' && matchesPanel(active.glassBg, dark) ? ' match' : '') +
              (photo ? ' photo' : '') +
              (sp ? ' split' : '')
            }
            style={
              active.kind === 'web' && active.glassBg && !matchesPanel(active.glassBg, dark)
                ? ({ '--page-bg': `rgba(${active.glassBg}, ${(100 - settings.addons.glass.opacity) / 100})` } as React.CSSProperties)
                : undefined
            }
          >
            {active.kind === 'web' && matchesPanel(active.glassBg, dark) && <Grain />}
            {webTabs.map((t) => (
              <WebView key={t.id} tab={t} active={t.id === active.id} pane={pane(t.id)} ratio={sp?.ratio ?? 0.5} />
            ))}
            <SplitDivider />
            {active.kind === 'newtab' && <NewTab />}
            {active.kind === 'settings' && <SettingsPage />}
            {active.kind === 'addons' && <AddonsPage />}
            {active.kind === 'passwords' && <PasswordsPage />}
            {active.kind === 'web' && active.error && <ErrorView tab={active} />}
          </main>
          <PageProgress on={active.kind === 'web' && active.loading} />
          <SwipeArrow />
          {findOpen && active.kind === 'web' && <FindBar />}
          <PermissionBar />
          <PasswordBar />
          <PasskeySheet />
          <Dock />
        </div>
      </div>
      {paletteOpen && <Palette />}
      <Glance />
      <TabPreview />
      <SnapPicker />
      <AutofillMenu />
      <Popover />
      <ContextMenu />
    </div>
  )
}
