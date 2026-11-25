// Pure logic for the shared status files ("beacons"): each chat writes only
// its own file, and every pane reads all of them. Nothing here touches the engine.

export type BeaconCron = { id: string; schedule: string; recurring: boolean; prompt: string }
export type BeaconTask = { type: string; status: string; description: string }

/** What one chat publishes about itself, rewritten every few seconds. */
export type Beacon = {
  v: 1
  sessionId: string
  /** Heartbeat: when the file was last written, in ms. */
  at: number
  /** Context as the chat's own engine reports it: exact, not estimated. */
  tokens?: number
  window?: number
  limit?: number
  model?: string
  /** A permission dialog is open, for this tool, since this time. */
  permission?: { tool: string; since: number }
  /** Scheduled wake-ups (CronCreate, ScheduleWakeup, /loop), as of the last turn's end. */
  crons: BeaconCron[]
  /** Background work in flight, as of the last turn's end. */
  background?: BeaconTask[]
  /** When the person last typed a prompt in this chat. */
  lastPromptMs?: number
  /** When a scheduled wake-up last ran, and how many have run. */
  lastWakeMs?: number
  wakes: number
}

/** A beacon older than this is a chat that has stopped (closed, crashed, or the mod unloaded). */
export const BEACON_FRESH_MS = 90_000

export const isFresh = (b: Beacon | undefined, now: number): b is Beacon =>
  b !== undefined && now - b.at < BEACON_FRESH_MS

/** Reads a beacon file's text; undefined for anything malformed. */
export function parseBeacon(text: string): Beacon | undefined {
  try {
    const b = JSON.parse(text)
    if (!b || b.v !== 1 || typeof b.sessionId !== 'string' || typeof b.at !== 'number') return undefined
    return { ...b, crons: Array.isArray(b.crons) ? b.crons : [], wakes: Number(b.wakes) || 0 }
  } catch {
    return undefined
  }
}

/**
 * Which chat shows toasts: the one the person typed in last, as that is the
 * one in front of them. Undefined when no chat has seen a prompt yet (then
 * every chat shows its own, as before).
 */
export function pickAnnouncer(beacons: Beacon[], now: number): string | undefined {
  let best: Beacon | undefined
  for (const b of beacons) {
    if (!isFresh(b, now) || b.lastPromptMs === undefined) continue
    if (!best || b.lastPromptMs > (best.lastPromptMs ?? 0)) best = b
  }
  return best?.sessionId
}

// ---------- Cron schedules ----------

/** The values one cron field allows, or undefined when it allows every value. */
function field(text: string, min: number, max: number): Set<number> | undefined {
  if (text === '*' || text === '?') return undefined
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in ${text}`)
    let lo = min
    let hi = max
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number)
      if (!Number.isInteger(a)) throw new Error(`bad value in ${text}`)
      lo = a
      hi = b === undefined ? (stepText === undefined ? a : max) : b
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/**
 * The next time a 5-field cron expression fires after `fromMs`, in local time,
 * or undefined when it cannot be read or does not fire within a year.
 */
export function nextCronMs(expr: string, fromMs: number): number | undefined {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return undefined
  let minutes, hours, days, months, weekdays
  try {
    minutes = field(parts[0], 0, 59)
    hours = field(parts[1], 0, 23)
    days = field(parts[2], 1, 31)
    months = field(parts[3], 1, 12)
    weekdays = field(parts[4], 0, 7)
  } catch {
    return undefined
  }
  if (weekdays?.has(7)) weekdays.add(0)
  const allows = (set: Set<number> | undefined, v: number) => set === undefined || set.has(v)
  const from = new Date(fromMs)
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  for (let d = 0; d <= 366; d++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d)
    if (!allows(months, day.getMonth() + 1)) continue
    // Standard cron: when both day fields are limited, either may match.
    const dayOk =
      days !== undefined && weekdays !== undefined
        ? days.has(day.getDate()) || weekdays.has(day.getDay())
        : allows(days, day.getDate()) && allows(weekdays, day.getDay())
    if (!dayOk) continue
    for (let h = 0; h < 24; h++) {
      if (!allows(hours, h)) continue
      for (let m = 0; m < 60; m++) {
        if (!allows(minutes, m)) continue
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime()
        if (t > fromMs) return t
      }
    }
  }
  return undefined
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "14:05" today, "Wed 14:05" within a week, else "Dec 3 14:05". */
export function formatWhen(ms: number, now: number): string {
  const d = new Date(ms)
  const n = new Date(now)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = d.toDateString() === n.toDateString()
  if (sameDay) return time
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  if (ms - now < 6 * 86_400_000) return `${weekday} ${time}`
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  return `${month} ${d.getDate()} ${time}`
}

/** A cron schedule in plain words: "Every 10 min", "Daily 09:00", or the expression. */
export function describeCron(expr: string, recurring: boolean): string {
  if (!recurring) return 'Once'
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/)
  const rest = `${dom} ${mon} ${dow}`
  if (rest === '* * *') {
    const everyMin = /^\*\/(\d+)$/.exec(m ?? '')
    if (everyMin && h === '*') return `Every ${everyMin[1]} min`
    if (m === '*' && h === '*') return 'Every minute'
    const everyHour = /^\*\/(\d+)$/.exec(h ?? '')
    if (/^\d+$/.test(m ?? '') && everyHour) return `Every ${everyHour[1]} h`
    if (/^\d+$/.test(m ?? '') && h === '*') return 'Hourly'
    if (/^\d+$/.test(m ?? '') && /^\d+$/.test(h ?? '')) return `Daily ${pad(Number(h))}:${pad(Number(m))}`
  }
  if (dom === '*' && mon === '*' && dow === '1-5' && /^\d+$/.test(m ?? '') && /^\d+$/.test(h ?? '')) {
    return `Weekdays ${pad(Number(h))}:${pad(Number(m))}`
  }
  return expr.trim()
}

/** One line for a chat's scheduled work, or undefined when it has none. */
export function scheduleLine(crons: BeaconCron[], now: number): string | undefined {
  if (crons.length === 0) return undefined
  const next = crons
    .map(c => nextCronMs(c.schedule, now))
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b)[0]
  const what = crons.length === 1 ? describeCron(crons[0].schedule, crons[0].recurring) : `${crons.length} scheduled`
  return next === undefined ? what : `${what} · next ${formatWhen(next, now)}`
}
