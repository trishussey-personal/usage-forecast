// Pure gauge logic: no $, so the hooks module and the tests share it.

import type {
  UsageForecastLimit,
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
  // "76k / 200k", or "resets in 2h 14m".
  detail: string
  // "~9 turns left", "on pace for ~58% at reset", "runs out in 1h 10m ...".
  forecast?: string
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

// Turns left before the window fills, from the average growth of the turns
// since the last drop (a compaction or /clear starts the count over).
export function turnsLeft(samples: UsageForecastSample[], window: number): number | null {
  let start = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.tokens < samples[i - 1]!.tokens) start = i
  }
  const run = samples.slice(start)
  if (run.length < 2) return null
  const growth = (run[run.length - 1]!.tokens - run[0]!.tokens) / (run.length - 1)
  if (growth <= 0) return null
  return Math.max(0, Math.floor((window - run[run.length - 1]!.tokens) / growth))
}

function contextMeter(
  context: NonNullable<UsageForecastReading['context']>,
  samples: UsageForecastSample[],
  t: Thresholds,
): Meter {
  const left = turnsLeft(samples, context.window)
  return {
    id: 'context',
    label: 'Context',
    short: 'Ctx',
    percent: context.percent,
    level: levelFor(context.percent, t.contextWarnAt, t.contextDangerAt),
    isReset: false,
    detail: `${tokens(context.tokens)} / ${tokens(context.window)}`,
    forecast: left === null ? undefined : `~${left} turn${left === 1 ? '' : 's'} left at this pace`,
  }
}

function limitMeter(limit: UsageForecastLimit, now: number, t: Thresholds): Meter {
  const known = WINDOWS[limit.kind]
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  const hasReset = Number.isFinite(resetsAt)
  const isReset = hasReset && resetsAt <= now
  const percent = isReset ? 0 : limit.percentUsed
  let level = levelFor(percent, t.limitWarnAt, t.limitDangerAt)
  let forecast: string | undefined

  if (isReset) {
    forecast = 'Window reset; your next turn refreshes it'
  } else if (percent >= 100) {
    forecast = 'Limit reached'
  } else if (hasReset && known?.lengthMs) {
    const p = pace(percent, resetsAt, known.lengthMs, now)
    if (p?.runsOutIn != null) {
      level = worse(level, 'warn')
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
    detail: isReset ? 'reset' : hasReset ? `resets in ${duration(resetsAt - now)}` : '',
    forecast,
  }
}

const ORDER = ['context', 'five_hour', 'seven_day']

// Every gauge the reading has a figure for, context first, then the windows.
export function meters(
  reading: UsageForecastReading,
  samples: UsageForecastSample[],
  now: number,
  t: Thresholds,
): Meter[] {
  const list: Meter[] = []
  if (reading.context) list.push(contextMeter(reading.context, samples, t))
  for (const limit of reading.limits) list.push(limitMeter(limit, now, t))
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length)
  return list.sort((a, b) => rank(a.id) - rank(b.id))
}
