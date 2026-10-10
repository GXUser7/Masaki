// Перенос из Chrome: закладки, ярлыки новой вкладки и история.
// Только то, что Chrome хранит открыто. Пароли и куки Chrome шифрует для себя одного —
// их не трогаем: войти на сайты в Masaki нужно самому (вход в Google сохраняется).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import type { ChromeProfile, HistoryEntry, Shortcut } from '../shared/types'

// MASAKI_CHROME_DIR — тестовая папка вместо настоящего Chrome (scripts/import-test.mjs).
const root = (): string =>
  process.env.MASAKI_CHROME_DIR ??
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
    : path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data'))
const web = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

interface BookmarkNode {
  type?: string
  name?: string
  url?: string
  children?: BookmarkNode[]
}

/** Все закладки по порядку: панель закладок, «Другие», с телефона. Папки раскрываются. */
export function chromeBookmarks(dir: string): Shortcut[] {
  const data = readJson(path.join(root(), dir, 'Bookmarks')) as { roots?: Record<string, BookmarkNode> } | null
  const out: Shortcut[] = []
  const seen = new Set<string>()
  const walk = (node: BookmarkNode | undefined): void => {
    for (const ch of node?.children ?? []) {
      if (ch.type === 'url') {
        if (web(ch.url) && !seen.has(ch.url)) {
          seen.add(ch.url)
          out.push({ title: ch.name?.trim() || ch.url, url: ch.url })
        }
      } else walk(ch)
    }
  }
  for (const key of ['bookmark_bar', 'other', 'synced']) walk(data?.roots?.[key])
  return out
}

/** Ярлыки, которые пользователь сам добавил на новую вкладку Chrome. */
export function chromeShortcuts(dir: string): Shortcut[] {
  const prefs = readJson(path.join(root(), dir, 'Preferences')) as { custom_links?: { list?: { title?: string; url?: string }[] } } | null
  return (prefs?.custom_links?.list ?? []).filter((l) => web(l.url)).map((l) => ({ title: l.title?.trim() || l.url!, url: l.url! }))
}

/** Профили Chrome с тем, что из них можно перенести. */
export function chromeProfiles(): ChromeProfile[] {
  const state = readJson(path.join(root(), 'Local State')) as { profile?: { info_cache?: Record<string, { name?: string }> } } | null
  let dirs = Object.keys(state?.profile?.info_cache ?? {})
  if (dirs.length === 0) {
    try {
      dirs = fs.readdirSync(root()).filter((d) => d === 'Default' || /^Profile \d+$/.test(d))
    } catch {
      return [] // Chrome не установлен
    }
  }
  return dirs
    .filter((dir) => fs.existsSync(path.join(root(), dir)))
    .map((dir) => ({
      dir,
      name: state?.profile?.info_cache?.[dir]?.name || dir,
      bookmarks: chromeBookmarks(dir).length,
      shortcuts: chromeShortcuts(dir).length,
      history: fs.existsSync(path.join(root(), dir, 'History'))
    }))
}

/**
 * Последние посещённые страницы. Chrome держит базу открытой, поэтому читаем её копию.
 * Бросает понятную ошибку, если Chrome не даёт скопировать файл.
 */
export function chromeHistory(dir: string, limit: number): HistoryEntry[] {
  const tmp = path.join(os.tmpdir(), `masaki-chrome-history-${process.pid}-${Date.now()}`)
  try {
    fs.copyFileSync(path.join(root(), dir, 'History'), tmp)
  } catch {
    throw new Error('Chrome не отдаёт историю — закройте его и попробуйте ещё раз')
  }
  try {
    const db = new DatabaseSync(tmp, { readOnly: true })
    try {
      const rows = db
        // Время в Chrome — микросекунды от 1601 года; переводим в миллисекунды Unix прямо в SQL,
        // потому что сырое значение не помещается в обычное число JavaScript.
        .prepare(
          'SELECT url, title, last_visit_time / 1000 - 11644473600000 AS t FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ?'
        )
        .all(limit * 2) as { url: string; title: string | null; t: number }[]
      return rows
        .filter((r) => web(r.url))
        .slice(0, limit)
        .map((r) => ({ url: r.url, title: r.title ?? '', time: r.t }))
        .reverse()
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}
