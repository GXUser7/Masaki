import { useState } from 'react'
import type { SyncOptions, SyncState } from '../../../shared/types'
import { hostOf } from '../lib/url'
import { useStore } from '../store'
import { Icon } from './Icon'
import { Fav } from './parts'

function SyncSwitch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }): React.JSX.Element {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)}>
      <span className="knob">{on && <Icon name="check" />}</span>
    </button>
  )
}

export function ago(t: number): string {
  if (!t) return 'ещё не было'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'только что'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} мин назад`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ч назад`
  return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

export function syncStatusText(st: SyncState): string {
  switch (st.status) {
    case 'syncing':
      return 'Синхронизация…'
    case 'error':
      return 'Не удалось синхронизировать'
    case 'signin':
      return 'Нужно войти снова'
    case 'waiting':
      return 'Ждём входа в Google…'
    default:
      return 'Синхронизировано · ' + ago(st.lastSync)
  }
}

/** Как получить ключ: Google не даёт сторонним браузерам встроенного ключа, его создают один раз. */
function KeyHowTo(): React.JSX.Element {
  const open = (url: string) => () => useStore.getState().newTab(url)
  return (
    <details className="sy-how">
      <summary>Как получить ключ — около 5 минут, бесплатно</summary>
      <ol>
        <li>
          Откройте{' '}
          <button className="sy-link" onClick={open('https://console.cloud.google.com/projectcreate')}>
            Google Cloud
          </button>{' '}
          и создайте проект «Masaki».
        </li>
        <li>
          <button className="sy-link" onClick={open('https://console.cloud.google.com/apis/library/drive.googleapis.com')}>
            Google Drive API
          </button>{' '}
          → Enable.
        </li>
        <li>Google Auth Platform → Get started: имя Masaki, ваша почта, Audience — External. Логотип не загружайте — с ним Google попросит проверку бренда.</li>
        <li>Data Access → Add or remove scopes → отметьте только …/auth/drive.appdata.</li>
        <li>Audience → Publish app → Confirm. Иначе Google будет выходить из синхронизации раз в 7 дней.</li>
        <li>Clients → Create client → тип «Desktop app» → Create → Download JSON.</li>
        <li>Здесь нажмите «Выбрать файл ключа» и укажите скачанный JSON.</li>
      </ol>
      <p className="hint pw-note">
        Проверку приложения (Verification) проходить не нужно: drive.appdata — неконфиденциальный доступ, а приложением
        пользуетесь только вы. Если при входе Google всё же покажет «Приложение не проверено», нажмите «Дополнительные
        настройки» → «Перейти на страницу Masaki» — это ваш собственный ключ.
      </p>
    </details>
  )
}

function ManualKey(): React.JSX.Element {
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [err, setErr] = useState<string | null>(null)
  return (
    <details className="sy-how">
      <summary>Ввести Client ID и Client secret вручную</summary>
      <div className="sy-manual">
        <input placeholder="Client ID" value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} aria-label="Client ID" />
        <input
          placeholder="Client secret"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          spellCheck={false}
          aria-label="Client secret"
        />
        <button
          className="tonal"
          disabled={!id.trim() || !secret.trim()}
          onClick={() =>
            void window.masaki.sync.setClient(id, secret).then((r) => {
              setErr(r.ok ? null : (r.error ?? 'Не получилось'))
              if (r.ok) {
                setId('')
                setSecret('')
              }
            })
          }
        >
          <Icon name="check" />
          Сохранить
        </button>
      </div>
      {err && <p className="err-text">{err}</p>}
    </details>
  )
}

/** Ключ шифрования паролей: придумать новый или ввести заданный на другом устройстве. */
function VaultKey({ st }: { st: SyncState }): React.JSX.Element | null {
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reset, setReset] = useState(false)
  const api = window.masaki.sync
  if (st.vault === 'off') return null
  if (st.vault === 'checking') return <p className="hint sy-vault-hint">Смотрю, есть ли пароли на Диске…</p>
  if (st.vault === 'ready') {
    return <p className="hint sy-vault-hint">Пароли и ключи доступа синхронизируются. Перед отправкой на Диск они шифруются вашим ключом — Google их не прочитает.</p>
  }
  const isNew = st.vault === 'needs-new'
  const submit = (): void => {
    if (isNew && pass !== again) {
      setErr('Ключи не совпадают')
      return
    }
    setBusy(true)
    setErr(null)
    void api.setVaultKey(pass).then((r) => {
      setBusy(false)
      if (r.ok) {
        setPass('')
        setAgain('')
      } else setErr(r.error ?? 'Не получилось')
    })
  }
  return (
    <div className="sy-vault">
      <b>{isNew ? 'Придумайте ключ шифрования паролей' : 'Введите ключ шифрования паролей'}</b>
      <small>
        {isNew
          ? 'Пароли шифруются им прямо на компьютере. Ключ понадобится на других устройствах; восстановить его нельзя — без него пароли на Диске не прочитать (на компьютерах они останутся).'
          : 'Тот ключ, что вы задали на другом устройстве, когда включали синхронизацию паролей.'}
      </small>
      {(st.vaultError || err) && <span className="err-text">{err || st.vaultError}</span>}
      <div className="sy-manual">
        <input
          type="password"
          placeholder={isNew ? 'Ключ — не короче 8 символов' : 'Ключ шифрования паролей'}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !isNew && submit()}
          aria-label="Ключ шифрования паролей"
          autoComplete="off"
        />
        {isNew && (
          <input
            type="password"
            placeholder="Ещё раз"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            aria-label="Ключ ещё раз"
            autoComplete="off"
          />
        )}
        <button className="tonal" disabled={busy || pass.length < 8} onClick={submit}>
          <Icon name="key" />
          {busy ? 'Проверяю…' : isNew ? 'Включить' : 'Подключить'}
        </button>
      </div>
      {!isNew &&
        (reset ? (
          <span className="sy-vault-reset">
            <small>Пароли на Диске удалятся, на этом компьютере останутся и уйдут на Диск под новым ключом.</small>
            <button className="perm-btn ghost" onClick={() => setReset(false)}>
              Нет
            </button>
            <button className="perm-btn sy-danger" onClick={() => void api.resetVault().then(() => setReset(false))}>
              Задать новый ключ
            </button>
          </span>
        ) : (
          <button className="sy-link sy-forgot" onClick={() => setReset(true)}>
            Забыли ключ?
          </button>
        ))}
    </div>
  )
}

function Devices({ st }: { st: SyncState }): React.JSX.Element | null {
  if (!st.devices.length) {
    return <p className="hint sy-nodev">Других устройств пока нет — войдите в синхронизацию в Masaki на другом компьютере.</p>
  }
  return (
    <div className="sy-devs">
      {st.devices.map((d) => (
        <div key={d.id} className="sy-dev">
          <div className="sy-dev-h">
            <Icon name={d.platform === 'android' ? 'phone' : 'computer'} />
            <b>{d.name}</b>
            <small>{ago(d.updated)}</small>
            <span className="sp" />
            <button className="ib" aria-label={`Забыть «${d.name}»`} title="Забыть устройство" onClick={() => void window.masaki.sync.forgetDevice(d.id)}>
              <Icon name="close" />
            </button>
          </div>
          {d.tabs.length === 0 && <small className="sy-dev-empty">Открытых сайтов нет</small>}
          {d.tabs.slice(0, 12).map((t, i) => (
            <button key={t.url + i} className="sy-tab" onClick={() => useStore.getState().newTab(t.url)}>
              <Fav favicon={t.favicon} title={t.title || t.url} url={t.url} />
              <span>
                <b>{t.title || t.url}</b>
                <small>{hostOf(t.url)}</small>
              </span>
            </button>
          ))}
          {d.tabs.length > 12 && <small className="sy-dev-empty">и ещё {d.tabs.length - 12}</small>}
        </div>
      ))}
    </div>
  )
}

export function SyncSection(): React.JSX.Element {
  const st = useStore((s) => s.sync)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [name, setName] = useState<string | null>(null)
  const api = window.masaki.sync

  if (!st) return <p className="hint">…</p>

  const signIn = (external = false): void => {
    setErr(null)
    void api.signIn(external).then((r) => !r.ok && r.error && setErr(r.error))
  }
  const opt = (k: keyof SyncOptions) => (v: boolean) => api.setOptions({ [k]: v })

  // 1. Ключа нет: объясняем, что это и где его взять.
  if (!st.client) {
    return (
      <>
        <p className="hint">
          Избранное, ярлыки, оформление, история и открытые вкладки — на всех ваших компьютерах с Masaki. Данные лежат в
          скрытой папке приложения на вашем Google Диске: остальные файлы Диска Masaki не видит.
        </p>
        <div className="set-row">
          <span>
            Ключ Google
            <small>Chrome Sync закрыт для других браузеров, поэтому у Masaki свой ключ — его создают один раз в Google Cloud.</small>
          </span>
          <button
            className="tonal"
            onClick={() => void api.pickClient().then((r) => setErr(r && !r.ok ? (r.error ?? 'Не получилось') : null))}
          >
            <Icon name="key" />
            Выбрать файл ключа…
          </button>
        </div>
        {err && <p className="err-text">{err}</p>}
        <KeyHowTo />
        <ManualKey />
      </>
    )
  }

  // 2. Ключ есть, но вход не выполнен.
  if (!st.account) {
    const waiting = st.status === 'waiting'
    return (
      <>
        <p className="hint">
          Избранное, ярлыки, оформление, история и открытые вкладки — на всех ваших компьютерах с Masaki. Данные лежат в
          скрытой папке приложения на вашем Google Диске.
        </p>
        <div className="sy-cta-row">
          <button className="sy-cta" disabled={waiting} onClick={() => signIn()}>
            <Icon name="sync" />
            {waiting ? 'Подтвердите вход во вкладке Google…' : 'Войти через Google'}
          </button>
          {waiting ? (
            <button className="perm-btn ghost" onClick={() => api.cancelSignIn()}>
              Отмена
            </button>
          ) : (
            <button className="sy-link" onClick={() => signIn(true)}>
              Войти через системный браузер
            </button>
          )}
        </div>
        {(err || st.error) && <p className="err-text">{err || st.error}</p>}
        <div className="set-row">
          <span>
            Ключ Google
            <small>Подключён · {st.client}</small>
          </span>
          <button className="perm-btn ghost" onClick={() => api.removeClient()}>
            Убрать ключ
          </button>
        </div>
      </>
    )
  }

  // 3. Синхронизация включена.
  const a = st.account
  const syncing = st.status === 'syncing'
  return (
    <>
      <div className={'sy-acc ' + st.status}>
        {a.photo ? (
          <img src={a.photo} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="acc-ph">
            <Icon name="person" />
          </span>
        )}
        <span className="sy-acc-t">
          <b>{a.name || a.email}</b>
          <small>{a.email}</small>
          <span className="sy-state">
            <Icon name={st.status === 'error' || st.status === 'signin' ? 'warn' : 'cloud'} />
            {syncStatusText(st)}
          </span>
        </span>
        <button className="tonal" disabled={syncing || st.status === 'signin'} onClick={() => void api.syncNow()}>
          <Icon name="sync" className={syncing ? 'sy-spin' : ''} />
          Синхронизировать
        </button>
      </div>
      {st.status === 'signin' && (
        <div className="sy-warn">
          <span>{st.error}</span>
          <button className="perm-btn primary" onClick={() => signIn()}>
            Войти снова
          </button>
        </div>
      )}
      {st.status === 'error' && st.error && <p className="err-text">{st.error}</p>}
      {err && <p className="err-text">{err}</p>}

      <div className="set-row">
        <span>
          Избранное и ярлыки
          <small>При первом входе избранное с разных компьютеров объединяется</small>
        </span>
        <SyncSwitch label="Синхронизировать избранное и ярлыки" on={st.options.bookmarks} onChange={opt('bookmarks')} />
      </div>
      <div className="set-row">
        <span>
          Оформление и настройки
          <small>Тема, цвета, стекло, часы, AI Mode, аддоны</small>
        </span>
        <SyncSwitch label="Синхронизировать оформление и настройки" on={st.options.settings} onChange={opt('settings')} />
      </div>
      <div className="set-row">
        <span>
          История
          <small>Палитра подсказывает сайты, где вы бывали на любом устройстве</small>
        </span>
        <SyncSwitch label="Синхронизировать историю" on={st.options.history} onChange={opt('history')} />
      </div>
      <div className="set-row">
        <span>
          Открытые вкладки
          <small>Видно, что открыто на других устройствах; ищутся и в палитре</small>
        </span>
        <SyncSwitch label="Синхронизировать открытые вкладки" on={st.options.tabs} onChange={opt('tabs')} />
      </div>
      <div className="set-row">
        <span>
          Пароли и ключи доступа
          <small>Шифруются вашим ключом прямо на компьютере — Google их не прочитает</small>
        </span>
        <SyncSwitch label="Синхронизировать пароли" on={st.options.passwords} onChange={opt('passwords')} />
      </div>
      <VaultKey st={st} />
      <div className="set-row">
        <span>
          Имя этого компьютера
          <small>Так его увидят другие устройства</small>
        </span>
        <input
          className="sy-name"
          value={name ?? st.deviceName}
          maxLength={40}
          aria-label="Имя этого компьютера"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name !== null) api.setDeviceName(name)
            setName(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>

      {st.options.tabs && (
        <>
          <h3 className="sy-h3">Вкладки на других устройствах</h3>
          <Devices st={st} />
        </>
      )}

      <div className="sy-foot">
        <button
          className="perm-btn ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void api.signOut().finally(() => setBusy(false))
          }}
        >
          <Icon name="logout" />
          Выйти из синхронизации
        </button>
        <span className="sp" />
        {confirmWipe ? (
          <>
            <small className="sy-wipe-q">Удалить всё, что Masaki хранит на Диске? Данные на компьютерах останутся.</small>
            <button className="perm-btn ghost" onClick={() => setConfirmWipe(false)}>
              Нет
            </button>
            <button
              className="perm-btn sy-danger"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void api.wipe().then((r) => {
                  setBusy(false)
                  setConfirmWipe(false)
                  if (!r.ok) setErr(r.error ?? 'Не получилось')
                })
              }}
            >
              Удалить
            </button>
          </>
        ) : (
          <button className="perm-btn ghost" onClick={() => setConfirmWipe(true)}>
            <Icon name="delete" />
            Удалить данные с Диска
          </button>
        )}
      </div>
    </>
  )
}
