// The README's docs/fallback.gif: an account runs out, the plugin switches, the work goes on.
// npm install && npm run render (npm run studio to preview).
import React from 'react'
import { AbsoluteFill, Composition, interpolate, registerRoot, Sequence, spring, useCurrentFrame, useVideoConfig } from 'remotion'

// docs/statusline.svg's palette.
const C = {
  bg: '#1e1f22', rule: '#3a3d42', text: '#d4d4d4', strong: '#e6e6e6', subtle: '#7f848e', user: '#2b2d31',
  green: '#98c379', yellow: '#e5c07b', red: '#e06c75', cyan: '#56b6c2', purple: '#c678dd', claude: '#d97757',
}
const FONT = "Menlo, ui-monospace, SFMono-Regular, 'DejaVu Sans Mono', monospace"
const SCENE = 300 // 10s at 30fps
const ROW = 26

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const fade = (f: number, at: number, len = 8) => interpolate(f, [at, at + len], [0, 1], clamp)

type Line = { at: number; text: string; color?: string; isUser?: boolean; isTool?: boolean }

type Script = {
  tag: string
  caption: string
  lines: Line[]
  rise: [number, number, number] // main's 5h window: from %, frame it hits 100, frame the switch lands
  doneAt: number
  toast?: string
  ask?: { at: number; pick: number }
}

const GOAL: Script = {
  tag: '/goal',
  caption: 'main runs out mid-goal → switches by itself, the goal keeps going',
  rise: [92, 110, 128],
  doneAt: 215,
  toast: 'main is out of usage · switched to work to keep the goal going',
  lines: [
    { at: 8, text: '> /goal all tests pass', isUser: true },
    { at: 34, text: 'Bash(npm test)', isTool: true },
    { at: 48, text: '  ⎿  3 failing', color: C.red },
    { at: 74, text: 'Update(src/parse.ts)', isTool: true },
    { at: 88, text: '  ⎿  Updated with 4 additions', color: C.subtle },
    { at: 160, text: 'Bash(npm test)', isTool: true },
    { at: 176, text: '  ⎿  all passing', color: C.green },
    { at: 215, text: '✓ Goal met: all tests pass', color: C.green },
  ],
}

const ASK: Script = {
  tag: 'no goal',
  caption: 'main runs out → asks first, then carries on',
  rise: [96, 78, 152],
  doneAt: 250,
  ask: { at: 84, pick: 140 },
  lines: [
    { at: 8, text: '> split the parser into two modules', isUser: true },
    { at: 34, text: 'Read(src/parse.ts)', isTool: true },
    { at: 48, text: '  ⎿  Read 412 lines', color: C.subtle },
    { at: 174, text: 'Write(src/parse/lexer.ts)', isTool: true },
    { at: 188, text: '  ⎿  Wrote 180 lines', color: C.subtle },
    { at: 212, text: 'Write(src/parse/ast.ts)', isTool: true },
    { at: 226, text: '  ⎿  Wrote 232 lines', color: C.subtle },
  ],
}

/** The plugin's account row: `● work w@example.com   5h █░░░░░░░░░ 12% ↻ 4h 50m`. */
function Account({ name, email, p, reset }: { name: string; email: string; p: number; reset: string }) {
  const fill = Math.round(p / 10)
  const color = p >= 80 ? C.red : p >= 50 ? C.yellow : C.green
  return (
    <span>
      <span style={{ color: C.green }}>●</span> <b style={{ color: C.strong }}>{name}</b> <span style={{ color: C.subtle }}>{email}</span>
      {'   '}<span style={{ color: C.subtle }}>5h</span> <span style={{ color }}>{'█'.repeat(fill)}</span>
      <span style={{ color: C.subtle }}>{'░'.repeat(10 - fill)}</span> <span style={{ color }}>{`${Math.round(p)}%`}</span>
      {' '}<span style={{ color: C.subtle }}>{`↻ ${reset}`}</span>
    </span>
  )
}

function Spinner({ f }: { f: number }) {
  const glyph = '·✢✳✶✻✽✻✶✳✢'[Math.floor(f / 3) % 10]
  return <span style={{ color: C.claude }}>{`${glyph} Working… `}<span style={{ color: C.subtle }}>(esc to interrupt)</span></span>
}

/** AskUserQuestion, as the plugin's question draws in place of the prompt. */
function Ask({ f, at, pick }: { f: number; at: number; pick: number }) {
  const { fps } = useVideoConfig()
  const enter = spring({ frame: f - at, fps, config: { damping: 18 } })
  const isPicked = f >= pick
  return (
    <div style={{ position: 'absolute', left: 24, right: 24, top: 262, opacity: Math.min(enter, 1 - fade(f, pick + 8, 6)), transform: `translateY(${(1 - enter) * 12}px)` }}>
      <div style={{ borderTop: `1px solid ${C.rule}`, paddingTop: 10 }}>
        <span style={{ background: C.cyan, color: C.bg, padding: '1px 8px', borderRadius: 3 }}>Usage</span>
      </div>
      <div style={{ color: C.strong, fontWeight: 700, marginTop: 8 }}>main is out of usage. Switch to work and continue?</div>
      <div style={{ color: C.cyan, marginTop: 6, fontWeight: isPicked ? 700 : 400, background: isPicked ? '#263238' : 'transparent' }}>❯ 1. Switch to work</div>
      <div style={{ color: C.text }}>{'  2. Stay on main'}</div>
      <div style={{ color: C.subtle, marginTop: 6, fontSize: 13 }}>Enter to select · ↑/↓ to navigate · Esc to cancel</div>
    </div>
  )
}

function Scene({ s }: { s: Script }) {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const [from, full, switchAt] = s.rise
  const p = interpolate(f, [0, full], [from, 100], clamp)
  const switched = fade(f, switchAt, 6)
  const isAsking = !!s.ask && f >= s.ask.at && f < s.ask.pick + 14
  const shown = s.lines.filter(l => f >= l.at)
  const toastIn = s.toast ? spring({ frame: f - switchAt + 4, fps, config: { damping: 16 } }) : 0
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT, fontSize: 15, whiteSpace: 'pre', opacity: Math.min(fade(f, 0, 8), 1 - fade(f, SCENE - 10, 10)) }}>
      <div style={{ position: 'absolute', left: 24, top: 18, display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ background: C.purple, color: C.bg, padding: '2px 10px', borderRadius: 4, fontWeight: 700 }}>{s.tag}</span>
        <span style={{ color: C.subtle }}>{s.caption}</span>
      </div>

      <div style={{ position: 'absolute', left: 24, right: 24, top: 62 }}>
        {shown.map(l => (
          <div key={l.at} style={{ height: ROW, lineHeight: `${ROW}px`, opacity: fade(f, l.at), transform: `translateY(${(1 - fade(f, l.at)) * 6}px)` }}>
            {l.isUser ? <span style={{ background: C.user, color: C.strong, padding: '2px 6px' }}>{l.text}</span>
              : l.isTool ? <span><span style={{ color: C.green }}>⏺ </span><b style={{ color: C.strong }}>{l.text}</b></span>
              : <span style={{ color: l.color ?? C.text }}>{l.text}</span>}
          </div>
        ))}
        {f < s.doneAt && !isAsking ? <div style={{ height: ROW, lineHeight: `${ROW}px` }}><Spinner f={f} /></div> : null}
      </div>

      {s.toast && f >= switchAt - 4 ? (
        <div style={{ position: 'absolute', right: 24, top: 306, opacity: Math.min(toastIn, 1 - fade(f, 262, 10)), transform: `translateX(${(1 - toastIn) * 30}px)`,
          border: `1px solid ${C.green}`, color: C.green, borderRadius: 6, padding: '3px 10px', fontSize: 14 }}>
          {s.toast}
        </div>
      ) : null}

      {isAsking ? <Ask f={f} at={s.ask!.at} pick={s.ask!.pick} /> : (
        <div style={{ position: 'absolute', left: 24, right: 24, top: 346, borderTop: `1px solid ${C.rule}`, borderBottom: `1px solid ${C.rule}`, height: 40, lineHeight: '40px', color: C.text }}>
          {'> '}<span style={{ opacity: Math.floor(f / 15) % 2 ? 0 : 1 }}>█</span>
        </div>
      )}

      <div style={{ position: 'absolute', left: 24, top: 410, height: ROW, lineHeight: `${ROW}px` }}>
        <div style={{ position: 'absolute', opacity: 1 - switched }}><Account name="main" email="me@example.com" p={p} reset="1h 10m" /></div>
        <div style={{ position: 'absolute', opacity: switched }}><Account name="work" email="w@example.com" p={12} reset="4h 50m" /></div>
      </div>
    </AbsoluteFill>
  )
}

function Fallback() {
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Sequence durationInFrames={SCENE}><Scene s={GOAL} /></Sequence>
      <Sequence from={SCENE} durationInFrames={SCENE}><Scene s={ASK} /></Sequence>
    </AbsoluteFill>
  )
}

registerRoot(() => <Composition id="Fallback" component={Fallback} durationInFrames={SCENE * 2} fps={30} width={900} height={450} />)
