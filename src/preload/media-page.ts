/**
 * Что играет на странице — для мини-плеера Masaki: Media Session сайта (название, исполнитель,
 * обложка, где сейчас трек) и кнопки, которые сайт сам умеет («следующий», «предыдущий», перемотка).
 * Плееры сайтов — YouCloud, YouTube, SoundCloud, Яндекс Музыка — сообщают это системе через
 * navigator.mediaSession; здесь те же сообщения видит и Masaki, а кнопки мини-плеера зовут
 * обработчики сайта, как это делают медиаклавиши.
 *
 * Функция сериализуется (contextBridge.executeInMainWorld): всё нужное — внутри неё. Наружу уходит
 * только строка JSON через report; команды приходят через функцию, которую отдаём в listen.
 */
export function installMediaHook(report: (json: string) => void, listen: (run: (action: string, time: number) => void) => void): void {
  const MS = window.MediaSession
  if (!MS || !navigator.mediaSession) return
  const proto = MS.prototype
  const handlers = new Map<string, (details: { action: string; seekTime?: number }) => void>()
  const origSet = proto.setActionHandler
  const origPos = proto.setPositionState
  const meta = Object.getOwnPropertyDescriptor(proto, 'metadata')
  const state = Object.getOwnPropertyDescriptor(proto, 'playbackState')
  let position: { duration: number; position: number; rate: number; at: number } | null = null
  let timer = 0
  /** Плееры вне документа (new Audio() у YouCloud): слабые ссылки — брошенные сайтом пусть собирает сборщик мусора. */
  const loose = new Set<WeakRef<HTMLMediaElement>>()

  const media = (): HTMLMediaElement | null => {
    const all = [...document.querySelectorAll('audio, video')] as HTMLMediaElement[]
    for (const ref of loose) {
      const m = ref.deref()
      if (!m) loose.delete(ref)
      else if (!m.isConnected) all.push(m)
    }
    return all.find((m) => !m.paused) ?? all.find((m) => m.currentSrc) ?? null
  }

  const send = (): void => {
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      const m = navigator.mediaSession.metadata
      const art = m ? [...m.artwork] : []
      // Самая большая обложка: размеры вида «512x512», у кого их нет — последняя в списке.
      const size = (s?: string): number => Math.max(0, ...String(s ?? '').split(/\s+/).map((x) => Number(x.split('x')[0]) || 0))
      const best = art.sort((a, b) => size(b.sizes) - size(a.sizes))[0]?.src ?? ''
      const el = media()
      // Позицию сайт может и не сообщать — тогда берём её у самого <audio>/<video>.
      const pos =
        position ??
        (el && Number.isFinite(el.duration) && el.duration > 0
          ? { duration: el.duration, position: el.currentTime, rate: el.paused ? 0 : el.playbackRate, at: Date.now() }
          : null)
      report(
        JSON.stringify({
          title: m?.title ?? '',
          artist: m?.artist ?? '',
          album: m?.album ?? '',
          artwork: best,
          actions: [...handlers.keys()],
          state: navigator.mediaSession.playbackState,
          // Плеера не нашли — верим тому, что сайт говорит системе.
          playing: el ? !el.paused : navigator.mediaSession.playbackState === 'playing',
          position: pos
        })
      )
    }, 60)
  }

  proto.setActionHandler = function (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    if (handler) handlers.set(action, handler as never)
    else handlers.delete(action)
    send()
    return origSet.call(this, action, handler)
  }
  proto.setPositionState = function (s?: MediaPositionState): void {
    position = s && Number.isFinite(s.duration) ? { duration: s.duration ?? 0, position: s.position ?? 0, rate: s.playbackRate ?? 1, at: Date.now() } : null
    send()
    return origPos.call(this, s)
  }
  if (meta?.get && meta.set) {
    Object.defineProperty(proto, 'metadata', {
      configurable: true,
      enumerable: true,
      get() {
        return meta.get!.call(this)
      },
      set(v) {
        meta.set!.call(this, v)
        send()
      }
    })
  }
  if (state?.get && state.set) {
    Object.defineProperty(proto, 'playbackState', {
      configurable: true,
      enumerable: true,
      get() {
        return state.get!.call(this)
      },
      set(v) {
        state.set!.call(this, v)
        send()
      }
    })
  }
  // Пауза, перемотка, новый трек у самого плеера — тоже повод обновить мини-плеер.
  const EVENTS = ['play', 'pause', 'seeked', 'loadedmetadata', 'emptied', 'ratechange']
  for (const type of EVENTS) document.addEventListener(type, () => send(), true)
  // Плеер вне документа (YouCloud играет через new Audio()) querySelectorAll не найдёт, а его события
  // до document не доходят. Узнаём о нём, когда сайт зовёт play(), и слушаем его самого.
  const known = new WeakSet<HTMLMediaElement>()
  const origPlay = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement): Promise<void> {
    if (!this.isConnected && !known.has(this)) {
      known.add(this)
      loose.add(new WeakRef(this))
      for (const type of EVENTS) this.addEventListener(type, () => send())
    }
    return origPlay.call(this)
  }

  listen((action, time) => {
    const h = handlers.get(action)
    if (h) {
      h(action === 'seekto' ? { action, seekTime: time } : { action })
      return
    }
    // Сайт кнопок не дал: пауза и продолжение — прямо у плеера.
    const el = media()
    if (!el) return
    if (action === 'play') void el.play()
    else if (action === 'pause') el.pause()
    else if (action === 'seekto') el.currentTime = time
  })
}
