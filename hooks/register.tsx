// Usage Forecast: gauges for the context window, the 5-hour window and the
// weekly window, as boxes that fill, a percentage, and green/yellow/red.
//
// session.start: a first reading, the /gauges command, the pane, and a
// minute tick so the countdowns move between turns.
// session.measure: the engine's own push after each main-thread turn and
// whenever a rate-limit window moves a whole point; keeps the reading, the
// context samples for turns-left, and toasts once on a turn for the worse.
// ui.render (Pane): the full gauges, on every surface.
// ui.render (AbovePrompt): one compact row, terminal and desktop.

import { atom, read, update } from 'claude-code'
import type { Register, SessionUsage } from 'claude-code'

import type { UsageForecastReading } from '../types'
import {
  COLORS,
  WORDS,
  boxes,
  duration,
  meters,
  type GlyphStyle,
  type Meter,
  type Thresholds,
} from './gauge'

const PANE = 'usage-forecast'
const TITLE = 'Usage'
const SAMPLES = 12
// A reading older than this says how old it is: other sessions, chats and
// Cowork spend the same 5-hour and weekly windows in the meantime.
const STALE_MS = 5 * 60_000

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const reading = atom({ plugin: 'usage-forecast', key: 'reading' } as const, null, {
  shape: 'reading-2',
})
const samples = atom({ plugin: 'usage-forecast', key: 'samples' } as const, [], {
  shape: 'samples-1',
})
const alerted = atom({ plugin: 'usage-forecast', key: 'alerted' } as const, {}, {
  shape: 'alerted-1',
})
const tick = atom({ plugin: 'usage-forecast', key: 'tick' } as const, 0)

function toReading(usage: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>, at: number) {
  const { context } = usage
  const value: UsageForecastReading = {
    at,
    context:
      context.tokens && context.window
        ? {
            tokens: context.tokens,
            window: context.window,
            percent: Math.round(context.percent ?? (context.tokens / context.window) * 100),
          }
        : null,
    ...(context.tokens ? {} : { contextPending: true }),
    limits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({
      kind,
      percentUsed,
      ...(resetsAt ? { resetsAt } : {}),
    })),
    ...(usage.cost ? { costUsd: usage.cost.usd } : {}),
  }
  return value
}

export const register: Register = (on, options) => {
  const thresholds: Thresholds = {
    contextWarnAt: Number(options.contextWarnAt ?? 60),
    contextDangerAt: Number(options.contextDangerAt ?? 80),
    limitWarnAt: Number(options.limitWarnAt ?? 70),
    limitDangerAt: Number(options.limitDangerAt ?? 90),
  }
  const style: GlyphStyle = options.glyphs === 'blocks' ? 'blocks' : 'boxes'
  const hasBand = options.band !== false
  const hasAlerts = options.alerts !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'gauges',
      description: 'Show context, 5-hour and weekly usage gauges in a pane',
    })
    const usage = await $.session.usage()
    const now = await $.clock.now()
    await update($, reading, () => toReading(usage, now))
    $.clock.every(60_000, () => {
      void update($, tick, n => n + 1)
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return result
  })

  on('command.run', { command: 'gauges' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Usage gauges opened.' }
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const value = toReading(e, now)
    await update($, reading, () => value)

    const context = value.context
    if (e.changed.includes('context') && context) {
      await update($, samples, list =>
        [...list, { at: now, tokens: context.tokens }].slice(-SAMPLES),
      )
    }

    // Toast once per window and level, never for a gauge back to green.
    const list = meters(value, await read($, samples), now, thresholds)
    const seen = await read($, alerted)
    const fresh: Record<string, string> = {}
    for (const meter of list) {
      if (meter.level === 'ok') continue
      const limit = value.limits.find(one => one.kind === meter.id)
      const mark = `${meter.level}@${limit?.resetsAt ?? ''}`
      fresh[meter.id] = mark
      if (hasAlerts && seen[meter.id] !== mark) {
        $.ui.toast(
          `${meter.label} at ${meter.percent}%` + (meter.forecast ? ` · ${meter.forecast}` : ''),
        )
      }
    }
    await update($, alerted, () => fresh)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const value = await read($, reading)
    if (value === null) {
      return <Text dimColor>No usage reading yet. It arrives with the first reply.</Text>
    }
    await read($, tick)
    const now = await $.clock.now()

    const list = meters(value, await read($, samples), now, thresholds)
    const count = e.props.bodyColumns >= 34 ? 20 : 10
    // mono: desktop, VS Code and mobile draw text in a proportional face, and
    // the boxes only line up gauge to gauge at one width each.
    const gauge = (meter: Meter) => {
      const { filled, empty } = boxes(meter.percent, count, style)
      return (
        <Text mono>
          <Text color={COLORS[meter.level]} dimColor={meter.isReset}>{filled}</Text>
          <Text dimColor>{empty}</Text>
        </Text>
      )
    }
    const age = now - value.at

    return (
      <Box flexDirection="column" paddingX={1}>
        {list.length === 0 && <Text dimColor>No figures reported yet.</Text>}
        {list.map(meter => (
          <Box key={meter.id} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text weight="bold">{meter.label}</Text>
              {meter.isPending ? (
                <Text dimColor tabular>{meter.percent}%</Text>
              ) : (
                <Text color={COLORS[meter.level]} weight="bold" tabular dimColor={meter.isReset}>
                  {meter.percent}% {WORDS[meter.level]}
                </Text>
              )}
            </Box>
            {gauge(meter)}
            {meter.detail !== '' && <Text dimColor>{meter.detail}</Text>}
            {meter.forecast && (
              <Text color={meter.level === 'ok' ? undefined : COLORS[meter.level]} dimColor={meter.level === 'ok'}>
                {meter.forecast}
              </Text>
            )}
          </Box>
        ))}
        {value.costUsd !== undefined && (
          <Text dimColor>This session: ${value.costUsd.toFixed(2)}</Text>
        )}
        {age >= STALE_MS && (
          <Text dimColor>As of {duration(age)} ago. Other sessions may have used more since.</Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!hasBand || e.props.hasSurvey) return next(e)
    const value = await read($, reading)
    if (value === null) return next(e)
    await read($, tick)
    const now = await $.clock.now()
    const list = meters(value, await read($, samples), now, thresholds)
    if (list.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const isWide = columns >= 96
    const count = columns >= 66 ? 10 : 5
    const gauge = (meter: Meter) => {
      const { filled, empty } = boxes(meter.percent, count, style)
      return [
        <Text mono color={COLORS[meter.level]} dimColor={meter.isReset}>{filled}</Text>,
        <Text mono dimColor>{empty}</Text>,
      ]
    }

    return (
      <Box flexDirection="row" columnGap={3} paddingX={1}>
        {list.map(meter => (
          <Text>
            <Text dimColor>{isWide ? meter.label : meter.short} </Text>
            {gauge(meter)}
            <Text
              color={meter.isPending ? undefined : COLORS[meter.level]}
              weight={meter.isPending ? undefined : 'bold'}
              tabular
              dimColor={meter.isReset || meter.isPending}
            >
              {' '}
              {meter.percent}%
            </Text>
          </Text>
        ))}
      </Box>
    )
  })
}
