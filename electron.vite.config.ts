import fs from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Ключ Google для синхронизации, вшиваемый в сборку: с ним пользователю не нужен свой проект в Google Cloud.
 * Берётся из переменных MASAKI_GOOGLE_CLIENT_ID/SECRET (сборка на GitHub) или из JSON клиента «Desktop app»,
 * скачанного из Google Cloud и положенного в корень проекта (google-oauth.json или client_secret_*.json).
 * Оба файла в .gitignore: в публичный репозиторий ключ не попадает. Нет ключа — синхронизация просит свой.
 */
function googleClient(): { id: string; secret: string } | null {
  const id = process.env.MASAKI_GOOGLE_CLIENT_ID?.trim()
  const secret = process.env.MASAKI_GOOGLE_CLIENT_SECRET?.trim()
  if (id && secret) return { id, secret }
  const file = ['google-oauth.json', ...fs.readdirSync(__dirname).filter((f) => /^client_secret_.*\.json$/.test(f))].find((f) =>
    fs.existsSync(resolve(__dirname, f))
  )
  if (!file) return null
  const c = JSON.parse(fs.readFileSync(resolve(__dirname, file), 'utf8')).installed
  if (!c?.client_id || !c.client_secret) throw new Error(`${file}: нужен JSON OAuth-клиента типа «Desktop app»`)
  return { id: c.client_id, secret: c.client_secret }
}

export default defineConfig({
  main: {
    define: { __GOOGLE_CLIENT__: JSON.stringify(googleClient()) }
  },
  preload: {
    build: {
      rollupOptions: {
        // index — мост для интерфейса Masaki, guest — маленький скрипт для страниц во вкладках.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          guest: resolve(__dirname, 'src/preload/guest.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
})
