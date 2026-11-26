import { expect, mock, test } from 'claude-code/testing'

import {
  applyPlan,
  base64Bytes,
  cleanTitle,
  findConflicts,
  forecast,
  fullColor,
  ingestChunk,
  isInside,
  nameList,
  needsEnglish,
  statusSummary,
  timeLeft,
  usageName,
  newTracker,
  projectOf,
  toolLabel,
  utf8Decode,
  utf8Length,
  verdictLabel,
} from '../hooks/parse'

/** Sample non-English text (a chat name, a plan step, a word), written as escapes. */
const ZH_NAME = '\u7259\u9f7f\u6a21\u578b'
const ZH_STEP = '\u8bfb\u53d6\u53c2\u8003\u56fe'
const ZH_WORD = '\u773c\u775b'
import { describeCron, nextCronMs, parseBeacon, parsePidList, pickAnnouncer, scheduleLine, staleBeaconFiles } from '../hooks/beacon'

// ---------- Pure logic ----------

test('plan updates replay like the desktop app', async () => {
  let plan = applyPlan([], {
    items: [
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'pending' },
      { content: 'C', status: 'pending' },
    ],
  })
  plan = applyPlan(plan, { advance: true })
  expect(plan.map(s => s.status)).toEqual(['completed', 'in_progress', 'pending'])
  plan = applyPlan(plan, { done: [2], start: 3 })
  expect(plan.map(s => s.status)).toEqual(['completed', 'completed', 'in_progress'])
})

const line = (o: object) => JSON.stringify(o) + '\n'
const assistant = (tokens: number, tools: object[], ts = '2026-11-25T08:00:00.000Z') =>
  line({
    type: 'assistant',
    timestamp: ts,
    message: {
      model: 'claude-opus-5-5',
      usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0 },
      content: tools.map((t, i) => ({ type: 'tool_use', id: `tu${tokens}_${i}`, ...t })),
    },
  })

test('a transcript yields plan, context, background work and edits', async () => {
  const t = newTracker()
  const text =
    assistant(1000, [{ name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] } }]) +
    assistant(5000, [
      { name: 'mcp__ccd_turn__update_plan', input: { advance: true } },
      { name: 'Edit', input: { file_path: 'C:\\P\\a.ts' } },
      { name: 'Bash', input: { command: 'render', description: 'Render frames', run_in_background: true } },
    ]) +
    line({
      type: 'user',
      timestamp: '2026-11-25T08:00:01.000Z',
      toolUseResult: { backgroundTaskId: 'bg1' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu5000_2', content: 'Command running in background with ID: bg1.' }] },
    }) +
    '{"type":"assistant", broken'
  const used = ingestChunk(t, text)
  // The unfinished last line is left for the next read.
  expect(used).toBe(utf8Length(text.slice(0, text.lastIndexOf('\n') + 1)))
  expect(t.context).toBe(5000)
  expect(t.plan.map(s => s.status)).toEqual(['completed', 'in_progress'])
  expect(t.marks).toEqual([1000, 5000])
  expect(Object.values(t.background).map(b => b.label)).toEqual(['Render frames'])
  expect(Object.keys(t.edits)).toEqual(['c:/p/a.ts'])

  ingestChunk(
    t,
    line({
      type: 'user',
      message: { content: '<task-notification>\n<task-id>bg1</task-id>\n<tool-use-id>tu5000_2</tool-use-id>\n<status>completed</status>\n</task-notification>' },
    }),
  )
  expect(Object.keys(t.background)).toEqual([])
})

test('a wrap-up question waits until the next prompt', async () => {
  const t = newTracker()
  ingestChunk(t, assistant(100, [{ name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Done.', ask: 'Ship it?' } }]))
  expect(t.pendingAsk).toBe('Ship it?')
  expect(t.recap).toBe('Done.')
  ingestChunk(t, line({ type: 'user', message: { content: 'yes' } }))
  expect(t.pendingAsk).toBe(undefined)
})

test('a finished plan clears on the next request; an unfinished one stays', async () => {
  const t = newTracker()
  ingestChunk(t, assistant(100, [{ name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'A', status: 'in_progress' }] } }]))
  ingestChunk(t, line({ type: 'user', message: { content: 'also do B' } }))
  expect(t.plan.length).toBe(1)
  ingestChunk(t, assistant(200, [{ name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Done.' } }]))
  expect(t.plan.map(s => s.status)).toEqual(['completed'])
  ingestChunk(t, line({ type: 'user', message: { content: 'next task' } }))
  expect(t.plan).toEqual([])
})

test('a foreground command is running until its result comes back', async () => {
  const t = newTracker()
  ingestChunk(t, assistant(100, [{ name: 'Bash', input: { command: 'blender', description: 'Render 48 frames' } }]))
  expect(Object.values(t.running).map(r => r.label)).toEqual(['Render 48 frames'])
  ingestChunk(t, line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu100_0', content: 'ok' }] } }))
  expect(Object.keys(t.running)).toEqual([])
  // Plan updates and questions never count as running.
  ingestChunk(t, assistant(200, [{ name: 'mcp__ccd_turn__update_plan', input: { advance: true } }, { name: 'AskUserQuestion', input: {} }]))
  expect(Object.keys(t.running)).toEqual([])
})

test('forecast compares the recent pace with the room left', async () => {
  const plan = [
    { content: 'A', status: 'completed' as const },
    { content: 'B', status: 'in_progress' as const },
    { content: 'C', status: 'pending' as const },
  ]
  // Deltas 10k, 20k (and a compaction drop that is ignored).
  const marks = [100_000, 110_000, 50_000, 70_000]
  expect(forecast({ plan, marks, context: 70_000 }, 200_000).verdict).toBe('fits')
  const tight = forecast({ plan, marks, context: 175_000 }, 200_000)
  expect(tight.perStep).toBe(15_000)
  expect(tight.need).toBe(30_000)
  expect(tight.verdict).toBe('over')
  expect(forecast({ plan, marks, context: 165_000 }, 200_000).verdict).toBe('tight')
  expect(forecast({ plan, marks, context: 70_000 }, undefined).verdict).toBe('unknown')
})

test('the context verdict shows only while plan steps remain', async () => {
  expect(verdictLabel({ stepsDone: 1, stepsTotal: 3, verdict: 'fits' })).toEqual({ text: 'enough for the plan', color: 'success' })
  expect(verdictLabel({ stepsDone: 1, stepsTotal: 3, verdict: 'over', need: 30_000 })).toEqual({ text: "won't fit: needs ~30k", color: 'error' })
  // A finished plan, or none at all, has nothing left to fit.
  expect(verdictLabel({ stepsDone: 3, stepsTotal: 3, verdict: 'fits' })).toBe(undefined)
  expect(verdictLabel({ stepsDone: 0, stepsTotal: 0, verdict: 'fits' })).toBe(undefined)
})

test('conflicts need two sessions on one file', async () => {
  const out = findConflicts(
    [
      { id: '1', name: 'One', edits: { 'c:/p/a.ts': 100, 'c:/p/b.ts': 100 } },
      { id: '2', name: 'Two', edits: { 'c:/p/a.ts': 200, 'c:/p/c.ts': 5 } },
    ],
    50,
  )
  expect(out).toEqual([{ path: 'c:/p/a.ts', sessions: ['One', 'Two'], lastMs: 200 }])
})

test('helpers', async () => {
  expect(isInside('C:\\home\\me\\Github\\eye', 'C:\\home\\me\\Github')).toBe(true)
  expect(isInside('C:\\home\\me\\Game', 'C:\\home\\me\\Github')).toBe(false)
  expect(utf8Length('a\u4e2d\u{1F600}')).toBe(1 + 3 + 4)
  expect([...base64Bytes('YWIKYw==')]).toEqual([97, 98, 10, 99])
  expect(needsEnglish('Eye kit')).toBe(false)
  expect(needsEnglish(`${ZH_WORD} kit`)).toBe(true)
  expect(cleanTitle('"Tooth model."\nextra')).toBe('Tooth model')
  expect(cleanTitle('Title: Export eye parts')).toBe('Export eye parts')
  expect(cleanTitle(ZH_WORD)).toBe(undefined)
  const root = 'C:\\G'
  // The cwd's own folder wins; else the folder with the most edits.
  expect(projectOf('C:\\G\\eye', root, {}, {})).toBe('eye')
  expect(projectOf(root, root, { 'c:/g/a/x.ts': 1, 'c:/g/a/y.ts': 2 }, { 'c:/g/b/z.md': 9 })).toBe('a')
  expect(projectOf(root, root, { 'c:/g/claude.md': 1, 'c:/g/.claude/s.json': 2 }, {})).toBe(undefined)
})

// ---------- The whole mod against fake session files ----------

const ROOT = 'C:/home/me/Github'
const CLAUDE = 'C:/home/me/.claude'
const SELF = 'self-0000'
const OTHER = 'other-1111'
const ELSEWHERE = 'game-2222'

const files: Record<string, string> = {
  [`${CLAUDE}/sessions/1.json`]: JSON.stringify({ sessionId: SELF, cwd: 'C:\\home\\me\\Github', name: 'Hub work', status: 'busy', startedAt: 0, pid: 101 }),
  [`${CLAUDE}/sessions/2.json`]: JSON.stringify({ sessionId: OTHER, cwd: 'C:\\home\\me\\Github\\eye', name: 'Eye kit', status: 'idle', startedAt: 0, pid: 102 }),
  [`${CLAUDE}/sessions/3.json`]: JSON.stringify({ sessionId: ELSEWHERE, cwd: 'C:\\home\\me\\Game', name: 'Game', status: 'busy', startedAt: 0 }),
  [`${CLAUDE}/projects/C--home-me-Github/${SELF}.jsonl`]:
    assistant(40_000, [{ name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'Read', status: 'in_progress' }, { content: 'Write', status: 'pending' }] } }]) +
    assistant(50_000, [{ name: 'mcp__ccd_turn__update_plan', input: { advance: true } }, { name: 'Write', input: { file_path: 'C:\\home\\me\\Github\\shared.md' } }, { name: 'Edit', input: { file_path: `${CLAUDE}/memory/MEMORY.md` } }]),
  [`${CLAUDE}/projects/C--home-me-Github-eye/${OTHER}.jsonl`]:
    assistant(90_000, [
      { name: 'Edit', input: { file_path: 'C:/home/me/Github/shared.md' } },
      // Claude's shared memory index, outside the project: never a conflict.
      { name: 'Edit', input: { file_path: `${CLAUDE}/memory/MEMORY.md` } },
    ]) +
    assistant(95_000, [{ name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Eyes exported.', ask: 'Publish the release?' } }]),
  // A session titled in Chinese: the pane must still read as English only.
  [`${CLAUDE}/sessions/4.json`]: JSON.stringify({ sessionId: 'zh-3333', cwd: 'C:\\home\\me\\Github\\teeth', name: ZH_NAME, status: 'busy', startedAt: 0, pid: 104 }),
  [`${CLAUDE}/projects/C--home-me-Github-teeth/zh-3333.jsonl`]:
    assistant(20_000, [{ name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: ZH_STEP, status: 'in_progress' }] } }]),
  // A chat busy with a long render: quiet, but not stuck.
  [`${CLAUDE}/sessions/5.json`]: JSON.stringify({ sessionId: 'render-4444', cwd: 'C:/home/me/Github/eye', name: 'Render job', status: 'busy', startedAt: 0, pid: 105 }),
  [`${CLAUDE}/projects/C--home-me-Github-eye/render-4444.jsonl`]:
    assistant(30_000, [{ name: 'Bash', input: { command: 'blender -b', description: 'Render 48 frames' } }]),
  // A chat whose app crashed: its record stays, its process (pid 999) is gone.
  [`${CLAUDE}/sessions/6.json`]: JSON.stringify({ sessionId: 'ghost-5555', cwd: 'C:/home/me/Github/eye', name: 'Ghost chat', status: 'busy', startedAt: 0, pid: 999 }),
  [`${CLAUDE}/projects/C--home-me-Github-eye/ghost-5555.jsonl`]: assistant(10_000, []),
  // The Chinese chat publishes its own status: a dialog open, and a /loop every 10 minutes.
  [`${CLAUDE}/agent-task-hub/zh-3333.json`]: JSON.stringify({
    v: 1,
    sessionId: 'zh-3333',
    at: Date.parse('2026-11-25T08:04:30.000Z'),
    tokens: 21_000,
    limit: 200_000,
    permission: { tool: 'Bash', since: Date.parse('2026-11-25T08:04:00.000Z') },
    crons: [{ id: 'c1', schedule: '*/10 * * * *', recurring: true, prompt: 'check the build' }],
    wakes: 2,
    lastWakeMs: Date.parse('2026-11-25T08:00:00.000Z'),
  }),
}
const TASKLIST = ['"claude.exe","101","Console","1","9 K"', '"claude.exe","102","Console","1","9 K"', '"claude.exe","104","Console","1","9 K"', '"claude.exe","105","Console","1","9 K"'].join('\r\n')
let modelFails = false
const TITLES: Record<string, string> = { [ZH_NAME]: 'Tooth model', [ZH_STEP]: '"Read the reference images."' }
/** Anything a person would read as not English (the pane's own marks allowed). */
const NOT_ENGLISH = /[^\u0020-\u007e\u2026\u00b7\u25cf\u25cb\u25b2\u2588\u2591]/
const norm = (p: string) => p.replace(/\\/g, '/')
/** When a fake file was last written: a status file's own heartbeat, else never. */
const writtenAt = (path: string): number => {
  try {
    return Number(JSON.parse(files[path] ?? '').at) || 0
  } catch {
    return 0
  }
}
/** Every path the mod read or wrote, to check what it skips. */
const reads: string[] = []
const writes: string[] = []
/** Every command the mod ran. */
const runs: { argv: readonly string[]; init?: { cwd?: string } }[] = []
/** This chat's id as the engine reports it: a /clear changes it. */
let selfIdNow = SELF
/** Where this chat draws: none for `claude -p` or a chat not on screen. */
let surfacesNow: string[] = ['desktop']
/** The context breakdown the engine reports, when a test sets one. */
let breakdownNow: object | undefined
let modelCalls = 0
/** The usage windows the engine reports, when a test sets them. */
let rateLimitsNow: object[] = []
/** What the mod put in the status line. */
const statusLines: string[] = []
/** When set, listing the live sessions fails, as a busy disk might. */
let isSessionListFailing = false
let sessionLists = 0

/** Stands in for the engine: a fake config folder, clock and session. */
async function world($: any, on: any, tokens: number, at = '2026-11-25T08:05:00.000Z', env: Record<string, string> = {}) {
  on('command.register', () => ({ value: { command: 'task-hub' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', (_, e: any) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  const session = mock.session(on)
  const clock = mock.clock(on)
  await clock.set(Date.parse(at))
  mock.env(on, { USERPROFILE: 'C:/home/me', ...env })
  mock.store(on)
  on('session.surfaces', () => ({ value: surfacesNow }))
  on('ui.status', (_: any, e: any) => {
    statusLines.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('model.complete', (_, e: any) => {
    modelCalls++
    if (modelFails) return { value: { isAnswered: false, reason: 'api-error', usage: {} } }
    const asked = Object.keys(TITLES).find(k => String(e.prompt).includes(k))
    return { value: { isAnswered: true, text: asked ? TITLES[asked] : 'Untitled', usage: {} } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: selfIdNow }))
  // The shell moved into a subfolder; the project root is still Github.
  on('session.cwd', () => ({ value: 'C:\\home\\me\\Github\\teeth' }))
  on('session.root', () => ({ value: 'C:\\home\\me\\Github' }))
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: rateLimitsNow, context: { window: 1_000_000, tokens, ...(breakdownNow ? { breakdown: breakdownNow } : {}) } },
  }))
  on('fs.list', (_, e: any) => {
    const dir = norm(e.path)
    if (dir.endsWith('/sessions')) {
      sessionLists++
      if (isSessionListFailing) throw new Error('the disk is busy')
    }
    const names = new Set<string>()
    for (const f of Object.keys(files)) {
      if (f.startsWith(dir + '/')) names.add(f.slice(dir.length + 1).split('/')[0])
    }
    return {
      value: [...names].map(name => ({
        name,
        kind: name.includes('.') ? 'file' : 'directory',
        size: 0,
        // A status file was last written at its heartbeat; other files' times are not used.
        mtimeMs: writtenAt(`${dir}/${name}`),
        isLink: false,
      })),
    }
  })
  on('fs.exists', (_, e: any) => ({ value: norm(e.path) in files }))
  on('fs.write', (_, e: any) => {
    writes.push(norm(e.path))
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('process.run', (_, e: any) => {
    runs.push(e)
    return { value: { exitCode: 0, stdout: TASKLIST, stderr: '' } }
  })
  on('fs.stat', (_, e: any) => ({
    value: { kind: 'file', size: files[norm(e.path)].length, mtimeMs: Date.parse('2026-11-25T08:00:00.000Z'), isLink: false },
  }))
  on('fs.read', (_, e: any) => {
    reads.push(norm(e.path))
    const text = files[norm(e.path)]
    const start = e.offset ?? 0
    return { value: text.slice(start, start + (e.length ?? text.length)) }
  })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'task-hub' })
  await clock.settle()
  // A second refresh picks up the English titles the first one asked for.
  await $.command.run({ command: 'task-hub' })
  await clock.settle()
  return { clock, session, toasts }
}

test('the pane shows this project, what needs you and conflicts', async ($, on) => {
  await world($, on, 50_000)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-task-hub',
      surface,
      component: 'Pane',
      requestId: 'agent-task-hub',
      props: { title: 'Agent Task Hub', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /^4 chats/ }))?.text).toBe('4 chats · 3 working · 2 waiting · 1 scheduled')
    // The Game folder is outside this project.
    expect(await ui.find({ type: 'Text', text: /Game/ })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /^Waiting for you$/ })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /^This chat$/ })).not.toBe(undefined)
    // Every row is labelled, and each session names its project folder.
    for (const label of ['Project', 'Plan', 'Context']) {
      expect(await ui.find({ type: 'Text', text: new RegExp(`^${label}$`) })).not.toBe(undefined)
    }
    expect(await ui.find({ type: 'Text', text: /^eye$/ })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /^teeth$/ })).not.toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /^95k/ }))?.text).toBe('95k of 1M (10%)')
    expect((await ui.find({ type: 'Text', text: /^Same file/ }))?.text).toBe('Same file edited by 2 chats: Github/shared.md')
    expect(await ui.find({ type: 'Text', text: /^Eye kit, Hub work$/ })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /MEMORY/ })).toBe(undefined)
    // A chat keeps its sidebar name; its plan step arrives as tidy English.
    expect(await ui.find({ type: 'Text', text: new RegExp(`^${ZH_NAME}$`) })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /^Tooth model$/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /Read the reference images/ }))?.text).toBe('Step 1 of 1 · Read the reference images')
    // Apart from that name, the pane is English only.
    expect(await ui.find({ type: 'Text', text: new RegExp(`^(?!${ZH_NAME}$).*${NOT_ENGLISH.source}`) })).toBe(undefined)
    await ui.unmount()
  }
})


test('this session is told once when its context nears auto-compaction', async ($, on) => {
  const { session } = await world($, on, 950_000)
  const notes = session.appended().filter((r: any) => JSON.stringify(r).includes('Agent Task Hub: context'))
  expect(notes.length).toBe(1)
  await $.command.run({ command: 'task-hub' })
  expect(session.appended().filter((r: any) => JSON.stringify(r).includes('Agent Task Hub: context')).length).toBe(1)
})

const PANE_AT = (surface: 'desktop' | 'terminal') => ({
  plugin: 'agent-task-hub',
  surface,
  component: 'Pane',
  requestId: 'agent-task-hub',
  props: { title: 'Agent Task Hub', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
})

test('a long command reads as running; silence with nothing running reads as stuck', async ($, on) => {
  await world($, on, 50_000, '2026-11-25T08:30:00.000Z')
  const ui = await $.ui.mount(PANE_AT('desktop'))
  expect((await ui.find({ type: 'Text', text: /^Render 48 frames/ }))?.text).toBe('Render 48 frames · 30m')
  // The Chinese chat is busy with nothing running: that one may be stuck.
  expect((await ui.find({ type: 'Text', text: /may be stuck/ }))?.text).toBe('No activity for 30m: it may be stuck')
  await ui.unmount()
})

test('each new question alerts, even with the same words', async ($, on) => {
  const { clock, toasts } = await world($, on, 50_000)
  const asked = () => toasts.filter(t => t.includes('Eye kit') && t.includes('Waiting for your decision')).length
  const before = asked()
  const path = `${CLAUDE}/projects/C--home-me-Github-eye/${OTHER}.jsonl`
  const original = files[path]
  // The person answers; later the chat asks the very same question again.
  files[path] +=
    line({ type: 'user', timestamp: '2026-11-25T08:03:00.000Z', message: { content: 'not yet' } }) +
    assistant(96_000, [{ name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Eyes exported.', ask: 'Publish the release?' } }], '2026-11-25T08:04:00.000Z')
  try {
    await $.command.run({ command: 'task-hub' })
    await clock.settle()
    expect(asked()).toBe(before + 1)
  } finally {
    files[path] = original
  }
})

test('a failed translation is retried, never stored as a placeholder', async ($, on) => {
  modelFails = true
  try {
    await world($, on, 50_000)
    const ui = await $.ui.mount(PANE_AT('desktop'))
    expect(await ui.find({ type: 'Text', text: /Untitled/ })).toBe(undefined)
    await ui.unmount()
  } finally {
    modelFails = false
  }
})

test('chats idle for over an hour fold into one line that opens on press', async ($, on) => {
  // 09:30: the Eye kit chat (idle, waiting) last moved at 08:00.
  await world($, on, 50_000, '2026-11-25T09:30:00.000Z')
  const ui = await $.ui.mount(PANE_AT('desktop'))
  expect(await ui.find({ type: 'Text', text: /^Eye kit$/ })).toBe(undefined)
  await ui.press({ key: 'earlier' })
  expect(await ui.find({ type: 'Text', text: /^Eye kit$/ })).not.toBe(undefined)
  await ui.unmount()
})

test('/task-hub auto off keeps new chats from opening the pane; auto on brings it back', async ($, on) => {
  let opened = 0
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: true } }
  })
  on('command.register', () => ({ value: { command: 'task-hub' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.clock(on)
  mock.store(on)
  const text = async (args: string) => ((await $.command.run({ command: 'task-hub', args })) as any)?.text as string

  expect(await text('auto off')).toBe('New chats will no longer open the pane. Type /task-hub to open it.')
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  expect(opened).toBe(0)
  expect(await text('auto')).toContain('do not open')

  expect(await text('auto on')).toBe('New chats will open the Agent Task Hub pane on their own.')
  expect(await text('auto')).toContain('New chats open the pane')
  expect(await text('something else')).toContain('Usage:')
})

// ---------- v2: shared status files ----------

test('cron schedules read as plain words with the next run', async () => {
  const from = new Date(2026, 10, 25, 14, 3).getTime()
  expect(nextCronMs('*/10 * * * *', from)).toBe(new Date(2026, 10, 25, 14, 10).getTime())
  expect(nextCronMs('0 9 * * 1-5', from)).toBe(new Date(2026, 10, 26, 9, 0).getTime())
  expect(nextCronMs('not a cron', from)).toBe(undefined)
  expect(describeCron('*/10 * * * *', true)).toBe('Every 10 min')
  expect(describeCron('30 9 * * *', true)).toBe('Daily 09:30')
  expect(describeCron('0 9 * * 1-5', true)).toBe('Weekdays 09:00')
  expect(describeCron('5 14 25 11 *', false)).toBe('Once')
  expect(scheduleLine([{ id: 'a', schedule: '*/10 * * * *', recurring: true, prompt: '' }], from)).toBe('Every 10 min · next 14:10')
  expect(scheduleLine([], from)).toBe(undefined)
})

test('toasts come from the chat typed in last', async () => {
  const b = (id: string, at: number, lastPromptMs?: number) => ({ v: 1 as const, sessionId: id, at, lastPromptMs, crons: [], wakes: 0 })
  expect(pickAnnouncer([b('a', 1000, 10), b('b', 1000, 20)], 2000)).toBe('b')
  // A stopped chat (stale heartbeat) cannot announce.
  expect(pickAnnouncer([b('a', 1000, 10), b('b', -200_000, 20)], 2000)).toBe('a')
  expect(pickAnnouncer([b('a', 1000)], 2000)).toBe(undefined)
  expect(parseBeacon('{"v":2}')).toBe(undefined)
  expect(parseBeacon('nonsense')).toBe(undefined)
})

test('the pane shows approvals, schedules, and hides crashed chats', async ($, on) => {
  await world($, on, 50_000)
  const ui = await $.ui.mount(PANE_AT('desktop'))
  expect(await ui.find({ type: 'Text', text: /^Needs approval$/ })).not.toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /waiting for Allow/ }))?.text).toBe('Bash is waiting for Allow')
  const when = new Date(Date.parse('2026-11-25T08:10:00.000Z'))
  const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  expect((await ui.find({ type: 'Text', text: /^Every 10 min/ }))?.text).toBe(`Every 10 min · next ${hhmm} · last ran 5m ago`)
  // Its own exact limit, not this chat's.
  expect((await ui.find({ type: 'Text', text: /^21k/ }))?.text).toBe('21k of 200k (11%)')
  expect(await ui.find({ type: 'Text', text: /Ghost chat/ })).toBe(undefined)
  await ui.unmount()
})

test('this chat publishes its own status file, and its scheduled tasks after each turn', async ($, on) => {
  // Nothing sits beneath the mod in a test: these stand for the engine's answers.
  for (const event of ['Stop', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse'] as const) {
    on(`classic.${event}`, () => ({}))
  }
  surfacesNow = []
  const { clock } = await world($, on, 50_000)
  const mine = () => parseBeacon(files[`${CLAUDE}/agent-task-hub/${SELF}.json`] ?? '')
  // The hooks return at once and write in the background: wait for the write to land.
  const eventually = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await clock.settle()
    return check()
  }
  expect(mine()?.tokens).toBe(50_000)
  // A run with no window (claude -p) never counts as the chat in front of the person.
  const typedBefore = mine()?.lastPromptMs
  await $.classic.UserPromptSubmit({ prompt: 'hi', source: 'user' } as any)
  await eventually(() => false) // let any background write finish
  expect(mine()?.lastPromptMs).toBe(typedBefore)
  surfacesNow = ['desktop']
  await $.classic.Stop({
    stop_hook_active: false,
    session_crons: [{ id: 'x', schedule: '0 9 * * *', recurring: true, prompt: 'daily report' }],
    background_tasks: [],
  } as any)
  expect(await eventually(() => mine()?.crons.length === 1)).toBe(true)
  expect(mine()?.crons.map(c => c.schedule)).toEqual(['0 9 * * *'])
  await $.classic.UserPromptSubmit({ prompt: 'hi', source: 'user' } as any)
  expect(await eventually(() => mine()?.lastPromptMs !== undefined)).toBe(true)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as any)
  expect(await eventually(() => mine()?.permission?.tool === 'Bash')).toBe(true)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 't' } as any)
  expect(await eventually(() => mine()?.permission === undefined)).toBe(true)
})

test('a byte read stands in when a text read of a big file is refused', async () => {
  const bytes = new TextEncoder().encode('{"a":"\u00e9\u4e2d"}\n')
  expect(utf8Decode(bytes)).toBe('{"a":"\u00e9\u4e2d"}\n')
})

test('plan steps with no plan in the tail ask for a deeper read', async () => {
  const t = newTracker()
  ingestChunk(t, assistant(100, [{ name: 'mcp__ccd_turn__update_plan', input: { advance: true } }]))
  expect(t.isPlanOrphan).toBe(true)
  ingestChunk(t, assistant(200, [{ name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'A', status: 'in_progress' }] } }]))
  expect(t.isPlanOrphan).toBe(false)
})

test('only the chat typed in last shows toasts', async ($, on) => {
  const path = `${CLAUDE}/agent-task-hub/${OTHER}.json`
  // Another chat had the person's latest prompt: this one stays quiet.
  files[path] = JSON.stringify({ v: 1, sessionId: OTHER, at: Date.parse('2026-11-25T08:04:50.000Z'), lastPromptMs: Date.parse('2026-11-25T09:00:00.000Z'), crons: [], wakes: 0 })
  try {
    const { clock, toasts } = await world($, on, 50_000)
    const before = toasts.length
    const eye = `${CLAUDE}/projects/C--home-me-Github-eye/${OTHER}.jsonl`
    const original = files[eye]
    files[eye] +=
      line({ type: 'user', timestamp: '2026-11-25T08:03:00.000Z', message: { content: 'not yet' } }) +
      assistant(96_000, [{ name: 'mcp__ccd_turn__wrap_up', input: { recap: 'x', ask: 'Again?' } }], '2026-11-25T08:04:00.000Z')
    try {
      await $.command.run({ command: 'task-hub' })
      await clock.settle()
      expect(toasts.length).toBe(before)
    } finally {
      files[eye] = original
    }
  } finally {
    delete files[path]
  }
})


// ---------- 0.2.1: fewer reads and writes ----------

test('status files of stopped chats are skipped without being read', async ($, on) => {
  const old = `${CLAUDE}/agent-task-hub/old-9999.json`
  files[old] = JSON.stringify({ v: 1, sessionId: 'old-9999', at: Date.parse('2026-11-20T08:00:00.000Z'), crons: [], wakes: 0 })
  try {
    reads.length = 0
    await world($, on, 50_000)
    expect(reads.filter(p => p === old).length).toBe(0)
    // A fresh one is still read.
    expect(reads.some(p => p.endsWith('/agent-task-hub/zh-3333.json'))).toBe(true)
  } finally {
    delete files[old]
  }
})

test('this chat rewrites its status file only on a change or for the heartbeat', async ($, on) => {
  const mine = () => writes.filter(p => p.endsWith(`/agent-task-hub/${SELF}.json`)).length
  const { clock } = await world($, on, 50_000)
  const after = mine()
  // Nothing changed and less than 30 s passed: no write.
  await clock.advance(10_000)
  await $.command.run({ command: 'task-hub' })
  await clock.settle()
  expect(mine()).toBe(after)
  // The heartbeat is due: one write.
  await clock.advance(30_000)
  await $.command.run({ command: 'task-hub' })
  await clock.settle()
  expect(mine()).toBe(after + 1)
})

test('a pane nobody sees refreshes every 30 s; a shown one every 5 s', async ($, on) => {
  const { clock } = await world($, on, 50_000)
  const refreshes = () => reads.filter(p => p.endsWith('/sessions/1.json')).length
  // Hidden: 10 s pass without a refresh.
  let before = refreshes()
  await clock.advance(10_000)
  await clock.settle()
  expect(refreshes()).toBe(before)
  // Drawn: the next 5-second tick refreshes again.
  const ui = await $.ui.mount(PANE_AT('desktop'))
  before = refreshes()
  await clock.advance(5_000)
  await clock.settle()
  expect(refreshes()).toBeGreaterThan(before)
  await ui.unmount()
})

test('a pane shown again after being hidden catches up at once', async ($, on) => {
  const { clock } = await world($, on, 50_000)
  // Hidden for 20 s: no refresh, so the data is 20 s old.
  await clock.advance(20_000)
  await clock.settle()
  const before = reads.filter(p => p.endsWith('/sessions/1.json')).length
  // Drawing it refreshes right away, without waiting for the next tick.
  const ui = await $.ui.mount(PANE_AT('desktop'))
  await clock.settle()
  expect(reads.filter(p => p.endsWith('/sessions/1.json')).length).toBeGreaterThan(before)
  await ui.unmount()
})

// ---------- Long-running panes and other systems ----------

test('process lists parse on Windows, macOS and Linux', async () => {
  const windows = '"claude.exe","101","Console","1","9 K"\r\n"node.exe","2002","Console","1","1 K"\r\nINFO: junk\r\n'
  expect([...parsePidList(windows, true)].sort()).toEqual(['101', '2002'])
  // `ps -A -o pid=` right-aligns the ids.
  const ps = '    1\n  423\n10234\n\n'
  expect([...parsePidList(ps, false)].sort()).toEqual(['1', '10234', '423'])
  expect(parsePidList('', false).size).toBe(0)
})

test('a chat gone for over 10 minutes is forgotten, and read afresh if it returns', async ($, on) => {
  const { clock } = await world($, on, 50_000)
  const record = `${CLAUDE}/sessions/2.json`
  const transcript = `${CLAUDE}/projects/C--home-me-Github-eye/${OTHER}.jsonl`
  const saved = files[record]
  delete files[record]
  try {
    await clock.advance(11 * 60_000)
    await $.command.run({ command: 'task-hub' })
    await clock.settle()
  } finally {
    files[record] = saved
  }
  reads.length = 0
  await $.command.run({ command: 'task-hub' })
  await clock.settle()
  // Forgotten, so its transcript is read again from the start.
  expect(reads.filter(p => p === transcript).length).toBeGreaterThan(0)
})

test('AGENT_TASK_HUB_NOTE_AT lowers the near-compaction threshold', async ($, on) => {
  // 50k of 1M is 5%: over a 1% threshold, far under the usual 85%.
  const { session } = await world($, on, 50_000, '2026-11-25T08:05:00.000Z', { AGENT_TASK_HUB_NOTE_AT: '0.01' })
  const notes = session.appended().filter((r: any) => JSON.stringify(r).includes('Agent Task Hub: context'))
  expect(notes.length).toBe(1)
})

// ---------- /clear, dialogs, failures and old files ----------

/** Waits for the mod's background writes to land. */
async function eventually(clock: any, check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await clock.settle()
  return check()
}

test('connector tools read as a person would say them', async () => {
  expect(toolLabel('mcp__Claude_Browser__navigate')).toBe('navigate (Claude Browser)')
  expect(toolLabel('mcp__ccd_session__start_session')).toBe('start_session (ccd session)')
  expect(toolLabel('Bash')).toBe('Bash')
  expect(toolLabel('mcp__odd')).toBe('mcp__odd')
})

test('only status files the mod named, unwritten for a week, are picked to delete', async () => {
  const now = Date.parse('2026-11-25T08:00:00.000Z')
  const day = 86_400_000
  const old = 'aaaaaaaa-1111-4111-8111-000000000001.json'
  const picked = staleBeaconFiles(
    [
      { name: old, kind: 'file', mtimeMs: now - 8 * day },
      { name: 'aaaaaaaa-1111-4111-8111-000000000002.json', kind: 'file', mtimeMs: now - 2 * day },
      // Not a name the mod writes: never picked, however old.
      { name: 'notes.json', kind: 'file', mtimeMs: now - 30 * day },
      { name: 'aaaaaaaa-1111-4111-8111-000000000003.json.bak', kind: 'file', mtimeMs: now - 30 * day },
      { name: 'aaaaaaaa-1111-4111-8111-000000000004.json', kind: 'directory', mtimeMs: now - 30 * day },
      // A time that could not be read is not old.
      { name: 'aaaaaaaa-1111-4111-8111-000000000005.json', kind: 'file', mtimeMs: 0 },
    ],
    now,
    7 * day,
  )
  expect(picked).toEqual([old])
})

test('status files of chats gone for a week are deleted, once a day', async ($, on) => {
  const dir = `${CLAUDE}/agent-task-hub`
  const OLD = 'aaaaaaaa-1111-4111-8111-000000000001'
  const RECENT = 'aaaaaaaa-1111-4111-8111-000000000002'
  const beaconAt = (id: string, at: string) => JSON.stringify({ v: 1, sessionId: id, at: Date.parse(at), crons: [], wakes: 0 })
  files[`${dir}/${OLD}.json`] = beaconAt(OLD, '2026-11-10T08:00:00.000Z')
  files[`${dir}/${RECENT}.json`] = beaconAt(RECENT, '2026-11-24T08:00:00.000Z')
  runs.length = 0
  try {
    const { clock } = await world($, on, 50_000)
    const deletes = () => runs.filter(r => r.argv[0] === 'cmd')
    expect(await eventually(clock, () => deletes().length > 0)).toBe(true)
    // Bare names, run in the status folder itself.
    expect(deletes().map(r => r.argv)).toEqual([['cmd', '/c', 'del', '/q', `${OLD}.json`]])
    expect(norm(deletes()[0].init?.cwd ?? '')).toBe(dir)
    // Not again the same day (an hour on, past the hourly look at the store). The clock
    // jumps there rather than stepping through every 5-second refresh on the way.
    await clock.set(Date.parse('2026-11-25T09:06:00.000Z'))
    await $.command.run({ command: 'task-hub' })
    await clock.settle()
    expect(deletes().length).toBe(1)
  } finally {
    delete files[`${dir}/${OLD}.json`]
    delete files[`${dir}/${RECENT}.json`]
  }
})

test('after /clear this chat shows once, as the new chat, with its own status started over', async ($, on) => {
  on('classic.UserPromptSubmit', () => ({}))
  const { clock } = await world($, on, 50_000)
  const beaconOf = (id: string) => parseBeacon(files[`${CLAUDE}/agent-task-hub/${id}.json`] ?? '')
  // The fake files outlive a test: start from this chat's status file as this test writes it.
  delete files[`${CLAUDE}/agent-task-hub/${SELF}.json`]
  await $.command.run({ command: 'task-hub' })
  await clock.settle()
  await $.classic.UserPromptSubmit({ prompt: 'hi', source: 'user' } as any)
  expect(await eventually(clock, () => beaconOf(SELF)?.lastPromptMs !== undefined)).toBe(true)

  // /clear: the same process, now under a new id; no session.start says so.
  const NEW = 'self-new-0001'
  const record = `${CLAUDE}/sessions/1.json`
  const transcript = `${CLAUDE}/projects/C--home-me-Github/${NEW}.jsonl`
  const saved = files[record]
  files[record] = saved.replace(SELF, NEW)
  files[transcript] = assistant(1_000, [], '2026-11-25T08:05:01.000Z')
  selfIdNow = NEW
  try {
    await clock.advance(5_000)
    await $.command.run({ command: 'task-hub' })
    await clock.settle()
    const ui = await $.ui.mount(PANE_AT('desktop'))
    // Four chats, as before: not the old one and the new one side by side.
    expect((await ui.find({ type: 'Text', text: /^4 chats/ }))?.text).toMatch(/^4 chats · /)
    await ui.unmount()
    // The new chat's status file starts over: the old chat's prompt is not its own.
    expect(await eventually(clock, () => beaconOf(NEW) !== undefined)).toBe(true)
    expect(beaconOf(NEW)?.lastPromptMs).toBe(undefined)
  } finally {
    selfIdNow = SELF
    files[record] = saved
    delete files[transcript]
    delete files[`${CLAUDE}/agent-task-hub/${NEW}.json`]
  }
})

test('an approval closes when its turn ends, as on No or Esc; a subagent does not close it', async ($, on) => {
  on('classic.PermissionRequest', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  const { clock } = await world($, on, 50_000)
  const mine = () => parseBeacon(files[`${CLAUDE}/agent-task-hub/${SELF}.json`] ?? '')
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as any)
  expect(await eventually(clock, () => mine()?.permission?.tool === 'Bash')).toBe(true)
  // A subagent finishing its own tool, or its own turn, leaves this chat's dialog open.
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 't', agent_id: 'sub-1' } as any)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'sub-1' } as any)
  await eventually(clock, () => false)
  expect(mine()?.permission?.tool).toBe('Bash')
  // The person said No: the turn ends as interrupted, with no classic Stop.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
  expect(await eventually(clock, () => mine()?.permission === undefined)).toBe(true)
})

test('a chat waiting on your approval is never called stuck', async ($, on) => {
  const { clock, toasts } = await world($, on, 50_000)
  const zh = `${CLAUDE}/agent-task-hub/zh-3333.json`
  const saved = files[zh]
  try {
    // 11 quiet minutes, with its dialog open all along (its heartbeat kept fresh).
    files[zh] = JSON.stringify({ ...JSON.parse(saved), at: Date.parse('2026-11-25T08:16:00.000Z') })
    await clock.advance(11 * 60_000)
    await $.command.run({ command: 'task-hub' })
    await clock.settle()
    const ui = await $.ui.mount(PANE_AT('desktop'))
    expect(await ui.find({ type: 'Text', text: /^Needs approval$/ })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /may be stuck/ })).toBe(undefined)
    await ui.unmount()
    expect(toasts.filter(t => t.includes('may be stuck')).length).toBe(0)
  } finally {
    files[zh] = saved
  }
})

test('a refresh that keeps failing does not set off another on every redraw', async ($, on) => {
  const { clock } = await world($, on, 50_000)
  const ui = await $.ui.mount(PANE_AT('desktop'))
  isSessionListFailing = true
  try {
    const before = sessionLists
    // Two 5-second refreshes are due, and both fail.
    await clock.advance(10_000)
    await clock.settle()
    const failed = sessionLists - before
    expect(failed).toBeGreaterThan(0)
    expect(failed).toBeLessThan(5)
    expect(await ui.find({ type: 'Text', text: /^Last refresh failed/ })).not.toBe(undefined)
  } finally {
    isSessionListFailing = false
    await ui.unmount()
  }
})

// ---------- Full chats, windowless runs, old questions ----------

test('a chat near its limit stands out: yellow from 80%, red from 95%', async ($, on) => {
  expect(fullColor(0.5)).toBe(undefined)
  expect(fullColor(0.8)).toBe('warning')
  expect(fullColor(0.95)).toBe('error')
  await world($, on, 850_000)
  const ui = await $.ui.mount(PANE_AT('desktop'))
  // This chat, with no plan verdict to say so, at 85%.
  expect((await ui.find({ type: 'Text', text: /^850k of 1M/ }))?.props.color).toBe('warning')
  // Another at 10% stays plain.
  expect((await ui.find({ type: 'Text', text: /^95k of 1M/ }))?.props.color).toBe(undefined)
  await ui.unmount()
})

test('a new message ends a question asked before it', async () => {
  const t = newTracker()
  ingestChunk(t, assistant(100, [{ name: 'AskUserQuestion', input: {} }]))
  expect(t.openQuestions.length).toBe(1)
  ingestChunk(t, line({ type: 'user', message: { content: 'never mind, do B' } }))
  expect(t.openQuestions).toEqual([])
})

test('with no window only this chat is read, and a window brings the rest without a burst of toasts', async ($, on) => {
  surfacesNow = []
  reads.length = 0
  modelCalls = 0
  const other = `${CLAUDE}/projects/C--home-me-Github-eye/${OTHER}.jsonl`
  try {
    const { clock, toasts } = await world($, on, 50_000)
    expect(reads.filter(p => p === other).length).toBe(0)
    expect(modelCalls).toBe(0)
    // Its own status file is still kept fresh.
    expect(parseBeacon(files[`${CLAUDE}/agent-task-hub/${SELF}.json`] ?? '')?.tokens).toBe(50_000)
    // A window opens: the next drawing reads every chat.
    surfacesNow = ['desktop']
    await clock.advance(2_000)
    const ui = await $.ui.mount(PANE_AT('desktop'))
    await clock.settle()
    expect(reads.filter(p => p === other).length).toBeGreaterThan(0)
    expect((await ui.find({ type: 'Text', text: /^4 chats/ }))?.text).toMatch(/^4 chats · /)
    // What was already waiting is noted, not announced all at once.
    expect(toasts.length).toBe(0)
    await ui.unmount()
  } finally {
    surfacesNow = ['desktop']
  }
})

test('with auto-compaction off the reminder names the context limit', async ($, on) => {
  breakdownNow = { isAutoCompactEnabled: false, memoryFiles: [], mcpTools: [], agents: [], apiUsage: null }
  try {
    const { session } = await world($, on, 50_000, '2026-11-25T08:05:00.000Z', { AGENT_TASK_HUB_NOTE_AT: '0.01' })
    const notes = session.appended().map((r: any) => JSON.stringify(r)).filter((t: string) => t.includes('Agent Task Hub: context'))
    expect(notes.length).toBe(1)
    expect(notes[0]).toContain('of the 1M context limit')
    expect(notes[0]).not.toContain('auto-compaction')
  } finally {
    breakdownNow = undefined
  }
})

test('a chat that comes back after being forgotten is announced again if it still waits', async ($, on) => {
  const { clock, toasts } = await world($, on, 50_000)
  const eyeToasts = () => toasts.filter(t => t.includes('Eye kit:')).length
  const before = eyeToasts()
  const record = `${CLAUDE}/sessions/2.json`
  const saved = files[record]
  delete files[record]
  try {
    await clock.advance(11 * 60_000)
    await $.command.run({ command: 'task-hub' })
    await clock.settle()
  } finally {
    files[record] = saved
  }
  await $.command.run({ command: 'task-hub' })
  await clock.settle()
  // Its alert was forgotten with it: the decision it still waits on is news again.
  expect(eyeToasts()).toBe(before + 1)
})


// ---------- Forks, twin names, reloads ----------

test("a fork's copied lines are its parent's edits, not its own", async () => {
  const t = newTracker('fork-1')
  // Copied from the parent: each line still names it.
  ingestChunk(t, line({ ...JSON.parse(assistant(100, [{ name: 'Edit', input: { file_path: 'C:/p/a.ts' } }])), sessionId: 'parent-1' }))
  expect(Object.keys(t.edits)).toEqual(['c:/p/a.ts'])
  expect(Object.keys(t.ownEdits)).toEqual([])
  ingestChunk(t, line({ ...JSON.parse(assistant(200, [{ name: 'Edit', input: { file_path: 'C:/p/b.ts' } }])), sessionId: 'fork-1' }))
  expect(Object.keys(t.ownEdits)).toEqual(['c:/p/b.ts'])
})

test('two chats of one name on one file are still two', async () => {
  const out = findConflicts(
    [
      { id: '1', name: 'Fix bug', edits: { 'c:/p/a.ts': 100 } },
      { id: '2', name: 'Fix bug', edits: { 'c:/p/a.ts': 200 } },
    ],
    50,
  )
  expect(out).toEqual([{ path: 'c:/p/a.ts', sessions: ['Fix bug', 'Fix bug'], lastMs: 200 }])
})

test('the pane ignores a fork\u2019s copied edits but counts a twin-named chat', async ($, on) => {
  const otherTranscript = `${CLAUDE}/projects/C--home-me-Github-eye/${OTHER}.jsonl`
  const added: Record<string, string> = {
    // A fork of "Eye kit": its whole history copied, every line naming the parent.
    [`${CLAUDE}/sessions/7.json`]: JSON.stringify({ sessionId: 'fork-7777', cwd: 'C:/home/me/Github/eye', name: 'Eye kit (fork)', status: 'idle', startedAt: 0 }),
    [`${CLAUDE}/projects/C--home-me-Github-eye/fork-7777.jsonl`]: files[otherTranscript]
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.stringify({ ...JSON.parse(l), sessionId: OTHER }))
      .join('\n') + '\n',
    // Another chat called "Hub work", like this one, writing the same file itself.
    [`${CLAUDE}/sessions/8.json`]: JSON.stringify({ sessionId: 'twin-8888', cwd: 'C:/home/me/Github', name: 'Hub work', status: 'idle', startedAt: 0 }),
    [`${CLAUDE}/projects/C--home-me-Github/twin-8888.jsonl`]: assistant(30_000, [{ name: 'Write', input: { file_path: 'C:/home/me/Github/shared.md' } }], '2026-11-25T08:02:00.000Z'),
  }
  Object.assign(files, added)
  try {
    await world($, on, 50_000)
    const ui = await $.ui.mount(PANE_AT('desktop'))
    expect((await ui.find({ type: 'Text', text: /^Same file/ }))?.text).toBe('Same file edited by 3 chats: Github/shared.md')
    expect(await ui.find({ type: 'Text', text: /^Eye kit, Hub work, Hub work$/ })).not.toBe(undefined)
    // The fork is still a chat of its own in the list.
    expect(await ui.find({ type: 'Text', text: /^Eye kit \(fork\)$/ })).not.toBe(undefined)
    await ui.unmount()
    expect(nameList(['Eye kit', 'Hub work', 'Hub work'])).toBe('Eye kit, Hub work and Hub work')
    expect(nameList(['A', 'B'])).toBe('A and B')
  } finally {
    for (const path of Object.keys(added)) delete files[path]
  }
})

test('a reminder already sent is not sent again after a reload', async ($, on) => {
  // What the session's state holds from before /reload-plugins.
  on('state.get', (_: any, e: any, next: any) =>
    e.key === 'noted' ? { value: { value: `${SELF}:note:0`, version: 1 } } : next(e),
  )
  const { session } = await world($, on, 50_000, '2026-11-25T08:05:00.000Z', { AGENT_TASK_HUB_NOTE_AT: '0.01' })
  const notes = session.appended().filter((r: any) => JSON.stringify(r).includes('Agent Task Hub: context'))
  expect(notes.length).toBe(0)
})

// ---------- Finished chats, the status line, usage, time left ----------

test('time left comes from the recent steps, pauses left out', async () => {
  const min = 60_000
  // Steps of 4, 6 and 5 minutes, then a 2-hour pause: 5 minutes a step, 3 steps left.
  expect(timeLeft([0, 4 * min, 10 * min, 15 * min, 135 * min], 3)).toBe(15 * min)
  expect(timeLeft([0], 3)).toBe(undefined)
  expect(timeLeft([0, 5 * min], 0)).toBe(undefined)
  expect(usageName('five_hour')).toBe('5h')
  expect(usageName('seven_day')).toBe('week')
  expect(statusSummary([{ isSelf: true, status: 'busy' }])).toBe(undefined)
})

test('a working chat that goes idle is announced as finished', async ($, on) => {
  const { clock, toasts } = await world($, on, 50_000)
  const record = `${CLAUDE}/sessions/5.json`
  const saved = files[record]
  files[record] = saved.replace('"status":"busy"', '"status":"idle"')
  try {
    await $.command.run({ command: 'task-hub' })
    await clock.settle()
    expect(toasts.filter(t => t.includes('Render job: finished')).length).toBe(1)
    // Once only.
    await $.command.run({ command: 'task-hub' })
    await clock.settle()
    expect(toasts.filter(t => t.includes('Render job: finished')).length).toBe(1)
  } finally {
    files[record] = saved
  }
})

test('the status line sums up the other chats', async ($, on) => {
  statusLines.length = 0
  await world($, on, 50_000)
  expect(statusLines[statusLines.length - 1]).toContain('Task hub: 2 waiting \u00b7 1 working')
})

test('usage windows show in the header, yellow from 80%', async ($, on) => {
  rateLimitsNow = [
    { kind: 'five_hour', percentUsed: 42 },
    { kind: 'seven_day', percentUsed: 85 },
  ]
  try {
    await world($, on, 50_000)
    const ui = await $.ui.mount(PANE_AT('desktop'))
    expect((await ui.find({ type: 'Text', text: /^42% of 5h$/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /^85% of week$/ }))?.props.color).toBe('warning')
    await ui.unmount()
  } finally {
    rateLimitsNow = []
  }
})

// ---------- Narrow panes ----------

const PANE_WIDE = (columns: number) => {
  const pane = PANE_AT('desktop')
  return { ...pane, props: { ...pane.props, bodyColumns: columns } }
}

test('a narrow pane drops the labels and puts each chat on two lines', async ($, on) => {
  await world($, on, 50_000)
  const ui = await $.ui.mount(PANE_WIDE(36))
  expect(await ui.find({ type: 'Text', text: /^Project$/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^Step 2\/2$/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^5%$/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^Working$/ })).not.toBe(undefined)
  // What needs a look still shows, on a line of its own.
  expect(await ui.find({ type: 'Text', text: /^Bash is waiting for Allow$/ })).not.toBe(undefined)
  await ui.unmount()
})

test('a very narrow pane gives each chat one line: name and context', async ($, on) => {
  await world($, on, 50_000)
  const ui = await $.ui.mount(PANE_WIDE(22))
  expect(await ui.find({ type: 'Text', text: /^Working$/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^Project$/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^Render job$/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^5%$/ })).not.toBe(undefined)
  await ui.unmount()
})

// ---------- Wake-ups, muted toasts, the compact line ----------

/** Render job goes idle; returns its finished toasts. */
async function renderJobFinishes($: any, clock: any, toasts: string[]) {
  const record = `${CLAUDE}/sessions/5.json`
  const saved = files[record]
  files[record] = saved.replace('"status":"busy"', '"status":"idle"')
  try {
    await $.command.run({ command: 'task-hub' })
    await clock.settle()
  } finally {
    files[record] = saved
  }
  return toasts.filter(t => t.includes('Render job: finished')).length
}

test('a turn a scheduled wake-up started is not announced as finished', async ($, on) => {
  const beacon = `${CLAUDE}/agent-task-hub/render-4444.json`
  // Woken by its schedule after the person last typed in it.
  files[beacon] = JSON.stringify({
    v: 1,
    sessionId: 'render-4444',
    at: Date.parse('2026-11-25T08:04:50.000Z'),
    crons: [{ id: 'c', schedule: '*/10 * * * *', recurring: true, prompt: 'check' }],
    lastPromptMs: Date.parse('2026-11-25T07:00:00.000Z'),
    lastWakeMs: Date.parse('2026-11-25T08:00:00.000Z'),
    wakes: 3,
  })
  try {
    const { clock, toasts } = await world($, on, 50_000)
    expect(await renderJobFinishes($, clock, toasts)).toBe(0)
  } finally {
    delete files[beacon]
  }
})

test('/task-hub quiet on mutes the toasts; the pane still updates', async ($, on) => {
  const { clock, toasts } = await world($, on, 50_000)
  const r = await $.command.run({ command: 'task-hub', args: 'quiet on' } as any)
  expect(JSON.stringify(r)).toContain('toasts are off')
  expect(await renderJobFinishes($, clock, toasts)).toBe(0)
  const back = await $.command.run({ command: 'task-hub', args: 'quiet off' } as any)
  expect(JSON.stringify(back)).toContain('toasts are on again')
})

test('the compact line carries the schedule and background work', async ($, on) => {
  await world($, on, 50_000)
  const ui = await $.ui.mount(PANE_WIDE(40))
  // The Chinese chat runs on a schedule.
  expect(await ui.find({ type: 'Text', text: /^scheduled$/ })).not.toBe(undefined)
  await ui.unmount()
})

test('this chat has a colour of its own', async ($, on) => {
  await world($, on, 50_000)
  const ui = await $.ui.mount(PANE_AT('desktop'))
  expect((await ui.find({ type: 'Text', text: /^This chat$/ }))?.props.color).toBe('merged')
  expect((await ui.find({ type: 'Text', text: /^Working$/ }))?.props.color).toBe('suggestion')
  await ui.unmount()
})

test('this chat stands out in a frame of its own', async ($, on) => {
  await world($, on, 50_000)
  const ui = await $.ui.mount(PANE_AT('desktop'))
  const frames = (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round')
  expect(frames.length).toBe(1)
  expect(frames[0].props.borderColor).toBe('merged')
  expect(frames[0].text).toContain('This chat')
  await ui.unmount()
})
