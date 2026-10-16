import { useEffect, useState } from 'react'
import type { PermissionPrompt, SitePermission } from '../../../shared/types'
import { shapes } from '../lib/shapes'
import { useStore } from '../store'
import { Icon, type IconName } from './Icon'
import { Grain } from './parts'

const icons: Record<PermissionPrompt['kind'], IconName> = {
  location: 'location',
  camera: 'camera',
  mic: 'mic',
  media: 'camera',
  notifications: 'bell',
  clipboard: 'paste',
  other: 'lock'
}

/** Запрос сайта на доступ — стеклянная плашка над страницей вместо системного окна Windows. */
export function PermissionBar(): React.JSX.Element | null {
  const prompts = useStore((s) => s.permissions)
  const p = prompts[0]
  if (!p) return null
  const answer = (allow: boolean, remember: boolean) => () => {
    window.masaki.permissions.answer(p.id, allow, remember)
    useStore.getState().dropPermission(p.id)
  }
  return (
    <div className="glass perm" role="alertdialog" aria-label="Запрос разрешения" key={p.id}>
      <Grain />
      <span className="perm-ic">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <path d={shapes.cookie9} />
        </svg>
        <Icon name={icons[p.kind]} />
      </span>
      <span className="perm-t">
        <b>{p.origin}</b> {p.text}
        {prompts.length > 1 && <small>Ещё запросов: {prompts.length - 1}</small>}
      </span>
      <span className="perm-acts">
        <button className="perm-btn ghost" onClick={answer(false, true)}>
          Запретить
        </button>
        <button className="perm-btn tonal-b" onClick={answer(true, false)}>
          Только сейчас
        </button>
        <button className="perm-btn primary" onClick={answer(true, true)}>
          Разрешить
        </button>
      </span>
    </div>
  )
}

/** Раздел настроек: запомненные решения по сайтам. */
export function PermissionList(): React.JSX.Element {
  const [items, setItems] = useState<SitePermission[] | null>(null)
  const reload = (): void => void window.masaki.permissions.list().then(setItems)
  useEffect(reload, [])
  if (!items) return <p className="hint">Загружаю…</p>
  if (!items.length) return <p className="hint">Вы ещё ничего не разрешали и не запрещали сайтам.</p>
  return (
    <div className="sc-edit">
      {items.map((it) => (
        <div key={it.origin + it.permission} className="sc-item">
          <span className="sc-item-t">
            <b>{it.site}</b>
            <small>{it.label}</small>
          </span>
          <span className={'perm-state' + (it.allow ? ' ok' : '')}>{it.allow ? 'Разрешено' : 'Запрещено'}</span>
          <button
            className="ib"
            aria-label={`Сбросить решение для ${it.site}`}
            title="Сбросить — сайт спросит снова"
            onClick={() => {
              window.masaki.permissions.forget(it.origin, it.permission)
              reload()
            }}
          >
            <Icon name="delete" />
          </button>
        </div>
      ))}
    </div>
  )
}
