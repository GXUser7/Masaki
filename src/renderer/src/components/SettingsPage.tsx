import { useEffect, useState } from 'react'
import {
  AI_PORT,
  type AiControlState,
  type BackgroundMode,
  type ChromeProfile,
  type ClockColor,
  type ClockSettings,
  type DefaultBrowserState,
  type GlassLevel,
  type Scheme,
  type Shortcut
} from '../../../shared/types'
import { handmadeIds, handmadeNames, hueOf, seedFromHue, seedPresets, swatchOf } from '../lib/theme'
import { useStore } from '../store'
import { Clock, clockStyles } from './Clock'
import { Icon } from './Icon'
import { PermissionList } from './Permissions'
import { SyncSection } from './SyncSection'
import { PasswordsSummary } from './PasswordsPage'

function Seg<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  label: string
}): React.JSX.Element {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, name]) => (
        <button key={v} role="radio" aria-checked={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {v === value && <Icon name="check" />}
          {name}
        </button>
      ))}
    </div>
  )
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }): React.JSX.Element {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)}>
      <span className="knob">{on && <Icon name="check" />}</span>
    </button>
  )
}

function ShortcutEditor({
  items,
  onChange,
  addLabel
}: {
  items: Shortcut[]
  onChange: (v: Shortcut[]) => void
  addLabel: string
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const add = (): void => {
    const u = url.trim()
    if (!u) return
    const full = /^[a-z]+:/i.test(u) ? u : 'https://' + u
    onChange([...items, { title: title.trim() || u, url: full }])
    setTitle('')
    setUrl('')
  }
  return (
    <div className="sc-edit">
      {items.map((it, i) => (
        <div key={it.url + i} className="sc-item">
          <span className="sc-item-t">
            <b>{it.title}</b>
            <small>{it.url}</small>
          </span>
          <button className="ib" aria-label={`Удалить «${it.title}»`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <Icon name="delete" />
          </button>
        </div>
      ))}
      <div className="sc-add">
        <input placeholder="Название" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Название" />
        <input
          placeholder="Адрес, например github.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          aria-label="Адрес"
        />
        <button className="tonal" onClick={add}>
          <Icon name="add" />
          {addLabel}
        </button>
      </div>
    </div>
  )
}

const urlKey = (u: string): string => u.replace(/#.*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase()

/** Добавить сайты в конец списка, пропуская те, что в нём уже есть. */
function mergeSites(have: Shortcut[], add: Shortcut[]): { list: Shortcut[]; added: number } {
  const keys = new Set(have.map((x) => urlKey(x.url)))
  const fresh = add.filter((x) => {
    const k = urlKey(x.url)
    if (keys.has(k)) return false
    keys.add(k)
    return true
  })
  return { list: [...have, ...fresh], added: fresh.length }
}

/** Перенос из Chrome: закладки → избранное, ярлыки новой вкладки, история для подсказок палитры. */
function ChromeImport(): React.JSX.Element {
  const [profiles, setProfiles] = useState<ChromeProfile[] | null>(null)
  const [dir, setDir] = useState('')
  const [what, setWhat] = useState({ bookmarks: true, shortcuts: true, history: true })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.masaki.chrome.profiles().then((list) => {
      setProfiles(list)
      if (list[0]) setDir(list[0].dir)
    })
  }, [])

  if (!profiles) return <p className="hint">Ищу Chrome…</p>
  if (profiles.length === 0) return <p className="hint">Chrome на этом компьютере не найден.</p>
  const p = profiles.find((x) => x.dir === dir) ?? profiles[0]
  const pick = {
    bookmarks: what.bookmarks && p.bookmarks > 0,
    shortcuts: what.shortcuts && p.shortcuts > 0,
    history: what.history && p.history
  }

  const run = async (): Promise<void> => {
    setBusy(true)
    setDone(null)
    setError(null)
    const r = await window.masaki.chrome.import(p.dir, pick)
    const st = useStore.getState()
    const fav = mergeSites(st.settings.favorites, r.bookmarks)
    const sc = mergeSites(st.settings.shortcuts, r.shortcuts)
    st.setSettings({ favorites: fav.list, shortcuts: sc.list })
    if (r.history) useStore.setState({ history: await window.masaki.history.list() })
    const parts: string[] = []
    if (pick.bookmarks) parts.push(`в избранное — ${fav.added}`)
    if (pick.shortcuts) parts.push(`ярлыков — ${sc.added}`)
    if (pick.history && !r.error) parts.push(`страниц истории — ${r.history}`)
    if (parts.length) setDone('Перенесено: ' + parts.join(', ') + '. Повторы пропущены.')
    setError(r.error ?? null)
    setBusy(false)
  }
  const toggle =
    (k: keyof typeof what) =>
    (v: boolean): void =>
      setWhat({ ...what, [k]: v })

  return (
    <>
      {profiles.length > 1 && (
        <div className="set-row">
          <span>Профиль Chrome</span>
          <Seg label="Профиль Chrome" value={p.dir} options={profiles.map((x) => [x.dir, x.name] as [string, string])} onChange={setDir} />
        </div>
      )}
      <div className="set-row">
        <span>
          Закладки
          <small>{p.bookmarks ? `${p.bookmarks} — станут избранным в боковой панели` : 'В этом профиле закладок нет'}</small>
        </span>
        <Switch label="Перенести закладки" on={pick.bookmarks} onChange={toggle('bookmarks')} />
      </div>
      <div className="set-row">
        <span>
          Ярлыки новой вкладки
          <small>{p.shortcuts ? `${p.shortcuts} — встанут рядом с ярлыками Masaki` : 'Своих ярлыков в Chrome нет'}</small>
        </span>
        <Switch label="Перенести ярлыки" on={pick.shortcuts} onChange={toggle('shortcuts')} />
      </div>
      <div className="set-row">
        <span>
          История
          <small>{p.history ? 'Палитра будет подсказывать сайты, где вы бывали в Chrome' : 'Истории в этом профиле нет'}</small>
        </span>
        <Switch label="Перенести историю" on={pick.history} onChange={toggle('history')} />
      </div>
      <div className="set-row">
        <span>
          <small>
            Пароли и входы на сайты Chrome хранит зашифрованными только для себя — на сайты нужно войти заново. Вход в
            Google достаточно сделать один раз: он сработает на YouTube, в Gmail и других сервисах Google.
          </small>
        </span>
        <button className="tonal" disabled={busy || !(pick.bookmarks || pick.shortcuts || pick.history)} onClick={() => void run()}>
          <Icon name="download" />
          {busy ? 'Переношу…' : 'Перенести'}
        </button>
      </div>
      {done && <p className="hint ci-done">{done}</p>}
      {error && <p className="err-text">{error}</p>}
    </>
  )
}

/** Своя картинка фона: выбрать файл и сразу включить её фоном. */
async function pickWallpaper(): Promise<void> {
  const img = await window.masaki.pickWallpaper()
  if (!img) return
  const st = useStore.getState()
  st.setSettings({ background: 'custom' })
  useStore.setState({ wallpaperRev: st.wallpaperRev + 1 })
}

/** «Свой цвет»: ползунок оттенка по радуге и поле для точного HEX. */
function CustomColor({ value, onChange }: { value: string; onChange: (hex: string) => void }): React.JSX.Element {
  const [text, setText] = useState(value)
  return (
    <div className="own-color">
      <input
        type="range"
        className="hue"
        min={0}
        max={359}
        value={hueOf(value)}
        aria-label="Оттенок"
        onChange={(e) => {
          const hex = seedFromHue(Number(e.target.value))
          setText(hex)
          onChange(hex)
        }}
      />
      <span className="own-preview" style={{ background: value }} />
      <input
        className="own-hex"
        value={text}
        spellCheck={false}
        aria-label="Цвет в формате HEX"
        onChange={(e) => {
          const v = e.target.value.trim()
          setText(v)
          const hex = v.startsWith('#') ? v : '#' + v
          if (/^#[0-9a-f]{6}$/i.test(hex)) onChange(hex.toUpperCase())
        }}
      />
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const set = useStore.getState().setSettings
  const clock = settings.clock
  const setClock = (patch: Partial<ClockSettings>): void => set({ clock: { ...clock, ...patch } })
  const v = window.masaki.versions

  return (
    <div className="settings">
      <div className="set-inner">
        <h1>Настройки</h1>

        <section className="sy-section">
          <h2>Синхронизация</h2>
          <SyncSection />
        </section>

        <section>
          <h2>Пароли</h2>
          <PasswordsSummary />
        </section>

        <section>
          <h2>Часы на новой вкладке</h2>
          <p className="hint">Стили по мотивам экрана блокировки Pixel. Нажмите на часы на новой вкладке, чтобы цифры «станцевали».</p>
          <div className="clock-grid">
            {clockStyles.map((st) => (
              <button
                key={st.id}
                className={'clock-card' + (clock.style === st.id ? ' on' : '')}
                aria-pressed={clock.style === st.id}
                onClick={() => setClock({ style: st.id })}
              >
                <span className="clock-prev">
                  <Clock cfg={{ ...clock, style: st.id, size: 'dynamic' }} preview />
                </span>
                <span className="clock-name">{st.name}</span>
                <span className="clock-hint">{st.hint}</span>
              </button>
            ))}
          </div>
          <div className="set-row">
            <span>Цвет</span>
            <Seg<ClockColor>
              label="Цвет часов"
              value={clock.color}
              onChange={(c) => setClock({ color: c })}
              options={[
                ['auto', 'Двухцветные'],
                ['primary', 'Основной'],
                ['tertiary', 'Дополнительный'],
                ['neutral', 'Нейтральный']
              ]}
            />
          </div>
          <div className="set-row">
            <span>Размер</span>
            <Seg
              label="Размер часов"
              value={clock.size}
              onChange={(size) => setClock({ size })}
              options={[
                ['dynamic', 'Крупные'],
                ['small', 'Компактные']
              ]}
            />
          </div>
          {clock.style === 'flex' && (
            <>
              <div className="set-row">
                <span>Форма цифр</span>
                <Seg
                  label="Форма цифр"
                  value={clock.rounded ? 'r' : 's'}
                  onChange={(x) => setClock({ rounded: x === 'r' })}
                  options={[
                    ['r', 'Скруглённые'],
                    ['s', 'Острые']
                  ]}
                />
              </div>
              <div className="set-row">
                <span>Толщина</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={clock.thickness}
                  aria-label="Толщина цифр"
                  onChange={(e) => setClock({ thickness: Number(e.target.value) })}
                />
              </div>
            </>
          )}
        </section>

        <section>
          <h2>Оформление</h2>
          <div className="set-row">
            <span>Тема</span>
            <Seg<Scheme>
              label="Тема"
              value={settings.scheme}
              onChange={(scheme) => set({ scheme })}
              options={[
                ['system', 'Как в Windows'],
                ['light', 'Светлая'],
                ['dark', 'Тёмная']
              ]}
            />
          </div>
          <div className="set-col">
            <span className="set-l">Цвета</span>
            <div className="swatches" role="radiogroup" aria-label="Палитра">
              {[...handmadeIds, ...Object.keys(seedPresets)].map((id) => {
                const sw = swatchOf(id)
                return (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={settings.palette === id}
                    className={'swatch' + (settings.palette === id ? ' on' : '')}
                    title={handmadeNames[id as keyof typeof handmadeNames] ?? seedPresets[id].name}
                    onClick={() => set({ palette: id })}
                  >
                    <span style={{ background: sw[0] }} />
                    <span style={{ background: sw[1] }} />
                    <span style={{ background: sw[2] }} />
                  </button>
                )
              })}
              <button
                role="radio"
                aria-checked={settings.palette === 'wallpaper'}
                className={'swatch wp' + (settings.palette === 'wallpaper' ? ' on' : '')}
                title="Из обоев: главный цвет фоновой картинки, как Material You на Pixel"
                onClick={() => set({ palette: 'wallpaper' })}
              >
                <Icon name="image" />
              </button>
              <button
                role="radio"
                aria-checked={settings.palette === 'custom'}
                className={'swatch own' + (settings.palette === 'custom' ? ' on' : '')}
                title="Свой цвет"
                style={{ background: settings.customColor }}
                onClick={() => set({ palette: 'custom' })}
              >
                <Icon name="add" />
              </button>
            </div>
            <span className="swatch-name">
              {settings.palette === 'wallpaper'
                ? 'Из обоев'
                : settings.palette === 'custom'
                  ? 'Свой цвет'
                  : (handmadeNames[settings.palette as keyof typeof handmadeNames] ?? seedPresets[settings.palette]?.name ?? '')}
            </span>
            {settings.palette === 'custom' && <CustomColor value={settings.customColor} onChange={(customColor) => set({ customColor })} />}
          </div>
          <div className="set-row">
            <span>Стекло</span>
            <Seg<GlassLevel>
              label="Сила размытия"
              value={settings.glass}
              onChange={(glass) => set({ glass })}
              options={[
                ['s', 'Лёгкое'],
                ['m', 'Среднее'],
                ['l', 'Сильное']
              ]}
            />
          </div>
          <div className="set-row">
            <span>Фон окна</span>
            <Seg
              label="Фон окна"
              value={settings.background}
              onChange={(background) => {
                if (background === 'custom') void pickWallpaper()
                else set({ background })
              }}
              options={[
                ['shapes', 'Фигуры'],
                // Обои системы Masaki берёт только у Windows.
                ...(window.masaki.platform === 'win32' ? [['wallpaper', 'Обои Windows'] as [BackgroundMode, string]] : []),
                ['custom', 'Своя картинка']
              ]}
            />
            {settings.background === 'custom' && (
              <button className="tonal" onClick={() => void pickWallpaper()}>
                <Icon name="image" />
                Другая картинка…
              </button>
            )}
          </div>
        </section>

        <section>
          <h2>Вкладки</h2>
          <div className="set-row">
            <span>
              Убирать в архив неактивные вкладки
              <small>Незакреплённые вкладки, которые давно не открывали, уходят в архив и ищутся в палитре (Ctrl+Shift+A). Группы и играющие вкладки не трогаются.</small>
            </span>
            <Seg
              label="Убирать в архив"
              value={String(settings.archiveAfter)}
              onChange={(v) => set({ archiveAfter: Number(v) })}
              options={[
                ['0', 'Никогда'],
                ['12', 'Через 12 ч'],
                ['24', 'Через сутки'],
                ['168', 'Через неделю']
              ]}
            />
          </div>
        </section>

        <section>
          <h2>Поиск и AI Mode</h2>
          <div className="set-row">
            <span>
              AI Mode включён при запуске
              <small>Запросы из палитры сразу уходят в AI Mode Google</small>
            </span>
            <Switch label="AI Mode при запуске" on={settings.aiDefault} onChange={(aiDefault) => set({ aiDefault })} />
          </div>
        </section>

        <section>
          <h2>Перенос из Chrome</h2>
          <ChromeImport />
        </section>

        <section>
          <h2>Ярлыки новой вкладки</h2>
          <ShortcutEditor items={settings.shortcuts} onChange={(shortcuts) => set({ shortcuts })} addLabel="Добавить" />
        </section>

        <section>
          <h2>Избранное в боковой панели</h2>
          <p className="hint">
            Звёздочка рядом с кнопками навигации добавляет текущую страницу. Если избранного много, в панели оно
            раскрывается плиткой «+N», а в палитре ищется по названию.
          </p>
          <ShortcutEditor items={settings.favorites} onChange={(favorites) => set({ favorites })} addLabel="Добавить" />
        </section>

        <section>
          <h2>Разрешения сайтов</h2>
          <p className="hint">Что вы разрешили или запретили сайтам. Сбросьте решение — сайт спросит снова.</p>
          <PermissionList />
        </section>

        <section>
          <h2>История</h2>
          <div className="set-row">
            <span>
              Очистить историю посещений
              <small>Подсказки палитры перестанут предлагать посещённые страницы</small>
            </span>
            <button
              className="tonal"
              onClick={() => {
                window.masaki.history.clear()
                useStore.setState({ history: [] })
              }}
            >
              <Icon name="delete" />
              Очистить
            </button>
          </div>
        </section>

        <DefaultBrowser />
        <AiControl on={settings.aiControl} onChange={(aiControl) => set({ aiControl })} />

        <section>
          <h2>О Masaki</h2>
          <p className="hint">
            Chromium {v.chrome} · Electron {v.electron} · Node {v.node}
          </p>
        </section>
      </div>
    </div>
  )
}

/** Masaki среди браузеров Windows. Последний шаг — «Установить по умолчанию» в Параметрах: его Windows оставляет пользователю. */
function DefaultBrowser(): React.JSX.Element | null {
  const [st, setSt] = useState<DefaultBrowserState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    const check = (): void => void window.masaki.system.defaultBrowser().then(setSt)
    check()
    // Выбирают в Параметрах Windows: вернулись в окно — смотрим снова.
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])
  if (!st?.supported) return null
  return (
    <section>
      <h2>Браузер по умолчанию</h2>
      <div className="set-row">
        <span>
          {st.isDefault ? 'Masaki — браузер по умолчанию' : 'Сделать Masaki браузером по умолчанию'}
          <small>
            {st.isDefault
              ? 'Ссылки из других программ открываются в Masaki'
              : 'Windows даёт выбрать браузер только в Параметрах: кнопка откроет страницу Masaki, там нажмите «Установить по умолчанию».'}
          </small>
        </span>
        {st.isDefault ? (
          <Icon name="check" className="db-ok" />
        ) : (
          <button
            className="tonal"
            onClick={() => void window.masaki.system.makeDefault().then((r) => setErr(r.ok ? null : (r.error ?? 'Не получилось')))}
          >
            <Icon name="openInNew" />
            Сделать основным
          </button>
        )}
      </div>
      {err && <p className="err-text">{err}</p>}
    </section>
  )
}

/** Порт отладки для ИИ-агентов: ключ Chromium, поэтому включается и выключается с перезапуска. */
function AiControl({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  const [st, setSt] = useState<AiControlState | null>(null)
  useEffect(() => {
    void window.masaki.system.aiControl().then(setSt)
  }, [])
  const active = !!st?.port
  return (
    <section>
      <h2>Управление для ИИ</h2>
      <div className="set-row">
        <span>
          Разрешить ИИ-агентам управлять Masaki
          <small>
            Claude Code и другие агенты подключаются через порт отладки {AI_PORT} (протокол Chrome DevTools): видят вкладки, нажимают,
            печатают, делают снимки — с вашими входами на сайты. Пока включено, это может любая программа на этом
            компьютере, поэтому включайте, когда нужно.
          </small>
        </span>
        <Switch label="Управление для ИИ" on={on} onChange={onChange} />
      </div>
      {st && on !== active && (
        <div className="sy-warn">
          <span>{on ? 'Порт откроется после перезапуска Masaki' : 'Порт закроется после перезапуска Masaki'}</span>
          <button className="perm-btn primary" onClick={() => window.masaki.system.relaunch()}>
            Перезапустить
          </button>
        </div>
      )}
      {st && on && active && !st.listening && (
        <p className="err-text">Порт {st.port} занят другой программой — Masaki не смог его открыть.</p>
      )}
      {st && on && active && st.listening && <p className="hint">Агент подключается к http://127.0.0.1:{st.port}</p>}
    </section>
  )
}
