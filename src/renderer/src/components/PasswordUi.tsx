import { useEffect, useRef, useState } from 'react'
import { shapes } from '../lib/shapes'
import { tabIdOfWebContents, useStore } from '../store'
import { Icon } from './Icon'
import { Grain } from './parts'

export function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return forms[0]
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1]
  return forms[2]
}

export const passwordsWord = (n: number): string => `${n} ${plural(n, ['пароль', 'пароля', 'паролей'])}`

/** Плашка над страницей: сохранить пароль после входа или перенести скачанный экспорт паролей. */
export function PasswordBar(): React.JSX.Element | null {
  const offer = useStore((s) => s.pwOffers[0])
  const csv = useStore((s) => s.pwCsv[0])
  const permissionShown = useStore((s) => s.permissions.length > 0)
  const [done, setDone] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(null), 6000)
    return () => window.clearTimeout(t)
  }, [done])

  // Запрос сайта на доступ важнее — плашки не накладываем друг на друга.
  if (permissionShown) return null

  const icon = (
    <span className="perm-ic">
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <path d={shapes.cookie9} />
      </svg>
      <Icon name="key" />
    </span>
  )

  if (done) {
    return (
      <div className="glass perm pw-bar" role="status">
        <Grain />
        {icon}
        <span className={'perm-t' + (done.error ? ' err-text' : '')}>{done.text}</span>
        <span className="perm-acts">
          <button className="perm-btn ghost" onClick={() => setDone(null)}>
            Закрыть
          </button>
          {!done.error && (
            <button className="perm-btn tonal-b" onClick={() => (setDone(null), useStore.getState().openPasswords())}>
              Открыть пароли
            </button>
          )}
        </span>
      </div>
    )
  }

  if (csv) {
    const drop = (): void => useStore.setState((s) => ({ pwCsv: s.pwCsv.filter((x) => x.id !== csv.id) }))
    return (
      <div className="glass perm pw-bar" role="alertdialog" aria-label="Перенос паролей" key={csv.id}>
        <Grain />
        {icon}
        <span className="perm-t">
          <span>
            Скачан <b>{csv.filename}</b> — {passwordsWord(csv.count)}. Перенести в Masaki?
          </span>
          <small>Пароли зашифруются Windows, а файл с открытыми паролями удалится.</small>
        </span>
        <span className="perm-acts">
          <button
            className="perm-btn ghost"
            onClick={() => {
              window.masaki.passwords.dismissCsv(csv.id)
              drop()
            }}
          >
            Не сейчас
          </button>
          <button
            className="perm-btn primary"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void window.masaki.passwords.importDownloaded(csv.id).then((r) => {
                setBusy(false)
                drop()
                const parts = [`перенесено ${r.added}`]
                if (r.updated) parts.push(`обновлено ${r.updated}`)
                if (r.skipped) parts.push(`пропущено ${r.skipped} (пароли приложений и пустые)`)
                setDone(r.error && !r.added && !r.updated ? { text: r.error, error: true } : { text: 'Готово: ' + parts.join(', ') + (r.error ? '. ' + r.error : '. Файл удалён.'), error: false })
              })
            }}
          >
            Перенести
          </button>
        </span>
      </div>
    )
  }

  if (!offer) return null
  const answer = (action: 'save' | 'never' | 'dismiss') => () => {
    window.masaki.passwords.answer(offer.id, action)
    useStore.setState((s) => ({ pwOffers: s.pwOffers.filter((x) => x.id !== offer.id) }))
  }
  return (
    <div className="glass perm pw-bar" role="alertdialog" aria-label="Сохранить пароль" key={offer.id}>
      <Grain />
      {icon}
      <span className="perm-t">
        <span>
          {offer.update ? 'Обновить пароль' : 'Сохранить пароль'} для <b>{offer.host}</b>?
        </span>
        <small>{offer.username ? 'Логин: ' + offer.username : 'Без логина'}</small>
      </span>
      <span className="perm-acts">
        <button className="perm-btn ghost" onClick={answer('never')}>
          Никогда для сайта
        </button>
        <button className="perm-btn tonal-b" onClick={answer('dismiss')}>
          Не сейчас
        </button>
        <button className="perm-btn primary" onClick={answer('save')}>
          {offer.update ? 'Обновить' : 'Сохранить'}
        </button>
      </span>
    </div>
  )
}

/** Список аккаунтов под полем входа во вкладке. Рисуем поверх страницы, страница его не видит. */
/** Подставить аккаунт из списка у поля: щелчком или Enter после стрелок (номер строки — из guest.ts). */
export function pickAutofill(index: number): void {
  const af = useStore.getState().autofill
  const it = af?.req.items[index]
  if (!af || !it) return
  if (it.passkey) window.masaki.passkeys.useConditional(af.wcId, it.id)
  else window.masaki.passwords.fill(af.wcId, it.id)
  useStore.setState({ autofill: null })
}

export function AutofillMenu(): React.JSX.Element | null {
  const af = useStore((s) => s.autofill)
  const paletteOpen = useStore((s) => s.palette.open)
  const list = useRef<HTMLDivElement>(null)
  // Строку, выбранную стрелками, держим на виду: список прокручивается сам.
  useEffect(() => {
    const box = list.current
    const row = box?.querySelector<HTMLElement>('.af-row.on')
    if (!box || !row) return
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop - 6
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight + 6
  }, [af?.sel])
  if (!af || paletteOpen) return null
  const el = document.querySelector(`webview[data-tab="${af.tabId}"]`)
  if (!el) return null
  const wr = el.getBoundingClientRect()
  // Масштаб вкладки: devicePixelRatio страницы включает её зум, у окна — только масштаб Windows.
  const k = af.req.dpr / window.devicePixelRatio
  const r = af.req.rect
  const width = Math.max(280, Math.min(420, r.w * k))
  const left = Math.min(wr.left + r.x * k, window.innerWidth - width - 8)
  const fieldTop = wr.top + r.y * k
  const fieldBottom = wr.top + (r.y + r.h) * k
  // Место считаем в пределах страницы, а не окна: внизу может быть док. Не влезает — список
  // прокручивается; сверху места больше — открывается вверх, как в Chrome.
  const want = 58 * af.req.items.length + 70
  const below = wr.bottom - fieldBottom - 14
  const above = fieldTop - wr.top - 14
  const down = below >= Math.min(want, 240) || below >= above
  const maxHeight = Math.max(120, Math.min(want, down ? below : above))
  const style: React.CSSProperties = down
    ? { left, top: fieldBottom + 6, width, maxHeight }
    : { left, bottom: window.innerHeight - fieldTop + 6, width, maxHeight }

  const pick = (index: number) => (e: React.MouseEvent) => {
    // mousedown, а не click: клик уводит фокус со страницы, и она прячет список раньше, чем он сработает.
    e.preventDefault()
    pickAutofill(index)
  }
  return (
    <div
      ref={list}
      className="glass af-menu"
      style={style}
      role="listbox"
      aria-label="Пароли и ключи доступа"
      aria-activedescendant={af.sel !== undefined && af.sel >= 0 ? `af-${af.sel}` : undefined}
      onMouseDown={(e) => e.preventDefault()}
    >
      <Grain />
      {af.req.items.map((it, i) => (
        <button
          key={it.id}
          id={`af-${i}`}
          className={'af-row' + (it.passkey ? ' af-pk' : '') + (af.sel === i ? ' on' : '')}
          role="option"
          aria-selected={af.sel === i}
          onMouseDown={pick(i)}
        >
          <span className="af-ic">
            <Icon name={it.passkey ? 'passkey' : 'key'} />
          </span>
          <span className="af-t">
            <b>{it.username || 'Без логина'}</b>
            <small>{it.passkey ? `Ключ доступа · ${it.host}` : `${it.host} · ••••••••`}</small>
          </span>
        </button>
      ))}
      <div className="cm-sep" />
      <button
        className="af-row af-manage"
        onMouseDown={(e) => {
          e.preventDefault()
          useStore.setState({ autofill: null })
          useStore.getState().openPasswords()
        }}
      >
        <Icon name="settings" />
        Управление паролями
      </button>
    </div>
  )
}

/**
 * Окно Masaki поверх вкладки: сайт просит создать ключ доступа или войти по нему. Рисует его интерфейс,
 * а не страница, — сайт не может ни подделать, ни нажать его кнопки. Нажатие и есть подтверждение.
 */
export function PasskeySheet(): React.JSX.Element | null {
  const prompts = useStore((s) => s.pkPrompts)
  const activeId = useStore((s) => s.activeId)
  const p = prompts.find((x) => tabIdOfWebContents(x.wcId) === activeId)
  useEffect(() => {
    if (!p) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      window.masaki.passkeys.answer(p.id, 'cancel')
      useStore.setState((s) => ({ pkPrompts: s.pkPrompts.filter((x) => x.id !== p.id) }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])
  if (!p) return null

  const answer = (action: 'ok' | 'cancel' | 'other', account?: string) => (): void => {
    window.masaki.passkeys.answer(p.id, action, account)
    useStore.setState((s) => ({ pkPrompts: s.pkPrompts.filter((x) => x.id !== p.id) }))
  }
  const where = p.synced ? 'на этом компьютере и в вашем шифрованном сейфе на Google Диске' : 'на этом компьютере'
  const title =
    p.kind === 'create'
      ? `Создать ключ доступа для ${p.rpId}?`
      : p.kind === 'get'
        ? `Войти на ${p.rpId}`
        : p.kind === 'exists'
          ? `Ключ доступа для ${p.rpId} уже есть`
          : `Для ${p.rpId} нет ключей доступа`
  const sub =
    p.kind === 'create'
      ? `Дальше вход без пароля. Ключ хранится ${where}, зашифрованный Windows.`
      : p.kind === 'get'
        ? p.accounts.length > 1
          ? 'Выберите аккаунт — Masaki войдёт ключом доступа.'
          : 'Masaki войдёт ключом доступа.'
        : p.kind === 'exists'
          ? 'Этот аккаунт уже входит по ключу из Masaki — новый не нужен.'
          : 'Создайте ключ в настройках безопасности сайта или войдите другим способом.'
  const user = p.user ? p.user.displayName || p.user.name : ''
  const letter = (s: string): string => (s.trim()[0] ?? '?').toUpperCase()

  return (
    <div className="pk-layer">
      <div className="pk-scrim" />
      <div className="glass pk-card" role="dialog" aria-modal="true" aria-label={title} key={p.id}>
        <Grain />
        <span className="perm-ic pk-ic">
          <svg viewBox="0 0 200 200" aria-hidden="true">
            <path d={shapes.cookie9} />
          </svg>
          <Icon name="passkey" />
        </span>
        <h2 className="pk-title">{title}</h2>
        <p className="pk-sub">{sub}</p>
        {p.kind === 'create' && p.user && (
          <div className="pk-acc static">
            <span className="pk-av">{letter(user)}</span>
            <span className="af-t">
              <b>{user || 'Без имени'}</b>
              {p.user.name && p.user.name !== user && <small>{p.user.name}</small>}
            </span>
          </div>
        )}
        {p.kind === 'get' && (
          <div className="pk-accs" role="listbox" aria-label="Аккаунты">
            {p.accounts.map((a, i) => (
              <button key={a.id} className="pk-acc" role="option" aria-selected={false} autoFocus={i === 0} onClick={answer('ok', a.id)}>
                <span className="pk-av">{letter(a.displayName || a.userName)}</span>
                <span className="af-t">
                  <b>{a.displayName || a.userName || 'Без имени'}</b>
                  {a.userName && a.userName !== a.displayName && <small>{a.userName}</small>}
                </span>
                <Icon name="forward" />
              </button>
            ))}
          </div>
        )}
        <div className="pk-acts">
          {p.kind !== 'exists' && (
            <button className="perm-btn ghost" title="Встроенный WebAuthn Windows: USB-ключ и другие устройства" onClick={answer('other')}>
              Ключ безопасности…
            </button>
          )}
          <span className="pk-sp" />
          {p.kind === 'create' && (
            <>
              <button className="perm-btn tonal-b" onClick={answer('cancel')}>
                Отмена
              </button>
              <button className="perm-btn primary" autoFocus onClick={answer('ok')}>
                Создать
              </button>
            </>
          )}
          {p.kind === 'get' && (
            <button className="perm-btn tonal-b" onClick={answer('cancel')}>
              Отмена
            </button>
          )}
          {(p.kind === 'exists' || p.kind === 'none') && (
            <button className="perm-btn primary" autoFocus onClick={answer(p.kind === 'exists' ? 'ok' : 'cancel')}>
              Понятно
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
