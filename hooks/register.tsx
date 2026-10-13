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
// The `api` profile is a Console API key, billed per token: this session alone
// sends it, as ANTHROPIC_API_KEY, after every account is out of usage.
const LIVE = 'Claude Code-credentials'
const SLOT = 'cc-swap-login'
const NAME = /^[\w.-]+$/
const API = 'api'
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
  const rank = (n: string) => (n === 'main' ? 0 : n === API ? 2 : 1) // API credit last: the fallback after the rest
  return [...new Set([...saved, ...pending])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
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

/** When a login's access token expires, in ms; Infinity when it doesn't say. */
const expiry = (creds: string): number => {
  try {
    return JSON.parse(creds).claudeAiOauth?.expiresAt ?? Infinity
  } catch {
    return Infinity
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
    void backFromApi($).catch(() => undefined)
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
  const live = await current($)
  const cur = await active($)
  const all = await names($)
  return Promise.all((all.includes(live) ? all : [live, ...all]).map(async name => {
    if (name === API) return { name, email: await apiLabel($), isActive: name === cur, isPending: false }
    const login = name === live ? await liveLogin($) : await slot($, name)
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
let band: { name: string; email?: string; limits?: Limit[]; cache?: number; isInStatusLine: boolean } | undefined

async function show($: EngineInterface) {
  const name = await active($)
  const cache = hitRate((await $.store.get(`cache:${await $.session.id()}`)) as Cache | undefined)
  const email = name === API ? await apiLabel($) : (await liveLogin($))?.oauthAccount?.emailAddress
  band = { name, email, limits: name === API ? undefined : await limits($, name), cache, isInStatusLine: await statusLinePrints($) }
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
  const top = await Promise.all([$.session.model(), $.session.usage(), $.store.get(`cache:${sid}`)])
    .then(([model, use, cache]) => sessionLine(model, use.context, cache as Cache | undefined))
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

/** The session's input tokens, and how many of them were read from the prompt cache. */
type Cache = { read: number; input: number }
const hitRate = (c?: Cache) => (c?.input ? Math.round((c.read / c.input) * 100) : undefined)

/**
 * ccstatusline's line: model, context used, the prompt cache's hit rate, and a context bar.
 * `@EFFORT@` is the effort segment, which profile-statusline.sh fills from Claude Code's input.
 */
function sessionLine(model: string, ctx: { tokens?: number; window: number; percent?: number }, cache?: Cache) {
  const used = ctx.tokens ?? 0
  const p = ctx.percent ?? Math.round((used / ctx.window) * 100)
  const fill = Math.round((Math.min(p, 100) / 100) * BAR)
  const hit = hitRate(cache)
  return [
    paint('accent', `Model: ${modelName(model)}`) + '@EFFORT@',
    paint(level(p), `Ctx: ${short(used)}`),
    hit !== undefined && paint(level(100 - hit), `Cache: ${hit}%`),
    `${paint(level(p), `Context: ${'█'.repeat(fill)}`)}${paint('subtle', '░'.repeat(BAR - fill))} ${paint(level(p), `${short(used)}/${short(ctx.window)} (${p}%)`)}`,
  ].filter(Boolean).join(paint('subtle', ' | '))
}

// Claude Code's status line runs this: "statusLine": { "type": "command", "command": "sh ~/.claude/profile-statusline.sh" }.
const STATUSLINE = `#!/bin/sh
# Written by the profile plugin: prints the status line it keeps for this session.
in=$(tr -d '\\n')
field() { printf '%s' "$in" | sed -n "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*$2.*/\\1/p"; }
id=$(field session_id '"\\([^"]*\\)"')
effort=$(field effort '{[[:space:]]*"level"[[:space:]]*:[[:space:]]*"\\([a-z0-9]*\\)"')
[ -n "$effort" ] && effort=$(printf '\\033[90m | \\033[0m\\033[35mEffort: %s\\033[0m' "$effort")
sed "s/@EFFORT@/$effort/" "$HOME/.claude/profile-statusline/$id.txt" 2>/dev/null || true
`

/**
 * Makes profile-statusline.sh the status line, once: only where none is set (never over
 * someone's own), and never again after, so removing it keeps it removed.
 */
async function claimStatusLine($: EngineInterface) {
  if ((await $.store.get('statusLineClaimed')) || (await platform($)) === 'win') return
  await $.store.set('statusLineClaimed', true)
  const path = `${await home($)}/.claude/settings.json`
  const settings = await $.fs.read(path).then(JSON.parse).catch(() => undefined) // unreadable: leave it be
  if (!settings || settings.statusLine) return
  settings.statusLine = { type: 'command', command: 'sh ~/.claude/profile-statusline.sh', refreshInterval: 10 }
  await $.fs.write(path, `${JSON.stringify(settings, null, 2)}\n`)
  $.ui.toast('Status line set to the profile plugin\'s: remove "statusLine" from ~/.claude/settings.json to undo')
}

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
  if (name === API) return setupApi($)
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
  if (name === API) return useApi($, false)
  const wasApi = await onApi($)
  const cur = await current($)
  if (name === cur && !wasApi) return `✓ Already on ${name}`
  const login = name === cur ? await liveLogin($) : await slot($, name)
  if (!login) return `! ${name} isn't signed in · /profile add ${name}`
  if (wasApi) await leaveApi($)
  if (name !== cur) {
    await save($, cur)
    await load($, name, login)
    await reconnectRemote($)
  }
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

// The `api` profile: a Console API key, pasted into a pane of the plugin's own so it
// never goes through the prompt or its history, and kept like a login. Only this
// session sends it, so other windows keep the live login and its connectors.
const KEY_PANE = 'profile-api-key'

/** Whether this session bills the `api` profile. */
const onApi = async ($: EngineInterface) => (await $.store.get(`using:${await $.session.id()}`)) === API

/** Where this session's requests go: `api`, or the live login's account. */
const active = async ($: EngineInterface) => ((await onApi($)) ? API : current($))

async function apiKey($: EngineInterface): Promise<string | undefined> {
  return JSON.parse((await readSlot($, API)) ?? '{}').apiKey
}

const apiLabel = async ($: EngineInterface) => `API credit · key …${(await apiKey($))?.slice(-4)}`

async function setupApi($: EngineInterface): Promise<string> {
  await $.ui.open({ id: KEY_PANE, title: 'Console API key', focus: true, closeOnEscape: true, rows: 2 })
  return 'Paste your Console API key (console.anthropic.com → API keys) in the box above the prompt and press Enter · it goes to the plugin alone, not the prompt or its history'
}

/** Enter in the paste box: the key out of whatever was pasted (a bare key, quoted, or `ANTHROPIC_API_KEY=…`). */
async function saveApiKey($: EngineInterface, text: string) {
  const key = /sk-ant-[\w-]+/.exec(text)?.[0]
  if (!key) return $.ui.toast('No Console API key (sk-ant-…) in that · paste it again, or Esc to cancel', { timeoutMs: 6000 })
  await writeSlot($, API, JSON.stringify({ apiKey: key }))
  await $.ui.close({ id: KEY_PANE })
  $.ui.toast(`✓ ${API} saved: Console API key …${key.slice(-4)} · billed only once every account is out of usage`, { timeoutMs: 8000 })
}

/** Claude Code sends an env API key only once approved: its last 20 characters in ~/.claude.json, as its own prompt records them. */
async function approveKey($: EngineInterface, key: string) {
  const path = await configPath($)
  const config = JSON.parse(await $.fs.read(path).catch(() => '{}'))
  const { approved = [], rejected = [] } = config.customApiKeyResponses ?? {}
  const tail = key.slice(-20)
  if (approved.includes(tail)) return
  const customApiKeyResponses = { approved: [...approved, tail], rejected: rejected.filter((r: string) => r !== tail) }
  await $.fs.write(path, `${JSON.stringify({ ...config, customApiKeyResponses }, null, 2)}\n`)
}

/** Which credential Claude Code sends with the next request. */
const sends = ($: EngineInterface) => $.session.authorize().then(a => a?.kind, () => undefined)

/** Bills this session to the `api` profile; `isAuto` when every account ran out, so it comes back by itself. */
async function useApi($: EngineInterface, isAuto: boolean): Promise<string> {
  const key = await apiKey($)
  if (!key) return `! No API credit set up · copy your Console API key, then /profile add ${API}`
  if (await onApi($)) return `✓ Already on ${API}`
  const held = await $.env.get('ANTHROPIC_AUTH_TOKEN')
  await approveKey($, key)
  await $.env.set('ANTHROPIC_AUTH_TOKEN', undefined) // it outranks ANTHROPIC_API_KEY
  await $.env.set('ANTHROPIC_API_KEY', key)
  // Claude Code reads the approval back from ~/.claude.json through a file watcher.
  for (let i = 0; i < 5 && (await sends($)) !== 'api-key'; i++) await $.clock.sleep(300)
  if ((await sends($)) !== 'api-key') {
    await $.env.set('ANTHROPIC_API_KEY', undefined)
    await $.env.set('ANTHROPIC_AUTH_TOKEN', held)
    return `! Claude Code didn't take the key …${key.slice(-4)} · still on ${await current($)}`
  }
  const sid = await $.session.id()
  await $.store.set(`using:${sid}`, API)
  await $.store.set(`apiAuto:${sid}`, isAuto)
  await show($)
  return [
    `✓ Switched to ${API} (${await apiLabel($)})`,
    `This session bills your Console key from your next message; other windows stay on ${await current($)} · /profile <name> to go back`,
  ].join('\n')
}

async function leaveApi($: EngineInterface) {
  await $.env.set('ANTHROPIC_API_KEY', undefined)
  await $.store.delete(`apiAuto:${await $.session.id()}`)
}

/** Back from API credit taken by itself, once an account has usage again. */
async function backFromApi($: EngineInterface) {
  if (!(await $.store.get(`apiAuto:${await $.session.id()}`)) || !(await onApi($))) return
  const { to } = await spare($, await $.clock.now())
  if (!to) return
  await use($, to)
  $.ui.toast(`${to} has usage again · back from API credit`, { timeoutMs: 8000 })
}

/** A window used up and not reset yet. */
const isOut = (list: Limit[] | undefined, now: number) =>
  !!list?.some(l => l.percentUsed >= 100 && (!l.resetsAt || Date.parse(l.resetsAt) > now))

/** The first signed-in account, in list order, with usage left and a token this session can use. */
async function spare($: EngineInterface, now: number, skip?: string): Promise<{ to?: string; expired: string[] }> {
  const live = await current($)
  const expired: string[] = []
  for (const name of await names($)) {
    if (name === skip || name === API || isOut(await limits($, name), now)) continue
    const login = name === live ? await liveLogin($) : await slot($, name)
    // A saved login nothing refreshed for hours holds an expired token: this session can't use it.
    if (login && expiry(login.creds) <= now) expired.push(name)
    else if (login) return { to: name, expired }
  }
  return { expired }
}

/** This session's credentials as they ride in its environment, which every Bash command inherits. */
async function secrets($: EngineInterface): Promise<string[]> {
  const all = [await $.env.get('ANTHROPIC_API_KEY'), await $.env.get('ANTHROPIC_AUTH_TOKEN')]
  return all.filter((s): s is string => !!s && s.length >= 20)
}

/** What this session sends, to tell whether another step switched meanwhile. */
const credential = async ($: EngineInterface) => `${await $.env.get('ANTHROPIC_AUTH_TOKEN')}|${await $.env.get('ANTHROPIC_API_KEY')}`

let failing: Promise<boolean> | undefined // parallel subagents hit the limit together: one switch

/**
 * The live account's plan is used up: switch to a signed-in one whose isn't, else to
 * the `api` profile. By itself while a /goal runs (nobody may be watching), else once
 * the person agrees.
 */
async function failover($: EngineInterface): Promise<boolean> {
  if (await onApi($)) return false // API credit is the last stop
  const now = await $.clock.now()
  const { rateLimits } = await $.session.usage()
  if (!isOut(rateLimits, now)) return false // failed for another reason
  const from = await current($)
  await $.store.set(`limits:${from}`, rateLimits) // so no fallback picks it till it resets
  const { to, expired } = await spare($, now, from)
  const key = await apiKey($)
  if (!to && !key) {
    $.ui.toast(expired.length
      ? `${from} is out of usage · ${expired.join(', ')}: saved login expired, /profile to it and reopen Claude Code to renew it`
      : `${from} is out of usage, and so is every other account`, { timeoutMs: 8000 })
    return false
  }
  // A goal takes the next account, API credit only after the last; asked, either is offered.
  let choice = to ?? API
  const isGoal = await $.store.get(`goal:${await $.session.id()}`)
  if (!isGoal) {
    const credit = `Console key …${key?.slice(-4)}, billed per token`
    const question = !to ? `${from} and every other account are out of usage. Continue on API credit (${credit})?`
      : key ? `${from} is out of usage. Continue on ${to}, or on API credit (${credit})?`
      : `${from} is out of usage. Switch to ${to} and continue?`
    const options = [...(to ? [`Switch to ${to}`] : []), ...(key ? ['Use API credit'] : []), `Stay on ${from}`]
    const answer = await $.ui.ask(question, { header: 'Usage', options }).catch(() => undefined)
    if (answer === 'Use API credit') choice = API
    else if (answer !== `Switch to ${to}`) return false
  }
  // Chosen over an account with usage left, API credit stays till /profile <name>.
  if (choice === API) {
    if (!(await useApi($, !to)).startsWith('✓')) return false
  } else await use($, choice)
  if (isGoal) {
    $.ui.toast(choice !== API ? `${from} is out of usage · switched to ${choice} to keep the goal going` : 'Every account is out of usage · on API credit to keep the goal going', { timeoutMs: 8000 })
  }
  return true
}

async function remove($: EngineInterface, name: string): Promise<string> {
  if (!(await names($)).includes(name)) return '! Usage: /profile remove <name>'
  if ((await current($)) === name || (await active($)) === name) return `! ${name} is the active login · switch away first`
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
    answer = await $.ui.ask(`Switch to which account? (now on ${await active($)})`, { header: 'Account', options: [...labels, ADD] })
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
      argumentHint: '[name | add <name> | add api | remove <name> | list]',
    })
    // The login this process loaded; a reload mid-switch (token set) keeps the first answer.
    const key = `startedOn:${await $.session.id()}`
    if (!(await $.env.get('ANTHROPIC_AUTH_TOKEN')) && !(await $.store.get(key))) await $.store.set(key, await current($))
    $.ui.status(undefined) // versions before 0.2.4 pinned a status line instead of the band
    const h = await home($)
    await $.fs.write(`${h}/.claude/profile-statusline.sh`, STATUSLINE)
    await claimStatusLine($)
    // A file per session: drop the ones nothing has written for a week.
    if ((await platform($)) !== 'win') void $.process.run(['find', `${h}/.claude/profile-statusline`, '-name', '*.txt', '-mtime', '+7', '-delete']).catch(() => undefined)
    await show($)
    await watchLogin($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (e.changed.includes('rateLimits') && e.rateLimits.length && !(await onApi($))) {
      await $.store.set(`limits:${await current($)}`, e.rateLimits)
      await show($)
    } else await writeStatus($) // context or cost
    return r
  })

  // The session's prompt-cache hit rate, for the status line.
  on('turn.complete', async ($, e, next) => {
    if (e.usage) {
      const key = `cache:${await $.session.id()}`
      const u = e.usage
      const was = ((await $.store.get(key)) as Cache | undefined) ?? { read: 0, input: 0 }
      await $.store.set(key, {
        read: was.read + u.cache_read_input_tokens,
        input: was.input + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
      })
      await show($)
    }
    return next(e)
  })

  // Remember that this session uses Remote Control, to reconnect it after a switch.
  on('command.run', { command: 'remote-control' }, async ($, e, next) => {
    await $.store.set(`remote:${await $.session.id()}`, true)
    return next(e)
  })

  // A request refused for a used-up plan ends the turn and pauses a /goal: send it
  // again on another account, or API credit, instead. A changed credential means
  // another step already switched.
  on('turn.step', async function* ($, e, next) {
    for (;;) {
      const held = await credential($)
      const r = yield* next(e)
      if (r.stopReason !== null || next.signal.aborted) return r
      if (held === (await credential($)) && !(await (failing ??= failover($).finally(() => (failing = undefined))))) return r
    }
  })

  // A command that prints the environment (`env`) would put this session's key or
  // token in the transcript: blank them out of what any tool hands back, before the
  // model or the transcript sees it. The command itself is left alone, so permission
  // rules still match it.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const hidden = await secrets($)
    const raw = `${r.text ?? ''}${JSON.stringify(r.result ?? '')}`
    if (!hidden.some(s => raw.includes(s))) return r
    const blank = (t: string) => hidden.reduce((out, s) => out.split(s).join('[redacted]'), t)
    if (r.isError) return { deny: blank(r.text ?? '') }
    return { result: JSON.parse(blank(JSON.stringify(r.result))), context: r.context }
  })

  // ponytail: a goal that ends by itself (met, impossible) is invisible to a plugin, so it
  // counts till /goal clear or /clear; read the transcript's goal entries if that bites.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const arg = e.args.trim()
    const key = `goal:${await $.session.id()}`
    if (arg) await (/^(clear|stop|off|reset|none|cancel)$/i.test(arg) ? $.store.delete(key) : $.store.set(key, true))
    return next(e)
  })

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    await $.store.delete(`goal:${await $.session.id()}`)
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
    await backFromApi($).catch(() => undefined)
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
        {band.cache !== undefined ? (
          <Box gap={1}>
            <Text color="subtle">Cache</Text>
            <Text color={level(100 - band.cache)}>{`${band.cache}%`}</Text>
          </Box>
        ) : null}
      </Box>
    )
  })

  // /profile add api's paste box: the key reaches this plugin alone, never the prompt.
  on('ui.render', { component: 'Pane', requestId: KEY_PANE }, async ($, e) => {
    const { Box, Input, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Input key="api-key" label="Console API key " placeholder="sk-ant-…" submitLabel="save" autoFocus onSubmit={() => undefined} />
        <Text dimColor>Stays out of the prompt and its history · Esc to cancel</Text>
      </Box>
    )
  })

  on('ui.input', { plugin: 'profile', element: 'api-key' }, async ($, e, next) => {
    if (e.kind === 'submit') await saveApiKey($, e.value)
    return next(e)
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
