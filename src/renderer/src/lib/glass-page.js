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
// Затемнения «к фону» (градиент от прозрачного к цвету сайта под свёрнутым текстом, как «Развернуть»
// под AI-обзором Google) — тоже эффект фона, а на светлых обоях они видны тёмной плашкой. Градиент,
// все цвета которого близки к цвету сайта, снимаем у самого элемента и у его ::before / ::after
// (псевдоэлемент инлайн-стилем не поправить: ставим элементу атрибут и гасим правилом в <style>).
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
  // more — что снять заодно (у градиента «к фону» это background-image).
  const clear = (el, more = []) => put(el, [...more, ['background-color', 'transparent']])
  // Без backdrop-filter: внутри вкладки он размывает не то, что видно глазу, и полоса выходит
  // светлее страницы. Просто полупрозрачный цвет сайта — страница под шапкой не мешает тексту.
  const tint = (el, more = []) => {
    put(el, [...more, ['background-color', `rgba(${barRgb.join(',')}, .62)`]])
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
    // prefers-color-scheme — предпочтение пользователя, а не тема сайта. У многих светлых
    // сайтов (например, Antigravity) html/body прозрачны даже в тёмном браузере: их подложка —
    // обычный светлый Canvas. Системный CSS-цвет учитывает именно color-scheme документа,
    // включая normal, dark и light dark, а также повышенную контрастность Windows.
    const probe = document.createElement('span')
    probe.style.cssText = 'display:none!important;background-color:Canvas!important;color-scheme:inherit!important'
    document.documentElement.appendChild(probe)
    const canvas = rgba(getComputedStyle(probe).backgroundColor)
    probe.remove()
    return canvas ? canvas.rgb : [255, 255, 255]
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

  // ---- Затемнения «к фону»: градиенты и ::before / ::after ----
  const ATTR = 'data-masaki-glass-pseudo' // какие псевдоэлементы элемента гасим: "before after"
  const PSEUDO_CSS = `[${ATTR}~="before"]::before,[${ATTR}~="after"]::after{background-image:none!important;background-color:transparent!important}`
  const styled = new Map() // корень (document или shadowRoot) → наш <style> с правилом выше
  const ensureStyle = (el) => {
    const root = el.getRootNode()
    const host = root instanceof ShadowRoot ? root : document // в shadow DOM правила документа не действуют
    if (styled.has(host)) return
    const st = document.createElement('style')
    st.textContent = PSEUDO_CSS
    const where = host === document ? document.head || document.documentElement : host
    where.appendChild(st)
    styled.set(host, st)
  }

  const GRADIENT = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/
  const COLOR = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|\btransparent\b/g
  // background-image делим по запятым верхнего уровня: слоёв может быть несколько.
  const layersOf = (s) => {
    const list = []
    let depth = 0
    let from = 0
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === ',' && depth === 0) {
        list.push(s.slice(from, i).trim())
        from = i + 1
      }
    }
    list.push(s.slice(from).trim())
    return list
  }
  const fades = new Map() // строка background-image → «градиент к фону»; своя для каждого base
  // «Градиент к фону»: только градиенты (ни одного url()), и все видимые остановки близки к цвету
  // фона сайта. Альфа любая: от прозрачного к base — затемнение, и оно же эффект самого фона.
  const fadeToBase = (img) => {
    let v = fades.get(img)
    if (v !== undefined) return v
    const layers = layersOf(img)
    v = layers.every((l) => GRADIENT.test(l))
    let stops = 0
    if (v) {
      for (const l of layers) {
        for (const m of l.match(COLOR) || []) {
          const c = rgba(m)
          if (!c) continue // полностью прозрачная остановка цвета не несёт: градиенты считаются с предумножением
          stops++
          if (!near(c.rgb, 22)) v = false
        }
      }
    }
    v = v && stops > 0
    fades.set(img, v)
    return v
  }
  // Под градиентом пусто или тот же цвет сайта; иначе это карточка своего цвета с затемнением.
  const bgNear = (st) => {
    const c = rgba(st.backgroundColor)
    return !c || near(c.rgb, 22)
  }
  // Затемнение поверх видео (полоса управления плеера) — не фон: без него кнопки не видно на светлом кадре.
  const overVideo = (r) => {
    for (const v of document.getElementsByTagName('video')) {
      const q = v.getBoundingClientRect()
      const w = Math.min(r.right, q.right) - Math.max(r.left, q.left)
      const h = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top)
      if (w > 0 && h > 0 && w * h >= r.width * r.height * 0.5) return true
    }
    return false
  }
  const pseudoHit = (el, which) => {
    const ps = getComputedStyle(el, which)
    // Сначала content: у подавляющего большинства элементов псевдоэлемента нет — отсев почти бесплатный.
    if (ps.content === 'none' || ps.content === 'normal') return false
    if (ps.backgroundImage !== 'none') return ps.backgroundClip !== 'text' && fadeToBase(ps.backgroundImage) && bgNear(ps)
    // Сплошная полоса цвета сайта поверх элемента — тоже затемнение; точки и галочки (маленькие) не трогаем.
    const c = rgba(ps.backgroundColor)
    if (!c || c.a < 0.5 || !near(c.rgb, 22) || ps.position !== 'absolute') return false
    return parseFloat(ps.width) >= el.getBoundingClientRect().width * 0.5
  }
  const markPseudo = (el, cs) => {
    if (cs.display === 'none') return
    const b = pseudoHit(el, '::before')
    const a = pseudoHit(el, '::after')
    if ((!b && !a) || overVideo(el.getBoundingClientRect())) return
    ensureStyle(el)
    el.setAttribute(ATTR, b && a ? 'before after' : b ? 'before' : 'after')
  }
  const unmarkPseudo = () => {
    styled.forEach((st, host) => {
      host.querySelectorAll(`[${ATTR}]`).forEach((e) => e.removeAttribute(ATTR))
      st.remove()
    })
    styled.clear()
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
    // В полосе (шапка, боковое меню) мягкая сила не трогает ничего — как и раньше.
    const touch = !next.bar || strong
    if (!saved.has(el)) {
      const img = cs.backgroundImage
      if (img === 'none') {
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
            // Размер сам по себе не делает секцию фоном сайта: на светлых лендингах бывают
            // большие тёмные блоки с белым текстом (и наоборот). Их собственный фон сохраняем.
            const hit = near(c.rgb, strong ? 22 : 6) && (strong || large(r))
            if (hit) clear(el)
          }
        }
      } else if (touch && (next.bar || cs.boxShadow === 'none') && cs.backgroundClip !== 'text' && fadeToBase(img) && bgNear(cs)) {
        // Градиент «к фону» (не карточка с тенью и не затемнение видео): снимаем и его, и цвет под ним.
        const r = el.getBoundingClientRect()
        if (!overVideo(r) && !playerBox(el, r)) {
          const drop = [['background-image', 'none']]
          if (next.bar) {
            const b = next.bar
            if (!next.tinted && r.width * r.height >= b.width * b.height * 0.5) {
              tint(el, drop)
              next = { bar: b, tinted: true }
            } else clear(el, drop)
          } else clear(el, drop)
        }
      }
    }
    if (touch) markPseudo(el, cs)
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
      .filter((a) => a.name !== 'style' && a.name !== ATTR) // свои пометки темой сайта не считаем
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
      fades.clear() // «близко к фону» считается от base — у другого base ответы другие
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
      unmarkPseudo()
      fades.clear()
      base = null
    }
  }
  window.__masakiGlass = api
})()
