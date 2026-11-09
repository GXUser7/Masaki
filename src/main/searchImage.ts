import { nativeImage, type Session } from 'electron'

const LIMIT = 20 * 1024 * 1024

/** Загрузка только по жесту в доверенном интерфейсе. Ограничиваем и скачивание, и декодирование. */
export async function searchImage(ses: Session, source: string): Promise<string | null> {
  if (source.length > LIMIT * 1.4) return null
  try {
    let bytes: Buffer
    let mime = ''
    const dataType = /^data:(image\/[\w.+-]+);base64,/i.exec(source)
    if (dataType) {
      mime = dataType[1].toLowerCase()
      bytes = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
    } else {
      const url = new URL(source)
      if (!['http:', 'https:', 'blob:'].includes(url.protocol) || url.username || url.password) return null
      const response = await ses.fetch(source, { signal: AbortSignal.timeout(15_000) })
      mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!response.ok || Number(response.headers.get('content-length')) > LIMIT || !response.body) {
        await response.body?.cancel()
        return null
      }
      const chunks: Buffer[] = []
      let size = 0
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > LIMIT) { await reader.cancel(); return null }
        chunks.push(Buffer.from(value))
      }
      bytes = Buffer.concat(chunks)
    }
    if (!bytes.length || bytes.length > LIMIT) return null
    const image = nativeImage.createFromBuffer(bytes)
    // NativeImage понимает PNG/JPEG, но не все веб-форматы. Их декодирует Chromium
    // в renderer и превращает в PNG до показа в палитре/передачи Lens.
    if (image.isEmpty()) {
      return ['image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/svg+xml', 'image/x-icon'].includes(mime)
        ? `data:${mime};base64,${bytes.toString('base64')}` : null
    }
    const { width, height } = image.getSize()
    // В палитру и Lens передаём ограниченную копию, исходный файл не меняем.
    return Math.max(width, height) > 1600
      ? image.resize(width >= height ? { width: 1600 } : { height: 1600 }).toDataURL()
      : image.toDataURL()
  } catch { return null }
}
