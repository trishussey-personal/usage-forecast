import type { SessionMeasureInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { boxes, levelFor, pace, turnsLeft } from './gauge'

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

    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeDefined()
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
  const at = NOW
  expect(turnsLeft([100, 110, 120].map(k => ({ at, tokens: k * 1000 })), 200_000)).toBe(8)
  expect(turnsLeft([150, 160, 40, 50].map(k => ({ at, tokens: k * 1000 })), 200_000)).toBe(15)
  expect(turnsLeft([{ at, tokens: 1000 }], 200_000)).toBeNull()
})
