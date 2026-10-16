import { app } from 'electron'
import fs from 'fs'
import path from 'path'

/** Пауза перед повтором, если запись не удалась (диск занят, файл держит антивирус). */
const RETRY_MS = 2000

/** JSON-файл в папке профиля с отложенной атомарной записью. */
export class JsonFile<T> {
  private timer: NodeJS.Timeout | undefined
  /** Последнее состояние, которое ещё не легло на диск. Снимается только после удачной записи —
   *  ошибка его не теряет: повторит таймер, а при выходе допишет flushSync. */
  private pending: T | undefined
  /** Номер последнего write и номер того, что уже на диске: запоздавшая запись не затрёт свежую. */
  private version = 0
  private savedVersion = 0
  /** Асинхронная запись в полёте. Следующая ждёт её: две записи иначе могли завершиться в обратном порядке. */
  private running: Promise<void> | null = null

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
    this.version++
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), delay)
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    while (this.running) await this.running
    if (this.pending === undefined) return
    this.running = this.save(this.pending, this.version).finally(() => {
      this.running = null
    })
    await this.running
  }

  private async save(data: T, version: number): Promise<void> {
    const tmp = this.file + '.tmp'
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
      await fs.promises.writeFile(tmp, JSON.stringify(data))
      // Пока писали, выход успел сохранить состояние синхронно — наше уже устарело.
      if (version <= this.savedVersion) {
        fs.rmSync(tmp, { force: true })
        return
      }
      // Замена синхронная: между проверкой выше и заменой не вклинится flushSync,
      // а после flushSync проверка не пропустит старые данные.
      fs.renameSync(tmp, this.file)
      this.saved(version)
    } catch {
      if (!this.timer && this.pending !== undefined) this.timer = setTimeout(() => void this.flush(), RETRY_MS)
    }
  }

  private saved(version: number): void {
    this.savedVersion = version
    if (this.version === version) this.pending = undefined
  }

  /** Для выхода из приложения: дописать без ожидания таймера и начатой асинхронной записи. */
  flushSync(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.pending === undefined) return
    // Свой временный файл: асинхронная запись может ещё дописывать общий .tmp.
    const tmp = this.file + '.sync.tmp'
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.pending))
      fs.renameSync(tmp, this.file)
      this.saved(this.version)
    } catch {
      // Остальные файлы профиля при выходе всё равно должны сохраниться.
    }
  }
}
