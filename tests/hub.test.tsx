import { expect, mock, test } from 'claude-code/testing'

import {
  applyPlan,
  base64Bytes,
  cleanTitle,
  findConflicts,
  forecast,
  ingestChunk,
  isInside,
  needsEnglish,
  newTracker,
  projectOf,
  utf8Length,
  verdictLabel,
} from '../hooks/parse'

/** Sample non-English text (a chat name, a plan step, a word), written as escapes. */
const ZH_NAME = '\u7259\u9f7f\u6a21\u578b'
const ZH_STEP = '\u8bfb\u53d6\u53c2\u8003\u56fe'
const ZH_WORD = '\u773c\u775b'
import { describeCron, nextCronMs, parseBeacon, pickAnnouncer, scheduleLine } from '../hooks/beacon'

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

/** Stands in for the engine: a fake config folder, clock and session. */
async function world($: any, on: any, tokens: number, at = '2026-11-25T08:05:00.000Z') {
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
  mock.env(on, { USERPROFILE: 'C:/home/me' })
  mock.store(on)
  on('model.complete', (_, e: any) => {
    if (modelFails) return { value: { isAnswered: false, reason: 'api-error', usage: {} } }
    const asked = Object.keys(TITLES).find(k => String(e.prompt).includes(k))
    return { value: { isAnswered: true, text: asked ? TITLES[asked] : 'Untitled', usage: {} } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF }))
  // The shell moved into a subfolder; the project root is still Github.
  on('session.cwd', () => ({ value: 'C:\\home\\me\\Github\\teeth' }))
  on('session.root', () => ({ value: 'C:\\home\\me\\Github' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, tokens } } }))
  on('fs.list', (_, e: any) => {
    const dir = norm(e.path)
    const names = new Set<string>()
    for (const f of Object.keys(files)) {
      if (f.startsWith(dir + '/')) names.add(f.slice(dir.length + 1).split('/')[0])
    }
    return {
      value: [...names].map(name => ({
        name,
        kind: name.includes('.') ? 'file' : 'directory',
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
    }
  })
  on('fs.exists', (_, e: any) => ({ value: norm(e.path) in files }))
  on('fs.write', (_, e: any) => {
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: TASKLIST, stderr: '' } }))
  on('fs.stat', (_, e: any) => ({
    value: { kind: 'file', size: files[norm(e.path)].length, mtimeMs: Date.parse('2026-11-25T08:00:00.000Z'), isLink: false },
  }))
  on('fs.read', (_, e: any) => {
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
    expect((await ui.find({ type: 'Text', text: /sessions/ }))?.text).toBe('4 sessions · 3 working · 2 waiting · 1 scheduled')
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

test('with openOnStart off, a new chat does not open the pane', { options: { openOnStart: false } }, async ($, on) => {
  let opened = 0
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: true } }
  })
  on('command.register', () => ({ value: { command: 'task-hub' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.clock(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  expect(opened).toBe(0)
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
  let surfaces: string[] = []
  on('session.surfaces', () => ({ value: surfaces }))
  await world($, on, 50_000)
  const mine = () => parseBeacon(files[`${CLAUDE}/agent-task-hub/${SELF}.json`] ?? '')
  expect(mine()?.tokens).toBe(50_000)
  // A run with no window (claude -p) never counts as the chat in front of the person.
  const typedBefore = mine()?.lastPromptMs
  await $.classic.UserPromptSubmit({ prompt: 'hi', source: 'user' } as any)
  expect(mine()?.lastPromptMs).toBe(typedBefore)
  surfaces = ['desktop']
  await $.classic.Stop({
    stop_hook_active: false,
    session_crons: [{ id: 'x', schedule: '0 9 * * *', recurring: true, prompt: 'daily report' }],
    background_tasks: [],
  } as any)
  expect(mine()?.crons.map(c => c.schedule)).toEqual(['0 9 * * *'])
  await $.classic.UserPromptSubmit({ prompt: 'hi', source: 'user' } as any)
  expect(mine()?.lastPromptMs).not.toBe(undefined)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as any)
  expect(mine()?.permission?.tool).toBe('Bash')
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 't' } as any)
  expect(mine()?.permission).toBe(undefined)
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

