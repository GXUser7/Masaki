/// <reference types="vite/client" />
import type { MasakiApi } from '../../shared/types'

declare global {
  interface Window {
    masaki: MasakiApi
  }
}
