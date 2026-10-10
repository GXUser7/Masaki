import { app } from 'electron'
import fs from 'fs'
import path from 'path'

/** JSON-файл в папке профиля с отложенной атомарной записью. */
export class JsonFile<T> {
  private timer: NodeJS.Timeout | undefined
  private pending: T | undefined

  constructor(private readonly name: string) {}

  private get file(): string {
    return path.join(app.getPath('userData'), this.name)
  }

  async read(): Promise<T | null> {
    try {
      return JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as T
    } catch {
      return null
    }
  }

  write(data: T, delay = 500): void {
    this.pending = data
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), delay)
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer)
    if (this.pending === undefined) return
    const data = this.pending
    this.pending = undefined
    const tmp = this.file + '.tmp'
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
    await fs.promises.writeFile(tmp, JSON.stringify(data))
    await fs.promises.rename(tmp, this.file)
  }

  /** Для выхода из приложения: дописать без ожидания таймера. */
  flushSync(): void {
    clearTimeout(this.timer)
    if (this.pending === undefined) return
    const data = this.pending
    this.pending = undefined
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, this.file)
  }
}
