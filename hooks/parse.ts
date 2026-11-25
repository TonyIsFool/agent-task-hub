// Pure logic: turns Claude Code transcript lines into a per-session summary.
// Nothing here touches the engine, so it can be tested on its own.

export type StepStatus = 'pending' | 'in_progress' | 'completed'
export type Step = { content: string; status: StepStatus }

export type Tracker = {
  /** Byte offset of the next unread line in the transcript. */
  offset: number
  plan: Step[]
  /** Context tokens at each plan-progress event, oldest first (last 30). */
  marks: number[]
  /** Input-side tokens of the latest main-thread response. */
  context?: number
  model?: string
  compactions: number
  recap?: string
  /** A question the session's last wrap-up asked, with no prompt since. */
  pendingAsk?: string
  /** When that question was asked, so each new question is its own alert. */
  askMs?: number
  /** AskUserQuestion calls that have no answer yet. */
  openQuestions: string[]
  /** Foreground tool calls with no result yet: tool_use id -> what and when. */
  running: Record<string, { label: string; ms: number }>
  /** Background work still running: tool_use id -> what and when. */
  background: Record<string, { label: string; ms: number }>
  /** Background task id -> tool_use id, so TaskStop can end one. */
  taskIds: Record<string, string>
  /** Background calls whose result (with the task id) has not come back. */
  launching: Record<string, { label: string; ms: number }>
  /** Edited file (normalized path) -> when, in ms. */
  edits: Record<string, number>
  /** Edited file (normalized) -> the path as the session spelled it, for display. */
  spelling: Record<string, string>
  /** Read or searched path (normalized) -> when, in ms. */
  reads: Record<string, number>
  title?: string
  lastEventMs?: number
}

export const newTracker = (): Tracker => ({
  offset: 0,
  plan: [],
  marks: [],
  compactions: 0,
  openQuestions: [],
  running: {},
  background: {},
  taskIds: {},
  launching: {},
  edits: {},
  spelling: {},
  reads: {},
})

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
/** Calls that wait on the person or return at once: never "running". */
const WAITING_TOOLS = new Set([PLAN_TOOL, WRAP_TOOL, 'AskUserQuestion'])

export const normalizePath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const toStatus = (s: unknown): StepStatus =>
  s === 'completed' || s === 'in_progress' ? s : 'pending'

type PlanInput = {
  items?: { content?: unknown; status?: unknown }[]
  advance?: boolean
  done?: number[]
  start?: number
}

/** Applies one update_plan call to a plan, the way the desktop app does. */
export function applyPlan(plan: Step[], input: PlanInput): Step[] {
  if (Array.isArray(input.items)) {
    return input.items.map(i => ({
      content: String(i.content ?? ''),
      status: toStatus(i.status),
    }))
  }
  const next = plan.map(s => ({ ...s }))
  if (input.advance) {
    const cur = next.findIndex(s => s.status === 'in_progress')
    if (cur >= 0) next[cur].status = 'completed'
    const pending = next.findIndex(s => s.status === 'pending')
    if (pending >= 0) next[pending].status = 'in_progress'
  }
  for (const n of input.done ?? []) {
    if (next[n - 1]) next[n - 1].status = 'completed'
  }
  if (typeof input.start === 'number' && next[input.start - 1]) {
    for (const s of next) if (s.status === 'in_progress') s.status = 'pending'
    next[input.start - 1].status = 'in_progress'
  }
  return next
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b && typeof b === 'object' && 'text' in b ? String(b.text) : ''))
    .join('\n')
}

const NOTIFICATION = /<task-notification>[\s\S]*?<\/task-notification>/g

/** Ends background work that a task notification reports as finished. */
function readNotifications(t: Tracker, text: string): void {
  for (const block of text.match(NOTIFICATION) ?? []) {
    const status = /<status>([^<]*)<\/status>/.exec(block)?.[1]?.trim()
    if (status === 'running') continue
    const toolUse = /<tool-use-id>([^<]*)<\/tool-use-id>/.exec(block)?.[1]?.trim()
    const task = /<task-id>([^<]*)<\/task-id>/.exec(block)?.[1]?.trim()
    const id = toolUse ?? (task ? t.taskIds[task] : undefined)
    if (id) {
      delete t.background[id]
      delete t.launching[id]
    }
  }
}

type Json = Record<string, any>

/** Feeds one parsed transcript line into the tracker. */
export function ingest(t: Tracker, d: Json): void {
  if (!d || typeof d !== 'object') return
  if (typeof d.timestamp === 'string') {
    const ms = Date.parse(d.timestamp)
    if (Number.isFinite(ms)) t.lastEventMs = ms
  }
  if (d.type === 'custom-title' && typeof d.customTitle === 'string') {
    t.title = d.customTitle
    return
  }
  if (d.isCompactSummary) t.compactions += 1
  if (d.isSidechain) return

  const msg = d.message
  if (!msg || typeof msg !== 'object') return
  const content = msg.content

  if (d.type === 'assistant') {
    const u = msg.usage
    if (u && typeof u === 'object') {
      t.context =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0)
      if (typeof msg.model === 'string') t.model = msg.model
    }
    if (!Array.isArray(content)) return
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue
      const input: Json = b.input ?? {}
      if (b.name === PLAN_TOOL) {
        t.plan = applyPlan(t.plan, input)
        if (t.context !== undefined) t.marks = [...t.marks, t.context].slice(-30)
      } else if (b.name === WRAP_TOOL) {
        t.plan = t.plan.map(s => ({ ...s, status: 'completed' }))
        if (typeof input.recap === 'string') t.recap = input.recap
        t.pendingAsk = typeof input.ask === 'string' ? input.ask : undefined
        t.askMs = t.pendingAsk === undefined ? undefined : t.lastEventMs
      } else if (b.name === 'AskUserQuestion') {
        t.openQuestions = [...t.openQuestions, String(b.id)]
      } else if (b.name === 'TaskStop') {
        const task = String(input.task_id ?? input.shell_id ?? '')
        const id = t.taskIds[task]
        if (id) delete t.background[id]
      }
      if (EDIT_TOOLS.has(b.name)) {
        const p = input.file_path ?? input.notebook_path
        if (typeof p === 'string' && t.lastEventMs !== undefined) {
          t.edits[normalizePath(p)] = t.lastEventMs
          t.spelling[normalizePath(p)] = p.replace(/\\/g, '/')
        }
      } else if (READ_TOOLS.has(b.name)) {
        const p = input.file_path ?? input.path
        if (typeof p === 'string') t.reads[normalizePath(p)] = t.lastEventMs ?? 0
      }
      if (input.run_in_background === true) {
        const label = String(input.description ?? input.command ?? b.name).slice(0, 80)
        t.launching[String(b.id)] = { label, ms: t.lastEventMs ?? 0 }
      } else if (!WAITING_TOOLS.has(b.name)) {
        // A long render or build: the chat is busy, not stuck.
        const label = String(input.description ?? b.name).slice(0, 80)
        t.running[String(b.id)] = { label, ms: t.lastEventMs ?? 0 }
      }
    }
    return
  }

  if (d.type !== 'user') return
  let isPrompt = !d.isMeta
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || b.type !== 'tool_result') continue
      isPrompt = false
      const id = String(b.tool_use_id)
      t.openQuestions = t.openQuestions.filter(q => q !== id)
      delete t.running[id]
      if (id in t.launching) {
        const launch = t.launching[id]
        delete t.launching[id]
        const r: Json = d.toolUseResult ?? {}
        const task =
          r.backgroundTaskId ??
          r.agentId ??
          /with ID: (\w+)/.exec(textOf(b.content))?.[1]
        if (!b.is_error) {
          t.background[id] = launch
          if (task) t.taskIds[String(task)] = id
        }
      }
    }
  }
  const text = textOf(content)
  if (text.includes('<task-notification>')) {
    readNotifications(t, text)
    isPrompt = false
  }
  if (isPrompt && text.trim() !== '') {
    t.pendingAsk = undefined
    t.askMs = undefined
    t.running = {} // a new prompt means nothing from before is still running
    // A finished plan belongs to the last request; this one starts fresh.
    if (t.plan.length > 0 && t.plan.every(s => s.status === 'completed')) t.plan = []
  }
}

/** Byte length of a string in UTF-8. */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/**
 * Feeds a chunk that starts at a line boundary. Returns how many bytes of it
 * were whole lines (the rest is a partial line to read again next time).
 */
export function ingestChunk(t: Tracker, text: string): number {
  const cut = text.lastIndexOf('\n')
  if (cut < 0) return 0
  const body = text.slice(0, cut + 1)
  for (const line of body.split('\n')) {
    if (line === '' || line.startsWith('{"type":"api-request')) continue
    try {
      ingest(t, JSON.parse(line))
    } catch {
      // A line we cannot read is skipped; the rest still counts.
    }
  }
  return utf8Length(body)
}

export type Verdict = 'fits' | 'tight' | 'over' | 'unknown'

export type Forecast = {
  /** Tokens per plan step at the recent pace. */
  perStep?: number
  remainingSteps: number
  need?: number
  /** Tokens left before auto-compaction. */
  room?: number
  verdict: Verdict
}

/** Predicts whether the rest of the plan fits before auto-compaction. */
export function forecast(
  t: Pick<Tracker, 'plan' | 'marks' | 'context'>,
  limit: number | undefined,
): Forecast {
  const remainingSteps = t.plan.filter(s => s.status !== 'completed').length
  const deltas: number[] = []
  for (let i = 1; i < t.marks.length; i++) {
    const d = t.marks[i] - t.marks[i - 1]
    // A drop is a compaction; zero is two updates in one response.
    if (d > 0) deltas.push(d)
  }
  const recent = deltas.slice(-3)
  const perStep =
    recent.length > 0 ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : undefined
  const room =
    limit !== undefined && t.context !== undefined ? Math.max(0, limit - t.context) : undefined
  if (room === undefined) return { perStep, remainingSteps, verdict: 'unknown' }
  if (remainingSteps === 0) return { perStep, remainingSteps, need: 0, room, verdict: 'fits' }
  if (perStep === undefined) return { remainingSteps, room, verdict: 'unknown' }
  const need = perStep * remainingSteps
  const verdict: Verdict = need <= room * 0.7 ? 'fits' : need <= room ? 'tight' : 'over'
  return { perStep, remainingSteps, need, room, verdict }
}

export type SessionEdits = { id: string; name: string; edits: Record<string, number> }
export type Conflict = { path: string; sessions: string[]; lastMs: number }

/** Files edited by two or more sessions since `sinceMs`. */
export function findConflicts(list: SessionEdits[], sinceMs: number): Conflict[] {
  const byPath = new Map<string, { names: Set<string>; lastMs: number }>()
  for (const s of list) {
    for (const [path, ms] of Object.entries(s.edits)) {
      if (ms < sinceMs) continue
      const entry = byPath.get(path) ?? { names: new Set<string>(), lastMs: 0 }
      entry.names.add(s.name)
      entry.lastMs = Math.max(entry.lastMs, ms)
      byPath.set(path, entry)
    }
  }
  const out: Conflict[] = []
  for (const [path, e] of byPath) {
    if (e.names.size >= 2) out.push({ path, sessions: [...e.names].sort(), lastMs: e.lastMs })
  }
  return out.sort((a, b) => b.lastMs - a.lastMs)
}

/** Whether `child` is `root` or inside it (Windows or POSIX paths). */
export function isInside(child: string, root: string): boolean {
  const c = normalizePath(child)
  const r = normalizePath(root)
  return c === r || c.startsWith(r + '/')
}

/** The folder Claude Code keeps a project's transcripts in. */
export const projectFolderName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

export function formatTokens(n: number | undefined): string {
  if (n === undefined) return '?'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`
}

/** A text bar, `width` cells wide, filled to `value / max`. */
export function textBar(value: number, max: number, width = 20): string {
  const filled = max > 0 ? Math.min(width, Math.max(0, Math.round((value / max) * width))) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Decodes base64 into bytes, without relying on any global. */
export function base64Bytes(b64: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let acc = 0
  let j = 0
  for (let i = 0; i < clean.length; i++) {
    acc = ((acc << 6) | alphabet.indexOf(clean[i])) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[j++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, j)
}

/** True when a string has anything outside printable ASCII (the pane is English only). */
export const needsEnglish = (s: string): boolean => /[^\u0020-\u007e]/.test(s)

/** Tidies a model's one-line title: no quotes, no trailing period, ASCII only. */
export function cleanTitle(raw: string): string | undefined {
  const line = raw.split('\n')[0] ?? ''
  const out = line
    .replace(/[^\u0020-\u007e]/g, '')
    .replace(/^\s*(title:\s*)?["'`*]*/i, '')
    .replace(/["'`*.]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return out === '' || out.length > 60 ? undefined : out
}

/**
 * The project folder a session works in: the first folder under `root` that
 * its cwd sits in, else the one whose files it edited most (reads count less),
 * the most recent winning a tie. Undefined when it has only touched `root`.
 */
export function projectOf(
  cwd: string,
  root: string,
  edits: Record<string, number>,
  reads: Record<string, number>,
): string | undefined {
  const r = normalizePath(root)
  const firstFolder = (path: string): string | undefined => {
    if (!path.startsWith(r + '/')) return undefined
    const rest = path.slice(r.length + 1).split('/')
    // A file at the root, or a hidden folder such as .claude, is no project.
    return rest.length >= 2 && !rest[0].startsWith('.') ? rest[0] : undefined
  }
  const own = normalizePath(cwd)
  if (own !== r && own.startsWith(r + '/')) return own.slice(r.length + 1).split('/')[0]
  const score = new Map<string, { points: number; lastMs: number }>()
  const add = (paths: Record<string, number>, points: number) => {
    for (const [path, ms] of Object.entries(paths)) {
      const folder = firstFolder(path)
      if (!folder) continue
      const s = score.get(folder) ?? { points: 0, lastMs: 0 }
      s.points += points
      s.lastMs = Math.max(s.lastMs, ms)
      score.set(folder, s)
    }
  }
  add(edits, 3)
  add(reads, 1)
  let best: string | undefined
  let top = { points: 0, lastMs: 0 }
  for (const [folder, s] of score) {
    if (s.points > top.points || (s.points === top.points && s.lastMs > top.lastMs)) {
      best = folder
      top = s
    }
  }
  return best
}

/**
 * The words and colour beside a chat's context use, or undefined when there is
 * nothing to judge: a verdict only means something while plan steps remain.
 */
export function verdictLabel(v: {
  stepsDone: number
  stepsTotal: number
  verdict: Verdict
  need?: number
}): { text: string; color: 'success' | 'warning' | 'error' } | undefined {
  if (v.stepsTotal <= v.stepsDone) return undefined
  if (v.verdict === 'fits') return { text: 'enough for the plan', color: 'success' }
  if (v.verdict === 'tight') return { text: `tight: needs ~${formatTokens(v.need)}`, color: 'warning' }
  if (v.verdict === 'over') return { text: `won't fit: needs ~${formatTokens(v.need)}`, color: 'error' }
  return undefined
}
