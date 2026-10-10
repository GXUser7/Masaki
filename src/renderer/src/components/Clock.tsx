import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ClockSettings, ClockStyle } from '../../../shared/types'
import { shapes } from '../lib/shapes'

// Стили часов по мотивам экрана блокировки Pixel.
export const clockStyles: { id: ClockStyle; name: string; hint: string }[] = [
  { id: 'flex', name: 'Стандартные', hint: 'Тонкие цифры одним цветом, как в Android 16. Есть скругление и толщина' },
  { id: 'metro', name: 'Мозаика', hint: 'Цифры из блоков трёх тонов' },
  { id: 'numerals', name: 'Цифры', hint: 'Крупные 12, 3, 6, 9 и стрелки' },
  { id: 'condensed', name: 'Антиква', hint: 'Высокие узкие цифры с засечками' },
  { id: 'overlap', name: 'Наложение', hint: 'Жирные цифры внахлёст, два тона' },
  { id: 'bubble', name: 'Пузыри', hint: 'Надутые разноцветные цифры с обводкой' },
  { id: 'serif', name: 'Каллиграфия', hint: 'Мягкая антиква с завитками' },
  { id: 'analog', name: 'Аналоговые', hint: 'Циферблат-печенька со стрелками' },
  { id: 'summary', name: 'Сводка', hint: 'Время слева, дата и неделя рядом' }
]

// «Мозаика»: цифры на сетке 3×5 из квадратных блоков; на поворотах блок — четверть круга.
const BLOCKS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['##.', '.#.', '.#.', '.#.', '.#.'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '..#', '..#'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###']
}

function blockCells(ch: string, seed: number): { d: string; tone: number }[] {
  const g = BLOCKS[ch] ?? BLOCKS['0']
  const on = (x: number, y: number): boolean => g[y]?.[x] === '#'
  const out: { d: string; tone: number }[] = []
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (!on(x, y)) continue
      const l = on(x - 1, y)
      const r = on(x + 1, y)
      const t = on(x, y - 1)
      const b = on(x, y + 1)
      const n = [l, r, t, b].filter(Boolean).length
      // Блок на повороте (ровно два соседа — по горизонтали и по вертикали) скругляем наружу.
      let d = `M${x} ${y}h1v1h-1z`
      if (n === 2 && r && b) d = `M${x} ${y + 1}A1 1 0 0 1 ${x + 1} ${y}L${x + 1} ${y + 1}Z`
      else if (n === 2 && l && b) d = `M${x} ${y}A1 1 0 0 1 ${x + 1} ${y + 1}L${x} ${y + 1}Z`
      else if (n === 2 && l && t) d = `M${x + 1} ${y}A1 1 0 0 1 ${x} ${y + 1}L${x} ${y}Z`
      else if (n === 2 && r && t) d = `M${x + 1} ${y + 1}A1 1 0 0 1 ${x} ${y}L${x + 1} ${y}Z`
      // Тона идут полосами сверху вниз (верх, середина, низ), у соседних цифр — со сдвигом, как на Pixel.
      const band = y <= 1 ? 0 : y === 2 ? 1 : 2
      out.push({ d, tone: (band + seed) % 3 })
    }
  }
  return out
}

function BlockDigit({ ch, seed, cls }: { ch: string; seed: number; cls: string }): React.JSX.Element {
  return (
    <svg viewBox="-0.02 -0.02 3.04 5.04" className={'mdig ' + cls} aria-hidden="true">
      {blockCells(ch, seed).map((c, i) => (
        <path key={i} d={c.d} className={'mc c' + c.tone} style={{ '--i': i } as CSSProperties} />
      ))}
    </svg>
  )
}

const pad = (n: number): string => String(n).padStart(2, '0')

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

const dayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime()

interface Props {
  cfg: ClockSettings
  compact?: boolean
  preview?: boolean
}

export function Clock({ cfg, compact = false, preview = false }: Props): React.JSX.Element {
  const now = useNow()
  const minuteKey = now.getHours() * 60 + now.getMinutes()
  const [beat, setBeat] = useState(1)
  const lastMinute = useRef(minuteKey)
  useEffect(() => {
    if (lastMinute.current !== minuteKey) {
      lastMinute.current = minuteKey
      setBeat((b) => b + 1)
    }
  }, [minuteKey])

  const hh = pad(now.getHours())
  const mm = pad(now.getMinutes())
  const dance = beat % 2 ? 'da' : 'db'
  const dg = (ch: string, i: number): React.JSX.Element => (
    <span key={i} className={`dg d${i} ${dance}`}>
      {ch}
    </span>
  )
  const t = cfg.thickness
  const vars = {
    '--w': Math.round(250 + t * 6.5),
    '--wd': Math.round(125 - t * 0.55),
    '--rond': cfg.rounded ? 100 : 0,
    '--mw': 100 + now.getMinutes() * 15,
    '--mwd': 25 + now.getMinutes() * 2
  } as CSSProperties

  const stacked = (
    <>
      <span className="crow r-h">
        {dg(hh[0], 0)}
        {dg(hh[1], 1)}
      </span>
      <span className="crow r-m">
        {dg(mm[0], 2)}
        {dg(mm[1], 3)}
      </span>
    </>
  )
  const oneLine = (
    <span className="crow">
      {dg(hh[0], 0)}
      {dg(hh[1], 1)}
      <span className="colon">:</span>
      {dg(mm[0], 2)}
      {dg(mm[1], 3)}
    </span>
  )

  let body: React.JSX.Element
  switch (cfg.style) {
    case 'analog': {
      const s = (now.getTime() - dayStart) / 1000
      const sec = Math.floor(s) * 6
      const min = (now.getMinutes() + now.getSeconds() / 60) * 6
      const hour = ((now.getHours() % 12) + now.getMinutes() / 60) * 30
      body = (
        <svg viewBox="0 0 200 200" className="dial" aria-hidden="true">
          <path d={shapes.cookie12} className="dial-bg" />
          <circle cx="100" cy="24" r="5" className="dial-mark" />
          <circle cx="176" cy="100" r="5" className="dial-mark" />
          <circle cx="100" cy="176" r="5" className="dial-mark" />
          <circle cx="24" cy="100" r="5" className="dial-mark" />
          <g className="hand" style={{ transform: `rotate(${hour}deg)` }}>
            <rect x="92" y="50" width="16" height="58" rx="8" className="h-hour" />
          </g>
          <g className="hand" style={{ transform: `rotate(${min}deg)` }}>
            <rect x="95" y="28" width="10" height="80" rx="5" className="h-min" />
          </g>
          <g className="hand sec" style={{ transform: `rotate(${sec}deg)` }}>
            <circle cx="100" cy="14" r="7" className="h-sec" />
          </g>
          <circle cx="100" cy="100" r="7" className="h-pin" />
        </svg>
      )
      break
    }
    case 'numerals': {
      // Как на Pixel: крупные 12, 3, 6, 9 вместо циферблата и три стрелки поверх.
      const s = (now.getTime() - dayStart) / 1000
      const sec = Math.floor(s) * 6
      const min = (now.getMinutes() + now.getSeconds() / 60) * 6
      const hour = ((now.getHours() % 12) + now.getMinutes() / 60) * 30
      body = (
        <svg viewBox="0 0 200 200" className={'nface ' + dance} aria-hidden="true">
          <text x="100" y="38" className="nf-n">12</text>
          <text x="170" y="102" className="nf-n">3</text>
          <text x="100" y="166" className="nf-n">6</text>
          <text x="30" y="102" className="nf-n">9</text>
          <g className="hand" style={{ transform: `rotate(${hour}deg)` }}>
            <rect x="92" y="50" width="16" height="58" rx="8" className="nf-hour" />
          </g>
          <g className="hand" style={{ transform: `rotate(${min}deg)` }}>
            <rect x="97" y="20" width="6" height="88" rx="3" className="nf-min" />
          </g>
          <g className="hand sec" style={{ transform: `rotate(${sec}deg)` }}>
            <rect x="99.1" y="14" width="1.8" height="104" rx="0.9" className="nf-sec" />
          </g>
          <circle cx="100" cy="100" r="4.5" className="nf-pin" />
        </svg>
      )
      break
    }
    case 'metro': {
      const row = (a: string, b: string, i: number): React.JSX.Element => (
        <span className="mrow">
          <BlockDigit ch={a} seed={i} cls={dance} />
          <BlockDigit ch={b} seed={i + 1} cls={dance} />
        </span>
      )
      body = compact ? (
        <span className="mrow">
          <BlockDigit ch={hh[0]} seed={0} cls={dance} />
          <BlockDigit ch={hh[1]} seed={1} cls={dance} />
          <span className="mgap" />
          <BlockDigit ch={mm[0]} seed={2} cls={dance} />
          <BlockDigit ch={mm[1]} seed={3} cls={dance} />
        </span>
      ) : (
        <span className="mgrid">
          {row(hh[0], hh[1], 0)}
          {row(mm[0], mm[1], 2)}
        </span>
      )
      break
    }
    case 'summary': {
      const weekday = now.toLocaleDateString('ru-RU', { weekday: 'long' })
      const date = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      body = (
        <span className="sum">
          <span className="sum-time">
            {hh}
            <span className="colon">:</span>
            {mm}
          </span>
          <span className="sum-side">
            <span className="sum-day">{weekday}</span>
            <span>{date}</span>
            <span className="sum-week">{isoWeek(now)}-я неделя</span>
          </span>
        </span>
      )
      break
    }
    default:
      body = compact ? oneLine : stacked
  }

  const cls = `clock clk-${cfg.style} clr-${cfg.color}${compact ? ' compact' : ''}${preview ? ' preview' : ''}`
  if (preview) {
    return (
      <div className={cls} style={vars} aria-hidden="true">
        {body}
      </div>
    )
  }
  return (
    <button className={cls} style={vars} onClick={() => setBeat((b) => b + 1)} aria-label={`Сейчас ${hh}:${mm}`}>
      {body}
    </button>
  )
}
