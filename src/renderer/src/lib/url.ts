// Превращаем ввод из палитры в адрес: сайт, поиск Google или AI Mode.

export const NEWTAB_URL = 'masaki://newtab'
export const SETTINGS_URL = 'masaki://settings'
export const ADDONS_URL = 'masaki://addons'
export const PASSWORDS_URL = 'masaki://passwords'

export function searchUrl(q: string): string {
  return 'https://www.google.com/search?q=' + encodeURIComponent(q)
}

/** AI Mode — тот же режим, что в поиске Chrome (udm=50). Пустой запрос открывает его стартовую страницу. */
export function aiModeUrl(q: string): string {
  return q.trim() ? 'https://www.google.com/search?udm=50&q=' + encodeURIComponent(q) : 'https://www.google.com/ai'
}

const SCHEME = /^(https?|file|view-source|about|data|chrome|masaki):/i

export function looksLikeAddress(text: string): boolean {
  const t = text.trim()
  if (!t || /\s/.test(t)) return false
  if (SCHEME.test(t)) return true
  if (/^localhost(:\d+)?(\/.*)?$/i.test(t)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(t)) return true
  return /^[^./:]+(\.[^./:]+)*\.[a-zа-яё]{2,}(:\d+)?([/?#].*)?$/i.test(t)
}

export function resolveInput(text: string, ai: boolean): string {
  const t = text.trim()
  if (!t) return ai ? aiModeUrl('') : NEWTAB_URL
  if (SCHEME.test(t)) return t
  if (looksLikeAddress(t)) return (/^(localhost|\d)/i.test(t) ? 'http://' : 'https://') + t
  return ai ? aiModeUrl(t) : searchUrl(t)
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

/** Текст для адресной строки: без https:// и хвостового слэша, как в Chrome. */
export function displayUrl(url: string): string {
  if (url === NEWTAB_URL) return ''
  return url.replace(/^https:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
}

/** Если открыт поиск Google или AI Mode, показываем запрос, а не длинный адрес. */
export function searchQueryOf(url: string): { q: string; ai: boolean } | null {
  try {
    const u = new URL(url)
    if (!/(^|\.)google\.[a-z.]+$/.test(u.hostname) || u.pathname !== '/search') return null
    const q = u.searchParams.get('q')
    if (!q) return null
    return { q, ai: u.searchParams.get('udm') === '50' }
  } catch {
    return null
  }
}

export function letterOf(title: string, url: string): string {
  const src = title.trim() || hostOf(url)
  const ch = src.replace(/^www\./, '').charAt(0)
  return ch ? ch.toUpperCase() : '•'
}
