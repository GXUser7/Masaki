const FMT0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const FMT1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })
const FMT2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })

/** Размер файла по-русски: «98,4 МБ», «342 КБ». */
export function formatBytes(n: number): string {
  if (n < 1024) return n + ' Б'
  if (n < 1024 ** 2) return FMT0.format(n / 1024) + ' КБ'
  if (n < 1024 ** 3) return FMT1.format(n / 1024 ** 2) + ' МБ'
  return FMT2.format(n / 1024 ** 3) + ' ГБ'
}
