// У скрытого окна нет нативного hit-test для вложенного webview. Посылаем настоящий ввод
// Chromium прямо гостю: он сохраняет isTrusted, фокус полей и штатное context-menu Electron.
// Координаты относятся к viewport гостя в CSS-пикселях, без смещения webview в окне.
export async function guestMouse(app, wcId, events) {
  return app.evaluate(async ({ webContents }, { wcId, events }) => {
    const guest = webContents.fromId(wcId)
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') throw new Error('Вкладка для ввода не найдена: ' + wcId)
    const debug = guest.debugger
    const attachedHere = !debug.isAttached()
    if (attachedHere) debug.attach('1.3')
    try {
      await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      for (const event of events) await debug.sendCommand('Input.dispatchMouseEvent', event)
    } finally {
      // Подключение мог принадлежать другой проверке — чужой сеанс не закрываем.
      if (attachedHere && !guest.isDestroyed() && debug.isAttached()) debug.detach()
    }
  }, { wcId, events })
}

export async function clickGuest(app, wcId, x, y, { button = 'left', modifiers = 0 } = {}) {
  const buttons = { left: 1, right: 2, middle: 4, back: 8, forward: 16 }[button]
  if (!buttons) throw new Error('Неизвестная кнопка мыши: ' + button)
  return guestMouse(app, wcId, [
    { type: 'mouseMoved', x, y, modifiers },
    { type: 'mousePressed', x, y, button, buttons, modifiers, clickCount: 1 },
    { type: 'mouseReleased', x, y, button, buttons: 0, modifiers, clickCount: 1 }
  ])
}

/** Клавиши прямо в гостя (стрелки, Enter, Escape): настоящий ввод Chromium, фокус остаётся в поле страницы. */
export async function guestKeys(app, wcId, keys) {
  return app.evaluate(async ({ webContents }, { wcId, keys }) => {
    const guest = webContents.fromId(wcId)
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') throw new Error('Вкладка для ввода не найдена: ' + wcId)
    const codes = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27 }
    const debug = guest.debugger
    const attachedHere = !debug.isAttached()
    if (attachedHere) debug.attach('1.3')
    try {
      for (const key of keys) {
        const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] }
        // Enter — с символом, как настоящий: иначе браузер не попробует отправить форму.
        await debug.sendCommand('Input.dispatchKeyEvent', key === 'Enter' ? { type: 'keyDown', text: '\r', ...base } : { type: 'rawKeyDown', ...base })
        await debug.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      }
    } finally {
      if (attachedHere && !guest.isDestroyed() && debug.isAttached()) debug.detach()
    }
  }, { wcId, keys })
}
