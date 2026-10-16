import { useEffect, useState } from 'react'
import { aiButton } from '../actions'
import { useStore } from '../store'
import { Clock } from './Clock'
import { Icon } from './Icon'
import { ShapeTile } from './parts'
import { openTileMenu } from '../menus'
import { moveTiles, tileKeys, useReorder } from '../lib/reorder'

function useDateLabel(): string {
  const [d, setD] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setD(new Date()), 30000)
    return () => window.clearInterval(t)
  }, [])
  const s = d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function NewTab(): React.JSX.Element {
  // Как в Chrome: на новой вкладке можно сразу печатать — первая буква открывает палитру.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const st = useStore.getState()
      if (st.palette.open || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      e.preventDefault()
      st.openPalette(false, 'current', e.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const clock = useStore((s) => s.settings.clock)
  const shortcuts = useStore((s) => s.settings.shortcuts)
  const themed = useStore((s) => s.settings.scThemed)
  const date = useDateLabel()
  const s = useStore.getState
  const rd = useReorder(tileKeys(shortcuts), (from, to) => s().setSettings({ shortcuts: moveTiles(s().settings.shortcuts, from, to) }))
  const compact = clock.size === 'small'

  return (
    <div className={'ntp' + (compact ? ' small' : '')}>
      <div className="ntp-clock">
        {clock.style !== 'summary' && <div className="pdate">{date}</div>}
        <Clock cfg={clock} compact={compact} />
      </div>
      <div className="search">
        <button className="fakebox" title="Поиск или адрес · Ctrl+K" onClick={() => s().openPalette(false)}>
          <Icon name="search" />
          <span className="fb-t">Поиск в Google или адрес сайта</span>
        </button>
        <button className="chip" title="Спросить AI Mode" onClick={aiButton}>
          <Icon name="sparkle" />
          AI Mode
        </button>
      </div>
      <div ref={rd.box} className={'shortcuts' + (rd.dragging !== null ? ' rd-on' : '')} {...rd.boxProps}>
        {shortcuts.map((sc, i) => {
          const drag = rd.item(i, sc.url)
          return (
            <button
              key={drag['data-rk']}
              {...drag}
              className={'sc' + (rd.dragging === i ? ' rd-drag' : '')}
              title={sc.url}
              onClick={() => s().navigate(sc.url, { raw: true })}
              onContextMenu={(e) => {
                e.preventDefault()
                openTileMenu(e.clientX, e.clientY, 'shortcuts', i)
              }}
            >
              <span className="sc-shape">
                <ShapeTile item={sc} index={i} themed={themed} />
              </span>
              <span className="sc-l">{sc.title}</span>
            </button>
          )
        })}
        <button className="sc" onClick={() => s().openSettings()}>
          <span className="sc-shape add">
            <Icon name="add" />
          </span>
          <span className="sc-l">Изменить</span>
        </button>
      </div>
    </div>
  )
}
