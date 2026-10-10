import { useEffect, useMemo, useState } from 'react'
import type { PasskeyItem, PasswordImportResult, PasswordItem } from '../../../shared/types'
import { useStore } from '../store'
import { Icon } from './Icon'
import { Fav } from './parts'
import { passwordsWord, plural } from './PasswordUi'

const passkeysWord = (n: number): string => `${n} ${plural(n, ['ключ доступа', 'ключа доступа', 'ключей доступа'])}`

const GOOGLE_EXPORT = 'https://passwords.google.com/options'

function importText(r: PasswordImportResult | null): string | null {
  if (!r) return null
  if (r.error && !r.added && !r.updated) return r.error
  const parts = [`добавлено ${r.added}`]
  if (r.updated) parts.push(`обновлено ${r.updated}`)
  if (r.skipped) parts.push(`пропущено ${r.skipped}`)
  return 'Готово: ' + parts.join(', ') + '. ' + (r.error ?? 'Файл удалён.')
}

/** Как перенести пароли из Google: экспорт CSV, который Masaki заберёт сам. */
function GoogleHowTo({ open }: { open?: boolean }): React.JSX.Element {
  return (
    <details className="sy-how" open={open}>
      <summary>Перенести пароли из Google</summary>
      <ol>
        <li>
          Откройте{' '}
          <button className="sy-link" onClick={() => useStore.getState().newTab(GOOGLE_EXPORT)}>
            Google Password Manager → Настройки
          </button>{' '}
          (вы уже вошли в Google в Masaki).
        </li>
        <li>«Экспорт паролей» → «Экспорт» и подтвердите вход — файл скачается в Masaki.</li>
        <li>Masaki предложит перенести пароли и удалит файл с открытыми паролями.</li>
      </ol>
      <p className="hint pw-note">
        Passkey Google не экспортирует. Пароли, сохранённые потом на телефоне, сами сюда не придут — повторите экспорт.
      </p>
    </details>
  )
}

function Editor({ item, onDone }: { item?: PasswordItem; onDone: () => void }): React.JSX.Element {
  const [url, setUrl] = useState(item?.origin ?? '')
  const [username, setUsername] = useState(item?.username ?? '')
  const [password, setPassword] = useState('')
  const [note, setNote] = useState(item?.note ?? '')
  const [show, setShow] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const save = (): void => {
    void window.masaki.passwords.save({ id: item?.id, url, username, password: password || undefined, note }).then((r) => {
      if (r.ok) onDone()
      else setErr(r.error ?? 'Не получилось')
    })
  }
  return (
    <div className="pw-edit">
      <div className="pw-edit-row">
        <input placeholder="Сайт, например github.com" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Сайт" spellCheck={false} />
        <input placeholder="Логин" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="Логин" spellCheck={false} />
      </div>
      <div className="pw-edit-row">
        <span className="pw-pass">
          <input
            type={show ? 'text' : 'password'}
            placeholder={item ? 'Новый пароль (пусто — не менять)' : 'Пароль'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Пароль"
            spellCheck={false}
            autoComplete="new-password"
          />
          <button className="ib" aria-label={show ? 'Скрыть пароль' : 'Показать пароль'} onClick={() => setShow(!show)}>
            <Icon name={show ? 'visibilityOff' : 'visibility'} />
          </button>
        </span>
        <input placeholder="Заметка" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Заметка" />
      </div>
      {err && <p className="err-text">{err}</p>}
      <div className="pw-edit-acts">
        <button className="perm-btn ghost" onClick={onDone}>
          Отмена
        </button>
        <button className="perm-btn primary" disabled={!url.trim() || (!item && !password)} onClick={save}>
          Сохранить
        </button>
      </div>
    </div>
  )
}

function Row({ it, editing, onEdit }: { it: PasswordItem; editing: boolean; onEdit: (id: string | null) => void }): React.JSX.Element {
  const [shown, setShown] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])
  if (editing) return <Editor item={it} onDone={() => onEdit(null)} />
  return (
    <div className="pw-row">
      <Fav url={it.origin} title={it.host} />
      <span className="pw-t">
        <b>{it.host}</b>
        <small>{it.username || 'без логина'}</small>
      </span>
      <span className={'pw-dots' + (shown !== null ? ' on' : '')}>{shown ?? '••••••••••'}</span>
      {confirm ? (
        <>
          <button className="perm-btn ghost" onClick={() => setConfirm(false)}>
            Нет
          </button>
          <button className="perm-btn sy-danger" onClick={() => void window.masaki.passwords.remove(it.id)}>
            Удалить
          </button>
        </>
      ) : (
        <>
          <button
            className="ib"
            aria-label={shown !== null ? 'Скрыть пароль' : 'Показать пароль'}
            title={shown !== null ? 'Скрыть' : 'Показать'}
            onClick={() => (shown !== null ? setShown(null) : void window.masaki.passwords.reveal(it.id).then(setShown))}
          >
            <Icon name={shown !== null ? 'visibilityOff' : 'visibility'} />
          </button>
          <button
            className={'ib' + (copied ? ' on' : '')}
            aria-label="Скопировать пароль"
            title={copied ? 'Скопировано — через минуту уберётся из буфера' : 'Скопировать'}
            onClick={() => void window.masaki.passwords.copy(it.id).then(setCopied)}
          >
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
          <button className="ib" aria-label="Изменить" title="Изменить" onClick={() => onEdit(it.id)}>
            <Icon name="edit" />
          </button>
          <button className="ib" aria-label="Удалить" title="Удалить" onClick={() => setConfirm(true)}>
            <Icon name="delete" />
          </button>
        </>
      )}
    </div>
  )
}

function PasskeyRow({ it }: { it: PasskeyItem }): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const name = it.displayName || it.userName || 'без имени'
  const date = new Date(it.created).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
  return (
    <div className="pw-row">
      <Fav url={'https://' + it.rpId} title={it.rpId} />
      <span className="pw-t">
        <b>{it.rpId}</b>
        <small>
          {name}
          {it.userName && it.userName !== name ? ` · ${it.userName}` : ''}
        </small>
      </span>
      <span className="pw-dots pk-date">создан {date}</span>
      {confirm ? (
        <>
          <button className="perm-btn ghost" onClick={() => setConfirm(false)}>
            Нет
          </button>
          <button className="perm-btn sy-danger" onClick={() => void window.masaki.passkeys.remove(it.id)}>
            Удалить
          </button>
        </>
      ) : (
        <button
          className="ib"
          aria-label={`Удалить ключ доступа для ${it.rpId}`}
          title="Удалить ключ. На сайте он останется в списке — уберите его и там"
          onClick={() => setConfirm(true)}
        >
          <Icon name="delete" />
        </button>
      )}
    </div>
  )
}

/** masaki://passwords — менеджер паролей. */
export function PasswordsPage(): React.JSX.Element {
  const rev = useStore((s) => s.pwRev)
  const sync = useStore((s) => s.sync)
  const [items, setItems] = useState<PasswordItem[] | null>(null)
  const [keys, setKeys] = useState<PasskeyItem[]>([])
  const [never, setNever] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    void window.masaki.passwords.list().then(setItems)
    void window.masaki.passkeys.list().then(setKeys)
    void window.masaki.passwords.never().then(setNever)
  }, [rev])

  const shown = useMemo(() => {
    const low = q.trim().toLowerCase()
    if (!items || !low) return items ?? []
    return items.filter((i) => i.host.toLowerCase().includes(low) || i.username.toLowerCase().includes(low) || i.note.toLowerCase().includes(low))
  }, [items, q])
  const shownKeys = useMemo(() => {
    const low = q.trim().toLowerCase()
    if (!low) return keys
    return keys.filter((k) => k.rpId.includes(low) || k.userName.toLowerCase().includes(low) || k.displayName.toLowerCase().includes(low))
  }, [keys, q])

  const synced = sync?.account && sync.vault === 'ready'
  return (
    <div className="settings pw-page">
      <div className="set-inner">
        <h1>Пароли</h1>
        <section>
          <p className="hint">
            {items ? passwordsWord(items.length) : '…'} · хранятся на этом компьютере зашифрованными Windows
            {synced ? ' и синхронизируются через Google Диск под вашим ключом.' : '.'}
          </p>
          <div className="pw-bar-tools">
            <span className="pw-search">
              <Icon name="search" />
              <input placeholder="Поиск по сайту или логину" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск паролей" />
            </span>
            <button className="tonal" onClick={() => setEditing('new')}>
              <Icon name="add" />
              Добавить
            </button>
            <button className="tonal" onClick={() => void window.masaki.passwords.importFile().then((r) => setMsg(importText(r)))}>
              <Icon name="download" />
              Импорт CSV…
            </button>
          </div>
          {msg && <p className="hint ci-done">{msg}</p>}
          {editing === 'new' && <Editor onDone={() => setEditing(null)} />}
          {items && items.length === 0 ? <GoogleHowTo open /> : <GoogleHowTo />}
          {!sync?.account && (
            <p className="hint pw-note">
              Чтобы пароли были и на других компьютерах, включите синхронизацию паролей в{' '}
              <button className="sy-link" onClick={() => useStore.getState().openSettings()}>
                настройках
              </button>
              .
            </p>
          )}
          <div className="pw-list">
            {shown.map((it) => (
              <Row key={it.id} it={it} editing={editing === it.id} onEdit={setEditing} />
            ))}
            {items && items.length > 0 && shown.length === 0 && <p className="hint">Ничего не нашлось.</p>}
          </div>
        </section>
        <section>
          <h2>Ключи доступа</h2>
          <p className="hint">
            {keys.length ? passkeysWord(keys.length) + '. ' : ''}
            Вход без пароля: сайт предлагает «Создать ключ доступа» (passkey), Masaki создаёт его и потом входит им
            сам — в окне поверх страницы или в списке у поля входа. Закрытый ключ не покидает Masaki
            {synced ? ', а на Диск уходит зашифрованным вашим ключом паролей.' : '.'}
          </p>
          {keys.length > 0 && (
            <div className="pw-list">
              {shownKeys.map((k) => (
                <PasskeyRow key={k.id} it={k} />
              ))}
              {shownKeys.length === 0 && <p className="hint">Ничего не нашлось.</p>}
            </div>
          )}
        </section>
        {never.length > 0 && (
          <section>
            <h2>Не предлагать сохранять</h2>
            <div className="sc-edit">
              {never.map((o) => (
                <div key={o} className="sc-item">
                  <span className="sc-item-t">
                    <b>{o.replace(/^https?:\/\/(www\.)?/, '')}</b>
                  </span>
                  <button
                    className="ib"
                    aria-label={`Снова предлагать для ${o}`}
                    title="Снова предлагать сохранять"
                    onClick={() => {
                      window.masaki.passwords.forgetNever(o)
                      setNever(never.filter((x) => x !== o))
                    }}
                  >
                    <Icon name="delete" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

/** Раздел «Пароли» в настройках: сколько сохранено и куда идти. */
export function PasswordsSummary(): React.JSX.Element {
  const rev = useStore((s) => s.pwRev)
  const [count, setCount] = useState<number | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    void window.masaki.passwords.list().then((l) => setCount(l.length))
  }, [rev])
  return (
    <>
      <div className="set-row">
        <span>
          {count === null ? 'Пароли' : passwordsWord(count)}
          <small>Masaki подставляет их на сайтах и предлагает сохранить новые. Хранятся зашифрованными Windows.</small>
        </span>
        <button className="tonal" onClick={() => useStore.getState().openPasswords()}>
          <Icon name="key" />
          Открыть пароли
        </button>
        <button className="tonal" onClick={() => void window.masaki.passwords.importFile().then((r) => setMsg(importText(r)))}>
          <Icon name="download" />
          Импорт CSV…
        </button>
      </div>
      {msg && <p className="hint ci-done">{msg}</p>}
      <GoogleHowTo />
    </>
  )
}
