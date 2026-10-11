import type { PageMenuParams, Shortcut } from '../../shared/types'
import { toggleMute } from './actions'
import type { MenuEntry } from './components/Menu'
import { isTileColor, siteIconColors } from './lib/iconColor'
import { isShape, shapeCycle, type ShapeName } from './lib/shapes'
import { aiModeUrl, hostOf, searchUrl } from './lib/url'
import { toggleGlassForSite } from './lib/glass'
import { groupColors, useStore } from './store'

const S = useStore.getState

function short(text: string, n = 28): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * Меню страницы. Electron отдаёт координаты клика уже в системе окна — по ним ставим меню,
 * а для «Просмотреть код» и «Копировать картинку» переводим их в координаты самой страницы.
 */
export function openPageMenu(p: PageMenuParams): void {
  let left = 0
  let top = 0
  for (const el of document.querySelectorAll<Electron.WebviewTag>('webview')) {
    try {
      if (el.getWebContentsId() !== p.wcId) continue
      const r = el.getBoundingClientRect()
      left = r.left
      top = r.top
      break
    } catch {
      // этот webview ещё не готов
    }
  }
  const act = (a: Parameters<typeof window.masaki.pageAction>[1]) => () => window.masaki.pageAction(p.wcId, a)
  const e: MenuEntry[] = []
  const sep = (): void => {
    if (e.length && e[e.length - 1].kind !== 'sep') e.push({ kind: 'sep' })
  }

  const gx = p.x - left
  const gy = p.y - top
  const media = (op: 'pip' | 'loop' | 'controls' | 'mute' | 'play') => act({ type: 'media', op, x: gx, y: gy })
  const lens = (url: string) => () => S().newTab('https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(url))

  if (p.linkURL) {
    e.push(
      { kind: 'item', icon: 'add', label: 'Открыть ссылку в новой вкладке', run: () => S().newTab(p.linkURL, { background: true }) },
      { kind: 'item', icon: 'openInNew', label: 'Открыть ссылку и перейти', run: () => S().newTab(p.linkURL) },
      { kind: 'item', icon: 'download', label: 'Сохранить ссылку как…', run: act({ type: 'download', url: p.linkURL }) },
      { kind: 'item', icon: 'link', label: 'Копировать адрес ссылки', run: () => window.masaki.copyText(p.linkURL) }
    )
    if (p.linkText.trim()) e.push({ kind: 'item', icon: 'copy', label: 'Копировать текст ссылки', run: () => window.masaki.copyText(p.linkText.trim()) })
    sep()
  }
  // Видео и аудио — как в Chrome: картинка в картинке, кадр, повтор, элементы управления.
  if ((p.mediaType === 'video' || p.mediaType === 'audio') && !p.linkURL) {
    const f = p.mediaFlags
    const video = p.mediaType === 'video'
    e.push({ kind: 'item', icon: f.isPaused ? 'play' : 'pause', label: f.isPaused ? 'Воспроизвести' : 'Пауза', run: media('play') })
    if (f.hasAudio) e.push({ kind: 'item', icon: f.isMuted ? 'volume' : 'volumeOff', label: f.isMuted ? 'Включить звук' : 'Выключить звук', run: media('mute') })
    e.push({ kind: 'item', icon: 'loop', label: f.isLooping ? 'Выключить повтор' : 'Повторять', run: media('loop') })
    if (f.canToggleControls) {
      e.push({ kind: 'item', icon: 'tune', label: f.isControlsVisible ? 'Скрыть элементы управления' : 'Показать элементы управления', run: media('controls') })
    }
    if (video) {
      e.push(
        { kind: 'item', icon: 'pip', label: 'Картинка в картинке', disabled: !f.canShowPictureInPicture, run: media('pip') },
        { kind: 'item', icon: 'image', label: 'Скопировать кадр', run: act({ type: 'copy-frame', x: gx, y: gy }) }
      )
    }
    if (p.srcURL && !p.srcURL.startsWith('blob:')) {
      e.push(
        { kind: 'sep' },
        { kind: 'item', icon: 'download', label: video ? 'Сохранить видео как…' : 'Сохранить аудио как…', run: act({ type: 'download', url: p.srcURL }) },
        { kind: 'item', icon: 'openInNew', label: video ? 'Открыть видео в новой вкладке' : 'Открыть аудио в новой вкладке', run: () => S().newTab(p.srcURL) },
        { kind: 'item', icon: 'link', label: video ? 'Копировать адрес видео' : 'Копировать адрес аудио', run: () => window.masaki.copyText(p.srcURL) }
      )
    }
    sep()
  }
  if (p.mediaType === 'image' && p.srcURL) {
    e.push(
      { kind: 'item', icon: 'image', label: 'Открыть картинку в новой вкладке', run: () => S().newTab(p.srcURL, { background: true }) },
      { kind: 'item', icon: 'download', label: 'Сохранить картинку', run: act({ type: 'download', url: p.srcURL }) },
      { kind: 'item', icon: 'copy', label: 'Копировать картинку', run: act({ type: 'copy-image', x: gx, y: gy }) },
      { kind: 'item', icon: 'link', label: 'Копировать адрес картинки', run: () => window.masaki.copyText(p.srcURL) },
      { kind: 'item', icon: 'lens', label: 'Найти картинку через Google Lens', disabled: p.srcURL.startsWith('data:') || p.srcURL.startsWith('blob:'), run: lens(p.srcURL) }
    )
    sep()
  }
  if (p.isEditable) {
    for (const w of p.dictionarySuggestions.slice(0, 4)) e.push({ kind: 'item', icon: 'check', label: w, run: act({ type: 'replace', word: w }) })
    if (p.misspelledWord) e.push({ kind: 'item', icon: 'add', label: 'Добавить в словарь', run: act({ type: 'add-word', word: p.misspelledWord }) })
    sep()
    const f = p.editFlags
    e.push(
      { kind: 'item', icon: 'undo', label: 'Отменить', kbd: 'Ctrl Z', disabled: !f.canUndo, run: act({ type: 'edit', cmd: 'undo' }) },
      { kind: 'item', icon: 'redo', label: 'Повторить', kbd: 'Ctrl Y', disabled: !f.canRedo, run: act({ type: 'edit', cmd: 'redo' }) },
      { kind: 'sep' },
      { kind: 'item', icon: 'cut', label: 'Вырезать', kbd: 'Ctrl X', disabled: !f.canCut, run: act({ type: 'edit', cmd: 'cut' }) },
      { kind: 'item', icon: 'copy', label: 'Копировать', kbd: 'Ctrl C', disabled: !f.canCopy, run: act({ type: 'edit', cmd: 'copy' }) },
      { kind: 'item', icon: 'paste', label: 'Вставить', kbd: 'Ctrl V', disabled: !f.canPaste, run: act({ type: 'edit', cmd: 'paste' }) },
      { kind: 'item', icon: 'paste', label: 'Вставить без форматирования', kbd: 'Ctrl Shift V', disabled: !f.canPaste, run: act({ type: 'paste-plain' }) },
      { kind: 'item', icon: 'selectAll', label: 'Выделить всё', kbd: 'Ctrl A', run: act({ type: 'edit', cmd: 'selectAll' }) }
    )
    sep()
  } else if (p.selectionText.trim()) {
    const text = p.selectionText.trim()
    const base = p.pageURL.split('#')[0]
    e.push(
      { kind: 'item', icon: 'copy', label: 'Копировать', kbd: 'Ctrl C', run: act({ type: 'edit', cmd: 'copy' }) },
      { kind: 'item', icon: 'link', label: 'Копировать ссылку на выделенное', run: () => window.masaki.copyText(base + '#:~:text=' + encodeURIComponent(text.slice(0, 300))) },
      { kind: 'item', icon: 'search', label: `Найти в Google «${short(text)}»`, run: () => S().newTab(searchUrl(text)) },
      { kind: 'item', icon: 'sparkle', label: `Спросить AI Mode о «${short(text)}»`, run: () => S().newTab(aiModeUrl(text)) },
      {
        kind: 'item',
        icon: 'translate',
        label: 'Перевести выделенное',
        run: () => S().newTab('https://translate.google.com/?sl=auto&tl=ru&op=translate&text=' + encodeURIComponent(text))
      }
    )
    sep()
  }
  if (!p.linkURL && !p.isEditable && !p.selectionText.trim() && p.mediaType === 'none') {
    const web = /^https?:/i.test(p.pageURL)
    e.push(
      { kind: 'item', icon: 'back', label: 'Назад', kbd: 'Alt ←', disabled: !p.canGoBack, run: act({ type: 'back' }) },
      { kind: 'item', icon: 'forward', label: 'Вперёд', kbd: 'Alt →', disabled: !p.canGoForward, run: act({ type: 'forward' }) },
      { kind: 'item', icon: 'reload', label: 'Обновить', kbd: 'Ctrl R', run: act({ type: 'reload' }) },
      { kind: 'sep' },
      {
        kind: 'item',
        icon: 'translate',
        label: 'Перевести на русский',
        disabled: !web,
        run: () => S().navigate('https://translate.google.com/translate?sl=auto&tl=ru&u=' + encodeURIComponent(p.pageURL), { raw: true })
      },
      { kind: 'item', icon: 'qr', label: 'Создать QR-код страницы', run: () => S().showQr(p.pageURL) },
      { kind: 'item', icon: 'download', label: 'Сохранить страницу как…', kbd: 'Ctrl S', run: act({ type: 'save-page' }) },
      { kind: 'item', icon: 'pdf', label: 'Сохранить как PDF…', run: act({ type: 'pdf' }) },
      { kind: 'item', icon: 'print', label: 'Печать…', kbd: 'Ctrl P', run: act({ type: 'print' }) },
      { kind: 'item', icon: 'code', label: 'Просмотр кода страницы', kbd: 'Ctrl U', run: () => S().newTab('view-source:' + p.pageURL) }
    )
    // Аддон «Прозрачные сайты»: быстро выключить или вернуть для этого сайта.
    const g = S().settings.addons.glass
    if (g.enabled && web) {
      const off = g.exclude.includes(hostOf(p.pageURL))
      e.push({ kind: 'item', icon: 'layers', label: off ? 'Вернуть прозрачность на этом сайте' : 'Выключить прозрачность на этом сайте', run: () => toggleGlassForSite(p.pageURL) })
    }
    sep()
  }
  e.push({ kind: 'item', icon: 'code', label: 'Просмотреть код элемента', kbd: 'F12', run: act({ type: 'inspect', x: p.x - left, y: p.y - top }) })
  S().openMenu(p.x, p.y, e)
}

/** Меню вкладки: в боковой панели и в капсуле. */
export function openTabMenu(x: number, y: number, id: string): void {
  const s = S()
  const t = s.tabs.find((x) => x.id === id)
  if (!t) return
  const i = s.tabs.indexOf(t)
  const active = s.active()
  const inSplit = !!s.split && (s.split.a === id || s.split.b === id)
  const groupItems: MenuEntry[] = [
    { kind: 'item', icon: 'add', label: 'В новую группу', run: () => S().addToGroup(id, 'new') },
    ...s.groups
      .filter((g) => g.id !== t.group)
      .map((g): MenuEntry => ({ kind: 'item', icon: 'tab', label: `В группу «${g.name}»`, run: () => S().addToGroup(id, g.id) })),
    ...(t.group ? [{ kind: 'item', icon: 'close', label: 'Убрать из группы', run: () => S().removeFromGroup(id) } as MenuEntry] : [])
  ]
  S().openMenu(x, y, [
    { kind: 'header', label: t.title || hostOf(t.url), sub: t.kind === 'web' ? hostOf(t.url) : undefined },
    { kind: 'item', icon: 'add', label: 'Новая вкладка', kbd: 'Ctrl T', run: () => S().newTab() },
    { kind: 'item', icon: 'copy', label: 'Дублировать', disabled: t.kind !== 'web', run: () => S().duplicateTab(id) },
    inSplit
      ? { kind: 'item', icon: 'close', label: 'Убрать разделение экрана', run: () => S().closeSplit() }
      : {
          kind: 'item',
          icon: 'tab',
          label: 'Открыть рядом с текущей',
          disabled: t.kind !== 'web' || active.kind !== 'web' || active.id === id,
          run: () => S().openSplit(id)
        },
    { kind: 'sep' },
    ...groupItems,
    {
      kind: 'item',
      icon: t.muted ? 'volume' : 'volumeOff',
      label: t.muted ? 'Включить звук на сайте' : 'Выключить звук на сайте',
      disabled: t.kind !== 'web',
      run: () => toggleMute(id)
    },
    { kind: 'sep' },
    { kind: 'item', icon: 'close', label: 'Закрыть', kbd: 'Ctrl W', run: () => S().closeTab(id) },
    { kind: 'item', icon: 'close', label: 'Закрыть другие вкладки', disabled: s.tabs.length < 2, run: () => S().closeOthers(id) },
    { kind: 'item', icon: 'down', label: 'Закрыть вкладки ниже', disabled: i === s.tabs.length - 1, run: () => S().closeBelow(id) },
    { kind: 'item', icon: 'history', label: 'Вернуть закрытую вкладку', kbd: 'Ctrl Shift T', disabled: !s.closed.length, run: () => S().reopenTab() }
  ])
}

/** Меню группы вкладок: переименовать, цвет, разгруппировать, закрыть. */
export function openGroupMenu(x: number, y: number, id: string, rename: () => void): void {
  const g = S().groups.find((x) => x.id === id)
  if (!g) return
  S().openMenu(x, y, [
    { kind: 'header', label: g.name, sub: 'Группа вкладок' },
    { kind: 'item', icon: 'tune', label: 'Переименовать', run: rename },
    ...groupColors.map(
      (c, i): MenuEntry => ({
        kind: 'item',
        icon: c === g.color ? 'check' : 'layers',
        label: ['Синий', 'Зелёный', 'Жёлтый', 'Красный', 'Фиолетовый', 'Розовый', 'Бирюзовый', 'Оранжевый'][i],
        run: () => S().updateGroup(id, { color: c })
      })
    ),
    { kind: 'sep' },
    { kind: 'item', icon: g.collapsed ? 'down' : 'up', label: g.collapsed ? 'Развернуть' : 'Свернуть', run: () => S().updateGroup(id, { collapsed: !g.collapsed }) },
    { kind: 'item', icon: 'tab', label: 'Разгруппировать', run: () => S().ungroup(id) },
    { kind: 'item', icon: 'close', danger: true, label: 'Закрыть группу', run: () => S().closeGroup(id) }
  ])
}

/** Меню плитки избранного или ярлыка: форма, цвет, открыть, убрать. */
export function openTileMenu(x: number, y: number, list: 'favorites' | 'shortcuts', index: number): void {
  const items = S().settings[list]
  const item = items[index]
  if (!item) return
  const current: ShapeName = isShape(item.shape) ? item.shape : shapeCycle[index % shapeCycle.length]
  const save = (next: Shortcut[]): void => S().setSettings({ [list]: next })
  // Меню не закрываем: пусть плитка на глазах перетекает в новую форму или цвет, а выбранное в ряду сразу отмечается.
  const refresh = (patch: (e: MenuEntry) => MenuEntry): void =>
    useStore.setState((st) => (st.menu ? { menu: { ...st.menu, entries: st.menu.entries.map(patch) } } : {}))
  const pick = (shape: ShapeName): void => {
    save(S().settings[list].map((it, j) => (j === index ? { ...it, shape } : it)))
    refresh((e) => (e.kind === 'shapes' ? { ...e, current: shape } : e))
  }
  const pickColor = (color: string | undefined): void => {
    // «Авто» — поля нет совсем, а не пустое: так цвет снова берётся из значка и в файлах настроек ничего лишнего.
    save(
      S().settings[list].map((it, j) => {
        if (j !== index) return it
        const { color: _was, ...rest } = it
        return color ? { ...rest, color } : rest
      })
    )
    refresh((e) => (e.kind === 'colors' ? { ...e, current: color } : e))
  }
  S().openMenu(x, y, [
    { kind: 'header', label: item.title, sub: hostOf(item.url) },
    { kind: 'shapes', current, pick },
    {
      kind: 'colors',
      current: isTileColor(item.color) ? item.color.toLowerCase() : undefined,
      auto: siteIconColors(item.url),
      pick: pickColor
    },
    { kind: 'sep' },
    { kind: 'item', icon: 'add', label: 'Открыть в новой вкладке', run: () => S().newTab(item.url) },
    { kind: 'item', icon: 'link', label: 'Копировать адрес', run: () => window.masaki.copyText(item.url) },
    { kind: 'sep' },
    {
      kind: 'item',
      icon: 'delete',
      danger: true,
      label: list === 'favorites' ? 'Убрать из избранного' : 'Удалить ярлык',
      run: () => save(S().settings[list].filter((_, j) => j !== index))
    }
  ])
}

/** Меню для полей ввода самого интерфейса (палитра, поиск на странице, настройки). */
export function openInputMenu(x: number, y: number, el: HTMLInputElement | HTMLTextAreaElement): void {
  const hasSel = (el.selectionEnd ?? 0) > (el.selectionStart ?? 0)
  const edit = (cmd: 'cut' | 'copy' | 'paste' | 'selectAll' | 'undo' | 'redo') => () => {
    el.focus()
    window.masaki.uiEdit(cmd)
  }
  S().openMenu(x, y, [
    { kind: 'item', icon: 'cut', label: 'Вырезать', kbd: 'Ctrl X', disabled: !hasSel, run: edit('cut') },
    { kind: 'item', icon: 'copy', label: 'Копировать', kbd: 'Ctrl C', disabled: !hasSel, run: edit('copy') },
    { kind: 'item', icon: 'paste', label: 'Вставить', kbd: 'Ctrl V', run: edit('paste') },
    { kind: 'sep' },
    { kind: 'item', icon: 'selectAll', label: 'Выделить всё', kbd: 'Ctrl A', run: edit('selectAll') }
  ])
}
