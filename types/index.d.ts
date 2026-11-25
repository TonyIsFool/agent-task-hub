export type Verdict = 'fits' | 'tight' | 'over' | 'unknown'

export type SessionView = {
  id: string
  name: string
  /** The project folder under the root this session works in. */
  project?: string
  isSelf: boolean
  /** The session's own status word: busy, idle, or another the app reports. */
  status: string
  /** What the session is waiting on you for, if anything. */
  needs?: string
  stepsDone: number
  stepsTotal: number
  currentStep?: string
  context?: number
  /** Tokens at which auto-compaction runs (or the window when unknown). */
  limit?: number
  perStep?: number
  need?: number
  room?: number
  verdict: Verdict
  compactions: number
  background: string[]
  lastEventMs?: number
  /** Busy, yet the transcript has not changed for this long. */
  quietMs?: number
  /** A long foreground command (render, build) and how long it has run. */
  runningLabel?: string
  runningMs?: number
  /** One value per question asked, so each new question alerts once. */
  needsKey?: string
  /** Scheduled wake-ups in plain words ("Every 10 min · next 14:05"). */
  scheduled?: string
  /** When a scheduled wake-up last ran. */
  lastWakeMs?: number
}

export type ConflictView = { path: string; sessions: string[]; lastMs: number }

export type Hub = {
  project: string
  updatedAt: number
  sessions: SessionView[]
  conflicts: ConflictView[]
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-task-hub': { hub: Shaped<Hub>; showEarlier: boolean }
  }
}
