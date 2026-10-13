import type { EngineInterface, Register } from 'claude-code'

// Swaps Claude Code's own /login. The live login is the credential Claude Code
// stores (macOS: Keychain entry "Claude Code-credentials"; Linux and Windows:
// ~/.claude/.credentials.json) plus `oauthAccount` in ~/.claude.json. Every account
// keeps a copy of both (macOS: Keychain service cc-swap-login; elsewhere
// ~/.claude/profile-logins/<name>.json, owner-only). Switching saves
// the live login into the current account's copy and loads the target's, so the
// next `claude` starts fully on it: plan usage, email, connectors.
// This session loaded its login at start, so it also gets the target's access
// token as ANTHROPIC_AUTH_TOKEN until it ends.
const LIVE = 'Claude Code-credentials'
const SLOT = 'cc-swap-login'
const NAME = /^[\w.-]+$/
const ADD = 'Add account…'
const FOOTER = '/profile <name> switch · /profile add <name> · /profile remove <name>'

type Login = { creds: string; oauthAccount?: { accountUuid?: string; emailAddress?: string } }
type Row = { name: string; email?: string; usage?: string; isActive: boolean; isPending: boolean }

// Plan usage from the rate-limit headers of each response: whichever account the
// session's requests go to reports its own, even on a switched token.
const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
type Limit = { kind: string; percentUsed: number; resetsAt?: string }

async function limits($: EngineInterface, name: string): Promise<Limit[] | undefined> {
  const l = await $.store.get(`limits:${name}`)
  return Array.isArray(l) ? (l as Limit[]) : undefined
}

async function usage($: EngineInterface, name: string): Promise<string | undefined> {
  return (await limits($, name))?.map(l => `${WINDOWS[l.kind] ?? l.kind} ${Math.round(l.percentUsed)}%`).join(' ')
}

/** `/usage` for a session on a switched token, whose own /usage reads the login it started with. */
async function usagePanel($: EngineInterface, name: string): Promise<string> {
  const email = (await liveLogin($))?.oauthAccount?.emailAddress
  const list = await limits($, name)
  const when = (iso?: string) => (iso ? ` · resets ${new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '')
  const bar = (p: number) => '█'.repeat(Math.round(Math.min(p, 100) / 5)).padEnd(20, '░')
  return [
    `Plan usage · ${name}${email ? ` (${email})` : ''}`,
    ...(list?.length
      ? list.map(l => `${(WINDOWS[l.kind] ?? l.kind).padEnd(3)} ${bar(l.percentUsed)} ${Math.round(l.percentUsed)}%${when(l.resetsAt)}`)
      : ['No reading yet: send a message first.']),
    '',
    'From response headers (this session switched with /profile). Reopen Claude Code for the full /usage.',
  ].join('\n')
}

// Accounts are the saved slots themselves, and the live one is whichever slot
// holds the live login's account: nothing to lose when the plugin's store resets.
const pending = new Set<string>() // added, browser sign-in not finished yet

async function names($: EngineInterface): Promise<string[]> {
  let saved: string[]
  if ((await platform($)) === 'mac') {
    const r = await $.process.run(['sh', '-c', `security dump-keychain | awk '/^keychain:/{a=""} /"acct"<blob>=/{a=$0} /"svce"<blob>="${SLOT}"/{print a}'`]).catch(() => undefined)
    saved = [...(r?.stdout ?? '').matchAll(/"acct"<blob>="([^"]*)"/g)].map(m => m[1]!)
  } else {
    const entries = await $.fs.list(await slotDir($)).catch(() => [])
    saved = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json')).map(f => f.name.slice(0, -5))
  }
  return [...new Set([...saved, ...pending])].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))
}

const sameAccount = (a?: Login['oauthAccount'], b?: Login['oauthAccount']) =>
  !!a && !!b && (a.accountUuid && b.accountUuid ? a.accountUuid === b.accountUuid : a.emailAddress === b.emailAddress)

/** The slot holding the live login's account; a login not saved yet gets a name of its own. */
async function current($: EngineInterface): Promise<string> {
  const live = (await liveLogin($))?.oauthAccount
  const all = await names($)
  for (const name of all) if (sameAccount(live, (await slot($, name))?.oauthAccount)) return name
  if (!all.includes('main')) return 'main'
  const base = live?.emailAddress?.split('@')[0]?.replace(/[^\w.-]/g, '') || 'account'
  let name = base
  for (let i = 2; all.includes(name); i++) name = `${base}${i}`
  return name
}

// Where Claude Code keeps its login differs by OS; everything else is shared.
let os: 'mac' | 'linux' | 'win' | undefined

async function platform($: EngineInterface): Promise<'mac' | 'linux' | 'win'> {
  if (os) return os
  if ((await $.env.get('OS')) === 'Windows_NT') return (os = 'win')
  const r = await $.process.run(['uname']).catch(() => undefined)
  return (os = r?.stdout.trim() === 'Darwin' ? 'mac' : 'linux')
}

async function home($: EngineInterface): Promise<string> {
  return ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '').replace(/\\/g, '/')
}

const credsFile = async ($: EngineInterface) => `${await home($)}/.claude/.credentials.json`
const slotDir = async ($: EngineInterface) => `${await home($)}/.claude/profile-logins`

/** Writes a secret file readable by its owner only (Windows: the profile folder is already). */
async function writeSecret($: EngineInterface, path: string, text: string) {
  const plat = await platform($)
  if (plat === 'linux') await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && umask 077 && : >"$1" && chmod 600 "$1"', 'sh', path])
  if (plat === 'win') await $.process.run(['cmd', '/c', 'mkdir', path.slice(0, path.lastIndexOf('/')).replace(/\//g, '\\')]).catch(() => undefined)
  await $.fs.write(path, text)
}

async function readLive($: EngineInterface): Promise<string | undefined> {
  if ((await platform($)) === 'mac') return getKey($, LIVE)
  return (await $.fs.read(await credsFile($)).catch(() => '')).trim() || undefined
}

async function writeLive($: EngineInterface, creds: string) {
  if ((await platform($)) === 'mac') return setKey($, LIVE, await liveAccount($), creds)
  await writeSecret($, await credsFile($), creds)
}

async function readSlot($: EngineInterface, name: string): Promise<string | undefined> {
  if ((await platform($)) === 'mac') return getKey($, SLOT, name)
  return (await $.fs.read(`${await slotDir($)}/${name}.json`).catch(() => '')).trim() || undefined
}

async function writeSlot($: EngineInterface, name: string, value: string) {
  if ((await platform($)) === 'mac') return setKey($, SLOT, name, value)
  await writeSecret($, `${await slotDir($)}/${name}.json`, value)
}

async function deleteSlot($: EngineInterface, name: string) {
  const plat = await platform($)
  const file = `${await slotDir($)}/${name}.json`
  const argv = plat === 'mac' ? ['security', 'delete-generic-password', '-s', SLOT, '-a', name]
    : plat === 'win' ? ['cmd', '/c', 'del', '/q', file.replace(/\//g, '\\')]
    : ['rm', '-f', file]
  await $.process.run(argv).catch(() => undefined)
}

/** `claude auth login`, detached: it waits on the browser callback, far past a hook's 10s budget. */
async function startLogin($: EngineInterface, log: string) {
  if ((await platform($)) === 'win') {
    const cmd = `/c set "ANTHROPIC_AUTH_TOKEN=" & set "CLAUDE_CONFIG_DIR=" & claude auth login`
    await $.process.run(['powershell', '-NoProfile', '-Command',
      `Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '${cmd}' -RedirectStandardOutput '${log.replace(/'/g, "''")}'`])
    return
  }
  await $.process.run(['sh', '-c', 'nohup env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_AUTH_TOKEN claude auth login >"$1" 2>&1 &', 'sh', log])
}

async function getKey($: EngineInterface, service: string, account?: string): Promise<string | undefined> {
  const r = await $.process.run(['security', 'find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w']).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout.trim() || undefined : undefined
}

/** Writes through `security -i` on stdin, hex-encoded, so the secret never shows in argv. */
async function setKey($: EngineInterface, service: string, account: string, value: string) {
  const hex = Array.from(new TextEncoder().encode(value), b => b.toString(16).padStart(2, '0')).join('')
  await $.process.run(['security', '-i'], { stdin: `add-generic-password -U -s "${service}" -a "${account}" -X ${hex}\n` })
}

/** The account attribute Claude Code filed its entry under, so the swap overwrites that entry. */
async function liveAccount($: EngineInterface): Promise<string> {
  const r = await $.process.run(['security', 'find-generic-password', '-s', LIVE]).catch(() => undefined)
  return /"acct"<blob>="([^"]*)"/.exec(`${r?.stdout}${r?.stderr}`)?.[1] ?? (await $.env.get('USER')) ?? 'claude'
}

const accessToken = (creds: string | undefined): string | undefined => {
  try {
    return JSON.parse(creds ?? '').claudeAiOauth?.accessToken
  } catch {
    return undefined
  }
}

async function configPath($: EngineInterface) {
  return `${await home($)}/.claude.json`
}

async function liveLogin($: EngineInterface): Promise<Login | undefined> {
  const creds = await readLive($)
  if (!creds) return undefined
  const config = JSON.parse(await $.fs.read(await configPath($)).catch(() => '{}'))
  return { creds, oauthAccount: config.oauthAccount }
}

async function slot($: EngineInterface, name: string): Promise<Login | undefined> {
  const raw = await readSlot($, name)
  return raw ? JSON.parse(raw) : undefined
}

/** Copies the live login into `name`'s slot (the token may have refreshed since it was loaded). */
async function save($: EngineInterface, name: string) {
  const live = await liveLogin($)
  if (live) await writeSlot($, name, JSON.stringify(live))
}

/**
 * Claude Code drops Remote Control when the signed-in account changes; reconnect it
 * under the new one when this session had it: /remote-control ran here, a phone is
 * attached, or (terminal only) remoteControlAtStartup turned it on. The desktop app
 * and VS Code have their own auto-connect toggles, which a plugin can't read.
 */
async function reconnectRemote($: EngineInterface) {
  seen = await signedIn($)
  const settings = JSON.parse(await $.fs.read(`${await home($)}/.claude/settings.json`).catch(() => '{}'))
  const surfaces = await $.session.surfaces().catch((): string[] => [])
  const isOn = surfaces.includes('mobile') || (await $.store.get(`remote:${await $.session.id()}`)) === true
    || (settings.remoteControlAtStartup && surfaces.includes('terminal'))
  // From a timer, outside the /profile run: a command can't start inside the one running.
  if (isOn) $.clock.after(500, () => void $.command.run({ command: 'remote-control', args: '' }).catch(() => undefined))
}

/** The live account's id, from ~/.claude.json (cheap enough to poll). */
async function signedIn($: EngineInterface) {
  const config = await $.fs.read(await configPath($)).then(JSON.parse).catch(() => ({}))
  return config.oauthAccount?.accountUuid ?? config.oauthAccount?.emailAddress
}

let seen: string | undefined
/** Another window can switch the login too; follow it so this window's Remote Control reconnects. */
async function watchLogin($: EngineInterface) {
  seen = await signedIn($)
  $.clock.every(5000, () => void (async () => {
    if (pending.size) return // an add briefly swaps the login and puts it back
    if ((await signedIn($)) !== seen) await reconnectRemote($)
  })())
  $.clock.every(60_000, () => {
    $.ui.invalidate('ui.render') // the reset countdowns
    void writeStatus($).catch(() => undefined)
    void syncToken($).catch(() => undefined)
  })
}

/**
 * A switched session holds a copy of the access token, and refreshing it (any window
 * does, near expiry) revokes that copy: take the fresh one from the live login or slot.
 */
async function syncToken($: EngineInterface) {
  const held = await $.env.get('ANTHROPIC_AUTH_TOKEN')
  const name = (await $.store.get(`using:${await $.session.id()}`)) as string | undefined
  if (!held || !name) return
  const login = name === (await current($)) ? await liveLogin($) : await slot($, name)
  const tok = accessToken(login?.creds)
  if (tok && tok !== held) await $.env.set('ANTHROPIC_AUTH_TOKEN', tok)
}

/** Makes `name`'s slot the live login. */
async function load($: EngineInterface, name: string, login: Login) {
  await writeLive($, login.creds)
  const path = await configPath($)
  const config = JSON.parse(await $.fs.read(path).catch(() => '{}'))
  await $.fs.write(path, `${JSON.stringify({ ...config, oauthAccount: login.oauthAccount }, null, 2)}\n`)
}

async function rows($: EngineInterface): Promise<Row[]> {
  const cur = await current($)
  const all = await names($)
  return Promise.all((all.includes(cur) ? all : [cur, ...all]).map(async name => {
    const login = name === cur ? await liveLogin($) : await slot($, name)
    return { name, email: login?.oauthAccount?.emailAddress, usage: await usage($, name), isActive: name === cur, isPending: !login }
  }))
}

// Plain lines the model can read; the CommandOutput hook below draws them in colour.
function listText(list: Row[]): string {
  const w = Math.max(...list.map(r => r.name.length))
  const line = (r: Row) => {
    const detail = [r.email, r.usage, r.isPending && 'sign-in pending', r.isActive && 'active'].filter(Boolean).join(' · ')
    return `${r.isActive ? '●' : '○'} ${r.name.padEnd(w)}  ${detail}`.trimEnd()
  }
  return ['Accounts', ...list.map(line), '', FOOTER].join('\n')
}

// The account and its plan usage: drawn above the prompt by the AbovePrompt hook, and
// written to ~/.claude/profile-status.txt for a status line to print in its place.
let band: { name: string; email?: string; limits?: Limit[]; isInStatusLine: boolean } | undefined

async function show($: EngineInterface) {
  const name = await current($)
  band = { name, email: (await liveLogin($))?.oauthAccount?.emailAddress, limits: await limits($, name), isInStatusLine: await statusLinePrints($) }
  await writeStatus($)
  $.ui.invalidate('ui.render')
}

/** A status line that prints the file (its command names it, or it's ccstatusline and its config does) shows the row itself. */
async function statusLinePrints($: EngineInterface) {
  const h = await home($)
  const settings = await $.fs.read(`${h}/.claude/settings.json`).then(JSON.parse).catch(() => ({}))
  const cmd: string = settings.statusLine?.command ?? ''
  if (cmd.includes('profile-status')) return true
  return cmd.includes('ccstatusline') && (await $.fs.read(`${h}/.config/ccstatusline/settings.json`).catch(() => '')).includes('profile-status')
}

const BAR = 10
const level = (p: number) => (p >= 80 ? 'error' : p >= 50 ? 'warning' : 'success')

/** One bar per plan window: its label, percent used, cells filled, colour and time to reset. */
function meters(list: Limit[] | undefined, now: number) {
  return (list ?? []).map(l => {
    const p = Math.min(Math.round(l.percentUsed), 100)
    return { kind: l.kind, label: WINDOWS[l.kind] ?? l.kind, p, fill: Math.round((p / 100) * BAR), color: level(p), reset: until(l.resetsAt, now) }
  })
}

const ANSI: Record<string, string> = { success: '32', warning: '33', error: '31', subtle: '90', bold: '1', accent: '36' }
const paint = (style: string, text: string) => `\x1b[${ANSI[style]}m${text}\x1b[0m`

// ponytail: every open session rewrites the same small file; a status line can rarely catch it mid-write.
async function writeStatus($: EngineInterface) {
  if (!band) return
  const head = [paint('success', '●'), paint('bold', band.name), band.email && paint('subtle', band.email)]
  const windows = meters(band.limits, await $.clock.now()).map(m => [
    paint('subtle', m.label),
    paint(m.color, '█'.repeat(m.fill)) + paint('subtle', '░'.repeat(BAR - m.fill)),
    paint(m.color, `${m.p}%`),
    m.reset && paint('subtle', `↻ ${m.reset}`),
  ])
  const line = [head, ...windows].map(part => part.filter(Boolean).join(' ')).join('   ')
  const h = await home($)
  await $.fs.write(`${h}/.claude/profile-status.txt`, `${line}\n`)
  // This session's whole status line, which profile-statusline.sh prints.
  const sid = await $.session.id()
  const top = await Promise.all([$.session.model(), $.session.usage(), $.store.get(`tokens:${sid}`)])
    .then(([model, use, total]) => sessionLine(model, use.context, total as number | undefined))
    .catch(() => undefined)
  await $.fs.write(`${h}/.claude/profile-statusline/${sid}.txt`, `${top ? `${top}\n` : ''}${line}\n`)
}

/** `950`, `216.3k`, `1.0M` */
const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`)

/** `claude-opus-5-5` reads `Opus 5.5`; an id of another shape stays as it is. */
function modelName(id: string) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id)
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}

/** What ccstatusline drew: model, context used, the session's tokens, and a context bar. */
function sessionLine(model: string, ctx: { tokens?: number; window: number; percent?: number }, total = 0) {
  const used = ctx.tokens ?? 0
  const p = ctx.percent ?? Math.round((used / ctx.window) * 100)
  const fill = Math.round((Math.min(p, 100) / 100) * BAR)
  return [
    paint('accent', `Model: ${modelName(model)}`),
    paint(level(p), `Ctx: ${short(used)}`),
    paint('accent', `Total: ${short(total)}`),
    `${paint(level(p), `Context: ${'█'.repeat(fill)}`)}${paint('subtle', '░'.repeat(BAR - fill))} ${paint(level(p), `${short(used)}/${short(ctx.window)} (${p}%)`)}`,
  ].join(paint('subtle', ' | '))
}

// Claude Code's status line runs this: "statusLine": { "type": "command", "command": "sh ~/.claude/profile-statusline.sh" }.
const STATUSLINE = `#!/bin/sh
# Written by the profile plugin: prints the status line it keeps for this session.
id=$(tr -d '\\n' | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
cat "$HOME/.claude/profile-statusline/$id.txt" 2>/dev/null || cat "$HOME/.claude/profile-status.txt" 2>/dev/null
`

/** How long until a window resets: `45m`, `2h 5m`, `3d 4h`. */
function until(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`
}

/**
 * `claude auth login` replaces the live login; once it has, copy it into the new
 * account's slot and put the previous account back. Gives up after 10 minutes.
 */
function watchSignIn($: EngineInterface, name: string, prev: string, prevToken: string | undefined) {
  let ticks = 0
  const timer = $.clock.every(3000, () => void (async () => {
    if (++ticks > 200) return (pending.delete(name), timer.cancel())
    const live = await liveLogin($)
    const tok = accessToken(live?.creds)
    if (!live || !tok || tok === prevToken || !live.oauthAccount?.emailAddress) return
    timer.cancel()
    await writeSlot($, name, JSON.stringify(live))
    pending.delete(name)
    const back = await slot($, prev)
    if (back) await load($, prev, back)
    await reconnectRemote($)
    $.ui.toast(`✓ ${name} signed in as ${live.oauthAccount.emailAddress} · /profile ${name} to switch`, { timeoutMs: 8000 })
  })())
}

async function add($: EngineInterface, name: string): Promise<string> {
  if (!NAME.test(name)) return '! Usage: /profile add <name>  (letters, digits, . _ -)'
  if (await slot($, name)) return `! ${name} is already signed in · /profile ${name} to switch, /profile remove ${name} to start over`
  const cur = await current($)
  await save($, cur) // the login is about to replace it
  const prevToken = accessToken((await liveLogin($))?.creds)
  const log = `${await home($)}/.claude/cc-swap-login.log`
  await startLogin($, log)
  pending.add(name)
  watchSignIn($, name, cur, prevToken)
  return [
    `✓ Sign-in for ${name} opened in your browser`,
    `Sign in there as the account you want (a private window avoids reusing your current claude.ai login).`,
    `No browser? The link is in ${log}`,
  ].join('\n')
}

async function use($: EngineInterface, name: string): Promise<string> {
  const cur = await current($)
  if (name === cur) return `✓ Already on ${name}`
  const login = await slot($, name)
  if (!login) return `! ${name} isn't signed in · /profile add ${name}`
  await save($, cur)
  await load($, name, login)
  await reconnectRemote($)
  // Back on the login this session started with: drop the token so usage and email return.
  const startedOn = (await $.store.get(`startedOn:${await $.session.id()}`)) as string | undefined
  await $.env.set('ANTHROPIC_AUTH_TOKEN', name === startedOn ? undefined : accessToken(login.creds))
  const using = `using:${await $.session.id()}`
  await (name === startedOn ? $.store.delete(using) : $.store.set(using, name))
  await show($)
  const email = login.oauthAccount?.emailAddress
  return [
    `✓ Switched to ${name}${email ? ` (${email})` : ''}`,
    `This session uses it from your next message, and its plan usage shows here after that; reopen Claude Code for /usage, email and connectors.`,
  ].join('\n')
}

async function remove($: EngineInterface, name: string): Promise<string> {
  if (!(await names($)).includes(name)) return '! Usage: /profile remove <name>'
  if ((await current($)) === name) return `! ${name} is the active login · switch away first`
  await deleteSlot($, name)
  pending.delete(name)
  return `✓ Removed ${name}`
}

/** `/profile` alone: a picker of the other signed-in accounts; undefined = show the list instead. */
async function pick($: EngineInterface): Promise<string | undefined> {
  const others = (await rows($)).filter(r => !r.isActive && !r.isPending).slice(0, 3)
  if (others.length === 0) return undefined
  const labels = others.map(r => (r.email ? `${r.name} (${r.email})` : r.name))
  let answer: string
  try {
    answer = await $.ui.ask(`Switch to which account? (now on ${await current($)})`, { header: 'Account', options: [...labels, ADD] })
  } catch {
    return undefined // dismissed, or no one to ask (-p)
  }
  const i = labels.indexOf(answer)
  if (i >= 0) return use($, others[i]!.name)
  if (answer === ADD) {
    const name = await $.ui.ask('Name for the new account?', { header: 'Name', options: ['work', 'personal'] }).catch(() => undefined)
    return name ? add($, name.trim()) : undefined
  }
  const typed = answer.trim() // typed under Other: switch to it, or add it
  return (await names($)).includes(typed) ? use($, typed) : add($, typed)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'profile',
      description: 'Switch your Claude login between accounts',
      argumentHint: '[name | add <name> | remove <name> | list]',
    })
    // The login this process loaded; a reload mid-switch (token set) keeps the first answer.
    const key = `startedOn:${await $.session.id()}`
    if (!(await $.env.get('ANTHROPIC_AUTH_TOKEN')) && !(await $.store.get(key))) await $.store.set(key, await current($))
    $.ui.status(undefined) // versions before 0.2.4 pinned a status line instead of the band
    const h = await home($)
    await $.fs.write(`${h}/.claude/profile-statusline.sh`, STATUSLINE)
    // A file per session: drop the ones nothing has written for a week.
    if ((await platform($)) !== 'win') void $.process.run(['find', `${h}/.claude/profile-statusline`, '-name', '*.txt', '-mtime', '+7', '-delete']).catch(() => undefined)
    await show($)
    await watchLogin($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (e.changed.includes('rateLimits') && e.rateLimits.length) {
      await $.store.set(`limits:${await current($)}`, e.rateLimits)
      await show($)
    } else await writeStatus($) // context or cost
    return r
  })

  // The session's running token count, for the status line's Total.
  on('turn.complete', async ($, e, next) => {
    if (e.usage) {
      const key = `tokens:${await $.session.id()}`
      const u = e.usage
      const turn = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await $.store.set(key, (((await $.store.get(key)) as number | undefined) ?? 0) + turn)
    }
    return next(e)
  })

  // Remember that this session uses Remote Control, to reconnect it after a switch.
  on('command.run', { command: 'remote-control' }, async ($, e, next) => {
    await $.store.set(`remote:${await $.session.id()}`, true)
    return next(e)
  })

  on('command.run', { command: 'usage' }, async ($, e, next) => {
    const cur = await current($)
    const startedOn = await $.store.get(`startedOn:${await $.session.id()}`)
    if (!(await $.env.get('ANTHROPIC_AUTH_TOKEN')) || cur === startedOn) return next(e)
    return { text: await usagePanel($, cur) }
  })

  on('command.run', { command: 'profile' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const name = rest.join(' ')

    if (verb === 'add') return { text: await add($, name) }
    if (verb === 'remove') return { text: await remove($, name) }
    if (verb === 'list' || verb === 'status') return { text: listText(await rows($)) }
    if (!verb) return { text: (await pick($)) ?? listText(await rows($)) }
    if ((await names($)).includes(verb)) return { text: await use($, verb) }
    return { text: `! No account ${verb} · /profile add ${NAME.test(verb) ? verb : '<name>'} to sign one in` }
  })

  // Account names and verbs after `/profile `.
  on('prompt.submit', async ($, e, next) => {
    await syncToken($).catch(() => undefined)
    return next(e)
  })

  on('prompt.autocomplete', async ($, e, next) => {
    const m = /^\/profile\s+(?:(remove)\s+)?$/.exec(e.text.slice(0, e.start))
    if (!m) return next(e)
    const verbs = m[1] ? [] : [['add', 'sign in another account'], ['remove', 'forget an account'], ['list', 'show all accounts']]
    const suggestions = [
      ...(await names($)).map(a => ({ text: a, description: 'account' })),
      ...verbs.map(([text, description]) => ({ text: text!, description })),
    ].filter(s => s.text.startsWith(e.token))
    return { suggestions: [...suggestions, ...(await next(e)).suggestions] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A status line shows only in the terminal; the desktop app keeps the row.
    if (!band || (band.isInStatusLine && e.surface === 'terminal') || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const windows = meters(band.limits, await $.clock.now()).map(m => (
      <Box key={m.kind} gap={1}>
        <Text color="subtle">{m.label}</Text>
        <Box>
          <Text color={m.color}>{'█'.repeat(m.fill)}</Text>
          <Text color="subtle">{'░'.repeat(BAR - m.fill)}</Text>
        </Box>
        <Text color={m.color}>{`${m.p}%`}</Text>
        {m.reset ? <Text color="subtle">{`↻ ${m.reset}`}</Text> : null}
      </Box>
    ))
    return (
      <Box gap={3}>
        <Box gap={1}>
          <Text color="success">●</Text>
          <Text bold>{band.name}</Text>
          {band.email && e.props.bodyColumns >= 90 ? <Text color="subtle">{band.email}</Text> : null}
        </Box>
        {windows}
      </Box>
    )
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'profile' } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const draw = (line: string) => {
      const row = /^([●○]) (\S+\s*)(.*)$/.exec(line)
      if (row) {
        const [, mark, name, detail] = row
        return (
          <Box gap={1}>
            <Text color={mark === '●' ? 'success' : 'subtle'}>{mark}</Text>
            <Text bold={mark === '●'}>{name}</Text>
            {detail!.split(' · ').filter(Boolean).map(d => (
              <Text color={d === 'active' ? 'success' : d === 'sign-in pending' ? 'warning' : 'subtle'}>{d}</Text>
            ))}
          </Box>
        )
      }
      if (line === 'Accounts') return <Text bold>Accounts</Text>
      if (line.startsWith('✓')) return <Text color="success">{line}</Text>
      if (line.startsWith('!')) return <Text color="warning">{line.slice(2)}</Text>
      return <Text dimColor>{line || ' '}</Text>
    }
    return <Box flexDirection="column">{e.props.text.split('\n').map(draw)}</Box>
  })
}
