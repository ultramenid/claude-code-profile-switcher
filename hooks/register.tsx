import type { EngineInterface, HttpInit, Register } from 'claude-code'

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
const VERBS = ['add', 'remove', 'list', 'status'] // /profile <verb> can never reach an account named so
const ADD = 'Add account…'
const ADD_SUB = 'Subscription account (Pro, Max, Team)'
const ADD_API = 'API credit (Console key)'
const FOOTER = '/profile <name> switch · /profile add <name> · /profile remove <name>'

type Login = { creds: string; oauthAccount?: { accountUuid?: string; organizationUuid?: string; emailAddress?: string } }
type Row = { name: string; email?: string; usage?: string; isActive: boolean; isPending: boolean }

// Plan usage from the rate-limit headers of each response: whichever account the
// session's requests go to reports its own, even on a switched token.
const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// Each account's reading in a file every window checks every few seconds: kept in $.store, another
// window's reading reached this one's status line at its minute's redraw at best.
const usageFile = async ($: EngineInterface, name: string) => `${await home($)}/.claude/profile-usage/${name}.json`
const keep = async ($: EngineInterface, name: string, list: Limit[] | null) => $.fs.write(await usageFile($, name), JSON.stringify(list))

async function limits($: EngineInterface, name: string): Promise<Limit[] | undefined> {
  // No file yet: the reading a version before 0.4.6 kept in $.store; a mid-write file reads as none.
  const l = await $.fs.read(await usageFile($, name)).then(JSON.parse, () => $.store.get(`limits:${name}`)).catch(() => undefined)
  if (!Array.isArray(l)) return undefined
  const now = await $.clock.now()
  // A window past its reset has started over, though no response has said so yet.
  return (l as Limit[]).map(w => (w.resetsAt && Date.parse(w.resetsAt) <= now ? { kind: w.kind, percentUsed: 0 } : w))
}

// A switched session's own reading can still be the login it started with, so there
// its account's windows come from the plan's usage endpoint (what /usage reads), asked
// with the credential the session sends.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
let usageNext = 0 // the endpoint takes a few reads a minute: once a minute
let usageBackoff = 0 // and none for five minutes after a 429, forced or not
let usageError: string | undefined // why the last read failed, which /usage shows: a row standing still says nothing

/** A fetch raced with a timer: a stalled endpoint would hold up the switch queue behind it. Undefined on failure. */
const fetchSoon = ($: EngineInterface, url: string, init: HttpInit) =>
  Promise.race([$.http.fetch(url, init).catch(() => undefined), $.clock.sleep(10_000).then(() => undefined)])

/** The live credential's windows from the usage endpoint, kept as its account's reading; undefined off a subscription or on failure. */
async function planUsage($: EngineInterface, force = false): Promise<Limit[] | undefined> {
  const now = await $.clock.now()
  if (now < usageBackoff || (!force && now < usageNext)) return undefined
  // A switched session's own token, sent as is: whatever the engine makes of its credentials then, the read is that account's.
  const held = (await using($)) ? await $.env.get('ANTHROPIC_AUTH_TOKEN') : undefined
  const auth = held ? undefined : await $.session.authorize().catch(() => null)
  if (!held && auth?.kind !== 'bearer') return void (usageError = 'no subscription login to read it with')
  usageNext = Math.max(usageNext, now + 60_000)
  try {
    const name = await active($) // whose credential it is: a switch while the read is in flight doesn't relabel it
    const beta = { 'anthropic-beta': 'oauth-2025-04-20' }
    const res = await fetchSoon($, USAGE_URL, held ? { headers: { ...beta, Authorization: `Bearer ${held}` } } : { auth: auth!.handle, headers: beta })
    if (!res) return void (usageError = 'no answer within 10s')
    if (res.status === 429) usageBackoff = now + 300_000
    if (!res.ok) return void (usageError = `HTTP ${res.status}${res.status === 429 ? ', tried again in 5 minutes' : ''}`)
    usageError = undefined
    const body = JSON.parse(res.text)
    const list: Limit[] = Object.keys(WINDOWS).flatMap(kind => {
      const w = body?.[kind]
      return typeof w?.utilization === 'number' ? [{ kind, percentUsed: Math.round(w.utilization * 10) / 10, ...(w.resets_at ? { resetsAt: w.resets_at } : {}) }] : []
    })
    if (list.length) await keep($, name, list)
    // Extra usage keeps an account going past its windows, till its monthly limit (null: none).
    const x = body?.extra_usage
    await $.store.set(`extra:${name}`, x?.is_enabled === true && (x.monthly_limit == null || !(x.used_credits >= x.monthly_limit)))
    return list
  } catch {
    return void (usageError = 'an answer that wasn\'t usage figures')
  }
}

async function usage($: EngineInterface, name: string): Promise<string | undefined> {
  return (await limits($, name))?.map(l => `${WINDOWS[l.kind] ?? l.kind} ${Math.round(l.percentUsed)}%`).join(' ')
}

/** `/usage` for a session on a switched token, whose own /usage reads the login it started with. */
async function usagePanel($: EngineInterface, name: string): Promise<string> {
  const email = (await loginOf($, name))?.oauthAccount?.emailAddress
  const list = await limits($, name)
  const when = (iso?: string) => (iso ? ` · resets ${new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '')
  const bar = (p: number) => '▰'.repeat(Math.round(Math.min(p, 100) / 5)).padEnd(20, '▱')
  return [
    `Plan usage · ${name}${email ? ` (${email})` : ''}`,
    ...(list?.length
      ? list.map(l => `${(WINDOWS[l.kind] ?? l.kind).padEnd(3)} ${bar(l.percentUsed)} ${Math.round(l.percentUsed)}%${when(l.resetsAt)}`)
      : ['No reading yet: send a message first.']),
    ...(usageError ? [`Last read failed: ${usageError}`] : []),
    '',
    'From the plan\'s usage figures, read at most once a minute (this session switched with /profile). Claude Code\'s own /usage is the shared login\'s: /profile back to it to see that one.',
  ].join('\n')
}

// Accounts are the saved slots themselves, and the live one is whichever slot
// holds the live login's account: nothing to lose when the plugin's store resets.
const pending = new Set<string>() // added, browser sign-in not finished yet

async function names($: EngineInterface): Promise<string[]> {
  let saved: string[]
  if ((await platform($)) === 'mac') {
    // A failed read is an error, never "no accounts": a startup reading none would pin the wrong login.
    const r = await $.process.run(['sh', '-c', `out=$(security dump-keychain) || exit 1; printf '%s\\n' "$out" | awk '/^keychain:/{a=""} /"acct"<blob>=/{a=$0} /"svce"<blob>="${SLOT}"/{print a}'`])
    if (r.exitCode !== 0) throw new Error(`Couldn't list the saved accounts in the Keychain (exit ${r.exitCode})`)
    saved = [...r.stdout.matchAll(/"acct"<blob>="([^"]*)"/g)].map(m => m[1]!)
  } else {
    const entries = await $.fs.list(await slotDir($)).catch(() => [])
    saved = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json')).map(f => f.name.slice(0, -5))
  }
  const rank = (n: string) => (n === 'main' ? 0 : n === API ? 2 : 1) // API credit last: the fallback after the rest
  return [...new Set([...saved, ...pending])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

const sameAccount = (a?: Login['oauthAccount'], b?: Login['oauthAccount']) =>
  !!a && !!b && (a.accountUuid && b.accountUuid
    ? a.accountUuid === b.accountUuid && (!a.organizationUuid || !b.organizationUuid || a.organizationUuid === b.organizationUuid)
    : a.emailAddress === b.emailAddress)

/** The slot holding the live login's account; a login not saved yet gets a name of its own. */
async function current($: EngineInterface): Promise<string> {
  const live = (await liveLogin($))?.oauthAccount
  const all = await names($)
  for (const name of all) if (sameAccount(live, (await slot($, name))?.oauthAccount)) return name
  if (!all.includes('main')) return 'main'
  const email = live?.emailAddress?.split('@')[0]?.replace(/[^\w.-]/g, '') || 'account'
  const base = [API, ...VERBS].includes(email) ? `${email}-login` : email
  let name = base
  for (let i = 2; all.includes(name); i++) name = `${base}${i}`
  return name
}

// Where Claude Code keeps its login differs by OS; everything else is shared.
let os: 'mac' | 'linux' | 'win' | undefined

async function platform($: EngineInterface): Promise<'mac' | 'linux' | 'win'> {
  if (os) return os
  if ((await $.env.get('OS')) === 'Windows_NT') return (os = 'win')
  const r = await $.process.run(['uname']) // a failure refuses (and asks again next time), never guesses Linux on a Mac
  return (os = r.stdout.trim() === 'Darwin' ? 'mac' : 'linux')
}

async function home($: EngineInterface): Promise<string> {
  return ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '').replace(/\\/g, '/')
}

const credsFile = async ($: EngineInterface) => `${await home($)}/.claude/.credentials.json`
const slotDir = async ($: EngineInterface) => `${await home($)}/.claude/profile-logins`

/** Writes a secret file readable by its owner only (Windows: the profile folder is already). */
async function writeSecret($: EngineInterface, path: string, text: string) {
  if ((await platform($)) === 'win') {
    await $.process.run(['cmd', '/c', 'mkdir', path.slice(0, path.lastIndexOf('/')).replace(/\//g, '\\')]).catch(() => undefined)
    return $.fs.write(path, text)
  }
  // Owner-only from the first byte, and whole or not at all: a file moved into place, the secret on stdin.
  const r = await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && umask 077 && cat >"$1.$$" && mv -f "$1.$$" "$1"', 'sh', path], { stdin: text })
  if (r.exitCode !== 0) throw new Error(`Writing ${path} failed (exit ${r.exitCode}): nothing changed`)
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

/** Whether the slot is gone (or never was). */
async function deleteSlot($: EngineInterface, name: string): Promise<boolean> {
  const plat = await platform($)
  const file = `${await slotDir($)}/${name}.json`
  const argv = plat === 'mac' ? ['security', 'delete-generic-password', '-s', SLOT, '-a', name]
    : plat === 'win' ? ['cmd', '/c', 'del', '/q', file.replace(/\//g, '\\')]
    : ['rm', '-f', file]
  const r = await $.process.run(argv).catch(() => undefined)
  return !!r && (r.exitCode === 0 || (plat === 'mac' && r.exitCode === 44)) // 44: no such item
}

/**
 * Where `/profile add` signs in: a Claude Code config folder of its own, so `claude auth login` writes
 * its login and account there (on macOS, to a Keychain entry named for the folder), never over the
 * login every window shares.
 */
const addDir = async ($: EngineInterface) => `${await home($)}/.claude/profile-add`

/** The add folder's Keychain entry, as Claude Code names one for a CLAUDE_CONFIG_DIR: its path's sha256. */
async function addService($: EngineInterface): Promise<string> {
  const r = await $.process.run(['sh', '-c', 'printf %s "$1" | shasum -a 256', 'sh', await addDir($)])
  const hash = /^[0-9a-f]{8}/.exec(r.stdout)?.[0]
  if (!hash) throw new Error(`Couldn't name the sign-in's Keychain entry (shasum exit ${r.exitCode})`)
  return `${LIVE}-${hash}`
}

/** The login and account `claude auth login` wrote in the add folder, once both are there. */
async function addedLogin($: EngineInterface): Promise<Login | undefined> {
  const dir = await addDir($)
  const creds = (await platform($)) === 'mac' ? await getKey($, await addService($))
    : (await $.fs.read(`${dir}/.credentials.json`).catch(() => '')).trim() || undefined
  const oauthAccount = (await $.fs.read(`${dir}/.claude.json`).then(JSON.parse).catch(() => ({}))).oauthAccount
  return creds && oauthAccount?.emailAddress && accessToken(creds) ? { creds, oauthAccount } : undefined
}

/** Empties the add folder, and on macOS its Keychain entry. */
async function clearAdd($: EngineInterface) {
  const dir = await addDir($)
  const plat = await platform($)
  if (plat === 'mac') await $.process.run(['security', 'delete-generic-password', '-s', await addService($)]).catch(() => undefined)
  await $.process.run(plat === 'win' ? ['cmd', '/c', 'rmdir', '/s', '/q', dir.replace(/\//g, '\\')] : ['rm', '-rf', dir]).catch(() => undefined)
}

/**
 * `claude auth login` in the add folder, detached: it waits on the browser callback, far past a
 * hook's 10s budget. It stops when the add gives up (10 minutes); its pid, to stop it sooner.
 */
async function startLogin($: EngineInterface, log: string): Promise<string | undefined> {
  const dir = await addDir($)
  if ((await platform($)) === 'win') {
    const cmd = `/c mkdir "${dir.replace(/\//g, '\\')}" & set "ANTHROPIC_AUTH_TOKEN=" & set "CLAUDE_CONFIG_DIR=${dir.replace(/\//g, '\\')}" & claude auth login`
    await $.process.run(['powershell', '-NoProfile', '-Command',
      `Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '${cmd.replace(/'/g, "''")}' -RedirectStandardOutput '${log.replace(/'/g, "''")}'`])
    return
  }
  const r = await $.process.run(['sh', '-c', 'command -v claude >/dev/null || exit 127; (umask 077 && mkdir -p "$2") || exit 1; CLAUDE_CONFIG_DIR="$2" nohup env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY claude auth login >"$1" 2>&1 & p=$!; (sleep 600; ps -p $p -o command= | grep -q "auth login" && kill $p) >/dev/null 2>&1 & echo $p', 'sh', log, dir])
  if (r.exitCode === 127) throw new Error("`claude` isn't on the PATH plugins run with here, so the sign-in can't open · run /profile add from Claude Code in a terminal")
  if (r.exitCode !== 0) throw new Error(`Couldn't make ${dir} for the sign-in (exit ${r.exitCode}) · nothing changed`)
  return /^\d+$/.exec(r.stdout.trim())?.[0]
}

/** Whether `claude auth login` still runs as `pid` (a pid that exited may be another process's by now); unknown reads as running. */
async function loginRunning($: EngineInterface, pid: string | undefined): Promise<boolean> {
  if (!pid) return true
  const r = await $.process.run(['ps', '-p', pid, '-o', 'command=']).catch(() => undefined)
  return !r || r.stdout.includes('auth login')
}

async function getKey($: EngineInterface, service: string, account?: string): Promise<string | undefined> {
  const r = await $.process.run(['security', 'find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w'])
  // Locked, or no prompt allowed: an error, never "not signed in", which a startup would pin as the wrong login.
  if (r.exitCode !== 0 && r.exitCode !== 44) throw new Error(`Couldn't read the Keychain (security exit ${r.exitCode})`)
  const out = r.exitCode === 0 ? r.stdout.trim() : ''
  // security -w prints a password with any non-ASCII byte (a name like Zoë) as hex; JSON never reads as hex
  return (/^(?:[0-9a-f]{2})+$/i.test(out) ? new TextDecoder().decode(Uint8Array.from(out.match(/../g)!, h => parseInt(h, 16))) : out) || undefined
}

/** Writes through `security -i` on stdin, hex-encoded, so the secret never shows in argv. */
async function setKey($: EngineInterface, service: string, account: string, value: string) {
  const hex = Array.from(new TextEncoder().encode(value), b => b.toString(16).padStart(2, '0')).join('')
  const line = `add-generic-password -U -s "${service}" -a "${account}" -X ${hex}\n`
  // security -i reads lines of up to 4095 bytes and runs what fits: a longer one would store a cut-off login.
  if (line.length > 4000) throw new Error(`A ${value.length}-byte login is too large for a Keychain write on stdin (MCP servers' sign-ins share Claude Code's entry): nothing changed`)
  const r = await $.process.run(['security', '-i'], { stdin: line })
  if (r.exitCode !== 0) throw new Error(`The Keychain write failed (security exit ${r.exitCode}): nothing changed`)
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
  try {
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined // cut off: not signed in, and /profile remove takes it out
  }
}

/** `name`'s login: the live one when it's the live account, else its slot. */
async function loginOf($: EngineInterface, name: string): Promise<Login | undefined> {
  return name === (await current($)) ? liveLogin($) : slot($, name)
}

/**
 * A login's own part of Claude Code's credential, as a slot keeps it: the rest (MCP
 * servers' sign-ins) stays with whichever login is live, so a switch never rolls it back.
 */
const own = (login: Login): Login => ({ ...login, creds: JSON.stringify({ claudeAiOauth: JSON.parse(login.creds).claudeAiOauth }) })

/**
 * Copies the live login into `name`'s slot (the token may have refreshed since it was
 * loaded), never over another account's: another window may have switched meanwhile.
 */
async function save($: EngineInterface, name: string) {
  const live = await liveLogin($)
  const saved = await slot($, name)
  // No account on it (~/.claude.json unreadable): nothing to tell it by later, so nothing to save.
  if (!live?.oauthAccount || (saved && !sameAccount(live.oauthAccount, saved.oauthAccount))) return
  // Another account's own token under this account's name: a switch caught between its two writes.
  const tok = accessToken(live.creds)
  for (const other of await names($)) if (tok && other !== name && other !== API && accessToken((await slot($, other))?.creds) === tok) return
  await writeSlot($, name, JSON.stringify(own(live)))
}

// Claude Code's own token endpoint and client: a session sent a token through ANTHROPIC_AUTH_TOKEN never renews it.
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/**
 * Whether `name`'s login needs renewing before it's sent: a saved copy 5 minutes ahead, as Claude Code
 * renews its own; the live login only once expired, since windows sending it renew it first.
 */
async function isDue($: EngineInterface, name: string, login: Login) {
  const now = await $.clock.now()
  const at = expiry(login.creds)
  return at <= now + 300_000 && (at <= now || name !== (await current($)))
}

/**
 * Runs `f` holding Claude Code's own refresh lock, the directory proper-lockfile takes (a minute
 * untouched is a crashed holder's): no other window, nor Claude Code itself, spends the same refresh
 * token meanwhile, and Claude Code, once it has the lock, reads back what `f` wrote. Undefined when
 * it stays held 15 seconds.
 */
async function locked<T>($: EngineInterface, f: () => Promise<T>): Promise<T | undefined> {
  const dir = `${await home($)}/.claude/.oauth_refresh.lock`
  // ponytail: no stale-lock check on Windows; a crashed holder's lock there blocks renewals till it's deleted.
  const isWin = (await platform($)) === 'win'
  const take = isWin ? ['cmd', '/c', 'mkdir', dir.replace(/\//g, '\\')]
    : ['sh', '-c', 'mkdir "$1" 2>/dev/null || { [ -n "$(find "$1" -maxdepth 0 -mmin +1)" ] && rmdir "$1" && mkdir "$1"; }', 'sh', dir]
  for (let i = 0; i < 30; i++) {
    if ((await $.process.run(take).catch(() => undefined))?.exitCode === 0) {
      try {
        return await f()
      } finally {
        await $.process.run(isWin ? ['cmd', '/c', 'rmdir', dir.replace(/\//g, '\\')] : ['rmdir', dir]).catch(() => undefined)
      }
    }
    await $.clock.sleep(500)
  }
  return undefined
}

/**
 * `name`'s login, its access token renewed when due and written back where it came from; undefined
 * when due but it can't be (no refresh token, refused, the lock held throughout).
 */
async function renew($: EngineInterface, name: string, login: Login): Promise<Login | undefined> {
  if (!(await isDue($, name, login))) return login
  return locked($, async () => {
    // Again under the lock: whoever held it may have just renewed this one, and its refresh token is spent.
    const cur = (await loginOf($, name)) ?? login
    if (!(await isDue($, name, cur))) return cur
    const old = JSON.parse(cur.creds).claudeAiOauth ?? {}
    if (!old.refreshToken) return undefined
    const now = await $.clock.now()
    const res = await fetchSoon($, TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: old.refreshToken, client_id: CLIENT_ID, ...(old.scopes?.length ? { scope: old.scopes.join(' ') } : {}) }),
    })
    if (!res?.ok) return undefined
    const body = JSON.parse(res.text)
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') return undefined
    const claudeAiOauth = { ...old, accessToken: body.access_token, refreshToken: body.refresh_token ?? old.refreshToken, expiresAt: now + body.expires_in * 1000 }
    // Back wherever the old copy still is, the live login and the slot alike: no copy keeps a spent refresh token.
    const live = await readLive($)
    if (accessToken(live) === old.accessToken) await writeLive($, JSON.stringify({ ...JSON.parse(live!), claudeAiOauth }))
    const saved = await slot($, name)
    if (saved && accessToken(saved.creds) === old.accessToken) await writeSlot($, name, JSON.stringify({ ...saved, creds: JSON.stringify({ claudeAiOauth }) }))
    return { ...cur, creds: JSON.stringify({ ...JSON.parse(cur.creds), claudeAiOauth }) }
  })
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
  const isOn = surfaces.includes('mobile') || (await $.env.get('CLAUDE_PROFILE_REMOTE')) === '1'
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
    const id = await signedIn($)
    if (id === undefined) return // unreadable for a moment (mid-write), or signed out: nothing to reconnect
    if (id !== seen) await reconnectRemote($)
  })())
  // Another window's reading of this account, on the status line within seconds rather than at the next minute.
  $.clock.every(5000, () => void (async () => {
    if (!band || band.name === API) return
    const l = await limits($, band.name)
    if (!l || JSON.stringify(l) === JSON.stringify(band.limits)) return // unreadable (mid-write), or nothing new
    band = { ...band, limits: l }
    await writeStatus($)
    $.ui.invalidate('ui.render')
  })().catch(() => undefined))
  $.clock.every(60_000, () => {
    void (async () => {
      await syncToken($).catch(() => undefined) // first: the plan below is read with a token renewed here
      const name = await using($)
      if (name && name !== API) await planUsage($) // a switched session's reading: no response brings it while idle or mid-turn
      await show($) // what other windows stored meanwhile, and the reset countdowns
    })().catch(() => undefined)
    void backFromApi($).catch(() => undefined)
    void keepShared($).catch(() => undefined)
  })
}

/**
 * Claude Code renews the shared login, spending the refresh key its account's saved copy holds: copy
 * it there, under the refresh lock so no renewal is caught halfway, or a /login that replaces it
 * leaves that account's saved login dead.
 */
async function keepShared($: EngineInterface) {
  const name = await current($)
  if ((await names($)).includes(name)) await locked($, () => save($, name))
}

/**
 * A switched session holds a copy of the access token, and refreshing it (any window
 * does, near expiry) revokes that copy: take the fresh one from the live login or slot,
 * renewing it here once due, since nothing renews a token sent as ANTHROPIC_AUTH_TOKEN.
 */
async function syncToken($: EngineInterface) {
  const held = await $.env.get('ANTHROPIC_AUTH_TOKEN')
  const name = await using($)
  if (!held || !name || name === API) return
  const login = await loginOf($, name)
  const tok = accessToken((login && (await renew($, name, login)))?.creds)
  // A switch meanwhile set (or dropped) its own token: never put this one back over it.
  if (tok && tok !== held && (await $.env.get('ANTHROPIC_AUTH_TOKEN')) === held && (await using($)) === name) await $.env.set('ANTHROPIC_AUTH_TOKEN', tok)
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
  try {
    const name = await active($)
    const cache = hitRate((await $.store.get(`cache:${await $.session.id()}`)) as Cache | undefined)
    const email = name === API ? await apiLabel($) : (await loginOf($, name))?.oauthAccount?.emailAddress
    band = { name, email, limits: name === API ? undefined : await limits($, name), cache, isInStatusLine: await statusLinePrints($) }
    await writeStatus($)
    $.ui.invalidate('ui.render')
  } catch {
    // The Keychain or ~/.claude.json unreadable for a moment: the last row stands.
  }
}

/**
 * A status line that prints the file (its command names it, or it's ccstatusline and its config does) shows the row itself.
 * The one in force is the most specific set: the project's local settings, then the project's, then the user's.
 */
async function statusLinePrints($: EngineInterface) {
  const h = await home($)
  const root = await $.session.root().catch(() => undefined) // where Claude Code reads project settings: not moved by a shell cd
  const paths = [root && `${root}/.claude/settings.local.json`, root && `${root}/.claude/settings.json`, `${h}/.claude/settings.json`]
  const lines = await Promise.all(paths.map(p => (p ? $.fs.read(p).then(s => JSON.parse(s).statusLine).catch(() => undefined) : undefined)))
  const cmd: string = lines.find(Boolean)?.command ?? ''
  if (cmd.includes('profile-status')) return true
  return cmd.includes('ccstatusline') && (await $.fs.read(`${h}/.config/ccstatusline/settings.json`).catch(() => '')).includes('profile-status')
}

const BAR = 10
const level = (p: number) => (p >= 80 ? 'error' : p >= 50 ? 'warning' : 'success')

/** One bar per plan window: its label, percent used, cells filled, colour and time to reset. */
function meters(list: Limit[] | undefined, now: number) {
  const order = (kind: string) => (Object.keys(WINDOWS).indexOf(kind) + 1 || 99)
  return [...(list ?? [])].sort((a, b) => order(a.kind) - order(b.kind)).map(l => {
    const p = Math.min(Math.round(l.percentUsed), 100)
    const at = l.resetsAt ? Math.round(Date.parse(l.resetsAt) / 1000) : NaN
    return { kind: l.kind, label: WINDOWS[l.kind] ?? l.kind, p, fill: Math.round((p / 100) * BAR), color: level(p), reset: until(l.resetsAt, now), at }
  })
}

const ANSI: Record<string, string> = { success: '32', warning: '33', error: '31', subtle: '90', bold: '1', accent: '36' }
const paint = (style: string, text: string) => `\x1b[${ANSI[style]}m${text}\x1b[0m`

let compacted: { sid: string; tokens: number } | undefined // the size after this conversation's last compaction, till the engine measures again

// ponytail: every open session rewrites the same small file; a status line can rarely catch it mid-write.
async function writeStatus($: EngineInterface) {
  if (!band) return
  const head = [paint('success', '●'), paint('bold', band.name), band.email && paint('subtle', band.email)]
  const all = meters(band.limits, await $.clock.now())
  // `@R<epoch seconds>@`: a countdown profile-statusline.sh works out each time it prints, so it's never behind.
  const row = (isLive: boolean) => [head, ...all.map(m => [
    paint('subtle', m.label),
    paint(m.color, '▰'.repeat(m.fill)) + paint('subtle', '▱'.repeat(BAR - m.fill)),
    paint(m.color, `${m.p}%`),
    m.reset && paint('subtle', `↻ ${isLive && Number.isFinite(m.at) ? `@R${m.at}@` : m.reset}`),
  ])].map(part => part.filter(Boolean).join(' ')).join(paint('subtle', ' │ '))
  const h = await home($)
  await $.fs.write(`${h}/.claude/profile-status.txt`, `${row(false)}\n`)
  // This session's whole status line, which profile-statusline.sh prints.
  const sid = await $.session.id()
  const top = await Promise.all([$.session.model(), $.session.usage(), $.store.get(`cache:${sid}`)])
    .then(([model, u, cache]) => sessionLine(model, compacted?.sid === sid ? { window: u.context.window, tokens: compacted.tokens } : u.context, cache as Cache | undefined))
    .catch(() => undefined)
  const path = `${h}/.claude/profile-statusline/${sid}`
  await $.fs.write(`${path}.txt`, `${top ? `${top}\n` : ''}${row(false)}\n`) // what the script before 0.4.4 prints: another window may have written that one
  await $.fs.write(`${path}.live.txt`, `${top ? `${top}\n` : ''}${row(true)}\n`)
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
let counting: Promise<unknown> = Promise.resolve() // turn.complete's adds to `cache:<sid>`, one at a time

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
    `${paint(level(p), `Context: ${'▰'.repeat(fill)}`)}${paint('subtle', '▱'.repeat(BAR - fill))} ${paint(level(p), `${short(used)}/${short(ctx.window)} (${p}%)`)}`,
  ].filter(Boolean).join(paint('subtle', ' | '))
}

// Claude Code's status line runs this: "statusLine": { "type": "command", "command": "sh ~/.claude/profile-statusline.sh" }.
const STATUSLINE_COMMAND = 'sh ~/.claude/profile-statusline.sh'
const STATUSLINE = `#!/bin/sh
# Written by the profile plugin: prints the status line it keeps for this session.
in=$(tr -d '\\n')
field() { printf '%s' "$in" | sed -n "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*$2.*/\\1/p"; }
id=$(field session_id '"\\([^"]*\\)"')
effort=$(field effort '{[[:space:]]*"level"[[:space:]]*:[[:space:]]*"\\([a-z0-9]*\\)"')
[ -n "$effort" ] && effort=$(printf '\\033[90m | \\033[0m\\033[35mEffort: %s\\033[0m' "$effort")
f="$HOME/.claude/profile-statusline/$id"
# .live.txt has countdowns worked out below; a plugin before 0.4.5 (another window's, say) writes .txt alone
if [ -f "$f.live.txt" ] && [ ! "$f.txt" -nt "$f.live.txt" ]; then f="$f.live.txt"; else f="$f.txt"; fi
# @EFFORT@ from the input above; @R<epoch seconds>@ as the time till then: 45m, 2h 5m, 3d 4h
fill() {
  awk -v now="$(date +%s)" -v effort="$effort" '{
    gsub(/@EFFORT@/, effort)
    while (match($0, /@R[0-9]+@/)) {
      m = (substr($0, RSTART + 2, RLENGTH - 3) - now) / 60; m = m > 0 ? int(m + 0.5) : 0
      d = int(m / 1440); h = int((m % 1440) / 60)
      $0 = substr($0, 1, RSTART - 1) (d ? d "d " h "h" : h ? h "h " m % 60 "m" : m "m") substr($0, RSTART + RLENGTH)
    }
    print
  }'
}
# row: this session's account row alone, for a status line of your own (ccstatusline's Custom Command)
{ if [ "$1" = row ]; then tail -n 1 "$f"; else cat "$f"; fi; } 2>/dev/null | fill || true
`

/**
 * Makes profile-statusline.sh the status line, once: only where none is set (never over
 * someone's own), and never again after, so removing it keeps it removed.
 */
async function claimStatusLine($: EngineInterface) {
  if ((await platform($)) === 'win') return
  const path = `${await home($)}/.claude/settings.json`
  const settings = await $.fs.read(path).then(JSON.parse).catch(() => undefined) // unreadable: leave it be, look again next time
  if (!settings) return
  // Claude Code runs it as a response lands, often before the plugin has written that response's
  // figures: once a second catches them. 10, the interval before 0.4.4, left them up to 10s behind.
  if (settings.statusLine?.command === STATUSLINE_COMMAND && settings.statusLine.refreshInterval === 10) {
    settings.statusLine.refreshInterval = 1
    await $.fs.write(path, `${JSON.stringify(settings, null, 2)}\n`)
  }
  if (await $.store.get('statusLineClaimed')) return
  await $.store.set('statusLineClaimed', true)
  if (settings.statusLine) return
  settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND, refreshInterval: 1 }
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

// The add in progress, in a file every window reads (it outlives a plugin reload); `{}` once over.
type Adding = { name: string; until: number; pid?: string }
const addingFile = async ($: EngineInterface) => `${await home($)}/.claude/profile-adding.json`
const marker = async ($: EngineInterface): Promise<Adding | undefined> => $.fs.read(await addingFile($)).then(JSON.parse).catch(() => undefined)

/** The add any window has in progress, till it gives up. */
async function adding($: EngineInterface): Promise<Adding | undefined> {
  const m = await marker($)
  return m && m.until > (await $.clock.now()) ? m : undefined
}

/** Ends this process's add, for every window, and drops what its sign-in left in the add folder. */
async function endAdd($: EngineInterface) {
  await $.fs.write(await addingFile($), '{}')
  await $.env.set('CLAUDE_PROFILE_ADDING', undefined)
  await clearAdd($)
}

/**
 * `claude auth login` writes the new account's login in the add folder; once it's there whole,
 * save it under the new name. Gives up after 10 minutes, or once the add is no longer marked (removed).
 */
function watchSignIn($: EngineInterface, name: string) {
  let isBusy = false
  const end = async (toast: string) => {
    timer.cancel()
    pending.delete(name)
    await endAdd($)
    $.ui.toast(toast, { timeoutMs: 8000 })
  }
  const timer = $.clock.every(3000, () => void (async () => {
    if (isBusy) return
    isBusy = true
    try {
      const m = await marker($)
      if (m?.name !== name) {
        pending.delete(name)
        return timer.cancel() // removed
      }
      if (m.until <= (await $.clock.now())) return end(`No new sign-in for ${name} in 10 minutes · /profile add ${name} to try again`)
      // The credential lands first, the account seconds later, and the sign-in exits once both have.
      const login = await addedLogin($)
      if (!login || (m.pid && (await loginRunning($, m.pid)))) return
      // An account saved under another name already, the one you're on among them: one name each.
      let dup: string | undefined
      for (const other of await names($)) if (other !== name && other !== API && sameAccount(login.oauthAccount, (await slot($, other))?.oauthAccount)) dup = other
      if (!dup) await writeSlot($, name, JSON.stringify(own(login)))
      await end(dup
        ? `That sign-in is ${dup}'s account, so ${name} wasn't saved · /profile add ${name} and sign in as another account (a private window helps)`
        : `✓ ${name} signed in as ${login.oauthAccount!.emailAddress} · /profile ${name} to switch`)
    } catch {
      // A locked Keychain, a half-written file, a failed write: the next tick tries again.
    } finally {
      isBusy = false
    }
  })())
}

async function add($: EngineInterface, name: string): Promise<string> {
  if (name === API) return setupApi($)
  if (!NAME.test(name) || VERBS.includes(name)) return `! Usage: /profile add <name>  (letters, digits, . _ -; not ${VERBS.join(', ')})`
  const busy = await adding($) // in any window
  if (busy) return `! The sign-in for ${busy.name} isn't finished · finish it first, or wait for it to give up`
  if (await slot($, name)) return `! ${name} is already signed in · /profile ${name} to switch, /profile remove ${name} to start over`
  const cur = await current($)
  if (name === cur) return `! ${name} is the login you're on · pick another name for the new account`
  await save($, cur) // the account you're on, listed by name from now on, and told apart from the sign-in
  await clearAdd($) // what an add given up on left behind
  const log = `${await home($)}/.claude/cc-swap-login.log`
  const pid = await startLogin($, log)
  await $.fs.write(await addingFile($), JSON.stringify({ name, until: (await $.clock.now()) + 600_000, pid }))
  await $.env.set('CLAUDE_PROFILE_ADDING', name) // this process's: a reload watches it again
  pending.add(name)
  watchSignIn($, name)
  return [
    `✓ Sign-in for ${name} opened in your browser`,
    `Sign in there as the account you want (a private window avoids reusing your current claude.ai login).`,
    `No browser? The link is in ${log}`,
  ].join('\n')
}

let switching: Promise<unknown> = Promise.resolve()

/** One switch at a time in this window (a timer, a prompt, a failover): each reads the state the last left. */
function serial<T>(f: () => Promise<T>): Promise<T> {
  const run = switching.then(f)
  switching = run.catch(() => undefined)
  return run
}

const use = ($: EngineInterface, name: string) => serial(() => (name === API ? switchToApi($, false) : switchTo($, name)))
const useApi = ($: EngineInterface, isAuto: boolean) => serial(() => switchToApi($, isAuto))

async function switchTo($: EngineInterface, name: string): Promise<string> {
  if (await isDesktop($)) return DESKTOP
  const wasApi = await onApi($)
  if (name === (await active($))) return `✓ Already on ${name}`
  // The shared login, every window's, stays as it is: a switch is this session's token alone.
  const cur = await current($)
  const saved = name === cur ? await liveLogin($) : await slot($, name)
  if (!saved) return `! ${name} isn't signed in · /profile add ${name}`
  // Back on the shared login: drop the token, so its own usage and email return; Claude Code renews that one itself.
  const isShared = name === cur
  // A saved copy nothing used for hours has expired: renewed before it's sent, never handed over dead.
  const login = isShared ? saved : await renew($, name, saved)
  if (!login) return `! ${name}'s saved login has expired and couldn't be renewed · /profile remove ${name}, then /profile add ${name}`
  if (wasApi) await leaveApi($)
  await $.env.set('ANTHROPIC_AUTH_TOKEN', isShared ? undefined : accessToken(login.creds))
  await $.env.set('CLAUDE_PROFILE_USING', isShared ? undefined : name)
  await show($) // the new name now: the usage read below can take seconds
  await planUsage($, true)
  await show($)
  const email = login.oauthAccount?.emailAddress
  return [
    `✓ Switched to ${name}${email ? ` (${email})` : ''}`,
    `Only this session moves, from your next message: other windows keep theirs, and a new one opens on ${cur}.`,
  ].join('\n')
}

// The `api` profile: a Console API key, pasted into a pane of the plugin's own so it
// never goes through the prompt or its history, and kept like a login. Only this
// session sends it, so other windows keep the live login and its connectors.
const KEY_PANE = 'profile-api-key'

// What this process switched to, and a desktop session's own account, live in its environment like
// the token they go with: a /clear (a new session id) keeps them, a resume (a new process) starts over.
const using = ($: EngineInterface) => $.env.get('CLAUDE_PROFILE_USING')
const startedOn = ($: EngineInterface) => $.env.get('CLAUDE_PROFILE_STARTED_ON')

// The desktop app signs each of its sessions in with its own account, and Claude Code there sends
// that whatever ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY say: no switch can move such a session.
const isDesktop = async ($: EngineInterface) => (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
const DESKTOP = "! A desktop app session always uses the app's own account: Claude Code there ignores another login or an API key · switch accounts in the app, or run /profile in claude in a terminal"

/** The desktop app's account: its saved name, else its email. */
async function desktopAccount($: EngineInterface): Promise<string> {
  const account = { accountUuid: await $.env.get('CLAUDE_CODE_ACCOUNT_UUID'), emailAddress: await $.env.get('CLAUDE_CODE_USER_EMAIL') }
  try {
    for (const name of await names($)) if (name !== API && sameAccount(account, (await slot($, name))?.oauthAccount)) return name
  } catch {
    // the Keychain unreadable for a moment: the email stands in
  }
  return account.emailAddress ?? 'desktop'
}

/** Whether this session bills the `api` profile. */
const onApi = async ($: EngineInterface) => (await using($)) === API

/**
 * Where this session's requests go: what it switched to, else the shared login, which Claude Code reads
 * again as its token nears expiry, whatever it loaded (a desktop session: the app's account).
 */
const active = async ($: EngineInterface) => (await using($)) ?? (await startedOn($)) ?? current($)

async function apiKey($: EngineInterface): Promise<string | undefined> {
  try {
    return JSON.parse((await readSlot($, API)) ?? '{}').apiKey
  } catch {
    return undefined
  }
}

const apiLabel = async ($: EngineInterface) => `API credit · key …${(await apiKey($))?.slice(-4)}`

async function setupApi($: EngineInterface): Promise<string> {
  await $.ui.open({ id: KEY_PANE, title: 'Console API key', focus: true, closeOnEscape: true, rows: 2 })
  return 'Paste your Console API key (console.anthropic.com → API keys) in the box above the prompt and press Enter · it goes to the plugin alone, not the prompt or its history'
}

/** Enter in the paste box: the key out of whatever was pasted (a bare key, quoted, or `ANTHROPIC_API_KEY=…`). */
async function saveApiKey($: EngineInterface, text: string) {
  const key = /sk-ant-api\d+-[\w-]+/.exec(text)?.[0]
  if (!key) return $.ui.toast('No Console API key (sk-ant-…) in that · paste it again, or Esc to cancel', { timeoutMs: 6000 })
  await writeSlot($, API, JSON.stringify({ apiKey: key }))
  if (await onApi($)) {
    await approveKey($, key)
    await $.env.set('ANTHROPIC_API_KEY', key)
  }
  await $.ui.close({ id: KEY_PANE })
  $.ui.toast(`✓ ${API} saved: Console API key …${key.slice(-4)} · billed only once every account is out of usage`, { timeoutMs: 8000 })
}

/** Claude Code sends an env API key only once approved: its last 20 characters in ~/.claude.json, as its own prompt records them. */
async function approveKey($: EngineInterface, key: string) {
  const path = await configPath($)
  const config = JSON.parse(await $.fs.read(path)) // unreadable: no switch, rather than a config without the rest
  const { approved = [], rejected = [] } = config.customApiKeyResponses ?? {}
  const tail = key.slice(-20)
  if (approved.includes(tail)) return
  const customApiKeyResponses = { approved: [...approved, tail], rejected: rejected.filter((r: string) => r !== tail) }
  await $.fs.write(path, `${JSON.stringify({ ...config, customApiKeyResponses }, null, 2)}\n`)
}

/** Which credential Claude Code sends with the next request. */
const sends = ($: EngineInterface) => $.session.authorize().then(a => a?.kind, () => undefined)

/** Bills this session to the `api` profile; `isAuto` when every account ran out, so it comes back by itself. */
async function switchToApi($: EngineInterface, isAuto: boolean): Promise<string> {
  if (await isDesktop($)) return DESKTOP
  const key = await apiKey($)
  if (!key) return `! No API credit set up · /profile add ${API} and paste your Console API key`
  if (await onApi($)) {
    if (!isAuto) await $.env.set('CLAUDE_PROFILE_API_AUTO', undefined) // chosen now: it stays
    return `✓ Already on ${API}`
  }
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
  await $.env.set('CLAUDE_PROFILE_USING', API)
  await $.env.set('CLAUDE_PROFILE_API_AUTO', isAuto ? '1' : undefined)
  await show($)
  return [
    `✓ Switched to ${API} (${await apiLabel($)})`,
    `This session bills your Console key from your next message; other windows stay on ${await current($)} · /profile <name> to go back`,
  ].join('\n')
}

async function leaveApi($: EngineInterface) {
  await $.env.set('ANTHROPIC_API_KEY', undefined)
  await $.env.set('CLAUDE_PROFILE_API_AUTO', undefined)
}

/** Back from API credit taken by itself, once an account has usage again. */
async function backFromApi($: EngineInterface) {
  if (!(await $.env.get('CLAUDE_PROFILE_API_AUTO')) || !(await onApi($))) return
  const { to } = await spare($, await $.clock.now())
  if (to && (await use($, to)).startsWith('✓ Switched')) $.ui.toast(`${to} has usage again · back from API credit`, { timeoutMs: 8000 })
}

/** A window used up and not reset yet, with no extra usage left to go on with. */
const isOut = (list: Limit[] | undefined, now: number, hasExtra: unknown) =>
  !hasExtra && !!list?.some(l => l.percentUsed >= 100 && (!l.resetsAt || Date.parse(l.resetsAt) > now))

const refused = new Set<string>() // access tokens the API refused outright: no fallback picks them again

/** The first signed-in account, in list order, with usage left and a token this session can use; `expired`: skipped, their saved login dead. */
async function spare($: EngineInterface, now: number, skip?: string): Promise<{ to?: string; expired: string[] }> {
  const live = await current($)
  const expired: string[] = []
  for (const name of await names($)) {
    if (name === skip || name === API || isOut(await limits($, name), now, await $.store.get(`extra:${name}`))) continue
    const login = name === live ? await liveLogin($) : await slot($, name)
    if (!login) continue
    // A saved copy nothing used for hours has expired: renewed here, else this session can't use it.
    // The shared login needn't be: switching to it drops the token, and Claude Code renews its own.
    const fresh = name === live ? login : await renew($, name, login)
    if (fresh && !refused.has(accessToken(fresh.creds) ?? '')) return { to: name, expired }
    expired.push(name)
  }
  return { expired }
}

/**
 * Whether a goal runs in this session, read as Claude Code reads it back on a resume: the transcript's last
 * goal_status entry, unless it's met or failed (a /goal clear writes a met one). So a goal Claude set counts,
 * and a resumed one; one met or judged impossible by itself doesn't.
 */
async function goalRuns($: EngineInterface): Promise<boolean> {
  const projects = `${await home($)}/.claude/projects`
  const id = await $.session.id()
  // The entry's own `"attachment":{"type":"goal_status"`, never one quoted in a message or a command (`\"attachment\":…`).
  const entry = '.attachment.:\\{.type.:.goal_status'
  // ponytail: Windows untested, like the rest there.
  const argv = (await platform($)) === 'win'
    ? ['powershell', '-NoProfile', '-Command', `Select-String -Path '${projects.replace(/\//g, '\\')}\\*\\${id}.jsonl' -Pattern '${entry}' | Select-Object -Last 3 | ForEach-Object Line`]
    : ['sh', '-c', 'grep -hE "$3" "$1"/*/"$2".jsonl 2>/dev/null | tail -n 3', 'sh', projects, id, entry]
  const r = await $.process.run(argv).catch(() => undefined)
  const last = (r?.stdout ?? '').split('\n').flatMap(line => {
    try {
      const a = JSON.parse(line).attachment
      return a?.type === 'goal_status' ? [a] : []
    } catch {
      return []
    }
  }).at(-1)
  return !!last && !last.met && !last.failed
}

/** This session's credentials as they ride in its environment, which every Bash command inherits. */
async function secrets($: EngineInterface): Promise<string[]> {
  const all = [await $.env.get('ANTHROPIC_API_KEY'), await $.env.get('ANTHROPIC_AUTH_TOKEN')]
  return all.filter((s): s is string => !!s && s.length >= 20)
}

/** `text` with every one of `hidden` blanked out. */
const blank = (hidden: string[], text: string) => hidden.reduce((out, s) => out.split(s).join('[redacted]'), text)

/** What this session sends, to tell whether another step switched meanwhile. */
const credential = async ($: EngineInterface) => `${await $.env.get('ANTHROPIC_AUTH_TOKEN')}|${await $.env.get('ANTHROPIC_API_KEY')}`

let failing: Promise<boolean> | undefined // parallel subagents hit the limit together: one switch
let declined: string | undefined // the credential the person chose to stay on, till their next message

/**
 * Another step's switch, awaited inside short `$` calls: a hook's 10s budget stops only
 * while one of its own is in flight, and that step may be waiting on the person.
 */
async function awaitSwitch($: EngineInterface, switched: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  const nap = (await platform($)) === 'win' ? ['powershell', '-NoProfile', '-Command', 'Start-Sleep 2'] : ['sleep', '2']
  for (;;) {
    if (signal.aborted) return false
    const r = await Promise.race([switched, $.process.run(nap).then(() => undefined, () => switched)])
    if (r !== undefined) return r
  }
}

/**
 * The live account's plan is used up, or its login refused: switch to a signed-in one whose
 * isn't, else to the `api` profile. By itself while a goal runs (nobody may be watching),
 * else once the person agrees. True once this session sends something else.
 */
async function failover($: EngineInterface): Promise<boolean> {
  if ((await onApi($)) || (await isDesktop($))) return false // API credit is the last stop; a desktop session can't move
  const isGoal = await goalRuns($)
  if (!isGoal && declined === (await credential($))) return false // asked already: steps in flight ran out too
  const now = await $.clock.now()
  const from = await active($)
  // The plan's reading says whether extra usage is left. Switched, the engine's reading
  // may be the login this process loaded: no plan reading, no telling.
  let rateLimits = await planUsage($, true)
  // Refused outright (revoked, or its refresh key spent): unless another window was renewing it just
  // then, the login is no more use than a used-up plan.
  let isDead = !rateLimits && usageError === 'HTTP 401'
  if (isDead) {
    const held = await credential($)
    await locked($, async () => undefined) // a renewal elsewhere writes its token back before letting go
    await syncToken($).catch(() => undefined)
    if ((await credential($)) !== held) return true // renewed meanwhile: go again on the fresh token
    rateLimits = await planUsage($, true)
    isDead = !rateLimits && usageError === 'HTTP 401'
  }
  if (isDead) {
    for (const tok of [await $.env.get('ANTHROPIC_AUTH_TOKEN'), accessToken((await loginOf($, from))?.creds)]) if (tok) refused.add(tok)
  } else {
    if (!rateLimits?.length) rateLimits = (await using($)) ? await limits($, from) : (await $.session.usage()).rateLimits
    if (!isOut(rateLimits, now, await $.store.get(`extra:${from}`))) return false // failed for another reason
    // So no fallback picks it till it resets; a window that doesn't say when has reset by its full length.
    const span = (kind: string) => (kind === 'seven_day' ? 7 * 24 : 5) * 3_600_000
    await keep($, from, rateLimits!.map(l => ({ ...l, resetsAt: l.resetsAt ?? new Date(now + span(l.kind)).toISOString() })))
  }
  const lead = isDead ? `${from}'s login was refused` : `${from} is out of usage`
  const fix = !isDead ? '' : from === (await current($)) ? ` · /login to sign ${from} in again` : ` · /profile remove ${from}, then /profile add ${from}`
  const others = isDead ? 'every other account is out of usage' : 'so is every other account'
  const { to, expired } = await spare($, now, from)
  const key = await apiKey($)
  const dead = expired.length ? ` · ${expired.join(', ')}: couldn't renew the saved login, /profile remove and /profile add it again` : ''
  if (!to && !key) {
    $.ui.toast(`${lead}${expired.length ? '' : `, and ${others}`}${fix}${dead}`, { timeoutMs: 8000 })
    return false
  }
  // A goal takes the next account, API credit only after the last; asked, either is offered.
  let choice = to ?? API
  if (!isGoal) {
    const credit = `Console key …${key?.slice(-4)}, billed per token`
    const question = !to ? `${lead}, and ${expired.length ? `${expired.join(', ')}'s saved login couldn't be renewed` : others}. Continue on API credit (${credit})?`
      : key ? `${lead}. Continue on ${to}, or on API credit (${credit})?`
      : `${lead}. Switch to ${to} and continue?`
    const options = [...(to ? [`Switch to ${to}`] : []), ...(key ? ['Use API credit'] : []), `Stay on ${from}`]
    const answer = await $.ui.ask(question, { header: 'Usage', options }).catch(() => undefined)
    if (answer === 'Use API credit') choice = API
    else if (answer !== `Switch to ${to}`) {
      declined = await credential($)
      return false
    }
  }
  // Chosen over an account with usage left, API credit stays till /profile <name>.
  const said = choice === API ? await useApi($, !to) : await use($, choice)
  if (!said.startsWith('✓')) {
    $.ui.toast(`${lead}, and the switch didn't happen: ${said.replace(/^! /, '')}`, { timeoutMs: 8000 })
    return false
  }
  if (isGoal || isDead) {
    const going = isGoal ? ' to keep the goal going' : ''
    $.ui.toast(choice !== API ? `${lead} · switched to ${choice}${going}${fix}` : `${expired.length || isDead ? lead : 'Every account is out of usage'} · on API credit${going}${fix}${dead}`, { timeoutMs: 8000 })
  }
  return true
}

async function remove($: EngineInterface, name: string): Promise<string> {
  const add = await adding($)
  const isAdding = add?.name === name // whichever window started it
  if (!isAdding && !(await names($)).includes(name)) return '! Usage: /profile remove <name>'
  if (!isAdding && (await current($)) === name) return `! ${name} is the shared login, the one new windows open on · /login as another account first`
  if (!isAdding && (await active($)) === name) return `! ${name} is the account this session uses · /profile to another first`
  if (!(await deleteSlot($, name))) return `! Couldn't remove ${name}'s saved login · nothing changed`
  pending.delete(name)
  await keep($, name, null) // a new account added under the name starts without them
  await $.store.delete(`extra:${name}`)
  if (isAdding) { // its sign-in watch stops, and the browser sign-in with it
    if (add.pid && (await loginRunning($, add.pid))) await $.process.run(['kill', add.pid]).catch(() => undefined)
    await endAdd($)
  }
  return `✓ Removed ${name}`
}

/** `/profile` alone: a picker of the other signed-in accounts; undefined = show the list instead. */
async function pick($: EngineInterface): Promise<string | undefined> {
  const others = (await isDesktop($)) ? [] : (await rows($)).filter(r => !r.isActive && !r.isPending).slice(0, 3)
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
  if (answer === ADD) { // the same flows as /profile add <name> and /profile add api
    const kind = await $.ui.ask('Add which kind of account?', { header: 'Add', options: [ADD_SUB, ADD_API] }).catch(() => undefined)
    if (!kind) return undefined
    if (kind !== ADD_SUB) return add($, kind === ADD_API ? API : kind.trim()) // typed under Other: a name
    const name = await $.ui.ask('Name for the new account?', { header: 'Name', options: ['work', 'personal'] }).catch(() => undefined)
    return name ? add($, name.trim()) : undefined
  }
  const typed = answer.trim() // typed under Other: an account to switch to
  return (await names($)).includes(typed) ? use($, typed) : `! No account ${typed} · /profile add ${NAME.test(typed) ? typed : '<name>'} to sign one in`
}

async function profile($: EngineInterface, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const name = rest.join(' ')
  if (verb === 'add') return add($, name)
  if (verb === 'remove') return remove($, name)
  if (verb === 'list' || verb === 'status') return listText(await rows($))
  if (!verb) return (await pick($)) ?? listText(await rows($))
  if ((await names($)).includes(verb)) return use($, verb)
  return `! No account ${verb} · /profile add ${NAME.test(verb) ? verb : '<name>'} to sign one in`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'profile',
      description: 'Switch your Claude login between accounts',
      argumentHint: '[name | add <name> | add api | remove <name> | list]',
    })
    $.ui.status(undefined) // versions before 0.2.4 pinned a status line instead of the band
    await watchLogin($) // first: its timers redraw the row and sync the token whatever fails below
    const mine = await $.env.get('CLAUDE_PROFILE_ADDING') // an add this process started before a reload
    const m = await adding($)
    if (mine && !pending.has(mine) && m?.name === mine && (await $.session.usage()).startedAt <= m.until - 600_000) {
      pending.add(mine)
      watchSignIn($, mine)
    }
    // A desktop session's own account. A terminal one sends the shared login when not switched: the
    // login it started on, as versions before 0.5.0 kept it, is no label for it once that moves.
    if (await isDesktop($)) {
      await $.env.set('CLAUDE_PROFILE_STARTED_ON', await desktopAccount($))
      if (await using($)) { // switched by a version before 0.4.4, to no effect
        await $.env.set('CLAUDE_PROFILE_USING', undefined)
        await $.env.set('ANTHROPIC_AUTH_TOKEN', undefined)
        await leaveApi($)
      }
    } else await $.env.set('CLAUDE_PROFILE_STARTED_ON', undefined)
    const h = await home($)
    await $.fs.write(`${h}/.claude/profile-statusline.sh`, STATUSLINE).catch(() => undefined)
    await claimStatusLine($).catch(() => undefined)
    // A file per session: drop the ones nothing has written for a week.
    if ((await platform($).catch(() => 'win')) !== 'win') void $.process.run(['find', `${h}/.claude/profile-statusline`, '-name', '*.txt', '-mtime', '+7', '-delete']).catch(() => undefined)
    // The engine's reading so far (a reload keeps it), as session.measure keeps the next: it measures only once a window moves a point.
    const { rateLimits } = await $.session.usage().catch(() => ({ rateLimits: [] }))
    if (rateLimits.length && !(await using($))) await active($).then(name => keep($, name, rateLimits)).catch(() => undefined)
    await show($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (e.changed.includes('context')) compacted = undefined // measured since
    if (await onApi($)) await writeStatus($)
    else if (await using($)) {
      await planUsage($) // a switched token: the engine's reading may be the login it started with
      await show($)
    } else if (e.changed.includes('rateLimits') && e.rateLimits.length) {
      await keep($, await active($), e.rateLimits) // the login this process loaded, whatever another window made live
      await show($)
    } else await writeStatus($) // context or cost
    return r
  })

  // /compact isn't a turn, so no session.measure follows it: show the smaller context now.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (r.messages && !e.agentId && e.trigger !== 'precompute') {
      // The engine may still report the old size; with no recorded size, its own figure stands.
      compacted = r.tokensAfter === undefined ? undefined : { sid: await $.session.id(), tokens: r.tokensAfter }
      await writeStatus($)
    }
    return r
  })

  // The session's prompt-cache hit rate, for the status line. Parallel subagents end
  // together: one count at a time, each adding to what the last stored.
  on('turn.complete', async ($, e, next) => {
    if (e.usage) {
      const key = `cache:${await $.session.id()}`
      const u = e.usage
      await (counting = counting.then(async () => {
        const was = ((await $.store.get(key)) as Cache | undefined) ?? { read: 0, input: 0 }
        await $.store.set(key, {
          read: was.read + u.cache_read_input_tokens,
          input: was.input + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        })
      }).catch(() => undefined))
      await show($)
    }
    return next(e)
  })

  // Remember that this session uses Remote Control, to reconnect it after a switch.
  on('command.run', { command: 'remote-control' }, async ($, e, next) => {
    await $.env.set('CLAUDE_PROFILE_REMOTE', '1')
    return next(e)
  })

  // A request refused for a used-up plan or a dead login ends the turn and pauses a
  // goal: send it again on another account, or API credit, instead. A changed
  // credential means another step already switched.
  on('turn.step', async function* ($, e, next) {
    for (;;) {
      const held = await credential($)
      const r = yield* next(e)
      if (r.stopReason !== null || next.signal.aborted) return r
      await syncToken($).catch(() => undefined) // another window refreshed it, revoking this copy: go again on the fresh one
      if (held !== (await credential($))) continue
      const switched = failing ? await awaitSwitch($, failing, next.signal)
        : await (failing = failover($).catch((err: Error) => ($.ui.toast(`Couldn't switch accounts: ${err.message}`, { timeoutMs: 8000 }), false)).finally(() => (failing = undefined)))
      if (!switched || next.signal.aborted) return r
    }
  })

  // A command that prints the environment (`env`) would put this session's key or
  // token in the transcript: blank them out of what any tool hands back, before the
  // model or the transcript sees it. The command itself is left alone, so permission
  // rules still match it.
  on('tool.call', async ($, e, next) => {
    const inherited = await secrets($) // what the tool's process starts with: a switch while it runs changes the env, not its output
    const r = await next(e)
    const hidden = [...new Set([...inherited, ...(await secrets($))])]
    if (!hidden.length) return r
    const raw = `${r.text ?? ''}${JSON.stringify(r.result ?? '')}`
    if (!hidden.some(s => raw.includes(s))) return r
    if (r.isError || r.result === undefined) return { deny: blank(hidden, r.text ?? JSON.stringify(r.result ?? '')) }
    return { result: JSON.parse(blank(hidden, JSON.stringify(r.result))), context: r.context }
  }).catch(($, e, next) => (next.error.kind === 're-entry' ? next(e) : { deny: "A plugin couldn't check this output for a credential, so it was withheld" })) // fails closed

  // Rows no tool call carries (a Monitor's streamed lines, a settings hook's output) are blanked as they're kept.
  on('session.append', async ($, e, next) => {
    const hidden = await secrets($)
    if (!hidden.length) return next(e) // on its own login: nothing of this session's rides in the environment
    const raw = JSON.stringify(e.message.content)
    if (!hidden.some(s => raw.includes(s))) return next(e)
    return next({ ...e, message: { ...e.message, content: JSON.parse(blank(hidden, raw)) } })
  })

  // API credit the goal took by itself stops with /goal clear: the next refusal asks.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    if (/^(clear|stop|off|reset|none|cancel)$/i.test(e.args.trim())) await serial(async () => {
      if (!(await $.env.get('CLAUDE_PROFILE_API_AUTO')) || !(await onApi($))) return
      await leaveApi($)
      await $.env.set('CLAUDE_PROFILE_USING', undefined)
      await show($)
    })
    return next(e)
  })

  // A conversation ends (exit, /clear, a resume): its keys go, and the next one's status line is drawn.
  on('session.end', async ($, e, next) => {
    await $.store.delete(`cache:${e.sessionId}`).catch(() => undefined)
    if (e.reason === 'clear' || e.reason === 'resume') $.clock.after(1000, () => void show($).catch(() => undefined))
    return next(e)
  })

  // /login here: the shared login is the new one, and so is this session's row.
  on('command.run', { command: 'login' }, async ($, e, next) => {
    const r = await next(e)
    await show($)
    return r
  })

  // The model shows on the status line from the file: redraw it after /model.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const r = await next(e)
    await writeStatus($).catch(() => undefined)
    return r
  })

  on('command.run', { command: 'usage' }, async ($, e, next) => {
    const name = await using($)
    if (!name || name === API) return next(e)
    await planUsage($)
    return { text: await usagePanel($, name) }
  })

  on('command.run', { command: 'profile' }, async ($, e) => ({ text: await profile($, e.args).catch((err: Error) => `! ${err.message}`) }))

  on('prompt.submit', async ($, e, next) => {
    declined = undefined
    await syncToken($).catch(() => undefined)
    await backFromApi($).catch(() => undefined)
    return next(e)
  })

  // Account names and verbs after `/profile `.
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
    const all = meters(band.limits, await $.clock.now())
    const { name, email, cache } = band
    // Wider than the column it would wrap: drop the email, then the countdowns, then the cache, then the 7d window.
    const width = (d: number) => [
      ['●', name, d < 1 && email],
      ...(d < 4 ? all : all.slice(0, 1)).map(m => [m.label, '▰'.repeat(BAR), `${m.p}%`, d < 2 && m.reset && `↻ ${m.reset}`]),
      ...(d < 3 && cache !== undefined ? [['Cache', `${cache}%`]] : []),
    ].map(g => g.filter(Boolean).join(' ')).join(' │ ').length
    const d = [0, 1, 2, 3].find(n => width(n) <= e.props.bodyColumns) ?? 4
    const windows = (d < 4 ? all : all.slice(0, 1)).map(m => (
      <Box key={m.kind} gap={1}>
        <Text color="subtle">{m.label}</Text>
        <Box>
          <Text color={m.color}>{'▰'.repeat(m.fill)}</Text>
          <Text color="subtle">{'▱'.repeat(BAR - m.fill)}</Text>
        </Box>
        <Text color={m.color}>{`${m.p}%`}</Text>
        {m.reset && d < 2 ? <Text color="subtle">{`↻ ${m.reset}`}</Text> : null}
      </Box>
    ))
    const groups = [
      <Box key="account" gap={1}>
        <Text color="success">●</Text>
        <Text bold>{name}</Text>
        {email && d < 1 ? <Text color="subtle">{email}</Text> : null}
      </Box>,
      ...windows,
      ...(cache !== undefined && d < 3 ? [
        <Box key="cache" gap={1}>
          <Text color="subtle">Cache</Text>
          <Text color={level(100 - cache)}>{`${cache}%`}</Text>
        </Box>,
      ] : []),
    ]
    // │ between the groups, as the status line's row has it
    return <Box gap={1}>{groups.flatMap((g, i) => (i ? [<Text key={`sep${i}`} color="subtle">│</Text>, g] : [g]))}</Box>
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
    if (e.kind === 'submit') await saveApiKey($, e.value).catch((err: Error) => $.ui.toast(`The key wasn't saved: ${err.message}`, { timeoutMs: 8000 }))
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
