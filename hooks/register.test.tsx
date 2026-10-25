import type { SessionMeasureInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  DEFAULT_THRESHOLDS,
  boxes,
  clock,
  hint,
  levelFor,
  meters,
  pace,
  sparkline,
  thresholdsFrom,
  turnsLeft,
} from './gauge'

const NOW = Date.parse('2026-10-25T12:00:00Z')
const HOUR = 3_600_000

const PANE = {
  plugin: 'usage-forecast',
  component: 'Pane',
  requestId: 'usage-forecast',
  props: {
    title: 'Usage',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'usage-forecast',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 110,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

// 2h of the 5-hour window left at 40% used: 3h gone, so it lands near 67%.
// 4 days of the week left at 72%: 3 days gone, so it runs out first.
const MEASURE: SessionMeasureInput = {
  context: { tokens: 130_000, window: 200_000, percent: 65 },
  rateLimits: [
    { kind: 'seven_day', percentUsed: 72, resetsAt: new Date(NOW + 96 * HOUR).toISOString() },
    { kind: 'five_hour', percentUsed: 40, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
  ],
  cost: { usd: 1.5 },
  changed: ['context', 'rateLimits', 'cost'],
}

test('the pane shows three gauges with colors and forecasts, on every surface', async ($, on) => {
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure(MEASURE)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    const context = await ui.find({ type: 'Text', text: /^65% / })
    expect(context?.text).toBe('65% Watch')
    expect(await ui.find({ type: 'Text', text: /130k \/ 200k/ })).toBeDefined()

    expect((await ui.find({ type: 'Text', text: /^40% / }))?.text).toBe('40% OK')
    expect(await ui.find({ type: 'Text', text: /On pace for ~67% at reset/ })).toBeDefined()

    // Under the 90% line, but the pace runs dry before the reset: yellow.
    expect((await ui.find({ type: 'Text', text: /^72% / }))?.text).toBe('72% Watch')
    expect(await ui.find({ type: 'Text', text: /Runs out in .* before reset/ })).toBeDefined()

    expect(await ui.find({ type: 'Text', text: /This session|\$\d/ })).toBeUndefined()
    await ui.unmount()
  }

  // Context and weekly turned for the worse; the 5-hour gauge stayed green.
  expect(toasts.length).toBe(2)
  expect(toasts[0]).toMatch(/^Context at 65%/)
  expect(toasts[1]).toMatch(/^Weekly at 72%/)

  // The same reading again announces nothing new.
  await $.session.measure(MEASURE)
  expect(toasts.length).toBe(2)
})

test('the band draws one row of gauges where it is raised', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure(MEASURE)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Context/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5-hour/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Weekly/ })).toBeDefined()
    // 65% of ten boxes: seven filled in the gauge's color, three dim.
    expect((await ui.find({ type: 'Text', text: /^■+$/ }))?.text).toBe('■■■■■■■')
    expect((await ui.find({ type: 'Text', text: /^□+$/ }))?.text).toBe('□□□')
    await ui.unmount()
  }
})

test('a window that has reset reads 0% until the next turn', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    ...MEASURE,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 95, resetsAt: new Date(NOW - 60_000).toISOString() },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^0% / }))?.text).toBe('0% OK')
  expect(await ui.find({ type: 'Text', text: /next turn refreshes/ })).toBeDefined()
  await ui.unmount()
})

test('with no context tokens yet the context gauge is empty, dim, and says why', async ($, on) => {
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const calm = [{ kind: 'five_hour', percentUsed: 3, resetsAt: new Date(NOW + 4 * HOUR).toISOString() }]
  await $.session.measure({
    ...MEASURE,
    context: { tokens: 0, window: 200_000, percent: 0 },
    rateLimits: calm,
    changed: ['rateLimits'],
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /^0%/ }))?.text).toBe('0%')
  expect(await pane.find({ type: 'Text', text: /Fills after the next reply/ })).toBeDefined()
  await pane.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Context/ })).toBeDefined()
  await band.unmount()
  expect(toasts.length).toBe(0)

  // The first reply brings real tokens: the placeholder gives way.
  await $.session.measure({ ...MEASURE, rateLimits: calm, changed: ['context'] })
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /Fills after/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /130k \/ 200k/ })).toBeDefined()
  await after.unmount()
})

test('tokens without a reported window draw no context gauge', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({ ...MEASURE, context: { tokens: 50_000, window: 0, percent: 0 } })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /Context|Fills after/ })).toBeUndefined()
  await pane.unmount()
})

test('before any reading the pane says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /No usage reading yet/ })).toBeDefined()
  await ui.unmount()
})

test('the gauge math', async () => {
  expect(levelFor(59, 60, 80)).toBe('ok')
  expect(levelFor(60, 60, 80)).toBe('warn')
  expect(levelFor(80, 60, 80)).toBe('danger')

  expect(boxes(0, 10, 'boxes')).toEqual({ filled: '', empty: '□□□□□□□□□□' })
  expect(boxes(1, 10, 'boxes').filled).toBe('■')
  expect(boxes(99, 10, 'blocks')).toEqual({ filled: '█████████', empty: '░' })
  expect(boxes(100, 10, 'boxes').filled).toBe('■■■■■■■■■■')

  // Too early in the window to project.
  expect(pace(5, NOW + 4.8 * HOUR, 5 * HOUR, NOW)).toBeNull()
  expect(pace(50, NOW + 2.5 * HOUR, 5 * HOUR, NOW)).toEqual({
    projected: 100,
    runsOutIn: null,
    remaining: 2.5 * HOUR,
  })

  // 10k a turn from 100k toward 200k; a compaction starts the count over.
  expect(turnsLeft([100, 110, 120].map(k => k * 1000), 200_000)).toBe(8)
  expect(turnsLeft([150, 160, 40, 50].map(k => k * 1000), 200_000)).toBe(15)
  expect(turnsLeft([1000], 200_000)).toBeNull()
})

const T = { contextWarnAt: 60, contextDangerAt: 80, limitWarnAt: 70, limitDangerAt: 90 }

test('each turn adds a sample: turns left, sparklines and reset clock times', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const at = (percent: number, tokens: number): SessionMeasureInput => ({
    ...MEASURE,
    context: { tokens, window: 200_000, percent: Math.round(tokens / 2000) },
    rateLimits: [
      { kind: 'five_hour', percentUsed: percent, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
    ],
    changed: ['context', 'rateLimits'],
  })
  await $.session.measure(at(40, 100_000))
  await $.session.measure(at(44, 110_000))
  await $.session.measure(at(48, 120_000))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 4 points a turn from 48%: 13 turns to 100.
  expect(await ui.find({ type: 'Text', text: /~13 turns left/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /resets in 2h 0m · \d{1,2}:\d\d(am|pm)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▁▅█$/ })).toBeDefined()
  // The pace forecast stays as it was; turns left is its own line.
  expect(await ui.find({ type: 'Text', text: /^On pace for ~\d+% at reset$/ })).toBeDefined()
  await ui.unmount()
})

test('the gauge additions', async () => {
  expect(sparkline([1])).toBe('')
  expect(sparkline([10, 10, 10])).toBe('▁▁▁')
  expect(sparkline([0, 50, 100])).toBe('▁▅█')
  // A one-point step draws small.
  expect(sparkline([40, 40, 40, 41])).toBe('▁▁▁▂')

  expect(clock(NOW + HOUR, NOW)).toMatch(/^\d{1,2}:\d\d(am|pm)$/)
  expect(clock(NOW + 72 * HOUR, NOW)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d\d(am|pm)$/)

  // Auto-compact at 160k of a 200k window: count toward 160k, not 200k.
  const samples = [100, 110, 120].map(k => ({ at: NOW, tokens: k * 1000, window: 200_000 }))
  const reading = {
    at: NOW,
    context: { tokens: 120_000, window: 200_000, percent: 60 },
    compactAt: 160_000,
    limits: [],
  }
  const [context] = meters(reading, samples, NOW, T)
  expect(context!.forecast).toBe('~4 turns until auto-compact')
  expect(context!.trend).toEqual([50, 55, 60])
})

test('the hint line', async () => {
  const limit = (percent: number, resetIn: number, extra = {}) => ({
    at: NOW,
    context: null,
    limits: [
      { kind: 'five_hour', percentUsed: percent, resetsAt: new Date(NOW + resetIn).toISOString() },
    ],
    ...extra,
  })
  const tight = [80, 85, 90].map(p => ({ at: NOW, tokens: 1, limits: { five_hour: p } }))
  const list = meters(limit(90, 2 * HOUR), tight, NOW, T)

  expect(hint(list, { model: 'claude-opus-5-5', effort: 'high' }, NOW)).toMatch(
    /^5-hour tight until .* · try lower effort \(high\)$/,
  )
  expect(hint(list, { model: 'claude-opus-5-5', effort: 'low' }, NOW)).toMatch(/· try Sonnet$/)
  expect(hint(list, { model: 'claude-haiku-5-5' }, NOW)).toMatch(/· try lower effort$/)

  // Low use with the reset under an hour away.
  expect(hint(meters(limit(20, 30 * 60_000), [], NOW, T), null, NOW)).toMatch(/^Room to spare before the /)
  // Comfortable and nothing close: no line.
  expect(hint(meters(limit(20, 3 * HOUR), [], NOW, T), null, NOW)).toBeUndefined()

  const near = [140, 145, 150].map(k => ({ at: NOW, tokens: k * 1000, window: 200_000 }))
  const ctx = meters(
    { at: NOW, context: { tokens: 150_000, window: 200_000, percent: 75 }, compactAt: 160_000, limits: [] },
    near,
    NOW,
    T,
  )
  expect(hint(ctx, null, NOW)).toBe('Compacts in ~2 turns · /compact or /clear')
})

test('limit turns left counts from the figure now, and hides past 50', async () => {
  const reading = (percent: number) => ({
    at: NOW,
    context: null,
    limits: [
      { kind: 'five_hour', percentUsed: percent, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
    ],
  })
  const run = [40, 44, 48].map(p => ({ at: NOW, tokens: 1, limits: { five_hour: p } }))
  // Another session took it to 60% since the last turn: 4 a turn from 60.
  expect(meters(reading(60), run, NOW, T)[0]!.turnsNote).toBe('~10 turns left')
  const slow = [30, 30, 30, 30, 30, 31].map(p => ({ at: NOW, tokens: 1, limits: { five_hour: p } }))
  expect(meters(reading(31), slow, NOW, T)[0]!.turnsNote).toBeUndefined()
})

test('a narrow pane keeps only the sparkline bars that fit', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  for (let i = 0; i < 12; i++) {
    await $.session.measure({
      ...MEASURE,
      rateLimits: [
        { kind: 'seven_day', percentUsed: 10 + i, resetsAt: new Date(NOW + 96 * HOUR).toISOString() },
      ],
      changed: ['context', 'rateLimits'],
    })
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 34 } })
  const detail = await ui.find({ type: 'Text', text: /^resets in / })
  // The weekly bars rise; the context ones are flat.
  const bars = await ui.find({ type: 'Text', text: /^[▁▂▃▄▅▆▇█]*[▂▃▄▅▆▇█][▁▂▃▄▅▆▇█]*$/ })
  expect(bars).toBeDefined()
  expect(detail!.text.length + 1 + bars!.text.length).toBeLessThanOrEqual(32)
  await ui.unmount()
})

test('threshold settings that make no sense fall back or are bounded', async () => {
  expect(thresholdsFrom({})).toEqual(DEFAULT_THRESHOLDS)
  expect(thresholdsFrom({ contextWarnAt: 'abc', limitDangerAt: '' })).toEqual(DEFAULT_THRESHOLDS)
  expect(thresholdsFrom({ contextDangerAt: '  ', limitWarnAt: true, limitDangerAt: [50] })).toEqual(
    DEFAULT_THRESHOLDS,
  )
  expect(thresholdsFrom({ contextWarnAt: -5 }).contextWarnAt).toBe(0)
  expect(thresholdsFrom({ contextWarnAt: '50', contextDangerAt: 150 })).toMatchObject({
    contextWarnAt: 50,
    contextDangerAt: 100,
  })
  // Yellow set above red: yellow drops to red's line.
  expect(thresholdsFrom({ limitWarnAt: 95, limitDangerAt: 85 })).toMatchObject({
    limitWarnAt: 85,
    limitDangerAt: 85,
  })
})
