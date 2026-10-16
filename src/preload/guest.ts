import { contextBridge, ipcRenderer } from 'electron'
import { installMediaHook } from './media-page'
import { installPasskeys } from './passkey-page'

// Скрипт для страниц во вкладках (изолированный мир: сама страница его не видит).

// Прозрачный документ опирается на Canvas браузера, а не на тему интерфейса Masaki.
// Сообщаем цвет подложки отдельно: фоны html/body не переписываем, чтобы сохранить CSS сайта.
let canvasColor = ''
let canvasFrame = 0
function sendCanvas(): void {
  canvasFrame = 0
  const root = document.documentElement
  if (!root) return
  const probe = document.createElement('span')
  probe.style.cssText = 'display:none!important;background-color:Canvas!important;color-scheme:inherit!important'
  root.appendChild(probe)
  const color = getComputedStyle(probe).backgroundColor
  probe.remove()
  if (color === canvasColor) return
  canvasColor = color
  ipcRenderer.sendToHost('page:canvas', color)
}
const scheduleCanvas = (): void => {
  if (!canvasFrame) canvasFrame = requestAnimationFrame(sendCanvas)
}
window.addEventListener('DOMContentLoaded', () => {
  sendCanvas()
  new MutationObserver(scheduleCanvas).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  // meta color-scheme и поздно загруженные стили тоже могут менять системный Canvas.
  if (document.head) new MutationObserver(scheduleCanvas).observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content', 'media', 'disabled'] })
})
window.addEventListener('load', scheduleCanvas, true)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', scheduleCanvas)

// 1. На странице входа Google прячем признаки Chromium, чтобы вход не упирался в «Возможно, этот браузер
// или приложение небезопасны». Заголовки и user agent для этого адреса подменяет главный процесс (Firefox ESR).
if (location.hostname === 'accounts.google.com') {
  contextBridge.executeInMainWorld({
    func: () => {
      try {
        Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true })
      } catch {
        // свойство уже переопределено
      }
    }
  })
}

// 2. Ключи доступа (passkey): WebAuthn страницы обслуживает менеджер ключей Masaki в главном процессе.
// В мир страницы уходит только функция-мост: какие запросы пропускать, решает главный процесс.
contextBridge.executeInMainWorld({
  func: installPasskeys,
  args: [
    (op: string, json: string): Promise<string> =>
      op === 'create' || op === 'get' || op === 'abort' ? ipcRenderer.invoke('pk:' + op, String(json)) : Promise.reject(new Error('unknown'))
  ]
})

// 3. Пароли: список аккаунтов у поля входа (его рисует интерфейс Masaki поверх вкладки), заполнение
// и предложение сохранить пароль после отправки формы. Пароль приходит сюда из главного процесса
// только после выбора аккаунта, а сайт для проверки главный процесс берёт сам, не со слов страницы.

type Item = { id: string; username: string; host: string; passkey?: boolean }
type Fields = { user: HTMLInputElement | null; pass: HTMLInputElement | null; focus: HTMLInputElement }

let items: Item[] | null = null
/** Ключи доступа для поля с autocomplete="… webauthn", пока страница ждёт вход по ключу. */
let keys: Item[] = []
let loading: Promise<Item[]> | null = null
let active: Fields | null = null
let shown = false
/** Пока вписываем логин и пароль, фокус прыгает по полям — список при этом не показываем. */
let filling = false
let hideTimer: ReturnType<typeof setTimeout> | undefined

const TEXTY = new Set(['text', 'email', 'tel', ''])
const WEBAUTHN = /(^|\s)webauthn(\s|$)/i
const USERISH = /user|login|email|e-mail|mail|identifier|account|phone|логин|почт/i

function visible(el: HTMLInputElement): boolean {
  if (el.disabled || el.readOnly || el.hidden) return false
  const r = el.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return false
  const cs = getComputedStyle(el)
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
}

const isPass = (i: HTMLInputElement): boolean => i.type === 'password'
const isTexty = (i: HTMLInputElement): boolean => TEXTY.has(i.type)
const inputsIn = (scope: ParentNode): HTMLInputElement[] => [...scope.querySelectorAll('input')].filter(visible)

function looksUser(i: HTMLInputElement): boolean {
  const ac = (i.autocomplete || '').toLowerCase()
  if (/username|email/.test(ac) || i.type === 'email') return true
  return USERISH.test(`${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`)
}

/** Поле логина — последнее текстовое поле перед первым полем пароля. */
function userBefore(all: HTMLInputElement[], pass: HTMLInputElement): HTMLInputElement | null {
  return all.slice(0, all.indexOf(pass)).reverse().find(isTexty) ?? null
}

function fieldsFor(t: HTMLInputElement): Fields | null {
  const all = inputsIn(t.form ?? document)
  const passes = all.filter(isPass)
  if (isPass(t)) {
    // Новый пароль (регистрация, смена пароля) не подставляем.
    if (/new-password/i.test(t.autocomplete)) return null
    return { user: userBefore(all, passes[0] ?? t), pass: t, focus: t }
  }
  if (!isTexty(t)) return null
  if (passes.length) {
    return userBefore(all, passes[0]) === t ? { user: t, pass: passes[0], focus: t } : null
  }
  // Вход в несколько шагов (сначала почта, потом пароль): на странице только поле логина.
  return looksUser(t) ? { user: t, pass: null, focus: t } : null
}

function loadItems(): Promise<Item[]> {
  if (items) return Promise.resolve(items)
  loading ??= ipcRenderer
    .invoke('pw:logins')
    .then((r: Item[]) => (items = Array.isArray(r) ? r : []))
    .catch(() => (items = []))
    .finally(() => (loading = null))
  return loading
}

ipcRenderer.on('pw:changed', () => {
  items = null
})
// Ключ из списка выбран — страница получила вход, список больше не нужен.
ipcRenderer.on('pk:used', () => {
  keys = []
  hide()
})

function hide(): void {
  clearTimeout(hideTimer)
  if (!shown) return
  shown = false
  ipcRenderer.sendToHost('pw:hide')
}

/** Сколько строк в показанном списке и какая выбрана стрелками (-1 — ни одной). */
let shownCount = 0
let picked = -1

function show(f: Fields, list: Item[]): void {
  // Пока печатают логин — только подходящие аккаунты, как в Chrome.
  const typed = f.focus === f.user ? f.focus.value.trim().toLowerCase() : ''
  const all = [...keys, ...list]
  const fit = typed ? all.filter((x) => x.username.toLowerCase().startsWith(typed) && x.username.toLowerCase() !== typed) : all
  if (!fit.length) return hide()
  clearTimeout(hideTimer)
  const r = f.focus.getBoundingClientRect()
  shown = true
  shownCount = fit.length
  picked = -1
  ipcRenderer.sendToHost('pw:show', {
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    dpr: window.devicePixelRatio,
    items: fit,
    role: f.focus === f.pass ? 'password' : 'username'
  })
}

document.addEventListener(
  'focusin',
  (e) => {
    const t = e.target
    if (filling || !(t instanceof HTMLInputElement)) return
    // Поле входа по ключу доступа (autocomplete="username webauthn") — ключи сайта в том же списке.
    const webauthn = WEBAUTHN.test(t.getAttribute('autocomplete') ?? '')
    const f = fieldsFor(t) ?? (webauthn && isTexty(t) ? { user: t, pass: null, focus: t } : null)
    if (!f) return
    const pk: Promise<Item[]> = webauthn ? ipcRenderer.invoke('pk:conditional').catch(() => []) : Promise.resolve([])
    void Promise.all([loadItems(), pk]).then(([list, ks]) => {
      keys = Array.isArray(ks) ? ks : []
      if ((!list.length && !keys.length) || document.activeElement !== t) return
      active = f
      show(f, list)
    })
  },
  true
)

document.addEventListener(
  'input',
  (e) => {
    if (!filling && active && e.target === active.focus && (items?.length || keys.length)) show(active, items ?? [])
  },
  true
)

document.addEventListener(
  'focusout',
  () => {
    // Клик по списку в интерфейсе тоже уводит фокус со страницы — даём ему успеть.
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hide, 250)
  },
  true
)
window.addEventListener('scroll', hide, { capture: true, passive: true })
window.addEventListener('resize', hide)
window.addEventListener('pagehide', hide)

/** Значение ставим нативным сеттером и шлём input/change — так его видят и React, и обычные формы. */
function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  input.focus()
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

ipcRenderer.on('pw:fill', (_e, d: { username: string; password: string }) => {
  const f = active
  hide()
  if (!f) return
  filling = true
  try {
    if (f.user && d.username) setValue(f.user, d.username)
    if (f.pass) setValue(f.pass, d.password)
  } finally {
    filling = false
  }
})

// ---------- После отправки формы: предложить сохранить ----------

function collect(from: Element | null): void {
  const scope: ParentNode = (from instanceof HTMLFormElement ? from : from?.closest('form')) ?? document
  const all = inputsIn(scope)
  const filled = all.filter((i) => isPass(i) && i.value)
  if (filled.length) {
    // Регистрация и смена пароля: сохраняем новый пароль, а не старый.
    const pass = filled.find((p) => /new-password/i.test(p.autocomplete)) ?? filled[filled.length - 1]
    const first = all.find(isPass)
    const user = first ? userBefore(all, first) : null
    ipcRenderer.send('pw:submit', { username: user?.value.trim() ?? '', password: pass.value })
    return
  }
  const u = all.find((i) => isTexty(i) && i.value.trim() && looksUser(i))
  if (u) ipcRenderer.send('pw:username', u.value.trim())
}

document.addEventListener('submit', (e) => collect(e.target as Element), true)
document.addEventListener(
  'click',
  (e) => {
    const b = (e.target as Element | null)?.closest?.('button, input[type=submit], input[type=button], [role=button]')
    if (b) collect(b)
  },
  true
)
// Список аккаунтов у поля — стрелками и Enter, как в Chrome. Фокус остаётся в поле страницы, поэтому клавиши
// ловим здесь, раньше страницы (окно, перехват): пока список открыт, они его, а не формы и не сайта.
window.addEventListener(
  'keydown',
  (e) => {
    if (!shown || !active || e.target !== active.focus || e.altKey || e.ctrlKey || e.metaKey) return
    const own = (): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      own()
      picked = e.key === 'ArrowDown' ? (picked + 1) % shownCount : picked <= 0 ? shownCount - 1 : picked - 1
      ipcRenderer.sendToHost('pw:sel', picked)
    } else if (e.key === 'Enter' && picked >= 0) {
      // Выбранный аккаунт подставляем, а форму не отправляем — как в Chrome.
      own()
      ipcRenderer.sendToHost('pw:pick', picked)
    } else if (e.key === 'Escape') {
      own()
      hide()
    }
  },
  true
)
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape') hide()
    else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) collect(e.target)
  },
  true
)

// 4. «Взгляд»: Alt+клик по ссылке открывает её карточкой поверх страницы, без новой вкладки.
document.addEventListener(
  'click',
  (e) => {
    if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || e.button !== 0) return
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || !/^https?:/i.test(a.href)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    ipcRenderer.sendToHost('glance', a.href)
  },
  true
)

// 5. Куда листают страницу: в свёрнутом режиме капсула сжимается, пока читают вниз.
// Проверки от дребезга. Худеющий док делает страницу выше, и браузер сам сдвигает прокрутку: у низа
// страницы — вверх, у вёрстки на vh — куда придётся. Это не чтение: сразу после смены размера положение
// только запоминаем, иначе док качался бы «маленький — большой» без конца. И слушаем лишь главную прокрутку
// страницы: списки, карусели и чаты внутри неё направление чтения не задают.
const scrollTops = new WeakMap<EventTarget, number>()
let scrollDir = ''
let resizedAt = -Infinity
window.addEventListener('resize', () => {
  resizedAt = performance.now()
})
window.addEventListener(
  'scroll',
  (e) => {
    const t = e.target
    const doc = t === document || t === document.documentElement || t === document.body
    if (!doc && ((t as Element).clientHeight < innerHeight * 0.5 || (t as Element).clientWidth < innerWidth * 0.4)) return
    const y = doc ? window.scrollY : (t as Element).scrollTop
    const key = doc ? document : (t as EventTarget)
    if (performance.now() - resizedAt < 400) {
      scrollTops.set(key, y)
      return
    }
    const last = scrollTops.get(key) ?? 0
    if (Math.abs(y - last) < 24 && y > 8) return
    scrollTops.set(key, y)
    const dir = y <= 8 || y < last ? 'up' : 'down'
    if (dir === scrollDir) return
    scrollDir = dir
    ipcRenderer.sendToHost('scroll', dir)
  },
  { passive: true, capture: true }
)

// 6. Свайп двумя пальцами по тачпаду — назад/вперёд, как в Chrome. Жест — серия событий колеса без паузы
// дольше 140 мс. Что это — свайп или прокрутка, решаем по первым пикселям и до конца серии не меняем:
// прокрутка, ушедшая вбок, «назад» не станет. Жест принадлежит странице, если под пальцами есть что листать
// вбок (карусель, таблица), если страница сама забрала колесо (preventDefault — Google Таблицы, карты,
// редакторы листают себя сами) или если за время жеста что-то на странице уехало вбок (своя полоса
// прокрутки рядом с сеткой). Щелчки колёсика мыши вбок не считаем.
function canScrollX(from: Element | null, dir: number): boolean {
  for (let n = from; n && n !== document.documentElement; n = n.parentElement) {
    if (n.scrollWidth <= n.clientWidth + 1) continue
    if (!/(auto|scroll)/.test(getComputedStyle(n).overflowX)) continue
    if (dir < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true
  }
  const se = document.scrollingElement
  if (se && se.scrollWidth > se.clientWidth + 1) {
    if (dir < 0 ? se.scrollLeft > 0 : se.scrollLeft + se.clientWidth < se.scrollWidth - 1) return true
  }
  return false
}

/** undecided — пальцы ещё не сдвинулись настолько, чтобы понять; other — прокрутка или жест страницы. */
let gesture: null | 'undecided' | 'swipe' | 'other' = null
/** Было ли что листать назад/вперёд там, где жест начался, — до того, как страница успела сдвинуться. */
let swipeRoom = { back: false, fwd: false }
let swipeDx = 0
let swipeDy = 0
let swipeEnd: ReturnType<typeof setTimeout> | undefined
let swipeFrame = 0

function endGesture(): void {
  cancelAnimationFrame(swipeFrame)
  swipeFrame = 0
  if (gesture === 'swipe') ipcRenderer.sendToHost('swipe-end', swipeDx)
  gesture = null
}

/** Жест оказался страничным: стрелку убираем без перехода, до конца серии больше не вмешиваемся. */
function dropSwipe(): void {
  if (gesture === 'swipe') {
    cancelAnimationFrame(swipeFrame)
    swipeFrame = 0
    ipcRenderer.sendToHost('swipe-end', 0)
  }
  if (gesture) gesture = 'other'
}

window.addEventListener(
  'wheel',
  (e) => {
    if (!e.isTrusted) return
    clearTimeout(swipeEnd)
    swipeEnd = setTimeout(endGesture, 140)
    if (!gesture) {
      gesture = 'undecided'
      swipeDx = swipeDy = 0
      const from = e.target as Element | null
      swipeRoom = { back: canScrollX(from, -1), fwd: canScrollX(from, 1) }
    }
    if (gesture === 'other') return
    const ax = Math.abs(e.deltaX)
    // Ctrl — масштаб, Shift — прокрутка колесом вбок, строки и страницы — колесо мыши, кратное 120 — его наклон.
    if (e.ctrlKey || e.shiftKey || e.deltaMode !== 0 || (ax >= 100 && ax % 120 === 0)) return dropSwipe()
    swipeDx += e.deltaX
    swipeDy += e.deltaY
    if (gesture === 'undecided' && Math.abs(swipeDx) + Math.abs(swipeDy) >= 4) {
      const sideways = Math.abs(swipeDx) >= Math.abs(swipeDy) * 1.5
      gesture = sideways && !(swipeDx < 0 ? swipeRoom.back : swipeRoom.fwd) ? 'swipe' : 'other'
    }
    // Наш слушатель стоит раньше страничных: об отмене узнаём, когда событие обойдёт всех.
    setTimeout(() => {
      if (e.defaultPrevented) dropSwipe()
    })
    if (gesture === 'swipe' && !swipeFrame) {
      swipeFrame = requestAnimationFrame(() => {
        swipeFrame = 0
        if (gesture === 'swipe') ipcRenderer.sendToHost('swipe', swipeDx)
      })
    }
  },
  { passive: true, capture: true }
)

// Что-то уехало вбок, пока идёт жест, — значит, пальцы листают страницу, а не историю.
const scrollLefts = new WeakMap<object, number>()
window.addEventListener(
  'scroll',
  (e) => {
    const el = e.target === document ? document.scrollingElement : (e.target as Element)
    if (!el) return
    const left = el.scrollLeft
    if (left !== (scrollLefts.get(el) ?? 0)) dropSwipe()
    scrollLefts.set(el, left)
  },
  { passive: true, capture: true }
)

// 6а. Боковые кнопки мыши («назад», «вперёд»). Chromium сам разбирает WM_XBUTTON* и отдаёт их странице как
// mouseup с button 3/4, а WM_APPCOMMAND до окна уже не доходит — поэтому win.on('app-command') их не слышит.
// Если страница отменила событие (preventDefault), кнопка ей нужна (карты, редакторы) — не трогаем, как Chrome.
// Предзагрузка идёт только в главном фрейме вкладки: нажатие над iframe сюда не попадёт.
// Наш слушатель поставлен раньше страничных, поэтому об отмене узнаём, когда событие обойдёт всех.
window.addEventListener('mouseup', (e) => {
  if (!e.isTrusted || (e.button !== 3 && e.button !== 4)) return
  const dir = e.button === 3 ? 'back' : 'forward'
  setTimeout(() => {
    if (!e.defaultPrevented) ipcRenderer.send('nav:mouse', dir)
  })
})

// 6б. Окна страницы — alert / confirm / prompt — окном Masaki, а не системным окном Windows. Как и настоящие,
// они останавливают код страницы до ответа: вопрос уходит в main синхронно (sendSync). Ответ null — main
// отказался (не главный фрейм и т. п.): тогда обычное окно браузера.
type JsAnswer = { ok: boolean; value?: string } | null
contextBridge.executeInMainWorld({
  func: (ask: (type: string, message: string, value?: string) => JsAnswer) => {
    const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt }
    const text = (m: unknown): string => (m === undefined ? '' : String(m))
    window.alert = function alert(message?: unknown): void {
      if (ask('alert', text(message)) === null) native.alert.call(window, message)
    }
    window.confirm = function confirm(message?: unknown): boolean {
      const r = ask('confirm', text(message))
      return r === null ? native.confirm.call(window, text(message)) : r.ok
    }
    window.prompt = function prompt(message?: unknown, value?: unknown): string | null {
      const r = ask('prompt', text(message), text(value))
      if (r === null) return native.prompt.call(window, text(message), text(value))
      return r.ok ? (r.value ?? '') : null
    }
  },
  args: [(type: string, message: string, value?: string): JsAnswer => ipcRenderer.sendSync('js:dialog', { type, message, value }) as JsAnswer]
})

// 7. Что играет: Media Session сайта — в мини-плеер Masaki (обложка, название, «следующий»).
// Команды мини-плеера приходят сюда (webview.send) и зовут обработчики сайта, как медиаклавиши.
let mediaRun: ((action: string, time: number) => void) | null = null
contextBridge.executeInMainWorld({
  func: installMediaHook,
  args: [
    (json: string): void => ipcRenderer.sendToHost('media', String(json).slice(0, 8000)),
    (run: (action: string, time: number) => void): void => {
      mediaRun = run
    }
  ]
})
const MEDIA_ACTIONS = new Set(['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward'])
ipcRenderer.on('media:action', (_e, action: string, time: number) => {
  if (MEDIA_ACTIONS.has(action)) mediaRun?.(action, Number(time) || 0)
})

// 8. YouCloud: мост вместо расширения (main/youcloud.ts). Говорит с сайтом языком bridge.js
// расширения — сообщениями window с меткой yc; сайт узнаёт, что он в Masaki, по host.
const YOUCLOUD = ['https://youcloud.inkerror67.workers.dev', 'http://localhost:5190']
if (YOUCLOUD.includes(location.origin)) {
  // Сразу, до первой отрисовки: сайт знает, что он в Masaki, и не рисует своего фона.
  const mark = (): void => document.documentElement?.setAttribute('data-host', 'masaki')
  if (document.documentElement) mark()
  else
    new MutationObserver((_, o) => {
      if (!document.documentElement) return
      mark()
      o.disconnect()
    }).observe(document, { childList: true })
  type Theme = { seed: string; dark: boolean }
  let theme: Theme | null = null
  type Hello = { version: string; tokens?: { kind: string; token: string; expiresIn?: number }[] } | null
  const reply = (data: Record<string, unknown>): void => window.postMessage({ yc: 'ext', ...data }, location.origin)
  const hello = (): void => {
    void ipcRenderer.invoke('yc:hello').then((h: Hello) => {
      if (!h) return
      reply({ kind: 'hello', version: h.version, host: 'masaki' })
      if (theme) reply({ kind: 'event', event: 'theme', ...theme })
      for (const t of h.tokens ?? []) reply({ kind: t.kind, token: t.token, expiresIn: t.expiresIn })
    })
  }
  const answer = (id: unknown, ask: Promise<Record<string, unknown>>): void => {
    ask.then(
      (a) => reply({ kind: 'response', id, ...(a ?? { error: 'no answer' }) }),
      (e) => reply({ kind: 'response', id, error: String(e?.message ?? e) })
    )
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return
    const d = event.data
    if (!d || typeof d !== 'object' || d.yc !== 'page') return
    if (d.kind === 'ping') hello()
    else if (d.kind === 'fetch') answer(d.id, ipcRenderer.invoke('yc:fetch', d.request))
    else if (d.kind === 'call') answer(d.id, ipcRenderer.invoke('yc:call', String(d.name)))
    else if (d.kind === 'yt-stream') answer(d.id, ipcRenderer.invoke('yc:yt-stream', String(d.videoId), !!d.fresh, !!d.live))
  })
  ipcRenderer.on('yc:token', (_e, t: { kind: string; token: string; expiresIn?: number }) => reply({ kind: t.kind, token: t.token, expiresIn: t.expiresIn }))
  ipcRenderer.on('yc:event', (_e, ev: Record<string, unknown>) => reply({ ...ev, event: ev.kind, kind: 'event' }))
  // Тема браузера: сайт берёт её цвет и светлоту (шлёт интерфейс Masaki).
  ipcRenderer.on('yc:theme', (_e, t: Theme) => {
    if (!t || typeof t.seed !== 'string') return
    theme = { seed: t.seed.slice(0, 32), dark: !!t.dark }
    reply({ kind: 'event', event: 'theme', ...theme })
  })
  hello()
}
