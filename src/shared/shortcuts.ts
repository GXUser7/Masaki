import type { Command } from './types'

// Таблица горячих клавиш, общая для главного процесса (нажатия во вкладках)
// и интерфейса (запасной путь, когда фокус в самом окне Masaki).
// Сравниваем по code, чтобы Ctrl+T и прочие работали и на русской раскладке.

export interface KeyInput {
  code: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

export function commandFor(input: KeyInput): Command | null {
  const ctrl = input.ctrl || input.meta
  const { shift, alt, code } = input

  if (ctrl && !alt) {
    switch (code) {
      case 'KeyT':
        return shift ? { type: 'reopen-tab' } : { type: 'new-tab' }
      case 'KeyW':
      case 'F4':
        return { type: 'close-tab' }
      case 'KeyL':
        return { type: 'palette', withUrl: true }
      case 'KeyK':
      case 'KeyE':
        return { type: 'palette', withUrl: false }
      case 'KeyB':
        return { type: 'toggle-sidebar' }
      case 'Tab':
        return shift ? { type: 'prev-tab' } : { type: 'next-tab' }
      case 'PageDown':
        return { type: 'next-tab' }
      case 'PageUp':
        return { type: 'prev-tab' }
      case 'KeyR':
        return { type: 'reload', hard: shift }
      case 'F5':
        return { type: 'reload', hard: true }
      case 'KeyF':
        return { type: 'find' }
      case 'Equal':
      case 'NumpadAdd':
        return { type: 'zoom', delta: 1 }
      case 'Minus':
      case 'NumpadSubtract':
        return { type: 'zoom', delta: -1 }
      case 'Digit0':
      case 'Numpad0':
        return { type: 'zoom', delta: 0 }
      case 'Comma':
        return { type: 'settings' }
      case 'KeyU':
        return { type: 'view-source' }
      case 'KeyP':
        return shift ? null : { type: 'print' }
      case 'KeyI':
        return shift ? { type: 'devtools' } : null
      case 'KeyA':
        return shift ? { type: 'tab-search' } : null
      case 'KeyS':
        return shift ? null : { type: 'save-page' }
    }
    if (/^Digit[1-9]$/.test(code)) {
      const n = Number(code.slice(5))
      return { type: 'tab-index', index: n === 9 ? -1 : n - 1 }
    }
  }
  if (alt && !ctrl && !shift) {
    if (code === 'ArrowLeft') return { type: 'back' }
    if (code === 'ArrowRight') return { type: 'forward' }
    if (code === 'KeyD') return { type: 'palette', withUrl: true }
  }
  if (!ctrl && !alt) {
    if (code === 'F5') return { type: 'reload' }
    if (code === 'F6') return { type: 'palette', withUrl: true }
    if (code === 'F3') return { type: 'find' }
    if (code === 'F12') return { type: 'devtools' }
  }
  return null
}
