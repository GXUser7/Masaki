// Скрипт аддона «Прозрачные сайты». Выполняется внутри страницы во вкладке: ставится один раз
// и даёт window.__masakiGlass.apply(strong, panel) / remove(). apply возвращает исходный цвет фона
// сайта «r,g,b» — Masaki подкладывает его полупрозрачным слоем под страницу, чтобы текст читался.
// panel — режим «как у панели»: { rgb, dark } — цвет стекла боковой панели и тёмная ли тема.
//
// Как решаем, что делать прозрачным: фон сайта — это цвет html/body (или обёртки приложения).
// Всё, что залито тем же цветом, — тоже «фон», его снимаем. Карточки, кнопки и прочее со своим
// цветом остаются. Всплывающие окна (диалоги, меню, баннеры) не трогаем вовсе — иначе их текст
// ляжет прямо на страницу. Шапки и боковые меню, под которыми прокручивается страница, делаем
// полупрозрачными, а не голыми.
;(() => {
  if (window.__masakiGlass) return

  const SKIP = new Set(['VIDEO', 'CANVAS', 'IMG', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT'])
  const OVERLAY = 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true],[role=menu],[role=listbox],[role=tooltip],[popover]'

  let base = null // [r, g, b]
  let strong = false
  let panel = null // { rgb, dark } или null
  let barRgb = null // чем красим шапки и боковые меню сайта
  let rootSign = ''
  const saved = new Map() // элемент → исходные значения свойств, которые мы перебили
  const tinted = new WeakSet()

  // Любой цвет из getComputedStyle (rgb, oklch, color(...)) → {rgb, a} через 1×1 canvas.
  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const colors = new Map()
  const rgba = (c) => {
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null
    let v = colors.get(c)
    if (v !== undefined) return v
    const m = /^rgba?\(([^)]+)\)$/.exec(c)
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      v = { rgb: p.slice(0, 3).map(Math.round), a: p.length > 3 ? p[3] : 1 }
    } else {
      cx.clearRect(0, 0, 1, 1)
      cx.fillStyle = '#0000'
      cx.fillStyle = c
      cx.fillRect(0, 0, 1, 1)
      const d = cx.getImageData(0, 0, 1, 1).data
      v = { rgb: [d[0], d[1], d[2]], a: d[3] / 255 }
    }
    if (v.a === 0) v = null
    colors.set(c, v)
    return v
  }
  const isDark = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128
  const near = (rgb, t) => Math.max(Math.abs(rgb[0] - base[0]), Math.abs(rgb[1] - base[1]), Math.abs(rgb[2] - base[2])) <= t

  const put = (el, props) => {
    if (!saved.has(el)) saved.set(el, props.map(([p]) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]))
    for (const [p, v] of props) el.style.setProperty(p, v, 'important')
  }
  const clear = (el) => put(el, [['background-color', 'transparent']])
  // Без backdrop-filter: внутри вкладки он размывает не то, что видно глазу, и полоса выходит
  // светлее страницы. Просто полупрозрачный цвет сайта — страница под шапкой не мешает тексту.
  const tint = (el) => {
    put(el, [['background-color', `rgba(${barRgb.join(',')}, .62)`]])
    tinted.add(el)
  }

  const readBase = () => {
    for (const el of [document.body, document.documentElement]) {
      const c = el && rgba(getComputedStyle(el).backgroundColor)
      if (c && c.a > 0.85) return c.rgb
    }
    // Бывает, что фон задан у обёртки приложения: берём крупный непрозрачный элемент в центре.
    for (const el of document.elementsFromPoint(innerWidth / 2, innerHeight / 2)) {
      const r = el.getBoundingClientRect()
      if (r.width < innerWidth * 0.6 || r.height < innerHeight * 0.45) continue
      const c = rgba(getComputedStyle(el).backgroundColor)
      if (c && c.a > 0.85) return c.rgb
    }
    return matchMedia('(prefers-color-scheme: dark)').matches ? [24, 24, 28] : [255, 255, 255]
  }

  // Где лежит элемент сам по себе: в обычной вёрстке, в «полосе» (шапка или боковое меню,
  // под которыми едет страница) или во всплывающем окне.
  const kindOf = (el, cs) => {
    if (el.matches(OVERLAY)) return 'overlay'
    const pos = cs.position
    if (pos === 'sticky') return 'bar'
    if (pos !== 'fixed' && !(pos === 'absolute' && cs.boxShadow !== 'none')) return 'flow'
    const r = el.getBoundingClientRect()
    const W = innerWidth
    const H = innerHeight
    if (r.width >= W * 0.9 && r.height >= H * 0.9) return 'flow' // обёртка приложения на весь экран
    if (pos === 'fixed' && r.top <= 4 && r.width >= W * 0.5 && r.height <= H * 0.3) return 'bar'
    if (pos === 'fixed' && r.left <= 4 && r.height >= H * 0.6 && r.width <= W * 0.4) return 'bar'
    return 'overlay'
  }
  const large = (r) => r.width >= innerWidth * 0.6 && r.height >= innerHeight * 0.45
  // Чёрная подложка плеера нужна: видео не всегда заполняет её целиком.
  const playerBox = (el, r) => {
    const v = el.querySelector('video')
    if (!v) return false
    const q = v.getBoundingClientRect()
    return r.width * r.height <= q.width * q.height * 2 + 1
  }

  let seen = new WeakSet()
  // ctx: { bar: прямоугольник полосы или null, tinted: в полосе уже есть матовый слой }
  const visit = (el, ctx) => {
    if (seen.has(el) || SKIP.has(el.tagName) || el instanceof SVGElement) return
    seen.add(el)
    const cs = getComputedStyle(el)
    const kind = kindOf(el, cs)
    if (kind === 'overlay') return
    let next = ctx
    if (kind === 'bar' && !ctx.bar) next = { bar: el.getBoundingClientRect(), tinted: false }
    if (!saved.has(el) && cs.backgroundImage === 'none') {
      const c = rgba(cs.backgroundColor)
      if (c) {
        const r = el.getBoundingClientRect()
        if (next.bar) {
          if (strong && c.a >= 0.5 && near(c.rgb, 22)) {
            const b = next.bar
            if (!next.tinted && r.width * r.height >= b.width * b.height * 0.5) {
              tint(el)
              next = { bar: b, tinted: true }
            } else clear(el)
          }
        } else if (c.a >= 0.85 && cs.boxShadow === 'none' && !playerBox(el, r)) {
          const hit = strong ? near(c.rgb, 22) || large(r) : near(c.rgb, 6) && large(r)
          if (hit) clear(el)
        }
      }
    }
    for (const ch of el.children) visit(ch, next)
    if (el.shadowRoot) for (const ch of el.shadowRoot.children) visit(ch, next)
  }

  // Контекст для узла, добавленного позже: смотрим на его предков.
  const contextOf = (el) => {
    let bar = null
    let isTinted = false
    for (let a = el; a && a !== document.documentElement; a = a.parentElement || a.getRootNode().host) {
      if (a === document.body) continue
      const kind = kindOf(a, getComputedStyle(a))
      if (kind === 'overlay') return null
      if (kind === 'bar') bar = a.getBoundingClientRect()
      if (tinted.has(a)) isTinted = true
    }
    return { bar, tinted: isTinted }
  }

  const sign = () => {
    const h = document.documentElement
    return [...h.attributes, ...(document.body ? document.body.attributes : [])]
      .filter((a) => a.name !== 'style')
      .map((a) => a.name + '=' + a.value)
      .join(' ')
  }
  // Без лишних записей: каждая запись в style у html — это событие для нашего же наблюдателя.
  const putRoot = () => {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue
      const st = el.style
      if (st.getPropertyValue('background-color') === 'transparent' && st.getPropertyPriority('background-color') === 'important' &&
          st.getPropertyValue('background-image') === 'none') continue
      put(el, [['background-color', 'transparent'], ['background-image', 'none']])
    }
  }
  const scanAll = () => {
    seen = new WeakSet()
    putRoot()
    if (document.body) for (const ch of document.body.children) visit(ch, { bar: null, tinted: false })
  }

  let queue = new Set()
  let timer = 0
  const flush = () => {
    timer = 0
    const nodes = queue
    queue = new Set()
    // Сменилась тема сайта (атрибуты html/body) — фон другой, пересчитываем всё.
    if (sign() !== rootSign) {
      const s = strong
      const p = panel
      api.remove()
      api.apply(s, p)
      return
    }
    putRoot() // сайт мог переписать атрибут style у html/body
    seen = new WeakSet()
    for (const n of nodes) {
      if (!n.isConnected) continue
      const ctx = contextOf(n.parentElement || n.getRootNode().host)
      if (ctx) visit(n, ctx)
    }
  }
  const later = () => {
    if (!timer) timer = setTimeout(flush, 300)
  }
  // Новые узлы — по всей странице; смена темы и переписанный style — только у html и body.
  const nodesObs = new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) queue.add(n)
    later()
  })
  const rootObs = new MutationObserver(later)
  let watching = false

  const api = {
    apply(s, p = null) {
      const same = JSON.stringify(p) === JSON.stringify(panel)
      if (base && s === strong && same) return base.join(',')
      if (base) api.remove()
      strong = s
      panel = p
      base = readBase()
      // «Как у панели»: шапки и меню сайта — цветом панели, если сайт той же светлоты, что тема.
      // Светлый сайт в тёмной теме (и наоборот) остаётся на своём цвете, иначе пропадёт текст.
      barRgb = p && isDark(base) === p.dark ? p.rgb : base
      rootSign = sign()
      scanAll()
      nodesObs.observe(document.documentElement, { childList: true, subtree: true })
      for (const el of [document.documentElement, document.body]) if (el) rootObs.observe(el, { attributes: true })
      watching = true
      return base.join(',')
    },
    remove() {
      if (watching) {
        nodesObs.disconnect()
        rootObs.disconnect()
      }
      watching = false
      clearTimeout(timer)
      timer = 0
      queue.clear()
      saved.forEach((list, el) => {
        for (const [p, v, pr] of list) v ? el.style.setProperty(p, v, pr) : el.style.removeProperty(p)
      })
      saved.clear()
      base = null
    }
  }
  window.__masakiGlass = api
})()
