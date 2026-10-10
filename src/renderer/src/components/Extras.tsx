import { createElement, useEffect, useRef, useState } from 'react'
import { goBack, goForward } from '../actions'
import { shapes, wavePath } from '../lib/shapes'
import { hostOf } from '../lib/url'
import { useStore, wv } from '../store'
import { Icon } from './Icon'
import { Grain, TabFav } from './parts'

const S = useStore.getState

// ---------- Кнопки окна и свои раскладки ----------

/** Кнопки окна: в шапке боковой панели или в конце капсулы. Задержка на «развернуть» — раскладки. */
export function WinButtons({ className = '' }: { className?: string }): React.JSX.Element {
  const maximized = useStore((s) => s.winMaximized)
  const timer = useRef<number | undefined>(undefined)
  const showSnap = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    const below = r.top < window.innerHeight / 2
    useStore.setState({ snap: { x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8 } })
  }
  return (
    <span className={'wbtns ' + className}>
      <button className="ib wb" aria-label="Свернуть окно" title="Свернуть" onClick={() => window.masaki.win.minimize()}>
        <Icon name="minimize" />
      </button>
      <button
        className="ib wb"
        aria-label={maximized ? 'Восстановить окно' : 'Развернуть окно'}
        title={maximized ? 'Восстановить · подержи курсор — раскладки' : 'Развернуть · подержи курсор — раскладки'}
        onClick={() => {
          window.clearTimeout(timer.current)
          window.masaki.win.toggleMaximize()
        }}
        onPointerEnter={(e) => {
          const el = e.currentTarget
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => showSnap(el), 550)
        }}
        onPointerLeave={() => window.clearTimeout(timer.current)}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} />
      </button>
      <button className="ib wb wb-x" aria-label="Закрыть окно" title="Закрыть" onClick={() => window.masaki.win.close()}>
        <Icon name="close" />
      </button>
    </span>
  )
}

type Zone = [number, number, number, number]
const layouts: Zone[][] = [
  [
    [0, 0, 0.5, 1],
    [0.5, 0, 0.5, 1]
  ],
  [
    [0, 0, 2 / 3, 1],
    [2 / 3, 0, 1 / 3, 1]
  ],
  [
    [0, 0, 1 / 3, 1],
    [1 / 3, 0, 1 / 3, 1],
    [2 / 3, 0, 1 / 3, 1]
  ],
  [
    [0, 0, 0.5, 0.5],
    [0.5, 0, 0.5, 0.5],
    [0, 0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5, 0.5]
  ]
]

/** Свои раскладки окна в стиле Masaki: у самодельных кнопок Windows свои Snap Layouts не показывает. */
export function SnapPicker(): React.JSX.Element | null {
  const snap = useStore((s) => s.snap)
  const close = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!snap) return
    // Курсор так и не зашёл на раскладки — убираем их.
    close.current = window.setTimeout(() => useStore.setState({ snap: null }), 1600)
    return () => window.clearTimeout(close.current)
  }, [snap])
  if (!snap) return null
  const width = 300
  const left = Math.min(Math.max(8, snap.x - width / 2), window.innerWidth - width - 8)
  const below = snap.y < window.innerHeight / 2
  return (
    <div
      className="glass snap"
      style={below ? { left, top: snap.y, width } : { left, bottom: window.innerHeight - snap.y, width }}
      role="menu"
      aria-label="Раскладка окна"
      onPointerEnter={() => window.clearTimeout(close.current)}
      onPointerLeave={() => {
        close.current = window.setTimeout(() => useStore.setState({ snap: null }), 250)
      }}
    >
      <Grain />
      <span className="snap-h">Раскладка окна</span>
      <div className="snap-grid">
        {layouts.map((zones, i) => (
          <div key={i} className="snap-l">
            {zones.map(([x, y, w, h], j) => (
              <button
                key={j}
                className="snap-z"
                aria-label={`Раскладка ${i + 1}, часть ${j + 1}`}
                style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
                onClick={() => {
                  window.masaki.win.snap({ x, y, w, h })
                  useStore.setState({ snap: null })
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- Превью вкладки ----------

function ago(t?: number): string {
  if (!t) return ''
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'только что'
  if (m < 60) return `в фоне ${m} мин`
  const h = Math.round(m / 60)
  return h < 24 ? `в фоне ${h} ч` : `в фоне ${Math.round(h / 24)} дн`
}

export function TabPreview(): React.JSX.Element | null {
  const preview = useStore((s) => s.preview)
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.preview?.tabId))
  const thumb = useStore((s) => (s.preview ? s.thumbs[s.preview.tabId] : undefined))
  if (!preview || !tab) return null
  const top = Math.min(Math.max(8, preview.y - 40), window.innerHeight - 250)
  return (
    <div className="glass tprev" style={{ left: preview.x, top }} aria-hidden="true">
      <Grain />
      <div className="tprev-img">
        {thumb ? <img src={thumb} alt="" draggable={false} /> : <TabFav tab={tab} className="tprev-fav" />}
      </div>
      <div className="tprev-t">
        <b>{tab.title || hostOf(tab.url)}</b>
        <small>
          {hostOf(tab.url)}
          {tab.audible ? ' · играет звук' : tab.lastActive ? ' · ' + ago(tab.lastActive) : ''}
        </small>
      </div>
    </div>
  )
}

// ---------- Мини-плеер ----------

const PAUSE_JS = `(() => { for (const m of document.querySelectorAll('video, audio')) if (!m.paused) { m.dataset.masakiPaused = '1'; m.pause() } })()`
const PLAY_JS = `(() => { const list = document.querySelectorAll('[data-masaki-paused]'); for (const m of list) { delete m.dataset.masakiPaused; m.play() } if (!list.length) { const m = document.querySelector('video, audio'); if (m) m.play() } })()`

function useBackgroundAudio() {
  const tab = useStore((s) => s.tabs.find((t) => t.id !== s.activeId && t.kind === 'web' && (t.audible || t.pausedByUs)))
  const playing = !!tab && tab.audible && !tab.pausedByUs
  const toggle = (): void => {
    if (!tab) return
    const el = wv(tab.id)
    if (!el) return
    void el.executeJavaScript(playing ? PAUSE_JS : PLAY_JS, true).catch(() => undefined)
    S().updateTab(tab.id, { pausedByUs: playing })
  }
  return { tab, playing, toggle }
}

const placeOf = (url: string): string => (url.startsWith('file:') ? 'файл на компьютере' : hostOf(url))

/** Звук в фоновой вкладке: название и пауза прямо в панели, не надо искать, где играет. */
export function MiniPlayer({ compact = false }: { compact?: boolean }): React.JSX.Element | null {
  const { tab, playing, toggle } = useBackgroundAudio()
  if (!tab) return null
  return (
    <div className={'mplayer' + (compact ? ' compact' : '') + (playing ? ' playing' : '')}>
      <button className="mp-main" title="Перейти на вкладку" onClick={() => S().activate(tab.id)}>
        <TabFav tab={tab} />
        <span className="mp-t">
          <b>{tab.title || hostOf(tab.url)}</b>
          <small>
            <span className="eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {playing ? 'играет' : 'пауза'} · {placeOf(tab.url)}
          </small>
        </span>
      </button>
      <button className="mp-btn" aria-label={playing ? 'Пауза' : 'Продолжить'} onClick={toggle}>
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
    </div>
  )
}

/** Звук в капсуле: эквалайзер; клик — пауза, подробности — над капсулой при наведении. */
export function CapsuleAudio(): React.JSX.Element | null {
  const { tab, playing, toggle } = useBackgroundAudio()
  if (!tab) return null
  return (
    <button
      className={'ib cap-aud' + (playing ? ' playing' : '')}
      aria-label={(playing ? 'Пауза: ' : 'Продолжить: ') + (tab.title || hostOf(tab.url))}
      title={(tab.title || hostOf(tab.url)) + (playing ? ' · пауза' : ' · продолжить')}
      onClick={toggle}
    >
      <span className="eq" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </button>
  )
}

// ---------- Загрузка страницы: волна по кромке ----------

/** Волнистый индикатор M3 Expressive по верхней кромке страницы — вместо спиннера на вкладке. */
export function PageProgress({ on }: { on: boolean }): React.JSX.Element {
  return (
    <div className={'pprog' + (on ? ' on' : '')} aria-hidden="true">
      <svg viewBox="0 0 1000 12" preserveAspectRatio="none">
        <path d={wavePath} />
      </svg>
    </div>
  )
}

/** Кадры для морфинга форм: индикатор загрузки M3 Expressive перетекает из формы в форму. */
export function MorphKeyframes(): React.JSX.Element {
  const seq = [shapes.cookie9, shapes.sunny8, shapes.clover4, shapes.flower6, shapes.cookie9]
  const frames = seq.map((d, i) => `${(i * 100) / (seq.length - 1)}%{d:path("${d}")}`).join('')
  return <style>{`@keyframes m3morph{${frames}}`}</style>
}

// ---------- «Взгляд»: ссылка поверх страницы ----------

export function Glance(): React.JSX.Element | null {
  const url = useStore((s) => s.glance)
  const [current, setCurrent] = useState<string | null>(null)
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    setCurrent(url)
    const el = ref.current as Electron.WebviewTag | null
    if (!el) return
    const nav = (e: Event): void => setCurrent((e as Electron.DidNavigateEvent).url)
    el.addEventListener('did-navigate', nav)
    el.addEventListener('did-navigate-in-page', nav)
    return () => {
      el.removeEventListener('did-navigate', nav)
      el.removeEventListener('did-navigate-in-page', nav)
    }
  }, [url])
  if (!url) return null
  const close = (): void => useStore.setState({ glance: null })
  const shown = current ?? url
  return (
    <div className="gl-layer">
      <button className="gl-scrim" aria-label="Закрыть взгляд" onClick={close} />
      <div className="glass gl-card" role="dialog" aria-label={'Взгляд: ' + hostOf(shown)}>
        <Grain />
        <div className="gl-bar">
          <Icon name={shown.startsWith('https:') ? 'lock' : 'globe'} />
          <span className="gl-host">{hostOf(shown)}</span>
          <span className="sp" />
          <button
            className="tonal gl-open"
            onClick={() => {
              close()
              S().newTab(shown)
            }}
          >
            <Icon name="openInNew" />
            Открыть вкладкой
          </button>
          <button className="ib" aria-label="Закрыть (Esc)" title="Закрыть · Esc" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        {createElement('webview', {
          ref,
          src: url,
          partition: 'persist:frost', // старое имя сессии: в ней куки и входы, не менять
          allowpopups: 'true',
          className: 'gl-wv'
        })}
      </div>
    </div>
  )
}

// ---------- Две вкладки рядом: ползунок ----------

export function SplitDivider(): React.JSX.Element | null {
  const split = useStore((s) => s.split)
  const visible = useStore((s) => !!s.split && (s.activeId === s.split.a || s.activeId === s.split.b))
  if (!split || !visible) return null
  return (
    <div className="split-div" style={{ left: `${split.ratio * 100}%` }}>
      <span
        className="split-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Граница между вкладками"
        onPointerDown={(e) => {
          const card = (e.currentTarget.closest('.card') as HTMLElement | null)?.getBoundingClientRect()
          if (!card) return
          e.currentTarget.setPointerCapture(e.pointerId)
          document.querySelector('.app')?.classList.add('resizing')
          const move = (ev: PointerEvent): void => {
            const ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - card.left) / card.width))
            useStore.setState((st) => (st.split ? { split: { ...st.split, ratio } } : {}))
          }
          const up = (): void => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            document.querySelector('.app')?.classList.remove('resizing')
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      />
      <button className="split-x" aria-label="Убрать разделение экрана" title="Убрать разделение" onClick={() => S().closeSplit()}>
        <Icon name="close" />
      </button>
    </div>
  )
}

// ---------- Жест «назад» с тачпада ----------

const SWIPE_AT = 180

export function SwipeArrow(): React.JSX.Element | null {
  const swipe = useStore((s) => (s.swipe && s.swipe.tabId === s.activeId ? s.swipe : null))
  if (!swipe) return null
  const back = swipe.dx < 0
  const p = Math.min(1, Math.abs(swipe.dx) / SWIPE_AT)
  const t = S().active()
  if (back ? !t.canBack : !t.canFwd) return null
  return (
    <div
      className={'swipe ' + (back ? 'back' : 'fwd') + (p >= 1 ? ' ready' : '')}
      style={{ '--p': p } as React.CSSProperties}
      aria-hidden="true"
    >
      <Icon name={back ? 'back' : 'forward'} />
    </div>
  )
}

/** Конец жеста: дотянул до порога — назад или вперёд. */
export function finishSwipe(tabId: string, dx: number): void {
  useStore.setState({ swipe: null })
  if (S().activeId !== tabId || Math.abs(dx) < SWIPE_AT) return
  if (dx < 0) goBack()
  else goForward()
}
