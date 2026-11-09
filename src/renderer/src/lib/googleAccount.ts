import { useStore, wv } from '../store'

const HOME = 'https://www.google.com/'
const pending = new Set<string>()

/** Вход начинается на сайте, как при ручном входе: ссылку и контекст перехода создаёт сам Google. */
export function openGoogleAccount(): void {
  pending.add(useStore.getState().newTab(HOME))
}

export function cancelGoogleAccountEntry(id: string): void {
  pending.delete(id)
}

export function continueGoogleAccountEntry(id: string): void {
  if (!pending.has(id)) return
  const view = wv(id)
  if (!view) return
  let url: URL
  try { url = new URL(view.getURL()) } catch { return }
  // Если сначала нужен выбор cookie Google, пользователь проходит его на самом сайте.
  if (url.origin === 'https://consent.google.com') return
  pending.delete(id)
  if (url.origin !== 'https://www.google.com' || url.pathname !== '/') return
  void view.executeJavaScript(String.raw`(() => {
    if (location.origin !== 'https://www.google.com' || location.pathname !== '/') return;
    const find = () => [...document.querySelectorAll('a[href]')].find(a => {
      const u = new URL(a.href);
      return u.origin === 'https://accounts.google.com' &&
        /^\/(?:ServiceLogin|AccountChooser|SignOutOptions|AddSession|v3\/signin)(?:\/|$)/.test(u.pathname) &&
        a.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) &&
        [...a.getClientRects()].some(r => r.width > 0 && r.height > 0);
    });
    const click = () => {
      if (location.origin !== 'https://www.google.com' || location.pathname !== '/') return false;
      const a = find();
      if (!a) return false;
      a.click();
      return true;
    };
    if (click()) return;
    // Шапка может появиться позже основного документа. При другой разметке остаётся обычный сайт Google.
    const observer = new MutationObserver(() => { if (click()) observer.disconnect(); });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['href', 'class', 'style', 'hidden', 'aria-hidden']
    });
    setTimeout(() => observer.disconnect(), 5000);
  })()`, true).catch(() => undefined)
}
