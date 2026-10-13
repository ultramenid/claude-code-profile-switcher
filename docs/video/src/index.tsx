// The README's docs/fallback.gif: accounts run out, the plugin switches (to API credit
// last), the work goes on, and it comes back once a plan resets.
// npm install && npm run render (npm run studio to preview).
import React from 'react'
import { AbsoluteFill, Composition, interpolate, registerRoot, Series, spring, useCurrentFrame, useVideoConfig } from 'remotion'

// docs/statusline.svg's palette.
const C = {
  bg: '#1e1f22', rule: '#3a3d42', text: '#d4d4d4', strong: '#e6e6e6', subtle: '#7f848e', user: '#2b2d31',
  green: '#98c379', yellow: '#e5c07b', red: '#e06c75', cyan: '#56b6c2', purple: '#c678dd', claude: '#d97757',
}
const FONT = "Menlo, ui-monospace, SFMono-Regular, 'DejaVu Sans Mono', monospace"
const ROW = 26
const KEY = 'API credit · key …WXYZ'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const fade = (f: number, at: number, len = 8) => interpolate(f, [at, at + len], [0, 1], clamp)

type Line = { at: number; text: string; color?: string; isUser?: boolean; isTool?: boolean }
/** What the account row shows from `at`; `p` climbs from its first % to its second over its third, in frames. */
type Account = { at: number; name: string; email: string; p?: [number, number, number]; reset?: string }

type Script = {
  tag: string
  caption: string
  duration: number
  doneAt: number // the spinner stops
  lines: Line[]
  accounts: Account[]
  toasts: { at: number; text: string }[]
  ask?: { at: number; pick: number; question: string; options: string[] } // the first option is picked
}

const GOAL: Script = {
  tag: '/goal',
  caption: 'every account runs out mid-goal → work, then API credit, by itself',
  duration: 330,
  doneAt: 262,
  lines: [
    { at: 8, text: '> /goal all tests pass', isUser: true },
    { at: 30, text: 'Bash(npm test)', isTool: true },
    { at: 44, text: '  ⎿  3 failing', color: C.red },
    { at: 70, text: 'Update(src/parse.ts)', isTool: true },
    { at: 135, text: 'Update(src/lexer.ts)', isTool: true },
    { at: 215, text: 'Bash(npm test)', isTool: true },
    { at: 230, text: '  ⎿  all passing', color: C.green },
    { at: 262, text: '✓ Goal met: all tests pass', color: C.green },
  ],
  accounts: [
    { at: 0, name: 'main', email: 'me@example.com', p: [90, 100, 95], reset: '1h 10m' },
    { at: 108, name: 'work', email: 'w@example.com', p: [95, 100, 62], reset: '2h 40m' },
    { at: 186, name: 'api', email: KEY },
  ],
  toasts: [
    { at: 104, text: 'main is out of usage · switched to work to keep the goal going' },
    { at: 182, text: 'Every account is out of usage · on API credit to keep the goal going' },
  ],
}

const ASK: Script = {
  tag: 'no goal',
  caption: 'main runs out → asks: work, API credit, or stay',
  duration: 300,
  doneAt: 250,
  lines: [
    { at: 8, text: '> split the parser into two modules', isUser: true },
    { at: 34, text: 'Read(src/parse.ts)', isTool: true },
    { at: 48, text: '  ⎿  Read 412 lines', color: C.subtle },
    { at: 174, text: 'Write(src/parse/lexer.ts)', isTool: true },
    { at: 188, text: '  ⎿  Wrote 180 lines', color: C.subtle },
    { at: 212, text: 'Write(src/parse/ast.ts)', isTool: true },
    { at: 226, text: '  ⎿  Wrote 232 lines', color: C.subtle },
  ],
  accounts: [
    { at: 0, name: 'main', email: 'me@example.com', p: [96, 100, 78], reset: '1h 10m' },
    { at: 152, name: 'work', email: 'w@example.com', p: [12, 12, 1], reset: '4h 50m' },
  ],
  toasts: [],
  ask: { at: 84, pick: 140, question: 'main is out of usage. Continue on work, or on API credit (Console key …WXYZ, billed per token)?', options: ['Switch to work', 'Use API credit', 'Stay on main'] },
}

const BACK: Script = {
  tag: 'back',
  caption: 'a plan resets → back from API credit by itself',
  duration: 230,
  doneAt: 175,
  lines: [
    { at: 8, text: '> add a test for the lexer', isUser: true },
    { at: 30, text: 'Write(test/lexer.test.ts)', isTool: true },
    { at: 44, text: '  ⎿  Wrote 64 lines', color: C.subtle },
    { at: 130, text: 'Bash(npm test)', isTool: true },
    { at: 146, text: '  ⎿  all passing', color: C.green },
  ],
  accounts: [
    { at: 0, name: 'api', email: KEY },
    { at: 96, name: 'main', email: 'me@example.com', p: [2, 2, 1], reset: '4h 59m' },
  ],
  toasts: [{ at: 92, text: 'main has usage again · back from API credit' }],
}

/** The plugin's account row: `● work w@example.com │ 5h ▰▱▱▱▱▱▱▱▱▱ 12% ↻ 4h 50m`, or `● api API credit · key …WXYZ`. */
function AccountRow({ a, f }: { a: Account; f: number }) {
  const head = (
    <>
      <span style={{ color: C.green }}>●</span> <b style={{ color: C.strong }}>{a.name}</b> <span style={{ color: C.subtle }}>{a.email}</span>
    </>
  )
  if (!a.p) return <span>{head}</span>
  const p = interpolate(f, [a.at, a.at + a.p[2]], [a.p[0], a.p[1]], clamp)
  const fill = Math.round(p / 10)
  const color = p >= 80 ? C.red : p >= 50 ? C.yellow : C.green
  return (
    <span>
      {head}
      <span style={{ color: C.subtle }}>{' │ '}</span><span style={{ color: C.subtle }}>5h</span> <span style={{ color }}>{'▰'.repeat(fill)}</span>
      <span style={{ color: C.subtle }}>{'▱'.repeat(10 - fill)}</span> <span style={{ color }}>{`${Math.round(p)}%`}</span>
      {' '}<span style={{ color: C.subtle }}>{`↻ ${a.reset}`}</span>
    </span>
  )
}

function Spinner({ f }: { f: number }) {
  const glyph = '·✢✳✶✻✽✻✶✳✢'[Math.floor(f / 3) % 10]
  return <span style={{ color: C.claude }}>{`${glyph} Working… `}<span style={{ color: C.subtle }}>(esc to interrupt)</span></span>
}

/** AskUserQuestion, as the plugin's question draws in place of the prompt. */
function Ask({ f, ask }: { f: number; ask: NonNullable<Script['ask']> }) {
  const { fps } = useVideoConfig()
  const enter = spring({ frame: f - ask.at, fps, config: { damping: 18 } })
  const isPicked = f >= ask.pick
  return (
    <div style={{ position: 'absolute', left: 24, right: 24, top: 232, opacity: Math.min(enter, 1 - fade(f, ask.pick + 8, 6)), transform: `translateY(${(1 - enter) * 12}px)` }}>
      <div style={{ borderTop: `1px solid ${C.rule}`, paddingTop: 10 }}>
        <span style={{ background: C.cyan, color: C.bg, padding: '1px 8px', borderRadius: 3 }}>Usage</span>
      </div>
      <div style={{ color: C.strong, fontWeight: 700, marginTop: 8, whiteSpace: 'normal' }}>{ask.question}</div>
      {ask.options.map((o, i) => i === 0
        ? <div key={o} style={{ color: C.cyan, marginTop: 6, fontWeight: isPicked ? 700 : 400, background: isPicked ? '#263238' : 'transparent' }}>{`❯ 1. ${o}`}</div>
        : <div key={o} style={{ color: C.text }}>{`  ${i + 1}. ${o}`}</div>)}
      <div style={{ color: C.subtle, marginTop: 6, fontSize: 13 }}>Enter to select · ↑/↓ to navigate · Esc to cancel</div>
    </div>
  )
}

/** One notice at a time, right-aligned above the prompt, till the next one or about 4s. */
function Toasts({ f, s }: { f: number; s: Script }) {
  const { fps } = useVideoConfig()
  return (
    <>
      {s.toasts.map((t, i) => {
        const end = Math.min(s.toasts[i + 1]?.at ?? Infinity, t.at + 110)
        if (f < t.at || f >= end) return null
        const enter = spring({ frame: f - t.at, fps, config: { damping: 16 } })
        return (
          <div key={t.at} style={{ position: 'absolute', right: 24, top: 306, opacity: Math.min(enter, 1 - fade(f, end - 10, 10)), transform: `translateX(${(1 - enter) * 30}px)`,
            border: `1px solid ${C.green}`, color: C.green, borderRadius: 6, padding: '3px 10px', fontSize: 14 }}>
            {t.text}
          </div>
        )
      })}
    </>
  )
}

function Scene({ s }: { s: Script }) {
  const f = useCurrentFrame()
  const isAsking = !!s.ask && f >= s.ask.at && f < s.ask.pick + 14
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT, fontSize: 15, whiteSpace: 'pre', opacity: Math.min(fade(f, 0, 8), 1 - fade(f, s.duration - 10, 10)) }}>
      <div style={{ position: 'absolute', left: 24, top: 18, display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ background: C.purple, color: C.bg, padding: '2px 10px', borderRadius: 4, fontWeight: 700 }}>{s.tag}</span>
        <span style={{ color: C.subtle }}>{s.caption}</span>
      </div>

      <div style={{ position: 'absolute', left: 24, right: 24, top: 62 }}>
        {s.lines.filter(l => f >= l.at).map(l => (
          <div key={l.at} style={{ height: ROW, lineHeight: `${ROW}px`, opacity: fade(f, l.at), transform: `translateY(${(1 - fade(f, l.at)) * 6}px)` }}>
            {l.isUser ? <span style={{ background: C.user, color: C.strong, padding: '2px 6px' }}>{l.text}</span>
              : l.isTool ? <span><span style={{ color: C.green }}>⏺ </span><b style={{ color: C.strong }}>{l.text}</b></span>
              : <span style={{ color: l.color ?? C.text }}>{l.text}</span>}
          </div>
        ))}
        {f < s.doneAt && !isAsking ? <div style={{ height: ROW, lineHeight: `${ROW}px` }}><Spinner f={f} /></div> : null}
      </div>

      <Toasts f={f} s={s} />

      {isAsking ? <Ask f={f} ask={s.ask!} /> : (
        <div style={{ position: 'absolute', left: 24, right: 24, top: 346, borderTop: `1px solid ${C.rule}`, borderBottom: `1px solid ${C.rule}`, height: 40, lineHeight: '40px', color: C.text }}>
          {'> '}<span style={{ opacity: Math.floor(f / 15) % 2 ? 0 : 1 }}>█</span>
        </div>
      )}

      <div style={{ position: 'absolute', left: 24, top: 410, height: ROW, lineHeight: `${ROW}px` }}>
        {s.accounts.map((a, i) => {
          const next = s.accounts[i + 1]
          const opacity = (i === 0 ? 1 : fade(f, a.at, 6)) * (next ? 1 - fade(f, next.at, 6) : 1)
          return <div key={a.at} style={{ position: 'absolute', opacity }}><AccountRow a={a} f={f} /></div>
        })}
      </div>
    </AbsoluteFill>
  )
}

const SCENES = [GOAL, ASK, BACK]

function Fallback() {
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Series>
        {SCENES.map(s => <Series.Sequence key={s.tag} durationInFrames={s.duration}><Scene s={s} /></Series.Sequence>)}
      </Series>
    </AbsoluteFill>
  )
}

registerRoot(() => (
  <Composition id="Fallback" component={Fallback} durationInFrames={SCENES.reduce((n, s) => n + s.duration, 0)} fps={30} width={900} height={450} />
))
