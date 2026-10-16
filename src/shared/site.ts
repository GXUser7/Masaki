import { getDomain } from 'tldts'

/** Граница сайта совпадает с Chromium: частные суффиксы не объединяют чужие проекты на github.io и т. п. */
export function siteCookieDomain(address: string): string {
  try {
    const url = new URL(address)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname
  } catch {
    return ''
  }
}
