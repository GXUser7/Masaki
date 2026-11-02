import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './Icon'
import { Grain } from './parts'

/** «1 символ», «3 символа», «12 символов». */
function chars(n: number): string {
  const d = n % 10
  const dd = n % 100
  const word = d === 1 && dd !== 11 ? 'символ' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'символа' : 'символов'
  return n.toLocaleString('ru-RU') + ' ' + word
}

/**
 * Плашка «Скопировано» внизу страницы (над доком, когда панель свёрнута): что именно легло в буфер —
 * текст, адрес или уменьшенная картинка. Мышь не ловит (под ней страница) и уходит сама; новое
 * копирование заменяет её и заново запускает показ.
 */
export function CopyToast(): React.JSX.Element | null {
  const copied = useStore((s) => s.copied)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (!copied) return
    setLeaving(false)
    const stay = copied.image ? 3000 : 2400
    const out = window.setTimeout(() => setLeaving(true), stay)
    const gone = window.setTimeout(() => useStore.setState({ copied: null }), stay + 320)
    return () => {
      window.clearTimeout(out)
      window.clearTimeout(gone)
    }
    // Перезапуск — на каждое новое копирование, даже того же самого текста.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copied?.id])
  if (!copied) return null
  const text = copied.text?.replace(/\s+/g, ' ').trim()
  const long = (copied.text?.length ?? 0) > 140
  return (
    <div key={copied.id} className={'glass copy-toast' + (leaving ? ' out' : '')} role="status" aria-live="polite">
      <Grain />
      {copied.image ? (
        <img className="ct-img" src={copied.image} alt="" />
      ) : (
        <span className="ct-ic">
          <Icon name="check" />
        </span>
      )}
      <span className="ct-t">
        <b>
          {copied.title}
          {long && <em> · {chars(copied.text!.length)}</em>}
        </b>
        {text ? <small>{text}</small> : copied.note ? <small>{copied.note}</small> : null}
      </span>
    </div>
  )
}
