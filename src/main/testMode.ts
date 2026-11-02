import type { BrowserWindow } from 'electron'

// Скрытый режим разрешён только с отдельным профилем: обычный запуск остаётся видимым.
export const testHeadless = !!process.env.MASAKI_PROFILE && process.env.MASAKI_TEST_HEADLESS === '1'

/** Автотест (свой профиль, окно без фокуса): камера и микрофон — подставные Chromium, настоящие не включаются. */
export const testFakeMedia = !!process.env.MASAKI_PROFILE && !!process.env.MASAKI_TEST_INACTIVE

/**
 * Автотест на Linux без связки ключей (CI, контейнер): safeStorage шифрует «как есть», иначе пароли, ключи
 * доступа и вход в синхронизацию не сохранить. Включается до чтения профиля, только с тестовым профилем и
 * флагом MASAKI_TEST_PLAIN_STORAGE; на Windows (DPAPI) и Mac не нужно и ничего не меняет.
 */
export const testPlainStorage = !!process.env.MASAKI_PROFILE && process.platform === 'linux' && process.env.MASAKI_TEST_PLAIN_STORAGE === '1'

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
