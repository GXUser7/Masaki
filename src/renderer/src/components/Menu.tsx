import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { tileColorsFor, tileSwatches, type TileColors } from '../lib/iconColor'
import { shapeNames, shapes, type ShapeName } from '../lib/shapes'
import { useStore } from '../store'
import { Icon, type IconName } from './Icon'
import { Grain } from './parts'

export type MenuEntry =
  | { kind: 'item'; label: string; icon?: IconName; kbd?: string; disabled?: boolean; danger?: boolean; run: () => void }
  | { kind: 'sep' }
  | { kind: 'header'; label: string; sub?: string }
  | { kind: 'shapes'; current: ShapeName; pick: (s: ShapeName) => void }
  /** Ряд цветов плитки: «Авто» (undefined), оттенки и свой цвет. auto — заливка из значка сайта, если он уже загружен. */
  | { kind: 'colors'; current: string | undefined; auto: TileColors | null; pick: (color: string | undefined) => void }

type ColorsEntry = Extract<MenuEntry, { kind: 'colors' }>

/** Заливка кружка — те же тона, что у самой плитки; светлую или тёмную выбирает тема в CSS. */
const dotVars = (c: TileColors): CSSProperties =>
  ({ '--tl': c.light.fill, '--td': c.dark.fill, '--il': c.light.ink, '--id': c.dark.ink }) as CSSProperties

/** Ряд цветов плитки. Меню не закрывается: плитка перекрашивается на глазах, как при смене формы. */
function ColorRow({ entry, onPicker }: { entry: ColorsEntry; onPicker: () => void }): React.JSX.Element {
  const cur = entry.current?.toLowerCase()
  const isPreset = tileSwatches.some((s) => s.hex === cur)
  const own = cur && !isPreset ? cur : undefined
  const ownVars = own ? dotVars(tileColorsFor(own)) : undefined
  // Радуга «Свой…» собрана из тех же оттенков, что и ряд, — без отдельных цветов в стилях.
  const rainbow = `conic-gradient(${[...tileSwatches.slice(0, 9), tileSwatches[0]].map((s) => s.hex).join(', ')})`
  return (
    <div className="cm-colors" role="radiogroup" aria-label="Цвет плитки">
      <button
        role="radio"
        aria-checked={!cur}
        title="Авто — цвет из значка сайта"
        aria-label="Цвет: Авто, из значка сайта"
        className={'cm-color auto' + (!cur ? ' on' : '')}
        onClick={() => entry.pick(undefined)}
      >
        <i className={'cm-color-dot' + (entry.auto ? '' : ' none')} style={entry.auto ? dotVars(entry.auto) : undefined}>
          <Icon name="image" />
        </i>
      </button>
      {tileSwatches.map((s) => (
        <button
          key={s.hex}
          role="radio"
          aria-checked={s.hex === cur}
          title={s.name}
          aria-label={'Цвет: ' + s.name}
          className={'cm-color' + (s.hex === cur ? ' on' : '')}
          onClick={() => entry.pick(s.hex)}
        >
          <i className="cm-color-dot" style={dotVars(tileColorsFor(s.hex))}>
            {s.hex === cur && <Icon name="check" />}
          </i>
        </button>
      ))}
      <label className={'cm-color own' + (own ? ' on' : '')} title="Свой цвет…" aria-label="Цвет: свой">
        <i className="cm-color-dot" style={own ? ownVars : { background: rainbow }}>
          {own && <Icon name="check" />}
        </i>
        <input
          type="color"
          aria-label="Свой цвет"
          value={own ?? cur ?? entry.auto?.light.fill ?? tileSwatches[6].hex}
          onClick={onPicker}
          onChange={(e) => entry.pick(e.target.value.toLowerCase())}
        />
      </label>
    </div>
  )
}

/** Стеклянное контекстное меню Masaki: и для страниц, и для вкладок, плиток и полей ввода. */
export function ContextMenu(): React.JSX.Element | null {
  const menu = useStore((s) => s.menu)
  const close = useStore((s) => s.closeMenu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // Окно выбора цвета отбирает у окна фокус; меню при этом закрываться не должно, иначе выбор уйдёт в пустоту.
  const picking = useRef(false)

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
    picking.current = false
    const onBlur = (): void => {
      if (!picking.current) close()
    }
    const onFocus = (): void => {
      picking.current = false
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
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
          if (e.kind === 'colors')
            return (
              <ColorRow
                key={i}
                entry={e}
                onPicker={() => {
                  picking.current = true
                }}
              />
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
