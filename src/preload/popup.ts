import { contextBridge } from 'electron'

// Всплывающие окна сайтов из вкладок (вход через Google, оплата): окно остаётся окном, чтобы работал
// window.opener. Здесь — только то, без чего не пустит вход Google; остальное (пароли, плеер) живёт во вкладках.
// Скрипт зарегистрирован на всю сессию вкладок (index.ts): во вкладках он повторяет пункт 1 guest.ts, а в
// iframe accounts.google.com на чужом сайте не работает — там navigator остаётся как у вкладки.
//
// Общий код с guest.ts сюда не импортировать: Vite вынесет его в отдельный файл, а preload в песочнице
// подключать файлы не умеет — упали бы оба скрипта.
if (window.top === window && location.hostname === 'accounts.google.com') {
  // Заголовки и navigator.userAgent для входа Google подменяет главный процесс (Firefox ESR), а
  // navigator.userAgentData есть только у Chromium — у «Firefox» его быть не должно.
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
