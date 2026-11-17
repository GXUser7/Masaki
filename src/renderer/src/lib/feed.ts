// Общие помощники ленты по дням (история и загрузки): кэшированные форматтеры дат и периоды.

export type Period = 'all' | 'today' | 'yesterday' | 'week' | 'month'

export const PERIODS: { id: Period; label: string }[] = [
  { id: 'all', label: 'За всё время' },
  { id: 'today', label: 'Сегодня' },
  { id: 'yesterday', label: 'Вчера' },
  { id: 'week', label: 'За неделю' },
  { id: 'month', label: 'За месяц' }
]

export const DAY = 24 * 60 * 60 * 1000

const TIME_FMT = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })
const DATE_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
const DATE_YEAR_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
const WEEKDAY_FMT = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' })

let cachedDayStart = 0
let cachedDayEnd = 0

export function startOfDay(t: number): number {
  if (t >= cachedDayStart && t < cachedDayEnd) return cachedDayStart
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  cachedDayStart = d.getTime()
  const next = new Date(d)
  next.setDate(next.getDate() + 1)
  cachedDayEnd = next.getTime()
  return cachedDayStart
}

/** Диапазон времени [from, to) для фильтра периода — считается один раз на проход, а не на каждую строку. */
export function periodRange(p: Period, now = Date.now()): [number, number] {
  if (p === 'all') return [-Infinity, Infinity]
  const today = startOfDay(now)
  switch (p) {
    case 'today':
      return [today, Infinity]
    case 'yesterday':
      return [today - DAY, today]
    case 'week':
      return [today - 6 * DAY, Infinity]
    case 'month':
      return [today - 29 * DAY, Infinity]
  }
}

export const timeOf = (t: number): string => TIME_FMT.format(t)

export function dayLabel(day: number, today = startOfDay(Date.now()), currentYear = new Date(today).getFullYear()): [string, string] {
  const d = new Date(day)
  const date = (d.getFullYear() === currentYear ? DATE_FMT : DATE_YEAR_FMT).format(d)
  if (day === today) return ['Сегодня', date]
  if (day === today - DAY) return ['Вчера', date]
  const wd = WEEKDAY_FMT.format(d)
  return [wd.charAt(0).toUpperCase() + wd.slice(1), date]
}
