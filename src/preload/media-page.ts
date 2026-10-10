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

  const media = (): HTMLMediaElement | null => {
    const all = [...document.querySelectorAll('audio, video')] as HTMLMediaElement[]
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
          playing: !!el && !el.paused,
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
  for (const type of ['play', 'pause', 'seeked', 'loadedmetadata', 'emptied', 'ratechange']) {
    document.addEventListener(type, () => send(), true)
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
