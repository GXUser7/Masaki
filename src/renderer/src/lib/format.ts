/** Размер файла по-русски: «98,4 МБ», «342 КБ». */
export function formatBytes(n: number): string {
  const num = (v: number, digits: number): string => v.toLocaleString('ru-RU', { maximumFractionDigits: digits })
  if (n < 1024) return n + ' Б'
  if (n < 1024 ** 2) return num(n / 1024, 0) + ' КБ'
  if (n < 1024 ** 3) return num(n / 1024 ** 2, 1) + ' МБ'
  return num(n / 1024 ** 3, 2) + ' ГБ'
}
