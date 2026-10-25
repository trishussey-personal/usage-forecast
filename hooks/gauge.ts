// Pure gauge logic: no $, so the hooks module and the tests share it.

import type {
  UsageForecastLimit,
  UsageForecastModel,
  UsageForecastReading,
  UsageForecastSample,
} from '../types'

export type Level = 'ok' | 'warn' | 'danger'

export type Thresholds = {
  contextWarnAt: number
  contextDangerAt: number
  limitWarnAt: number
  limitDangerAt: number
}

export type Meter = {
  id: string
  label: string
  short: string
  percent: number
  level: Level
  // The window reset after the reading: the figure is old until the next turn.
  isReset: boolean
  // No figure yet: drawn dim, without a level word.
  isPending?: boolean
  // "76k / 200k", or "resets in 2h 14m".
  detail: string
  // "~9 turns left", "on pace for ~58% at reset", "runs out in 1h 10m ...".
  forecast?: string
  // Percent at each recent turn, oldest first, for the sparkline.
  trend: number[]
  // Turns until the window fills (or context auto-compacts), at recent pace.
  turnsLeft?: number
  // "~15 turns left" for a limit, drawn beside the forecast but kept out of
  // toasts; context says it in its forecast.
  turnsNote?: string
  // Context counts toward the auto-compact line, not the full window.
  compacts?: boolean
  // The straight-line pace runs the window out before it resets.
  runsOut?: boolean
  resetsAt?: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

// Each window's length, so its start is resetsAt less the length.
const WINDOWS: Record<string, { label: string; short: string; lengthMs?: number }> = {
  five_hour: { label: '5-hour', short: '5h', lengthMs: 5 * HOUR },
  seven_day: { label: 'Weekly', short: 'Wk', lengthMs: 7 * DAY },
  spend_limit: { label: 'Spend', short: '$' },
}

// Below this share of a window gone, a projection is noise (3% in five
// minutes "projects" 180%), so no pace is drawn and no color escalates.
const MIN_ELAPSED = 0.1

// Theme keys: they follow the person's light or dark theme.
export const COLORS: Record<Level, string> = {
  ok: 'success',
  warn: 'warning',
  danger: 'error',
}

// A word beside the color, so the state reads without it.
export const WORDS: Record<Level, string> = {
  ok: 'OK',
  warn: 'Watch',
  danger: 'High',
}

export const GLYPHS = {
  boxes: { full: '■', empty: '□' },
  blocks: { full: '█', empty: '░' },
} as const

export type GlyphStyle = keyof typeof GLYPHS

export function levelFor(percent: number, warnAt: number, dangerAt: number): Level {
  if (percent >= dangerAt) return 'danger'
  if (percent >= warnAt) return 'warn'
  return 'ok'
}

function worse(a: Level, b: Level): Level {
  const rank = { ok: 0, warn: 1, danger: 2 }
  return rank[a] >= rank[b] ? a : b
}

// Boxes filled for a percentage: any use at all shows one box, and only a
// full window fills the last.
export function boxes(percent: number, count: number, style: GlyphStyle) {
  const { full, empty } = GLYPHS[style] ?? GLYPHS.boxes
  const clamped = Math.max(0, Math.min(100, percent))
  let filled = Math.round((clamped / 100) * count)
  if (clamped > 0 && filled === 0) filled = 1
  if (clamped < 100 && filled === count) filled = count - 1
  return { filled: full.repeat(filled), empty: empty.repeat(count - filled) }
}

export function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

// A reset as a wall-clock time in the runtime's local zone: "4:42pm" within
// the day, "Fri 9:00am" further out.
export function clock(at: number, now: number): string {
  const date = new Date(at)
  const hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const time = `${hours % 12 || 12}:${minutes}${hours < 12 ? 'am' : 'pm'}`
  if (at - now < 20 * HOUR) return time
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]} ${time}`
}

const SPARKS = '▁▂▃▄▅▆▇█'

// Recent percentages as one bar each, scaled to their own range so a slow
// climb still shows, but over at least MIN_SPAN points so a one-point step
// (limits move in whole points) draws small; flat when nothing moved.
const MIN_SPAN = 5

export function sparkline(values: number[]): string {
  if (values.length < 2) return ''
  const low = Math.min(...values)
  const span = Math.max(Math.max(...values) - low, MIN_SPAN)
  return values
    .map(v => SPARKS[Math.round(((v - low) / span) * (SPARKS.length - 1))])
    .join('')
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

// Straight-line pace over the part of the window gone: where it lands at the
// reset, and whether it runs out first.
export function pace(percent: number, resetsAt: number, lengthMs: number, now: number) {
  const remaining = resetsAt - now
  const elapsed = lengthMs - remaining
  if (remaining <= 0 || percent <= 0 || elapsed < lengthMs * MIN_ELAPSED) {
    return null
  }
  const perMs = percent / elapsed
  const msToFull = (100 - percent) / perMs
  return {
    projected: Math.round(percent + perMs * remaining),
    runsOutIn: msToFull < remaining ? msToFull : null,
    remaining,
  }
}

// Turns left before a value reaches its ceiling, from the average growth of
// the turns since the last drop (a compaction, /clear or a reset starts the
// count over).
// `current` is the figure now, when newer than the last sample (another
// session spends the same limit windows between this one's turns).
export function turnsLeft(values: number[], ceiling: number, current?: number): number | null {
  let start = 0
  for (let i = 1; i < values.length; i++) {
    if (values[i]! < values[i - 1]!) start = i
  }
  const run = values.slice(start)
  if (run.length < 2) return null
  const growth = (run[run.length - 1]! - run[0]!) / (run.length - 1)
  if (growth <= 0) return null
  const now = Math.max(current ?? run[run.length - 1]!, run[run.length - 1]!)
  return Math.max(0, Math.floor((ceiling - now) / growth))
}

const turns = (n: number) => `~${n} turn${n === 1 ? '' : 's'}`

function contextMeter(
  context: NonNullable<UsageForecastReading['context']>,
  compactAt: number | undefined,
  samples: UsageForecastSample[],
  t: Thresholds,
): Meter {
  // Auto-compact fires before the window is full: count toward that line.
  const ceiling = compactAt && compactAt < context.window ? compactAt : context.window
  const left = turnsLeft(
    samples.map(one => one.tokens),
    ceiling,
  )
  const until = ceiling === context.window ? 'left at this pace' : 'until auto-compact'
  return {
    id: 'context',
    label: 'Context',
    short: 'Ctx',
    percent: context.percent,
    level: levelFor(context.percent, t.contextWarnAt, t.contextDangerAt),
    isReset: false,
    detail: `${tokens(context.tokens)} / ${tokens(context.window)}`,
    forecast: left === null ? undefined : `${turns(left)} ${until}`,
    trend: samples
      .filter(one => one.window)
      .map(one => Math.round((one.tokens / one.window!) * 100)),
    ...(left === null ? {} : { turnsLeft: left }),
    ...(ceiling === context.window ? {} : { compacts: true }),
  }
}

// Past this many turns the estimate is noise from whole-point steps.
const MAX_TURNS = 50

function limitMeter(
  limit: UsageForecastLimit,
  samples: UsageForecastSample[],
  now: number,
  t: Thresholds,
): Meter {
  const known = WINDOWS[limit.kind]
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  const hasReset = Number.isFinite(resetsAt)
  const isReset = hasReset && resetsAt <= now
  const percent = isReset ? 0 : limit.percentUsed
  let level = levelFor(percent, t.limitWarnAt, t.limitDangerAt)
  let forecast: string | undefined
  let runsOut = false
  const trend = samples
    .map(one => one.limits?.[limit.kind])
    .filter((v): v is number => v !== undefined)
  const counted = isReset || percent >= 100 ? null : turnsLeft(trend, 100, percent)
  const left = counted !== null && counted <= MAX_TURNS ? counted : null

  if (isReset) {
    forecast = 'Window reset; your next turn refreshes it'
  } else if (percent >= 100) {
    forecast = 'Limit reached'
  } else if (hasReset && known?.lengthMs) {
    const p = pace(percent, resetsAt, known.lengthMs, now)
    if (p?.runsOutIn != null) {
      level = worse(level, 'warn')
      runsOut = true
      forecast = `Runs out in ${duration(p.runsOutIn)}, ${duration(p.remaining - p.runsOutIn)} before reset`
    } else if (p) {
      forecast = `On pace for ~${p.projected}% at reset`
    }
  }

  return {
    id: limit.kind,
    label: known?.label ?? limit.kind,
    short: known?.short ?? limit.kind.slice(0, 3),
    percent,
    level,
    isReset,
    detail: isReset
      ? 'reset'
      : hasReset
        ? `resets in ${duration(resetsAt - now)} · ${clock(resetsAt, now)}`
        : '',
    forecast,
    trend,
    ...(left === null ? {} : { turnsLeft: left, turnsNote: `${turns(left)} left` }),
    ...(runsOut ? { runsOut } : {}),
    ...(hasReset ? { resetsAt } : {}),
  }
}

const ORDER = ['context', 'five_hour', 'seven_day']

// No context tokens yet (a new session, or just after /clear): an empty,
// dim context gauge says so, rather than the gauge looking missing.
function pendingContext(): Meter {
  return {
    id: 'context',
    label: 'Context',
    short: 'Ctx',
    percent: 0,
    level: 'ok',
    isReset: false,
    isPending: true,
    detail: 'Fills after the next reply',
    trend: [],
  }
}

// Every gauge the reading has a figure for, context first, then the windows.
// Context with no tokens yet is drawn pending; with tokens but no reported
// window there is no percentage to draw, so it is left out.
export function meters(
  reading: UsageForecastReading,
  samples: UsageForecastSample[],
  now: number,
  t: Thresholds,
): Meter[] {
  const list: Meter[] = []
  if (reading.context) list.push(contextMeter(reading.context, reading.compactAt, samples, t))
  else if (reading.contextPending) list.push(pendingContext())
  for (const limit of reading.limits) list.push(limitMeter(limit, samples, now, t))
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length)
  return list.sort((a, b) => rank(a.id) - rank(b.id))
}

// A turn or two left, or a pace that runs out: worth a nudge.
const TIGHT_TURNS = 5
const HIGH_EFFORT = ['high', 'xhigh', 'max']

// One line of advice from the gauges, or none: pressure on a limit first,
// then context near auto-compact, then room to spare before a reset.
export function hint(list: Meter[], model: UsageForecastModel | null, now: number): string | undefined {
  const limits = list.filter(one => one.id !== 'context' && !one.isReset && one.resetsAt)
  const tight = limits.find(
    one => one.runsOut || (one.turnsLeft !== undefined && one.turnsLeft <= TIGHT_TURNS),
  )
  if (tight) {
    const effort = model?.effort
    const lever =
      typeof effort === 'string' && HIGH_EFFORT.includes(effort)
        ? `lower effort (${effort})`
        : model && /opus/i.test(model.model)
          ? 'Sonnet'
          : model && /sonnet/i.test(model.model)
            ? 'Haiku for simple steps'
            : 'lower effort'
    return `${tight.label} tight until ${clock(tight.resetsAt!, now)} · try ${lever}`
  }

  const context = list.find(one => one.id === 'context')
  if (context?.compacts && context.turnsLeft !== undefined && context.turnsLeft <= 3) {
    return `Compacts in ${turns(context.turnsLeft)} · /compact or /clear`
  }

  const soon = limits.find(one => one.id === 'five_hour' && one.resetsAt! - now <= HOUR)
  if (soon && limits.every(one => one.percent < 50)) {
    return `Room to spare before the ${clock(soon.resetsAt!, now)} reset`
  }
  return undefined
}
