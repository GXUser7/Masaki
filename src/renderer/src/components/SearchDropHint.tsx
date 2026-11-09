import { shapes } from '../lib/shapes'
import { Icon } from './Icon'

/** Карточка остаётся в DOM до конца ухода, а жест по-прежнему принимает сама панель. */
export function SearchDropHint({ active }: { active: boolean }): React.JSX.Element {
  return (
    <div className={'search-drop-hint' + (active ? ' on' : '')} aria-hidden={!active}>
      <span className="sdh-badge" aria-hidden="true">
        <svg className="sdh-shape" viewBox="0 0 200 200"><path d={shapes.cookie9} /></svg>
        <Icon name="search" />
      </span>
      <span className="sdh-copy">
        <b>Отпустите для поиска</b>
        <small>Откроется в новой вкладке</small>
      </span>
    </div>
  )
}
