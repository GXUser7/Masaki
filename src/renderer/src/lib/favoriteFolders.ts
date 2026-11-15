import type { Shortcut } from '../../../shared/types'
import { shapeCycle } from './shapes'
import { tileKeys } from './reorder'

export function favoriteGroups(items: Shortcut[]): { key: string; folder?: string; entries: { item: Shortcut; index: number }[] }[] {
  const groups: ReturnType<typeof favoriteGroups> = []
  const keys = tileKeys(items)
  items.forEach((item, index) => {
    let group = item.folder ? groups.find((g) => g.folder === item.folder) : undefined
    if (!group) {
      group = { key: item.folder ? 'folder:' + item.folder : keys[index], folder: item.folder, entries: [] }
      groups.push(group)
    }
    group.entries.push({ item, index })
  })
  return groups
}

/** Двигаем целиком выбранную папку; формы отдельных закладок остаются прежними. */
export function moveFavoriteGroup(items: Shortcut[], from: number, to: number): Shortcut[] {
  const groups = favoriteGroups(items)
  const [group] = groups.splice(from, 1)
  if (!group) return items
  groups.splice(to, 0, group)
  return groups.flatMap((g) => g.entries.map(({ item, index }) => ({ ...item, shape: item.shape ?? shapeCycle[index % shapeCycle.length] })))
}
