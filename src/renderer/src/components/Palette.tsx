import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { askAiWithImage } from '../actions'
import { shapes } from '../lib/shapes'
import { hostOf, looksLikeAddress, resolveInput } from '../lib/url'
import { toggleGlass } from '../lib/glass'
import { mediaAction, mediaPlaying, musicTab, openYouCloud, youcloudKnown } from '../lib/youcloud'
import { useStore, wv } from '../store'
import { Icon, type IconName } from './Icon'
import { Fav, Grain } from './parts'

type Row =
  | { kind: 'ai'; title: string; sub: string }
  | { kind: 'search'; title: string; sub: string }
  | { kind: 'suggest'; title: string; sub: string }
  | { kind: 'url'; title: string; sub: string; url: string }
  | { kind: 'tab'; title: string; sub: string; id: string; url: string; favicon?: string }
  | { kind: 'hist'; title: string; sub: string; url: string }
  | { kind: 'fav'; title: string; sub: string; url: string }
  | { kind: 'remote'; title: string; sub: string; url: string; favicon?: string }
  | { kind: 'arch'; title: string; sub: string; url: string; favicon?: string }
  | { kind: 'cmd'; title: string; sub: string; icon: IconName; run: () => void }
  | { kind: 'music'; title: string; sub: string }

const icons: Record<Row['kind'], IconName> = {
  ai: 'sparkle',
  search: 'search',
  suggest: 'search',
  url: 'globe',
  tab: 'tab',
  hist: 'history',
  fav: 'starFilled',
  remote: 'computer',
  arch: 'history',
  cmd: 'tune',
  music: 'music'
}

interface PaletteCommand {
  title: string
  sub: string
  icon: IconName
  run: () => void
  hidden?: boolean
}

/** Команды палитры: начни ввод с «>». */
function commands(): PaletteCommand[] {
  const S = useStore.getState
  const s = S()
  const t = s.active()
  const web = t.kind === 'web'
  const origin = web ? new URL(t.url).origin : ''
  const page = (a: Parameters<typeof window.masaki.pageAction>[1]) => () => {
    const el = wv(t.id)
    if (el) window.masaki.pageAction(el.getWebContentsId(), a)
  }
  const muteAll = (on: boolean) => () => {
    for (const x of S().tabs) {
      const el = x.kind === 'web' ? wv(x.id) : null
      if (!el) continue
      el.setAudioMuted(on)
      S().updateTab(x.id, { muted: on })
    }
  }
  const other = s.tabs
    .filter((x) => x.kind === 'web' && x.id !== t.id)
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0]
  const g = s.settings.addons
  const music = musicTab()
  const playing = !!music && mediaPlaying(music)
  const song = music?.media?.title ? music.media.title + (music.media.artist ? ' — ' + music.media.artist : '') : music?.title || ''
  return [
    { title: 'Новая вкладка', sub: 'Ctrl+T', icon: 'add', run: () => S().newTab() },
    { title: 'YouCloud', sub: 'Музыка: SoundCloud, Яндекс Музыка, YouTube Music', icon: 'music', run: () => openYouCloud() },
    {
      title: playing ? 'Пауза' : 'Продолжить музыку',
      sub: song,
      icon: playing ? 'pause' : 'play',
      run: () => music && mediaAction(music, playing ? 'pause' : 'play'),
      hidden: !music?.media
    },
    {
      title: 'Следующий трек',
      sub: song,
      icon: 'skipNext',
      run: () => music && mediaAction(music, 'nexttrack'),
      hidden: !music?.media?.actions.includes('nexttrack')
    },
    {
      title: 'Предыдущий трек',
      sub: song,
      icon: 'skipPrev',
      run: () => music && mediaAction(music, 'previoustrack'),
      hidden: !music?.media?.actions.includes('previoustrack')
    },
    { title: 'Вернуть закрытую вкладку', sub: 'Ctrl+Shift+T', icon: 'history', run: () => S().reopenTab(), hidden: !s.closed.length },
    {
      title: 'Закрыть дубли вкладок',
      sub: 'Оставить по одной вкладке на каждый адрес',
      icon: 'tab',
      run: () => {
        const seen = new Set<string>()
        for (const x of S().tabs) {
          if (x.kind !== 'web') continue
          const key = x.url.replace(/#.*$/, '')
          if (seen.has(key) && x.id !== S().activeId) S().closeTab(x.id)
          else seen.add(key)
        }
      }
    },
    { title: 'Закрыть другие вкладки', sub: 'Оставить только текущую', icon: 'close', run: () => S().closeOthers(t.id), hidden: s.tabs.length < 2 },
    { title: 'Выключить звук во всех вкладках', sub: 'Тишина везде', icon: 'volumeOff', run: muteAll(true) },
    { title: 'Включить звук во всех вкладках', sub: 'Вернуть звук', icon: 'volume', run: muteAll(false) },
    {
      title: s.split ? 'Убрать разделение экрана' : 'Разделить экран с прошлой вкладкой',
      sub: s.split ? 'Одна вкладка на весь экран' : other ? 'Рядом: ' + (other.title || hostOf(other.url)) : 'Нужна вторая открытая вкладка',
      icon: 'tab',
      run: () => (S().split ? S().closeSplit() : other && S().openSplit(other.id)),
      hidden: !s.split && (!other || !web)
    },
    { title: s.settings.sidebarCollapsed ? 'Показать боковую панель' : 'Свернуть боковую панель', sub: 'Ctrl+B', icon: 'sidebar', run: () => S().toggleSidebar() },
    { title: 'Тёмная тема', sub: 'Оформление', icon: 'sparkle', run: () => S().setSettings({ scheme: 'dark' }), hidden: s.settings.scheme === 'dark' },
    { title: 'Светлая тема', sub: 'Оформление', icon: 'sparkle', run: () => S().setSettings({ scheme: 'light' }), hidden: s.settings.scheme === 'light' },
    { title: 'Тема как в Windows', sub: 'Оформление', icon: 'sparkle', run: () => S().setSettings({ scheme: 'system' }), hidden: s.settings.scheme === 'system' },
    {
      title: g.glass.enabled ? 'Выключить прозрачные сайты' : 'Включить прозрачные сайты',
      sub: 'Аддон',
      icon: 'layers',
      run: toggleGlass
    },
    {
      title: g.adblock.enabled ? 'Выключить блокировщик рекламы' : 'Включить блокировщик рекламы',
      sub: 'Аддон',
      icon: 'shield',
      run: () => S().setSettings({ addons: { ...S().settings.addons, adblock: { enabled: !g.adblock.enabled } } })
    },
    {
      title: 'Очистить данные этого сайта',
      sub: web ? hostOf(t.url) + ' · входы, куки и хранилище' : 'Откройте сайт',
      icon: 'delete',
      run: () => void window.masaki.site.clearData(origin).then(() => wv(t.id)?.reload()),
      hidden: !web
    },
    { title: 'Очистить кэш', sub: 'Картинки и файлы сайтов; входы останутся', icon: 'delete', run: () => void window.masaki.site.clearCache() },
    { title: 'Сохранить как PDF', sub: 'Страница целиком', icon: 'pdf', run: page({ type: 'pdf' }), hidden: !web },
    { title: 'Печать', sub: 'Ctrl+P', icon: 'print', run: page({ type: 'print' }), hidden: !web },
    { title: 'QR-код страницы', sub: 'Открыть на телефоне', icon: 'qr', run: () => S().showQr(t.url), hidden: !web },
    { title: 'Поиск по вкладкам', sub: 'Ctrl+Shift+A', icon: 'search', run: () => S().openTabSearch() },
    { title: 'Пароли', sub: 'Менеджер паролей', icon: 'key', run: () => S().openPasswords() },
    { title: 'Загрузки', sub: 'Скачанные файлы', icon: 'download', run: () => S().setPopover('downloads') },
    { title: 'Аддоны', sub: 'Прозрачные сайты, блокировщик, расширения', icon: 'extension', run: () => S().openAddons() },
    { title: 'Настройки', sub: 'Ctrl+,', icon: 'settings', run: () => S().openSettings() },
    s.update?.status === 'ready'
      ? { title: 'Обновить Masaki', sub: `Версия ${s.update.version} — перезапуск`, icon: 'update', run: () => window.masaki.update.install() }
      : {
          title: 'Проверить обновления',
          sub: `Masaki ${s.update?.current ?? ''}`,
          icon: 'update',
          run: () => {
            S().openSettings()
            window.masaki.update.check()
          },
          hidden: !s.update || s.update.mode === 'off'
        }
  ]
}

/** Командная палитра: адрес, поиск Google, AI Mode, открытые вкладки и история. */
export function Palette(): React.JSX.Element {
  const palette = useStore((s) => s.palette)
  const ai = useStore((s) => s.ai)
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeId)
  const history = useStore((s) => s.history)
  const favorites = useStore((s) => s.settings.favorites)
  const devices = useStore((s) => s.sync?.devices)
  const archive = useStore((s) => s.archive)
  const [text, setText] = useState(palette.text)
  const [sel, setSel] = useState(0)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const [place, setPlace] = useState<CSSProperties | null>(null)
  // Картинка для AI Mode (data:image/…): вставка Ctrl+V, перетаскивание или кнопка. С ней палитра — в AI Mode.
  const [image, setImage] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const attach = (file: File | null | undefined): boolean => {
    if (!file || !file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) return false
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') return
      setImage(reader.result)
      useStore.getState().setAi(true)
      setSel(0)
      input.current?.focus()
    }
    reader.readAsDataURL(file)
    return true
  }
  const imageIn = (data: DataTransfer | null): File | null => {
    for (const item of data?.items ?? []) if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile()
    return null
  }

  // Палитра всегда по центру страницы, откуда бы её ни вызвали; поле-источник на это время прячется.
  useLayoutEffect(() => {
    const measure = (): void => {
      const stage = document.querySelector('.stage')
      if (!stage) return setPlace(null)
      const r = stage.getBoundingClientRect()
      const width = Math.min(720, r.width - 32)
      const top = Math.max(24, r.top + r.height * 0.18)
      setPlace({ left: r.left + (r.width - width) / 2, width, top, maxHeight: window.innerHeight - top - 24 })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    if (palette.select) el.select()
    else el.setSelectionRange(el.value.length, el.value.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Подсказки поиска Google, как в омнибоксе Chrome.
  useEffect(() => {
    const q = text.trim()
    if (!q || looksLikeAddress(q)) {
      setSuggestions([])
      return
    }
    let alive = true
    const t = window.setTimeout(() => {
      void window.masaki.suggest(q).then((list) => alive && setSuggestions(list))
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [text])

  const rows = useMemo<Row[]>(() => {
    const q = text.trim()
    const low = q.toLowerCase()
    const out: Row[] = []
    const has = (s: string): boolean => s.toLowerCase().includes(low)
    // Поиск по вкладкам: все открытые и то, что ушло в архив.
    if (palette.mode === 'tabs') {
      for (const t of tabs.filter((t) => !low || has(t.title) || has(t.url))) {
        out.push({ kind: 'tab', title: t.title || hostOf(t.url), sub: (t.id === activeId ? 'Текущая вкладка · ' : 'Вкладка · ') + hostOf(t.url), id: t.id, url: t.url, favicon: t.favicon })
      }
      for (const a of archive.filter((a) => !low || has(a.title) || has(a.url)).slice(0, 8)) {
        out.push({ kind: 'arch', title: a.title || hostOf(a.url), sub: 'Из архива · ' + hostOf(a.url), url: a.url, favicon: a.favicon })
      }
      return out
    }
    // С картинкой — один путь: спросить о ней AI Mode (адрес или поиск картинку бы потеряли).
    if (image && !q.startsWith('>')) {
      out.push({ kind: 'ai', title: 'Спросить AI Mode о картинке', sub: q ? `«${q}»` : 'Можно дописать вопрос или сразу нажать Enter' })
      return out
    }
    // Команды: «>» в начале.
    if (q.startsWith('>')) {
      const cq = q.slice(1).trim().toLowerCase()
      for (const c of commands()) {
        if (c.hidden || (cq && !c.title.toLowerCase().includes(cq) && !c.sub.toLowerCase().includes(cq))) continue
        out.push({ kind: 'cmd', title: c.title, sub: c.sub, icon: c.icon, run: c.run })
      }
      return out
    }
    const norm = (u: string): string => u.replace(/#.*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '')
    const seen = new Set<string>(tabs.filter((t) => t.kind === 'web').map((t) => norm(t.url)))
    const recent = [...history].reverse().filter((h) => {
      const key = norm(h.url)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (!q) {
      out.push({ kind: 'ai', title: 'Спросить AI Mode', sub: 'Начните печатать вопрос' })
      for (const t of tabs.filter((t) => t.kind === 'web' && t.id !== activeId).slice(0, 3)) {
        out.push({ kind: 'tab', title: t.title, sub: 'Открытая вкладка · ' + hostOf(t.url), id: t.id, url: t.url, favicon: t.favicon })
      }
      for (const h of recent.slice(0, 5)) out.push({ kind: 'hist', title: h.title || h.url, sub: hostOf(h.url), url: h.url })
      return out
    }
    if (looksLikeAddress(q)) out.push({ kind: 'url', title: q, sub: 'Открыть сайт', url: resolveInput(q, false) })
    const search: Row = { kind: 'search', title: q, sub: 'Поиск в Google' }
    const ask: Row = { kind: 'ai', title: 'Спросить AI Mode', sub: `«${q}»` }
    if (ai) out.push(ask, search)
    else out.push(search, ask)
    // Слушали музыку в YouCloud — запрос можно сразу искать и там (своя вкладка, свой сервис).
    if (!looksLikeAddress(q) && youcloudKnown()) out.push({ kind: 'music', title: q, sub: 'Найти в YouCloud' })
    for (const sg of suggestions.filter((x) => x.toLowerCase() !== low).slice(0, 4)) {
      // Google подсказывает и адреса сайтов — такие строки открывают сайт, а не поиск.
      if (looksLikeAddress(sg)) out.push({ kind: 'url', title: sg.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), sub: 'Открыть сайт', url: resolveInput(sg, false) })
      else out.push({ kind: 'suggest', title: sg, sub: ai ? 'AI Mode' : 'Поиск в Google' })
    }
    const match = (s: string): boolean => s.toLowerCase().includes(low)
    for (const t of tabs.filter((t) => t.kind === 'web' && (match(t.title) || match(t.url))).slice(0, 2)) {
      out.push({ kind: 'tab', title: t.title, sub: 'Перейти на вкладку · ' + hostOf(t.url), id: t.id, url: t.url, favicon: t.favicon })
    }
    // Избранное (в том числе перенесённые закладки Chrome) — выше истории и без повторов в ней.
    const open = new Set(tabs.filter((t) => t.kind === 'web').map((t) => norm(t.url)))
    const favHits = favorites.filter((f) => !open.has(norm(f.url)) && (match(f.title) || match(f.url))).slice(0, 3)
    for (const f of favHits) out.push({ kind: 'fav', title: f.title, sub: 'Избранное · ' + hostOf(f.url), url: f.url })
    const favKeys = new Set(favHits.map((f) => norm(f.url)))
    // Вкладки, открытые на других устройствах (синхронизация), — как «вкладки с других устройств» в Chrome.
    const remote = (devices ?? [])
      .flatMap((d) => d.tabs.map((t) => ({ ...t, device: d.name })))
      .filter((t) => !open.has(norm(t.url)) && !favKeys.has(norm(t.url)) && (match(t.title) || match(t.url)))
      .slice(0, 2)
    for (const t of remote) {
      favKeys.add(norm(t.url))
      out.push({ kind: 'remote', title: t.title || t.url, sub: `На устройстве «${t.device}» · ${hostOf(t.url)}`, url: t.url, favicon: t.favicon })
    }
    for (const h of recent.filter((h) => !favKeys.has(norm(h.url)) && (match(h.title) || match(h.url))).slice(0, 3)) {
      out.push({ kind: 'hist', title: h.title || h.url, sub: hostOf(h.url), url: h.url })
    }
    for (const a of archive.filter((a) => match(a.title) || match(a.url)).slice(0, 2)) {
      out.push({ kind: 'arch', title: a.title || hostOf(a.url), sub: 'Из архива · ' + hostOf(a.url), url: a.url, favicon: a.favicon })
    }
    return out
  }, [text, ai, tabs, activeId, history, favorites, suggestions, devices, archive, palette.mode, image])

  const current = Math.min(sel, rows.length - 1)

  function choose(row: Row | undefined): void {
    const s = useStore.getState()
    const target = palette.target
    if (!row) return
    switch (row.kind) {
      case 'ai':
        if (image) void askAiWithImage(text.trim(), image, target)
        else s.navigate(text, { ai: true, target })
        break
      case 'search':
        s.navigate(row.title, { ai: false, target })
        break
      case 'suggest':
        s.navigate(row.title, { ai, target })
        break
      case 'url':
      case 'hist':
      case 'fav':
      case 'remote':
        s.navigate(row.url, { raw: true, target })
        break
      case 'arch':
        // Вернулась из архива — убираем её оттуда.
        useStore.setState((st) => ({ archive: st.archive.filter((a) => a.url !== row.url) }))
        s.navigate(row.url, { raw: true, target })
        break
      case 'cmd':
        s.closePalette()
        row.run()
        break
      case 'music':
        s.closePalette()
        openYouCloud(row.title)
        break
      case 'tab':
        s.closePalette()
        s.activate(row.id)
        break
    }
  }

  function onKey(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((current + 1) % rows.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((current - 1 + rows.length) % rows.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(rows[current])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      useStore.getState().closePalette()
    } else if (e.key === 'Backspace' && image && !text) {
      // Как у вложений в чатах: стереть «назад» из пустого поля — убрать картинку.
      e.preventDefault()
      setImage(null)
    }
  }

  return (
    <div className="pal-layer">
      <button className="scrim" aria-label="Закрыть палитру" onClick={() => useStore.getState().closePalette()} />
      <div
        className={'glass cmd' + (place ? ' anchored' : '')}
        style={place ?? undefined}
        role="dialog"
        aria-label="Адрес, поиск и AI Mode"
        onDragOver={(e) => {
          if (palette.mode !== 'tabs' && [...e.dataTransfer.items].some((i) => i.kind === 'file' && i.type.startsWith('image/'))) e.preventDefault()
        }}
        onDrop={(e) => {
          if (palette.mode !== 'tabs' && attach(imageIn(e.dataTransfer))) e.preventDefault()
        }}
      >
        <Grain />
        <div className={'cmd-in' + (ai ? ' ai' : '')}>
          <Icon name={ai ? 'sparkle' : 'search'} />
          {image && (
            <span className="pal-pic">
              <img src={image} alt="Картинка для AI Mode" />
              <button className="pal-pic-x" aria-label="Убрать картинку" title="Убрать картинку" onClick={() => {
                setImage(null)
                input.current?.focus()
              }}>
                <Icon name="close" />
              </button>
            </span>
          )}
          <input
            ref={input}
            value={text}
            spellCheck={false}
            placeholder={
              palette.mode === 'tabs'
                ? 'Поиск по вкладкам и архиву'
                : image
                  ? 'Что спросить о картинке?'
                  : ai
                    ? 'Спросите AI Mode о чём угодно…'
                    : 'Адрес, поиск или вопрос · «>» — команды'
            }
            aria-label="Адрес, поиск или вопрос"
            onChange={(e) => {
              setText(e.target.value)
              setSel(0)
            }}
            onKeyDown={onKey}
            onPaste={(e) => {
              if (palette.mode !== 'tabs' && attach(imageIn(e.clipboardData))) e.preventDefault()
            }}
          />
          <button
            hidden={palette.mode === 'tabs'}
            className="ib pal-pic-add"
            aria-label="Добавить картинку для AI Mode"
            title="Картинка для AI Mode — или вставьте её (Ctrl+V) и перетащите сюда"
            onClick={() => picker.current?.click()}
          >
            <Icon name="image" />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              attach(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <button
            hidden={palette.mode === 'tabs'}
            className={'chip' + (ai ? ' on' : '')}
            aria-pressed={ai}
            onClick={() => {
              useStore.getState().setAi(!ai)
              setSel(0)
              input.current?.focus()
            }}
          >
            <Icon name="sparkle" />
            AI Mode
          </button>
          <span className="kbd">Esc</span>
        </div>
        <div className="cmd-sep" />
        <div className="rows" role="listbox" aria-label="Подсказки">
          {rows.map((r, i) => (
            <button
              key={r.kind + r.title + i}
              role="option"
              aria-selected={i === current}
              className={'row' + (i === current ? ' on' : '')}
              onMouseMove={() => i !== current && setSel(i)}
              onClick={() => choose(r)}
            >
              {r.kind === 'ai' ? (
                <span className="row-ic aiic">
                  <svg viewBox="0 0 200 200" className="ai-bg">
                    <path d={shapes.cookie9} />
                  </svg>
                  <Icon name="sparkle" className="ai-ic" />
                </span>
              ) : r.kind === 'cmd' ? (
                <span className="row-ic cmd-ic">
                  <Icon name={r.icon} />
                </span>
              ) : r.kind === 'tab' || r.kind === 'hist' || r.kind === 'remote' || r.kind === 'arch' ? (
                <span className="row-ic">
                  {r.kind === 'tab' || r.kind === 'remote' || r.kind === 'arch' ? <Fav favicon={r.favicon} title={r.title} url={r.url} /> : <Icon name={icons[r.kind]} />}
                </span>
              ) : (
                <span className="row-ic">
                  <Icon name={icons[r.kind]} />
                </span>
              )}
              <span className="row-t">
                <b>{r.title}</b>
                <small>{r.sub}</small>
              </span>
              {i === current && <span className="kbd">Enter</span>}
            </button>
          ))}
        </div>
        <div className="cmd-foot">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>выбрать
          </span>
          <span>
            <span className="kbd">Enter</span>открыть
          </span>
          <span>
            <span className="kbd">Esc</span>закрыть
          </span>
          <div className="sp" />
          {/* Плашка про новую вкладку важнее подсказок хоткеев — вместе они не влезают в строку. */}
          {palette.target === 'new' ? (
            <span className="pal-new">Откроется в новой вкладке</span>
          ) : (
            <>
              <span>
                <span className="kbd">Ctrl T</span>вкладка
              </span>
              <span>
                <span className="kbd">Ctrl B</span>панель
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
