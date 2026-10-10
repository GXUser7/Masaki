import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { shapeNames, shapes, type ShapeName } from '../lib/shapes'
import { useStore } from '../store'
import { Icon, type IconName } from './Icon'
import { Grain } from './parts'

export type MenuEntry =
  | { kind: 'item'; label: string; icon?: IconName; kbd?: string; disabled?: boolean; danger?: boolean; run: () => void }
  | { kind: 'sep' }
  | { kind: 'header'; label: string; sub?: string }
  | { kind: 'shapes'; current: ShapeName; pick: (s: ShapeName) => void }

/** Стеклянное контекстное меню Masaki: и для страниц, и для вкладок, плиток и полей ввода. */
export function ContextMenu(): React.JSX.Element | null {
  const menu = useStore((s) => s.menu)
  const close = useStore((s) => s.closeMenu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    setPos(null)
    if (!menu) return
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8))
    const top = menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height) : menu.y
    setPos({ left, top })
    // Пересчитываем место только при новом открытии, а не при смене формы в том же меню.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu?.x, menu?.y, !!menu])

  useEffect(() => {
    if (!menu) return
    const first = ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    first?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button.cm-item:not(:disabled)') ?? [])]
      const i = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
      next?.focus()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu?.x, menu?.y, !!menu, close])

  if (!menu) return null
  const run = (fn: () => void) => () => {
    close()
    fn()
  }

  return (
    <>
      <div
        className="cm-scrim"
        onMouseDown={close}
        onContextMenu={(e) => {
          e.preventDefault()
          close()
        }}
      />
      <div
        ref={ref}
        className={'glass cmenu' + (pos ? ' shown' : '')}
        role="menu"
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Grain />
        {menu.entries.map((e, i) => {
          if (e.kind === 'sep') return <div key={i} className="cm-sep" />
          if (e.kind === 'header')
            return (
              <div key={i} className="cm-head">
                <b>{e.label}</b>
                {e.sub && <small>{e.sub}</small>}
              </div>
            )
          if (e.kind === 'shapes')
            return (
              <div key={i} className="cm-shapes" role="radiogroup" aria-label="Форма">
                {(Object.keys(shapes) as ShapeName[]).map((name) => (
                  <button
                    key={name}
                    role="radio"
                    aria-checked={name === e.current}
                    title={shapeNames[name]}
                    aria-label={shapeNames[name]}
                    className={'cm-shape' + (name === e.current ? ' on' : '')}
                    onClick={() => e.pick(name)}
                  >
                    <svg viewBox="0 0 200 200">
                      <path d={shapes[name]} />
                    </svg>
                  </button>
                ))}
              </div>
            )
          return (
            <button
              key={i}
              role="menuitem"
              className={'cm-item' + (e.danger ? ' danger' : '')}
              disabled={e.disabled}
              onClick={run(e.run)}
            >
              {e.icon ? <Icon name={e.icon} /> : <span className="cm-noic" />}
              <span className="cm-l">{e.label}</span>
              {e.kbd && <span className="kbd">{e.kbd}</span>}
            </button>
          )
        })}
      </div>
    </>
  )
}
