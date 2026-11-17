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

/** Список уникальных названий групп в порядке первого появления. */
export function folderNames(items: Shortcut[]): string[] {
  const names: string[] = []
  for (const item of items) {
    const name = item.folder?.trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** Следующее свободное имя вида «Группа N». */
export function nextFolderName(items: Shortcut[], base = 'Группа'): string {
  const used = new Set(folderNames(items))
  let n = 1
  while (used.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** Назначить закладке папку или убрать её из папки (если folder пустой/undefined). */
export function assignFavoriteFolder(items: Shortcut[], index: number, folder?: string): Shortcut[] {
  const name = folder?.trim()
  return items.map((it, j) => {
    if (j !== index) return it
    const { folder: _was, ...rest } = it
    return name ? { ...rest, folder: name } : rest
  })
}

/** Переименовать папку на всех её закладках; пустое или совпадающее имя ничего не меняет. */
export function renameFavoriteFolder(items: Shortcut[], oldName: string, newName: string): Shortcut[] {
  const next = newName.trim()
  if (!next || next === oldName) return items
  return items.map((it) => (it.folder === oldName ? { ...it, folder: next } : it))
}

/** Расформировать группу: оставить все закладки в избранном без поля folder. */
export function ungroupFavoriteFolder(items: Shortcut[], name: string): Shortcut[] {
  return items.map((it) => {
    if (it.folder !== name) return it
    const { folder: _was, ...rest } = it
    return rest
  })
}

/** Удалить группу вместе со всеми её закладками из избранного. */
export function deleteFavoriteFolder(items: Shortcut[], name: string): Shortcut[] {
  return items.filter((it) => it.folder !== name)
}
