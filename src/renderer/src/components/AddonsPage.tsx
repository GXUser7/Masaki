import { useEffect, useState } from 'react'
import type { AddonSettings, ExtensionInfo } from '../../../shared/types'
import { syncGlassAll } from '../lib/glass'
import { shapes } from '../lib/shapes'
import { useStore } from '../store'
import { Icon, type IconName } from './Icon'

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }): React.JSX.Element {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)}>
      <span className="knob">{on && <Icon name="check" />}</span>
    </button>
  )
}

function AddonCard({
  icon,
  shape,
  title,
  text,
  on,
  onToggle,
  children
}: {
  icon: IconName
  shape: keyof typeof shapes
  title: string
  text: string
  on?: boolean
  onToggle?: (v: boolean) => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={'addon' + (on ? ' on' : '')}>
      <div className="addon-head">
        <span className="addon-ic">
          <svg viewBox="0 0 200 200" aria-hidden="true">
            <path d={shapes[shape]} />
          </svg>
          <Icon name={icon} />
        </span>
        <span className="addon-t">
          <b>{title}</b>
          <small>{text}</small>
        </span>
        {onToggle && <Toggle label={title} on={!!on} onChange={onToggle} />}
      </div>
      {children}
    </section>
  )
}

/** Страница аддонов: встроенные моды Masaki и расширения Chrome. */
export function AddonsPage(): React.JSX.Element {
  const addons = useStore((s) => s.settings.addons)
  const set = (patch: Partial<AddonSettings>): void => {
    useStore.getState().setSettings({ addons: { ...useStore.getState().settings.addons, ...patch } })
  }
  const glass = addons.glass
  const setGlass = (patch: Partial<AddonSettings['glass']>): void => {
    set({ glass: { ...glass, ...patch } })
    syncGlassAll()
  }

  const [adblockState, setAdblockState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [adblockError, setAdblockError] = useState('')
  const [exts, setExts] = useState<ExtensionInfo[]>([])
  const [extError, setExtError] = useState('')
  useEffect(() => {
    const load = (): void => void window.masaki.extensions.list().then(setExts)
    load()
    // Поставили из магазина, обновилось, удалили из меню кнопки — список обновится сам.
    return window.masaki.extensions.onChanged(load)
  }, [])

  return (
    <div className="settings addons-page">
      <div className="set-inner">
        <h1>Аддоны</h1>
        <p className="hint">Встроенные моды Masaki и расширения Chrome. Изменения применяются сразу.</p>

        <AddonCard
          icon="layers"
          shape="cookie12"
          title="Прозрачные сайты"
          text="Как моды Zen: фон сайтов становится прозрачным, и сквозь страницу видно матовое стекло и обои Masaki."
          on={glass.enabled}
          onToggle={(enabled) => setGlass({ enabled })}
        >
          {glass.enabled && (
            <div className="addon-body">
              <div className="set-row">
                <span>
                  Сила
                  <small>«Сильно» снимает фон и с крупных блоков сайта — так прозрачнее YouTube и подобные</small>
                </span>
                <div className="seg">
                  {(
                    [
                      ['soft', 'Мягко'],
                      ['strong', 'Сильно']
                    ] as const
                  ).map(([v, name]) => (
                    <button key={v} className={glass.strength === v ? 'on' : ''} onClick={() => setGlass({ strength: v })}>
                      {glass.strength === v && <Icon name="check" />}
                      {name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-row">
                <span>
                  Прозрачность
                  <small>
                    {glass.match
                      ? 'Под сайтом то же стекло, что у боковой панели, — без подбора на глаз. Светлый сайт в тёмной теме (и наоборот) остаётся на своём цвете, иначе пропадёт текст'
                      : 'Свой цвет сайта под страницей с прозрачностью по ползунку'}
                  </small>
                </span>
                <div className="seg">
                  {(
                    [
                      [true, 'Как у панели'],
                      [false, 'Своя']
                    ] as const
                  ).map(([v, name]) => (
                    <button key={name} className={glass.match === v ? 'on' : ''} onClick={() => setGlass({ match: v })}>
                      {glass.match === v && <Icon name="check" />}
                      {name}
                    </button>
                  ))}
                </div>
              </div>
              {!glass.match && (
                <div className="set-row">
                  <span>
                    Прозрачность — {glass.opacity}%
                    <small>Меньше — читаемее светлые сайты, больше — сильнее видно стекло</small>
                  </span>
                  <input
                    type="range"
                    min={20}
                    max={90}
                    step={5}
                    value={glass.opacity}
                    aria-label="Прозрачность сайтов"
                    onChange={(e) => setGlass({ opacity: Number(e.target.value) })}
                  />
                </div>
              )}
              <div className="set-col">
                <span className="set-l">Сайты без прозрачности</span>
                {glass.exclude.length === 0 ? (
                  <p className="hint">Пока нет. Выключить для сайта — правый клик по странице → «Прозрачность на этом сайте».</p>
                ) : (
                  <div className="chips-list">
                    {glass.exclude.map((h) => (
                      <span key={h} className="xchip">
                        {h}
                        <button aria-label={`Вернуть прозрачность для ${h}`} onClick={() => setGlass({ exclude: glass.exclude.filter((x) => x !== h) })}>
                          <Icon name="close" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </AddonCard>

        <AddonCard
          icon="shield"
          shape="clover8"
          title="Блокировщик рекламы"
          text="Фильтры Ghostery: реклама и трекеры. При первом включении скачиваются списки, дальше они хранятся в профиле."
          on={addons.adblock.enabled}
          onToggle={async (enabled) => {
            set({ adblock: { enabled } })
            if (!enabled) return
            setAdblockState('loading')
            const r = await window.masaki.adblock.set(true)
            setAdblockState(r.ok ? 'idle' : 'error')
            setAdblockError(r.error ?? '')
            if (!r.ok) set({ adblock: { enabled: false } })
          }}
        >
          {adblockState === 'loading' && <p className="hint addon-body">Скачиваю фильтры…</p>}
          {adblockState === 'error' && <p className="hint addon-body err-text">Не удалось включить: {adblockError}</p>}
        </AddonCard>

        <AddonCard
          icon="extension"
          shape="flower6"
          title="Расширения Chrome"
          text="Из Chrome Web Store — кнопкой «Установить» на странице расширения, или распакованные из папки. Кнопки расширений — у адреса, под значком пазла."
        >
          <div className="addon-body">
            {exts.length > 0 && (
              <div className="sc-edit">
                {exts.map((x) => (
                  <div key={x.id} className={'sc-item' + (x.enabled ? '' : ' ext-off')}>
                    {x.icon ? (
                      <img className="ext-item-ic" src={x.icon} alt="" draggable={false} />
                    ) : (
                      <span className="ext-item-ic none">
                        <Icon name="extension" />
                      </span>
                    )}
                    <span className="sc-item-t">
                      <b>
                        {x.name}
                        <span className="ext-src">{x.store ? 'Web Store' : 'папка'}</span>
                      </b>
                      <small>{x.description ?? (x.store ? `версия ${x.version}` : `${x.version} · ${x.path}`)}</small>
                    </span>
                    {x.options && x.enabled && (
                      <button className="ib" aria-label={`Параметры ${x.name}`} title="Параметры" onClick={() => useStore.getState().newTab(x.options)}>
                        <Icon name="settings" />
                      </button>
                    )}
                    <button
                      className="ib"
                      aria-label={`Удалить ${x.name}`}
                      title={x.store ? 'Удалить расширение' : 'Удалить из Masaki (папка останется)'}
                      onClick={async () => {
                        await window.masaki.extensions.remove(x.id)
                        setExts(await window.masaki.extensions.list())
                      }}
                    >
                      <Icon name="delete" />
                    </button>
                    <Toggle
                      label={(x.enabled ? 'Отключить ' : 'Включить ') + x.name}
                      on={x.enabled}
                      onChange={async (on) => {
                        await window.masaki.extensions.setEnabled(x.id, on)
                        setExts(await window.masaki.extensions.list())
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="set-row">
              <button className="tonal" onClick={() => useStore.getState().newTab('https://chromewebstore.google.com/')}>
                <Icon name="openInNew" />
                Chrome Web Store
              </button>
              <button
                className="tonal"
                onClick={async () => {
                  setExtError('')
                  const r = await window.masaki.extensions.add()
                  if (!r) return
                  if (!r.ok || !r.ext) return setExtError(r.error ?? 'Не удалось загрузить')
                  if (!addons.extensions.includes(r.ext.path)) set({ extensions: [...addons.extensions, r.ext.path] })
                  setExts(await window.masaki.extensions.list())
                }}
              >
                <Icon name="add" />
                Распакованное…
              </button>
              {extError && <span className="hint err-text">{extError}</span>}
            </div>
            <p className="hint">
              Работает большинство расширений: страницы и стили, кнопки и их окна, меню, вкладки. Не работают блокировщики
              на declarativeNetRequest (у Masaki свой — «Блокировщик рекламы» выше) и расширения, которым нужен вход в
              Chrome или системные программы.
            </p>
          </div>
        </AddonCard>
      </div>
    </div>
  )
}
