import type { BrowserWindow } from 'electron'

// Скрытый режим разрешён только с отдельным профилем: обычный запуск остаётся видимым.
export const testHeadless = !!process.env.MASAKI_PROFILE && process.env.MASAKI_TEST_HEADLESS === '1'

/** Автотест (свой профиль, окно без фокуса): камера и микрофон — подставные Chromium, настоящие не включаются. */
export const testFakeMedia = !!process.env.MASAKI_PROFILE && !!process.env.MASAKI_TEST_INACTIVE

/** Попапы расширений тоже не должны показываться или забирать фокус во время проверки. */
export function keepTestWindowHidden(window: BrowserWindow): void {
  if (!testHeadless) return
  window.setSkipTaskbar(true)
  window.webContents.backgroundThrottling = false
  window.show = () => {}
  window.showInactive = () => {}
  window.focus = () => {}
  window.on('show', () => window.hide())
}
