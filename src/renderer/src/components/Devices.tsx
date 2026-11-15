import { useEffect, useRef, useState } from 'react'
import type { DeviceAsk } from '../../../shared/types'
import { useStore } from '../store'
import { Icon } from './Icon'
import { Grain } from './parts'

// Окна выбора для сайтов: демонстрация экрана, USB/HID/Serial/Bluetooth-устройство, HTTP-вход.
// Вместо системных окон Windows — стеклянные листы Masaki (как окна ключей доступа и страниц).

const deviceIcon: Record<DeviceAsk['kind'], 'usb' | 'keyboard' | 'settings' | 'bluetooth'> = {
  usb: 'usb',
  hid: 'keyboard',
  serial: 'settings',
  bluetooth: 'bluetooth'
}

/** Демонстрация экрана: снимки экранов и окон, как у Chrome. */
export function DisplaySheet(): React.JSX.Element | null {
  const asks = useStore((s) => s.displayAsks)
  const a = asks[0]
  if (!a) return null
  const answer = (sourceId: string | null): void => {
    window.masaki.devices.answerDisplay(a.id, sourceId)
    useStore.setState((st) => ({ displayAsks: st.displayAsks.filter((x) => x.id !== a.id) }))
  }
  const sources = [...a.sources].sort((x, y) => Number(y.screen) - Number(x.screen))
  return (
    <div className="pk-layer">
      <div className="pk-scrim" />
      <div className="glass pk-card ds-card" role="dialog" aria-modal="true" aria-label="Демонстрация экрана">
        <Grain />
        <span className="perm-ic pk-ic">
          <Icon name="computer" />
        </span>
        <h2 className="pk-title">Поделиться экраном</h2>
        <p className="pk-sub">
          {a.origin || 'Сайт'} увидит выбранный {a.audio ? 'экран со звуком' : 'экран или окно'}
        </p>
        <div className="ds-grid" role="listbox" aria-label="Что показать">
          {sources.map((src) => (
            <button key={src.id} className="ds-src" role="option" aria-selected={false} onClick={() => answer(src.id)}>
              {src.thumb ? <img src={src.thumb} alt="" draggable={false} /> : <span className="ds-empty" />}
              <span className="ds-name">
                <Icon name={src.screen ? 'computer' : 'window'} />
                {src.name || (src.screen ? 'Экран' : 'Окно')}
              </span>
            </button>
          ))}
        </div>
        <div className="pk-acts">
          <span className="pk-sp" />
          <button className="perm-btn tonal-b" onClick={() => answer(null)}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}

/** Список устройств сайта: USB, HID, последовательные порты, Bluetooth. */
export function DeviceSheet(): React.JSX.Element | null {
  const asks = useStore((s) => s.deviceAsks)
  const a = asks[0]
  if (!a) return null
  const answer = (deviceId?: string): void => {
    window.masaki.devices.answerDevice(a.id, deviceId)
    useStore.setState((st) => ({ deviceAsks: st.deviceAsks.filter((x) => x.id !== a.id) }))
  }
  return (
    <div className="pk-layer">
      <div className="pk-scrim" />
      <div className="glass pk-card" role="dialog" aria-modal="true" aria-label={a.label}>
        <Grain />
        <span className="perm-ic pk-ic">
          <Icon name={deviceIcon[a.kind]} />
        </span>
        <h2 className="pk-title">{a.label}</h2>
        <p className="pk-sub">
          {a.origin || 'Сайт'} просит выбрать устройство{a.origin ? '' : ' для подключения'}
        </p>
        <div className="pk-accs" role="listbox" aria-label="Устройства">
          {a.devices.map((d) => (
            <button key={d.id} className="pk-acc" role="option" aria-selected={false} onClick={() => answer(d.id)}>
              <span className="pk-av">
                <Icon name={deviceIcon[a.kind]} />
              </span>
              <span className="af-t">
                <b>{d.name}</b>
              </span>
              <Icon name="forward" />
            </button>
          ))}
        </div>
        <div className="pk-acts">
          <span className="pk-sp" />
          <button className="perm-btn tonal-b" onClick={() => answer()}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}

/** HTTP/прокси-аутентификация: сайт или прокси просит логин и пароль. */
export function AuthSheet(): React.JSX.Element | null {
  const asks = useStore((s) => s.authAsks)
  const a = asks[0]
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const userRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!a) return
    setUser('')
    setPass('')
    requestAnimationFrame(() => userRef.current?.focus())
  }, [a?.id])
  if (!a) return null
  const answer = (ok: boolean): void => {
    window.masaki.devices.answerAuth(a.id, ok ? user : undefined, ok ? pass : undefined)
    useStore.setState((st) => ({ authAsks: st.authAsks.filter((x) => x.id !== a.id) }))
  }
  return (
    <div
      className="pk-layer"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          answer(false)
        } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault()
          answer(true)
        }
      }}
    >
      <div className="pk-scrim" />
      <div className="glass pk-card" role="dialog" aria-modal="true" aria-label="Вход по паролю">
        <Grain />
        <span className="perm-ic pk-ic">
          <Icon name="key" />
        </span>
        <h2 className="pk-title">{a.proxy ? 'Прокси-сервер требует вход' : 'Сайт требует вход'}</h2>
        <p className="pk-sub">
          {a.host}
          {a.realm ? ` · ${a.realm}` : ''}
        </p>
        <label className="pd-label">
          Логин
          <input ref={userRef} className="pd-input" value={user} autoComplete="off" spellCheck={false} onChange={(e) => setUser(e.target.value)} />
        </label>
        <label className="pd-label">
          Пароль
          <input type="password" className="pd-input" value={pass} autoComplete="off" onChange={(e) => setPass(e.target.value)} />
        </label>
        <div className="pk-acts">
          <span className="pk-sp" />
          <button className="perm-btn tonal-b" onClick={() => answer(false)}>
            Отмена
          </button>
          <button className="perm-btn primary" onClick={() => answer(true)}>
            Войти
          </button>
        </div>
      </div>
    </div>
  )
}
