import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SitePermission } from '../../../shared/types'
import { siteCookieDomain } from '../../../shared/site'
import { hostOf } from '../lib/url'
import { translatePageUrl } from '../menus'
import { useStore, wv } from '../store'
import { Icon } from './Icon'
import { Grain } from './parts'

// Панель «О сайте» — как «Сведения о сайте» в Chrome: что за сайт, какие решения по разрешениям
// приняты, куки и данные. Открывается щитом в адресной капсуле (и в панели, и в доке).

export function SiteInfoSheet(): React.JSX.Element | null {
  const open = useStore((s) => s.siteInfo)
  const t = useStore((s) => s.tabs.find((x) => x.id === s.activeId))
  const collapsed = useStore((s) => s.settings.sidebarCollapsed)
  const [perms, setPerms] = useState<SitePermission[] | null>(null)
  const [cookies, setCookies] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const box = panel.current
      if (!box) return
      const button = document.querySelector(`.abar-${collapsed ? 'cap' : 'side'} .a-lock`)
      const anchor = button?.getBoundingClientRect() ?? open.anchor
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - box.offsetWidth - 12))
      // В доке лист открывается над кнопкой, в панели — под ней; bottom от общего .pop не наследуем.
      setPosition(collapsed
        ? { left, bottom: window.innerHeight - anchor.top + 8, top: 'auto' }
        : { left, top: anchor.bottom + 8, bottom: 'auto' })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, collapsed])
  useEffect(() => {
    if (!open) return
    setPerms(null)
    setCookies(null)
    if (t?.kind !== 'web' || t.id !== open.tabId || t.url !== open.url || !/^https?:/i.test(t.url)) {
      useStore.setState({ siteInfo: null })
      return
    }
    let live = true
    void window.masaki.permissions.list().then((all) => {
      if (live) setPerms(all.filter((p) => p.origin === new URL(t.url).origin))
    })
    // Как в Chrome: Esc закрывает сведения о сайте.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useStore.setState({ siteInfo: null })
    }
    window.addEventListener('keydown', onKey)
    return () => {
      live = false
      window.removeEventListener('keydown', onKey)
    }
  }, [open, t?.id, t?.url, t?.kind])

  if (!open || !t || t.kind !== 'web' || !/^https?:/i.test(t.url)) return null
  const origin = new URL(t.url).origin
  const host = hostOf(t.url)
  const https = t.url.startsWith('https:')
  const site = siteCookieDomain(t.url)
  const close = (): void => useStore.setState({ siteInfo: null })

  const clearCookies = async (): Promise<void> => {
    const view = wv(t.id)
    if (!view) return
    setCookies('cleaning')
    const r = await window.masaki.site.clearCookies(view.getWebContentsId(), origin).catch(() => ({ ok: false, error: 'Не получилось' }))
    setCookies(r.ok ? 'done' : 'error')
  }

  return (
    <>
      <button className="pop-scrim" aria-label="Закрыть сведения о сайте" onClick={close} />
      <div ref={panel} className="glass pop site-info" style={position} role="dialog" aria-label={`Сведения о сайте ${host}`}>
        <Grain />
        <div className={'pop-h si-head' + (https ? '' : ' insecure')}>
          <Icon name={https ? 'lock' : 'warn'} />
          <span className="si-host">{host}</span>
        </div>
        <b className={'si-security' + (https ? '' : ' insecure')}>{https ? 'Соединение защищено' : 'Соединение не защищено'}</b>
        <p className="hint si-note">
          {https ? 'Данные между Masaki и сайтом шифруются.' : 'Без шифрования: не вводите пароли на этом сайте.'}
        </p>
        <div className="si-acts">
          <button className="mi" onClick={() => (close(), useStore.getState().navigate(t.url, { raw: true, target: 'new' }))}>
            <Icon name="openInNew" /> Открыть адрес в новой вкладке
          </button>
          <button className="mi" onClick={() => window.masaki.copyText(t.url, 'Адрес скопирован')}>
            <Icon name="link" /> Копировать адрес
          </button>
          <button
            className="mi"
            onClick={() => {
              const u = translatePageUrl(t.url)
              if (u) (close(), useStore.getState().navigate(u, { raw: true }))
            }}
          >
            <Icon name="translate" /> Перевести на русский
          </button>
        </div>

        <div className="si-sep" />
        <div className="pop-h">Разрешения</div>
        {perms === null ? (
          <p className="hint">Читаю решения…</p>
        ) : perms.length === 0 ? (
          <p className="hint">Вы ещё ничего не разрешали и не запрещали этому сайту.</p>
        ) : (
          <div className="sc-edit">
            {perms.map((p) => (
              <div key={p.origin + p.permission} className="sc-item">
                <span className="sc-item-t">
                  <b>{p.label}</b>
                </span>
                <span className={'perm-state' + (p.allow ? ' ok' : '')}>{p.allow ? 'Разрешено' : 'Запрещено'}</span>
                <button
                  className="ib"
                  aria-label={`Сбросить решение «${p.label}»`}
                  title="Сбросить — сайт спросит снова"
                  onClick={() => {
                    window.masaki.permissions.forget(p.origin, p.permission)
                    void window.masaki.permissions.list().then((all) => setPerms(all.filter((x) => x.origin === origin)))
                  }}
                >
                  <Icon name="delete" />
                </button>
              </div>
            ))}
          </div>
        )}

        {site && (
          <>
            <div className="si-sep" />
            <div className="pop-h">Данные</div>
            <button className="mi sy-mi" onClick={() => void clearCookies()} disabled={cookies === 'cleaning'}>
              <Icon name={cookies === 'done' ? 'check' : cookies === 'error' ? 'warn' : 'delete'} />
              <span className="sy-mi-t" aria-live="polite">
                {cookies === 'cleaning' ? 'Очистка кук…' : cookies === 'done' ? 'Куки очищены' : cookies === 'error' ? 'Не удалось очистить куки' : 'Очистить куки сайта'}
                <small>{cookies === 'done' ? 'потребуется войти заново' : `${site} и его поддомены`}</small>
              </span>
            </button>
            <button
              className="mi"
              onClick={() => {
                void window.masaki.site.clearData(origin)
                setCookies('data-done')
              }}
            >
              <Icon name={cookies === 'data-done' ? 'check' : 'delete'} />
              <span className="sy-mi-t">
                Очистить данные сайта
                <small>хранилища, IndexedDB, Service Worker — куки останутся</small>
              </span>
            </button>
          </>
        )}
      </div>
    </>
  )
}
