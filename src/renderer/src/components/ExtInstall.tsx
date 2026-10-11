import { useEffect, useState } from 'react'
import type { ExtInstallPrompt } from '../../../shared/types'
import { shapes } from '../lib/shapes'
import { Icon } from './Icon'
import { Grain } from './parts'

/**
 * «Добавить расширение?» — Chrome Web Store просит установить расширение. Спрашивает Masaki, а не страница
 * магазина: сайт не может ни подделать это окно, ни нажать его кнопки. Что расширение сможет делать,
 * написано по его manifest.json.
 */
export function ExtInstallSheet(): React.JSX.Element | null {
  const [queue, setQueue] = useState<ExtInstallPrompt[]>([])
  useEffect(() => window.masaki.extensions.onInstallPrompt((p) => setQueue((q) => [...q.filter((x) => x.id !== p.id), p])), [])
  const p = queue[0]
  const answer = (allow: boolean) => (): void => {
    if (!p) return
    window.masaki.extensions.answerInstall(p.id, allow)
    setQueue((q) => q.filter((x) => x.id !== p.id))
  }
  useEffect(() => {
    if (!p) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      answer(false)()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p])
  if (!p) return null
  const title = `Добавить «${p.name}»?`
  return (
    <div className="pk-layer">
      <div className="pk-scrim" />
      <div className="glass pk-card ext-card" role="dialog" aria-modal="true" aria-label={title} key={p.id}>
        <Grain />
        {p.icon ? (
          <img className="ext-card-ic" src={p.icon} alt="" draggable={false} />
        ) : (
          <span className="perm-ic pk-ic">
            <svg viewBox="0 0 200 200" aria-hidden="true">
              <path d={shapes.cookie9} />
            </svg>
            <Icon name="extension" />
          </span>
        )}
        <h2 className="pk-title">{title}</h2>
        {p.permissions.length > 0 ? (
          <>
            <p className="pk-sub">Расширение сможет:</p>
            <ul className="ext-perms">
              {p.permissions.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="pk-sub">Особых разрешений расширению не нужно.</p>
        )}
        <p className="pk-sub ext-note">Из Chrome Web Store, обновляется само. Удалить можно в «Аддонах».</p>
        <div className="pk-acts">
          <span className="pk-sp" />
          <button className="perm-btn tonal-b" onClick={answer(false)}>
            Отмена
          </button>
          <button className="perm-btn primary" autoFocus onClick={answer(true)}>
            Добавить расширение
          </button>
        </div>
      </div>
    </div>
  )
}
