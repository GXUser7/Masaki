// Профили в меню аккаунта, как в Chrome: у каждого своё окно со своими входами на сайты, вкладками,
// историей и паролями (src/main/profiles.ts). Имя и аватар профиль берёт у своего аккаунта Google.

import { useState } from 'react'
import type { ProfileInfo } from '../../../shared/types'
import { useStore } from '../store'
import { Icon } from './Icon'

function ProfileAva({ p }: { p: ProfileInfo }): React.JSX.Element {
  if (p.photo) return <img src={p.photo} alt="" referrerPolicy="no-referrer" />
  return (
    <span className="pf-letter" style={{ '--pf': p.color } as React.CSSProperties}>
      {(p.name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

export function ProfilesBlock({ close }: { close: () => void }): React.JSX.Element {
  const profiles = useStore((s) => s.profiles)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const api = window.masaki.profiles
  const reload = (): void => useStore.getState().loadProfiles()
  const save = (id: string): void => {
    if (name.trim()) api.rename(id, name)
    setEditing(null)
    setTimeout(reload, 150)
  }

  return (
    <>
      <div className="pop-h">Профили</div>
      {profiles.map((p) =>
        editing === p.id ? (
          <div key={p.id} className="pf-edit">
            <ProfileAva p={p} />
            <input
              autoFocus
              value={name}
              maxLength={40}
              aria-label="Имя профиля"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save(p.id)
                if (e.key === 'Escape') setEditing(null)
              }}
              onBlur={() => save(p.id)}
            />
          </div>
        ) : removing === p.id ? (
          <div key={p.id} className="pf-confirm">
            <small>Удалить профиль «{p.name}» вместе с его вкладками, входами на сайты и паролями?</small>
            <span className="pf-confirm-b">
              <button className="perm-btn ghost" onClick={() => setRemoving(null)}>
                Нет
              </button>
              <button
                className="perm-btn sy-danger"
                onClick={() =>
                  void api.remove(p.id).then((r) => {
                    setRemoving(null)
                    setErr(r.ok ? '' : (r.error ?? 'Не получилось'))
                    reload()
                  })
                }
              >
                Удалить
              </button>
            </span>
          </div>
        ) : (
          <div key={p.id} className={'pf-row' + (p.current ? ' cur' : '')}>
            <button
              className="acc-row"
              title={p.current ? 'Профиль этого окна' : 'Открыть окно профиля'}
              onClick={() => {
                if (!p.current) api.open(p.id)
                close()
              }}
            >
              <ProfileAva p={p} />
              <span className="acc-t">
                <b>{p.name}</b>
                <small>{p.current ? 'Это окно' + (p.email ? ' · ' + p.email : '') : p.email || 'Без аккаунта Google'}</small>
              </span>
              {p.current && <Icon name="check" />}
            </button>
            <button
              className="ib pf-act"
              aria-label={`Переименовать «${p.name}»`}
              title="Переименовать"
              onClick={() => {
                setName(p.name)
                setEditing(p.id)
              }}
            >
              <Icon name="edit" />
            </button>
            {!p.current && p.id !== 'default' && (
              <button className="ib pf-act" aria-label={`Удалить «${p.name}»`} title="Удалить профиль" onClick={() => setRemoving(p.id)}>
                <Icon name="delete" />
              </button>
            )}
          </div>
        )
      )}
      {err && <p className="err-text pf-err">{err}</p>}
      <button
        className="mi"
        onClick={() => {
          void api.create().then(reload)
          close()
        }}
      >
        <Icon name="add" /> Новый профиль
      </button>
    </>
  )
}
