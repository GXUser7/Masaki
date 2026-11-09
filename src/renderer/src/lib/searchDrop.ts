import { useEffect, useRef, useState, type DragEvent, type HTMLAttributes } from 'react'
import { useStore } from '../store'

const LIMIT = 20 * 1024 * 1024
const INTERNAL_DRAG = 'application/x-masaki-reorder'

/** WebP/GIF/AVIF тоже нужны поиску: декодирует Chromium, в Lens уходит ограниченная копия PNG. */
export async function normalizeSearchImage(source: string): Promise<string | null> {
  try {
    const image = new Image()
    image.src = source
    await image.decode()
    // PNG/JPEG оставляем исходными: уменьшение большого файла перед POST выполняет lensBody в main.
    if (/^data:image\/(png|jpeg);base64,/i.test(source)) return source
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } catch { return null }
}

export function canSearchDrop(data: DataTransfer): boolean {
  return !data.types.includes(INTERNAL_DRAG) && (data.types.includes('Files') || data.types.some((t) => ['text/plain', 'text/uri-list', 'text/html'].includes(t)))
}

/** Считываем DataTransfer сразу: после await Chromium уже очищает данные жеста. HTML не вставляем в DOM. */
export function readSearchDrop(data: DataTransfer): Promise<{ text: string; image?: string } | null> {
  const file = [...data.files].find((f) => f.type.startsWith('image/'))
  if (file) {
    if (file.size > LIMIT) return Promise.resolve(null)
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result !== 'string') return resolve(null)
        void normalizeSearchImage(reader.result).then((image) => resolve(image ? { text: '', image } : null))
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
  }
  const html = data.getData('text/html').slice(0, 1_000_000)
  const fragment = html ? new DOMParser().parseFromString(html, 'text/html') : null
  // Выделение текста может содержать встроенную иконку: такой жест остаётся текстовым поиском.
  const src = !fragment?.body.textContent?.trim() ? fragment?.querySelector('img')?.getAttribute('src') : null
  const uri = data.getData('text/uri-list').split(/\r?\n/).find((s) => s && !s.startsWith('#')) ?? ''
  const text = (data.getData('text/plain') || uri).trim().slice(0, 10_000)
  const imageUrl = src || (/^data:image\//i.test(uri || text) ? uri || text : '')
  if (imageUrl && /^(https?:\/\/|data:image\/|blob:https?:\/\/)/i.test(imageUrl)) {
    return window.masaki.searchImage(imageUrl)
      .then((image) => image ? normalizeSearchImage(image) : null)
      .then((image) => image ? { text: '', image } : null)
  }
  return Promise.resolve(text ? { text } : null)
}

/** Док и панель принимают выделение, ссылку, файл картинки и картинку со страницы. */
export function useSearchDrop(): { active: boolean; props: HTMLAttributes<HTMLElement> } {
  const [active, setActive] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const end = (): void => setActive(false)
    window.addEventListener('dragend', end)
    return () => { generation.current++; window.removeEventListener('dragend', end) }
  }, [])
  const over = (e: DragEvent<HTMLElement>): void => {
    if (e.defaultPrevented || !canSearchDrop(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setActive(true)
  }
  return { active, props: {
    onDragEnter: over,
    onDragOver: over,
    onDragLeave: (e) => {
      if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setActive(false)
    },
    onDrop: (e) => {
      setActive(false)
      if (e.defaultPrevented || !canSearchDrop(e.dataTransfer)) return
      e.preventDefault()
      const request = ++generation.current
      const sourceTab = useStore.getState().activeId
      void readSearchDrop(e.dataTransfer).then((content) => {
        if (request !== generation.current) return
        const s = useStore.getState()
        if (s.activeId !== sourceTab) return
        if (!content) {
          s.showCopied({ title: 'Не удалось добавить картинку', text: 'Нужен файл изображения до 20 МБ или доступная картинка со страницы.' })
          return
        }
        s.openPalette(false, 'new', content.text, content.image ? true : undefined, content.image)
      }).catch(() => {
        if (request === generation.current) useStore.getState().showCopied({ title: 'Не удалось добавить картинку', text: 'Попробуйте перетащить сохранённый файл.' })
      })
    }
  } }
}
