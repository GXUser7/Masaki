import { contextBridge } from 'electron'

// Всплывающие окна сайтов из вкладок (вход через Google, оплата): окно остаётся окном, чтобы работал
// window.opener. Здесь — только то, без чего не пустит вход Google; остальное (пароли, плеер) живёт во вкладках.
// Скрипт зарегистрирован на всю сессию вкладок (index.ts), а в
// iframe accounts.google.com на чужом сайте не работает — там navigator остаётся как у вкладки.
//
// Общий код с guest.ts сюда не импортировать: Vite вынесет его в отдельный файл, а preload в песочнице
// подключать файлы не умеет — упали бы оба скрипта.
if (window.top === window && location.hostname === 'accounts.google.com') {
  // Смена UA в did-start-navigation была слишком поздней для первого документа новой вкладки/окна.
  // Согласуем navigator с заголовком до любого скрипта Google, без повторной загрузки формы входа.
  contextBridge.executeInMainWorld({
    func: () => {
      try {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
        const values = { userAgent: ua, appVersion: '5.0 (Windows)', vendor: '', userAgentData: undefined }
        for (const [key, value] of Object.entries(values)) {
          Object.defineProperty(Navigator.prototype, key, { get: () => value, configurable: true })
        }
      } catch {
        // свойство уже переопределено
      }
    }
  })
}
