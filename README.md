# Usage Forecast

A Claude Code mod that shows three gauges: **context window**, **5-hour limit** and **weekly limit**. Each one is a row of boxes that fills as you use it, a percentage, and a color: green, yellow, red. It also projects where you'll land at the next reset, so you see trouble coming before it arrives.

```text
Context                    65% Watch
■■■■■■■■■■■■■□□□□□□□
130k / 200k                ▁▂▃▅▆
~3 turns until auto-compact

5-hour                        40% OK
■■■■■■■■□□□□□□□□□□□□
resets in 2h 0m · 4:42pm   ▁▁▂▃
On pace for ~67% at reset
~15 turns left

Weekly                     72% Watch
■■■■■■■■■■■■■■□□□□□□
resets in 4d 0h · Thu 9:00am ▁▂▄
Runs out in 1d 4h, 2d 20h before reset

Weekly tight until Thu 9:00am · try lower effort (high)
```

And a one-line band above the prompt (terminal and desktop):

```text
Context ■■■■■■■□□□ 65%   5-hour ■■■■□□□□□□ 40%   Weekly ■■■■■■■□□□ 72%
```

## How it works

- **Where the numbers come from.** `$.session.usage()` and the `session.measure` event, the same figures the status line uses. Context is input tokens over the model's window. The 5-hour and weekly figures are what the last API reply reported.
- **Colors.** The mod uses the theme colors `success`, `warning` and `error`, not fixed hex values. They follow your Claude Code theme, so they work in light and dark mode.
- **Words beside the colors.** Each gauge also says **OK**, **Watch** or **High**, so it reads without color.
- **Pace forecast.** A straight line over the part of the window that's gone. If that line hits 100% before the reset, the gauge turns yellow even under your threshold. No forecast until 10% of the window has passed, because earlier guesses are noise.
- **Turns left.** Average growth per turn since the last drop (a compaction, `/clear` or a reset). For context it counts toward the auto-compact line when auto-compact is on, since that is what you hit first; for the 5-hour and weekly windows, toward 100%, shown only up to 50 turns (beyond that, whole-point steps make it noise).
- **Sparklines.** The last dozen turns of each gauge, scaled to their own range (at least 5 points, so a one-point step draws small), and only as many bars as fit beside the countdown.
- **Reset times.** Each countdown also gives the clock time, in the time zone of the machine Claude Code runs on, with the day when it is more than 20 hours out.
- **Hint line.** At most one dim line at the bottom of the pane, only when there is something to say: a limit running tight (with the lever that would help, from your current model and effort), context about to auto-compact, or room to spare before a reset under an hour away. The band never changes shape for it.
- **Toasts.** One toast the first time a gauge turns yellow or red in a window. Never repeated for the same window and level.

| Hook | What it does |
| --- | --- |
| `session.start` | First reading, `/gauges` command, opens the pane, starts a one-minute tick for countdowns |
| `session.measure` | New reading after each turn, and whenever a limit moves a whole point; a per-turn sample for turns left and sparklines |
| `turn.step` | Notes the main thread's model and effort for the hint line; changes nothing |
| `ui.render` `Pane` | The full gauges, on every surface (terminal, desktop, VS Code, mobile) |
| `ui.render` `AbovePrompt` | The compact band (terminal and desktop) |

## Install

At the prompt of a terminal session:

```text
/plugin install usage-forecast --marketplace trishussey-personal/usage-forecast
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install usage-forecast --marketplace trishussey-personal/usage-forecast
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `trishussey-personal/usage-forecast`, then **Add plugin**.

To try it from a clone without installing: `claude --plugin-dir ./usage-forecast`.

## Settings

All in `/config`, under the plugin:

| Setting | Default |
| --- | --- |
| Context: yellow at / red at | 60% / 80% |
| Limits: yellow at / red at | 70% / 90% |
| Box style | `boxes` (■□), or `blocks` (█░) if ■ looks off in your font |
| One-line band above the prompt | on |
| Toasts | on |

Run `/gauges` to reopen the pane after closing it.

## Limits

- **Limits only update when this session talks to the API.** Other sessions, claude.ai chats and Cowork spend the same 5-hour and weekly windows. The pane says how old the reading is after 5 minutes.
- **Rate limits need a subscription.** On an API key there are no 5-hour or weekly figures; the context gauge still works.
- **The context percentage is of the full window.** Auto-compact fires before 100%, so Claude Code's own notice can read higher.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

The pure math lives in `hooks/gauge.ts`; the hooks and drawing in `hooks/register.tsx`.
