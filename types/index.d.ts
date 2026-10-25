// One rate-limit window as the last API response reported it.
export type UsageForecastLimit = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

// What the gauges draw: the latest figures, and when they were read.
export type UsageForecastReading = {
  at: number
  context: { tokens: number; window: number; percent: number } | null
  // No context tokens counted yet: the gauge is drawn empty until the next reply.
  contextPending?: boolean
  // The token count at which auto-compaction runs; absent when it is off.
  compactAt?: number
  limits: UsageForecastLimit[]
  costUsd?: number
}

// Context tokens and each window's percent used after each main-thread turn,
// oldest first, for turns-left and the sparklines.
export type UsageForecastSample = {
  at: number
  tokens: number
  window?: number
  limits?: Record<string, number>
}

// The model and effort of the main thread's last request, for the hint line.
export type UsageForecastModel = { model: string; effort?: string | number }

declare module 'claude-code' {
  interface PluginState {
    'usage-forecast': {
      reading: Shaped<UsageForecastReading | null>
      samples: Shaped<UsageForecastSample[]>
      // Meter id -> the level@reset already announced, so a toast fires once.
      alerted: Shaped<Record<string, string>>
      model: Shaped<UsageForecastModel | null>
      // Bumped once a minute so countdowns redraw between turns.
      tick: number
    }
  }
}
