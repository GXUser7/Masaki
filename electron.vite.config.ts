import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
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
