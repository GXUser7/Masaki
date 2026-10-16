import { useEffect, useRef, useState } from 'react'
import type { JsDialog, PermissionPrompt, SitePermission } from '../../../shared/types'
import { shapes } from '../lib/shapes'
import { tabIdOfWebContents, useStore } from '../store'
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

const dialogIcons: Record<JsDialog['type'], IconName> = { alert: 'bell', confirm: 'check', prompt: 'edit' }
const dialogVerbs: Record<JsDialog['type'], string> = { alert: 'сообщает', confirm: 'спрашивает', prompt: 'просит ввести' }
/** Сколько окон уже показала вкладка: со второго можно запретить остальные, как в Chrome. */
const dialogCounts = new Map<number, number>()

/**
 * Окно страницы (alert / confirm / prompt) в стиле Masaki вместо системного окна Windows — видно на своей
 * вкладке, страница стоит, пока не ответят. Enter — «ОК», Esc — «Отмена». Рисует его интерфейс, а не сайт.
 */
export function PageDialog(): React.JSX.Element | null {
  const dialogs = useStore((s) => s.jsDialogs)
  const activeId = useStore((s) => s.activeId)
  const d = dialogs.find((x) => tabIdOfWebContents(x.wcId) === activeId)
  const [value, setValue] = useState('')
  const [mute, setMute] = useState(false)
  const [count, setCount] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const ok = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!d) return
    const n = (dialogCounts.get(d.wcId) ?? 0) + 1
    dialogCounts.set(d.wcId, n)
    setCount(n)
    setValue(d.value ?? '')
    setMute(false)
    // Фокус — в окно Masaki: страница стоит и клавиш всё равно не примет.
    requestAnimationFrame(() => (d.type === 'prompt' ? input.current?.select() : ok.current?.focus()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.id])
  if (!d) return null

  const answer = (yes: boolean): void => {
    window.masaki.jsDialogs.answer(d.id, yes, d.type === 'prompt' && yes ? value : undefined, mute)
    if (mute) dialogCounts.delete(d.wcId)
    useStore.setState((s) => ({ jsDialogs: s.jsDialogs.filter((x) => x.id !== d.id) }))
  }
  const title = `${d.origin} ${dialogVerbs[d.type]}`
  return (
    <div
      className="pk-layer"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          answer(d.type === 'alert')
        } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault()
          answer(true)
        }
      }}
    >
      <div className="pk-scrim" />
      <div className="glass pk-card pd-card" role={d.type === 'alert' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={title} key={d.id}>
        <Grain />
        <span className="perm-ic pk-ic">
          <svg viewBox="0 0 200 200" aria-hidden="true">
            <path d={shapes.cookie9} />
          </svg>
          <Icon name={dialogIcons[d.type]} />
        </span>
        <h2 className="pk-title pd-title">{title}</h2>
        {d.message && <p className="pd-msg">{d.message}</p>}
        {d.type === 'prompt' && (
          <input ref={input} className="pd-input" value={value} spellCheck={false} aria-label="Ответ странице" onChange={(e) => setValue(e.target.value)} />
        )}
        {count > 1 && (
          <label className="pd-mute">
            <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} />
            Больше не показывать окна этой страницы
          </label>
        )}
        <div className="pk-acts">
          <span className="pk-sp" />
          {d.type !== 'alert' && (
            <button className="perm-btn tonal-b" onClick={() => answer(false)}>
              Отмена
            </button>
          )}
          <button ref={ok} className="perm-btn primary" onClick={() => answer(true)}>
            ОК
          </button>
        </div>
      </div>
    </div>
  )
}
