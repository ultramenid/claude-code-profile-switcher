import { expect, mock, test } from 'claude-code/testing'

const run = ($: any, args: string) =>
  $.command.run({
    command: 'profile',
    args,
    origin: { kind: 'plugin', name: 'profile' },
    presentation: { isFullscreen: false, columns: 80 },
  }).then((r: any) => r.text as string)

const creds = (tok: string) => JSON.stringify({ claudeAiOauth: { accessToken: tok, refreshToken: `r-${tok}` } })
const unhex = (h: string) => new TextDecoder().decode(new Uint8Array(h.match(/../g)!.map(b => parseInt(b, 16))))
const hex = (s: string) => Array.from(new TextEncoder().encode(s), b => b.toString(16).padStart(2, '0')).join('')
const LIVE = 'Claude Code-credentials|me'
const CONFIG = '/home/u/.claude.json'
const command = ($: any, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as any)

/** A fake Keychain behind `security`, and ~/.claude.json, starting logged in as me@x. */
function stage(on: any, answers: string[] = []) {
  const keychain: Record<string, string> = { 'Claude Code-credentials|me': creds('t-main') }
  const files: Record<string, string> = { '/home/u/.claude.json': JSON.stringify({ theme: 'dark', oauthAccount: { emailAddress: 'me@x' } }) }
  const env: Record<string, string | undefined> = { HOME: '/home/u', USER: 'me' }
  const argvs: string[] = []
  const remote: string[] = []
  const panes = new Set<string>()
  on('command.run', { command: 'remote-control' }, () => (remote.push('run'), { text: '' }))
  const surfaces = ['terminal']
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  const model = { id: 'claude-opus-5-5' }
  on('session.model', () => ({ value: model.id }))
  on('turn.complete', () => ({ text: '' }))
  const rateLimits: { kind: string; percentUsed: number }[] = []
  const context: { tokens?: number; window: number; percent?: number } = { tokens: 216_300, window: 1_000_000, percent: 22 }
  on('session.usage', () => ({ value: { startedAt: 0, context, rateLimits } }))
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', (_$: any, e: any) => ((env[e.name] = e.value), { value: undefined }))
  const store: Record<string, unknown> = {}
  on('store.get', (_$: any, e: any) => ({ value: e.key in store ? structuredClone(store[e.key]) : undefined }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = structuredClone(e.value)), { value: undefined }))
  on('store.delete', (_$: any, e: any) => (delete store[e.key], { value: undefined }))
  const session = {
    id: 'sess-1',
    isKeychainBroken: false,
    isDeleteBroken: false,
    isHexForNonAscii: false, // `security -w` prints a password holding a non-ASCII byte as hex
    isUnameBlocked: false, // a guard plugin refusing the run, say
    loginPid: '', // what starting `claude auth login` prints: none, so an add waits out its 10 minutes
    isLoginRunning: true, // what `ps` says of it
    readFailures: 0, // Keychain reads that fail (locked, no prompt allowed)
    dumpFailures: 0, // Keychain listings that fail
    tornReads: 0, // reads of ~/.claude.json that catch another window mid-write
    dumpDelayMs: 0,
    unreadable: new Set<string>(), // paths fs.read refuses (over 4 MiB, mid-write)
    failWrite: new Set<string>(), // paths whose next fs.write is refused
    usageStatus: {} as Record<string, number>, // a credential the usage endpoint answers with this status
    holds: {} as Record<string, { reached: () => void; shut: Promise<void> }>, // usage reads held till opened
    renewals: {} as Record<string, string>, // the token endpoint: a refresh token it takes once, and the access token it hands back
  }
  on('session.id', () => ({ value: session.id }))
  // Claude Code's order: ANTHROPIC_AUTH_TOKEN, then an approved ANTHROPIC_API_KEY, then the login.
  on('session.authorize', () => {
    const approved: string[] = JSON.parse(files['/home/u/.claude.json']!).customApiKeyResponses?.approved ?? []
    const isKey = !env.ANTHROPIC_AUTH_TOKEN && !!env.ANTHROPIC_API_KEY && approved.includes(env.ANTHROPIC_API_KEY.slice(-20))
    return { value: { handle: isKey ? 'key' : env.ANTHROPIC_AUTH_TOKEN ?? 't-main', kind: isKey ? 'api-key' : 'bearer' } }
  })
  // The plan's usage endpoint, answering for the credential the session sends.
  const plan: Record<string, Record<string, { utilization: number; resets_at?: string }>> = {}
  on('http.fetch', async (_$: any, e: any) => {
    if (e.url === 'https://platform.claude.com/v1/oauth/token') { // refresh tokens rotate: each renews once, any other is refused
      const sent = JSON.parse(e.init.body)
      const tok = sent.grant_type === 'refresh_token' && sent.client_id && !e.init.auth ? session.renewals[sent.refresh_token] : undefined
      delete session.renewals[sent.refresh_token]
      return { value: tok ? { status: 200, ok: true, headers: {}, text: JSON.stringify({ access_token: tok, refresh_token: `r-${tok}`, expires_in: 28_800 }) }
        : { status: 400, ok: false, headers: {}, text: '{"error":"invalid_grant"}' } }
    }
    const hold = session.holds[e.init?.auth]
    if (hold) {
      delete session.holds[e.init?.auth]
      hold.reached()
      await hold.shut
    }
    const status = session.usageStatus[e.init?.auth]
    if (status) return { value: { status, ok: false, headers: {}, text: '' } }
    const body = e.url === 'https://api.anthropic.com/api/oauth/usage' ? plan[e.init?.auth] : undefined
    return { value: body ? { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } : { status: 401, ok: false, headers: {}, text: '' } }
  })
  on('ui.open', (_$: any, e: any) => (panes.add(e.id), { value: { isPlaced: true } }))
  on('ui.close', (_$: any, e: any) => (panes.delete(e.id), { value: undefined }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { name: 'profile' } }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  const clock = mock.clock(on)
  on('fs.read', (_$: any, e: any) => {
    if (e.path === CONFIG && session.tornReads > 0) return (session.tornReads--, { value: files[e.path]!.slice(0, 20) })
    return e.path in files && !session.unreadable.has(e.path) ? { value: files[e.path] } : { deny: 'ENOENT' }
  })
  on('fs.write', (_$: any, e: any) => (session.failWrite.delete(e.path) ? { deny: 'ENOSPC' } : ((files[e.path] = e.text), { value: undefined })))
  on('process.run', async (_$: any, e: any) => {
    const a: string[] = e.argv
    argvs.push(a.join(' '))
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'uname') return session.isUnameBlocked ? { deny: 'refused' } : out('Darwin\n')
    if (a[0] === 'sh' && a[2]!.includes('auth login')) return out(session.loginPid)
    if (a[0] === 'ps') return out(session.isLoginRunning ? 'node /usr/local/bin/claude auth login\n' : '')
    if (a[0] === 'security' && a.includes('-w') && session.readFailures > 0) return (session.readFailures--, out('', 36))
    if (a[0] === 'sh' && a[2]!.includes('dump-keychain')) {
      if (session.dumpFailures > 0) return (session.dumpFailures--, out('', 1))
      if (session.dumpDelayMs) await clock.sleep(session.dumpDelayMs)
      return out(Object.keys(keychain).filter(k => k.startsWith('cc-swap-login|')).map(k => `    "acct"<blob>="${k.split('|')[1]}"`).join('\n'))
    }
    if (a[0] !== 'security') return out('')
    if (a[1] === '-i') {
      if (session.isKeychainBroken) return out('', 1)
      const [, s, acct, hex] = /-s "([^"]+)" -a "([^"]+)" -X (\w+)/.exec(e.init.stdin)!
      keychain[`${s}|${acct}`] = unhex(hex!)
      return out('')
    }
    const s = a[a.indexOf('-s') + 1]
    const acct = a.includes('-a') ? a[a.indexOf('-a') + 1] : undefined
    const key = Object.keys(keychain).find(k => k.startsWith(`${s}|`) && (!acct || k === `${s}|${acct}`))
    if (a[1] === 'delete-generic-password') return session.isDeleteBroken ? out('', 51) : key ? (delete keychain[key], out('')) : out('', 44)
    if (!key) return out('', 44)
    const v = keychain[key]!
    if (a.includes('-w')) return out(session.isHexForNonAscii && /[^\x20-\x7e]/.test(v) ? hex(v) : v)
    return out(`attributes:\n    "acct"<blob>="${key.split('|')[1]}"\n`)
  })
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    asked.push(e.questions[0].question)
    const ans = answers.shift()
    if (ans === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: ans } } }
  })
  /** What `claude auth login` would do once the browser sign-in finishes. */
  const signIn = (tok: string, email: string) => {
    keychain['Claude Code-credentials|me'] = creds(tok)
    files['/home/u/.claude.json'] = JSON.stringify({ ...JSON.parse(files['/home/u/.claude.json']!), oauthAccount: { emailAddress: email } })
  }
  const liveEmail = () => JSON.parse(files['/home/u/.claude.json']!).oauthAccount.emailAddress
  const liveToken = () => JSON.parse(keychain[LIVE]!).claudeAiOauth.accessToken
  /** Every saved account's access token, by name. */
  const tokens = () => Object.fromEntries(Object.entries(keychain).filter(([k]) => k.startsWith('cc-swap-login|') && !k.endsWith('|api'))
    .map(([k, v]) => [k.split('|')[1], JSON.parse(JSON.parse(v).creds).claudeAiOauth.accessToken]))
  /** Holds the next usage read with `handle` till `open()`; `reached` resolves once it's in flight. */
  const holdUsage = (handle: string) => {
    let open!: () => void
    let reached!: () => void
    const shut = new Promise<void>(r => (open = r))
    const isReached = new Promise<void>(r => (reached = r))
    session.holds[handle] = { reached, shut }
    return { reached: isReached, open }
  }
  return { keychain, env, argvs, signIn, liveEmail, liveToken, tokens, clock, files, remote, surfaces, rateLimits, panes, plan, context, session, toasts, asked, model, holdUsage, store }
}

test('add captures a full login and puts the current one back; switching swaps the live login', async ($, on) => {
  const { keychain, env, argvs, signIn, liveEmail, clock } = stage(on)

  expect(await run($, 'add work')).toContain('✓ Sign-in for work opened')
  expect(argvs.some(a => a.includes('claude auth login'))).toBe(true)
  expect(argvs.some(a => a.includes('t-main'))).toBe(false) // secrets go on stdin, never argv
  expect(await run($, 'list')).toContain('○ work  sign-in pending')

  signIn('t-work', 'w@x')
  await clock.advance(3000)
  expect(keychain['Claude Code-credentials|me']).toBe(creds('t-main')) // main is live again
  expect(liveEmail()).toBe('me@x')
  expect(await run($, 'list')).toBe(
    'Accounts\n● main  me@x · active\n○ work  w@x\n\n/profile <name> switch · /profile add <name> · /profile remove <name>',
  )

  expect(await run($, 'work')).toContain('✓ Switched to work (w@x)')
  expect(keychain['Claude Code-credentials|me']).toBe(creds('t-work'))
  expect(liveEmail()).toBe('w@x')
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t-work')

  // a refresh while on work is kept when switching away
  keychain['Claude Code-credentials|me'] = creds('t-work2')
  expect(await run($, 'main')).toContain('✓ Switched to main (me@x)')
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t-main') // this test's session never started: no startedOn
  expect(keychain['Claude Code-credentials|me']).toBe(creds('t-main'))
  expect(JSON.parse(keychain['cc-swap-login|work']!).creds).toBe(creds('t-work2'))

  expect(await run($, 'main')).toBe('✓ Already on main')
  expect(await run($, 'remove main')).toContain('switch away first')
  expect(await run($, 'remove work')).toBe('✓ Removed work')
  expect(keychain['cc-swap-login|work']).toBeUndefined()
  expect(await run($, 'nope')).toContain('No account nope')
  expect(await run($, 'add')).toContain('Usage')
})

test('/profile alone: Add account… asks subscription or API credit, then runs that add', async ($, on) => {
  const { signIn, clock, panes, asked } = stage(on, ['Add account…', 'API credit (Console key)', 'Add account…', 'Subscription account (Pro, Max, Team)', 'home'])
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)

  expect(await run($, '')).toContain('Paste your Console API key') // as /profile add api
  expect(panes.has('profile-api-key')).toBe(true)
  expect(await run($, '')).toContain('✓ Sign-in for home opened') // as /profile add home
  expect(asked.filter(q => q === 'Add which kind of account?')).toHaveLength(2)
  expect(asked.at(-1)).toBe('Name for the new account?')
})

test('switching back to the login the session started on drops the token', async ($, on) => {
  const { env, signIn, clock } = stage(on)
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)
  await run($, 'work')
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t-work')
  await run($, 'main')
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
})

test('a switch never loses a login: unreadable config or a failed Keychain write changes nothing; MCP sign-ins stay live', async ($, on) => {
  const { keychain, files, signIn, clock, session } = stage(on)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)
  const LIVE = 'Claude Code-credentials|me'
  keychain[LIVE] = JSON.stringify({ ...JSON.parse(creds('t-main')), mcpOAuth: { linear: 'm1' } })
  expect(await run($, 'work')).toContain('✓ Switched to work')
  expect(JSON.parse(keychain[LIVE]!)).toEqual({ ...JSON.parse(creds('t-work')), mcpOAuth: { linear: 'm1' } }) // the login swapped, not the MCP sign-ins
  expect(JSON.parse(keychain['cc-swap-login|main']!).creds).toBe(creds('t-main'))

  const before = () => [keychain[LIVE], files['/home/u/.claude.json'], keychain['cc-swap-login|main'], keychain['cc-swap-login|work']].join('\n')
  const was = before()
  const config = files['/home/u/.claude.json']!
  files['/home/u/.claude.json'] = config.slice(0, 20) // half-written by another window
  expect(await run($, 'main')).toMatch(/^! /)
  files['/home/u/.claude.json'] = config
  expect(before()).toBe(was)
  session.isKeychainBroken = true // locked, or a write security refuses
  expect(await run($, 'main')).toContain('The Keychain write failed')
  expect(before()).toBe(was)
  session.isKeychainBroken = false
  expect(await run($, 'main')).toContain('✓ Switched to main')
})

test('per process: a /clear keeps the switch, and another window making a login live does not relabel this session', async ($, on) => {
  const { keychain, files, env, signIn, clock, session } = stage(on)
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)
  await run($, 'work')
  session.id = 'sess-2' // /clear: a new session id, no session.start
  expect(await run($, 'work')).toBe('✓ Already on work')
  keychain['Claude Code-credentials|me'] = creds('t-work-2') // another window refreshed work
  await clock.advance(60_000)
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t-work-2') // still followed
  signIn('t-main', 'me@x') // another window made main live
  expect(await run($, 'list')).toContain('● work  w@x · active') // this session still sends work's token
  expect(await run($, 'main')).toContain('✓ Switched to main')
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined() // main is the login this process loaded
  expect(JSON.parse(files['/home/u/.claude.json']!).oauthAccount.emailAddress).toBe('me@x')
})

const MARK = '/home/u/.claude/profile-adding.json'

test('an add is marked for every window till it ends: saved, given up after 10 minutes, or removed', async ($, on) => {
  const { keychain, env, files, signIn, clock, toasts } = stage(on)
  const marked = () => JSON.parse(files[MARK] ?? '{}').name
  await run($, 'add work')
  expect([marked(), env.CLAUDE_PROFILE_ADDING]).toEqual(['work', 'work'])
  signIn('t-work', 'w@x')
  await clock.advance(3000)
  expect([marked(), env.CLAUDE_PROFILE_ADDING]).toEqual([undefined, undefined])

  await run($, 'add home')
  await clock.advance(600_000) // no sign-in
  expect(toasts.at(-1)).toContain('No new sign-in for home in 10 minutes')
  expect([marked(), env.CLAUDE_PROFILE_ADDING]).toEqual([undefined, undefined])

  expect(await run($, 'add home')).toContain('✓ Sign-in for home opened')
  expect(await run($, 'remove home')).toBe('✓ Removed home')
  expect(marked()).toBeUndefined()
  signIn('t-home', 'h@x') // finished anyway: its watch has stopped
  await clock.advance(3000)
  expect(keychain['cc-swap-login|home']).toBeUndefined()
})

test('another window adding: no second add here, and one Remote Control reconnect once it has put the login back', async ($, on) => {
  const { files, remote, signIn, clock, argvs } = stage(on)
  files['/home/u/.claude/settings.json'] = '{"remoteControlAtStartup":true}'
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  files[MARK] = JSON.stringify({ name: 'work', prev: 'main', prevAccount: { emailAddress: 'me@x' }, until: clock.now() + 600_000 })
  expect(await run($, 'add home')).toContain('The sign-in for work isn\'t finished')
  expect(argvs.some(a => a.includes('claude auth login'))).toBe(false)
  signIn('t-work', 'w@x') // its sign-in, live till that window puts main back
  await clock.advance(5000)
  expect(remote.length).toBe(0)
  signIn('t-main', 'me@x')
  files[MARK] = '{}'
  await clock.advance(5500)
  expect(remote.length).toBe(1)
})

test('a plugin reload mid-add (module state gone, the process environment kept) watches for the sign-in again', async ($, on) => {
  const { keychain, env, files, signIn, liveEmail, clock } = stage(on)
  // What /profile add left before the reload: main saved, the marker, this process's mark.
  keychain['cc-swap-login|main'] = JSON.stringify({ creds: creds('t-main'), oauthAccount: { emailAddress: 'me@x' } })
  files[MARK] = JSON.stringify({ name: 'work', prev: 'main', prevAccount: { emailAddress: 'me@x' }, until: clock.now() + 600_000 })
  env.CLAUDE_PROFILE_ADDING = 'work'
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  expect(await run($, 'list')).toContain('○ work  sign-in pending')
  signIn('t-work', 'w@x')
  await clock.advance(3000)
  expect(JSON.parse(keychain['cc-swap-login|work']!).creds).toBe(creds('t-work'))
  expect(liveEmail()).toBe('me@x') // main put back
  expect(env.CLAUDE_PROFILE_ADDING).toBeUndefined()
})

test('plan usage is kept per account; a switched one reads its own from the plan, not the reading of the login the session started on', async ($, on) => {
  const { signIn, clock, plan, files } = stage(on)
  const measure = (five: number, seven: number) =>
    $.session.measure({ context: {} as any, rateLimits: [{ kind: 'five_hour', percentUsed: five }, { kind: 'seven_day', percentUsed: seven }], changed: ['rateLimits'] })
  const row = () => files['/home/u/.claude/profile-status.txt']!.replace(/\x1b\[\d+m/g, '')
  await measure(23.4, 40)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)
  plan['t-work'] = { five_hour: { utilization: 5 }, seven_day: { utilization: 12 } }
  await run($, 'work')
  expect(row()).toBe('● work w@x │ 5h ▰▱▱▱▱▱▱▱▱▱ 5% │ 7d ▰▱▱▱▱▱▱▱▱▱ 12%\n') // read on the switch
  await measure(24, 41) // the engine still reading main's windows: not work's
  expect(await run($, 'list')).toContain('○ main  me@x · 5h 23% 7d 40%\n● work  w@x · 5h 5% 7d 12% · active')
  plan['t-work'] = { five_hour: { utilization: 9 }, seven_day: { utilization: 13 } }
  await clock.advance(61_000)
  await measure(25, 41) // a minute on, the next turn reads work's again
  expect(row()).toBe('● work w@x │ 5h ▰▱▱▱▱▱▱▱▱▱ 9% │ 7d ▰▱▱▱▱▱▱▱▱▱ 13%\n')
  const usage = await $.command.run({ command: 'usage', args: '', origin: { kind: 'plugin', name: 'profile' }, presentation: { isFullscreen: false, columns: 80 } } as any)
  expect(usage.text).toContain('Plan usage · work (w@x)')
  expect(usage.text).toContain('5h  ▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 9%\n7d  ▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 13%')
})

test('a request refused for a used-up plan goes again on another account: asked first, by itself during a /goal', async ($, on) => {
  const { env, signIn, clock, rateLimits, keychain, toasts, files, holdUsage, session, tokens } = stage(on, ['Switch to work'])
  const sent: (string | undefined)[] = []
  on('command.run', { command: 'goal' }, () => ({ text: '' }))
  on('turn.step', async function* (_$: any, e: any) { // the API: main, the login the session started on, is used up
    sent.push(env.ANTHROPIC_AUTH_TOKEN)
    const isOut = !env.ANTHROPIC_AUTH_TOKEN?.startsWith('t-work')
    rateLimits.splice(0, 9, { kind: 'five_hour', percentUsed: isOut ? 100 : 3 })
    return { turnId: e.turnId, index: e.index, answer: isOut ? '' : 'ok', toolUses: [], stopReason: isOut ? null : 'end_turn', usage: null }
  })
  const step = async () => {
    const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    for (;;) {
      const r = await s.next()
      if (r.done) return r.value
    }
  }
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)

  const held = holdUsage('t-work')
  const agreed = step()
  await held.reached
  expect(files['/home/u/.claude/profile-statusline/sess-1.txt']).toContain('w@x') // the row names work before its usage arrives
  held.open()
  expect((await agreed).answer).toBe('ok') // asked, and agreed
  expect(sent).toEqual([undefined, 't-work'])
  expect(await run($, 'list')).toContain('○ main  me@x · 5h 100%')

  await run($, 'main')
  sent.length = 0
  expect((await step()).stopReason).toBeNull() // asked, and dismissed: the turn fails as before
  expect(sent).toEqual([undefined])
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()

  await $.command.run({ command: 'goal', args: 'all tests pass', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as any)
  expect((await step()).answer).toBe('ok') // a goal runs: no one to ask
  expect(toasts.at(-1)).toBe('main is out of usage · switched to work to keep the goal going')

  await run($, 'main')
  const work = JSON.parse(keychain['cc-swap-login|work']!)
  // Hours on main: nothing used work's saved copy, so its access token has expired.
  const idle = (refreshToken: string) => JSON.stringify({ ...work, creds: JSON.stringify({ claudeAiOauth: { accessToken: 't-work', refreshToken, expiresAt: clock.now() - 3_600_000 } }) })
  keychain['cc-swap-login|work'] = idle('r-spent') // a refresh token the endpoint refuses
  expect((await step()).stopReason).toBeNull() // no use switching to it
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  expect(toasts.at(-1)).toContain("work: couldn't renew the saved login")
  keychain['cc-swap-login|work'] = idle('r-work')
  session.renewals['r-work'] = 't-work-3'
  expect((await step()).answer).toBe('ok') // renewed, then switched to
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t-work-3')
  expect(tokens().work).toBe('t-work-3') // its saved copy too: no copy keeps the spent refresh token
  expect(toasts.at(-1)).toBe('main is out of usage · switched to work to keep the goal going')
})

test('API credit comes after every account: pasted in a box, offered when asked, by itself during a /goal, back once a plan resets', async ($, on) => {
  const { env, signIn, clock, rateLimits, panes, files, plan, toasts } = stage(on, ['Use API credit', 'Switch to work', 'Use API credit'])
  const KEY = 'sk-ant-api03-test-0123456789abcdefghijWXYZ'
  const sent: string[] = []
  on('command.run', { command: 'goal' }, () => ({ text: '' }))
  on('tool.call', { tool: 'Bash' }, () => { // `env`, as Bash would print it
    const out = `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY}\nHOME=/home/u\n`
    return { result: { stdout: out, stderr: '', interrupted: false }, text: out, ref: 1 }
  })
  on('turn.step', async function* (_$: any, e: any) { // every plan is used up for an hour; the Console key has credit
    const onKey = !env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_API_KEY === KEY
    sent.push(onKey ? 'key' : env.ANTHROPIC_AUTH_TOKEN ?? 'main')
    const resetsAt = new Date(clock.now() + 3_600_000).toISOString()
    rateLimits.splice(0, 9, ...(onKey ? [] : [{ kind: 'five_hour', percentUsed: 100, resetsAt }]))
    plan['t-work'] = { five_hour: { utilization: 100, resets_at: resetsAt } } // what the usage endpoint says of work
    return { turnId: e.turnId, index: e.index, answer: onKey ? 'ok' : '', toolUses: [], stopReason: onKey ? 'end_turn' : null, usage: null }
  })
  const step = async () => {
    const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    for (;;) {
      const r = await s.next()
      if (r.done) return r.value
    }
  }
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)

  expect(await run($, 'add api')).toContain('Paste your Console API key')
  expect(panes.has('profile-api-key')).toBe(true)
  await $.ui.mount({ plugin: 'profile', surface: 'terminal', component: 'Pane', requestId: 'profile-api-key',
    props: { title: 'Console API key', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 2 }, view: {} } } as any)
  await $.ui.input({ plugin: 'profile', key: 'api-key', text: 'hello' })
  expect(toasts.at(-1)).toContain('No Console API key')
  await $.ui.input({ plugin: 'profile', key: 'api-key', text: ` ANTHROPIC_API_KEY="${KEY}"\n` }) // the key out of a copied line
  expect(toasts.at(-1)).toBe('✓ api saved: Console API key …WXYZ · billed only once every account is out of usage')
  expect(panes.has('profile-api-key')).toBe(false)
  expect(await run($, 'list')).toContain('○ work  w@x\n○ api   API credit · key …WXYZ')

  expect((await step()).answer).toBe('ok') // work had usage, API credit was chosen over it: it stays
  expect(sent).toEqual(['main', 'key'])
  await clock.advance(61_000)
  expect(env.ANTHROPIC_API_KEY).toBe(KEY)
  // Bash inherits the key: `env` must not carry it into the transcript.
  const printed = (await $.tool.call({ tool: 'Bash', command: 'env', description: 'Print the environment' } as any)) as any
  expect(JSON.stringify(printed)).not.toContain(KEY)
  expect(printed.result.stdout).toBe('ANTHROPIC_API_KEY=[redacted]\nHOME=/home/u\n')
  await run($, 'main')
  sent.length = 0

  expect((await step()).answer).toBe('ok') // main, then work, then the key: asked each time
  expect(sent).toEqual(['main', 't-work', 'key'])
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined() // it would outrank the key
  expect(JSON.parse(files['/home/u/.claude.json']!).customApiKeyResponses.approved).toEqual([KEY.slice(-20)])
  expect(await run($, 'list')).toContain('● api   API credit · key …WXYZ · active')
  expect(await run($, 'remove api')).toContain('switch away first')

  await clock.advance(3_660_000) // the plans reset
  expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(toasts.at(-1)).toBe('main has usage again · back from API credit')

  sent.length = 0
  await $.command.run({ command: 'goal', args: 'ship it', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as any)
  expect((await step()).answer).toBe('ok') // a goal runs: no one to ask
  expect(sent).toEqual(['main', 't-work', 'key'])
  expect(toasts.at(-1)).toBe('Every account is out of usage · on API credit to keep the goal going')

  expect(await run($, 'work')).toContain('✓ Switched to work (w@x)') // back by hand
  expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t-work')
})

test('an account past its windows with extra usage left is not out; once that is used up, it fails over', async ($, on) => {
  const answers = ['Switch to work']
  const { env, signIn, clock, rateLimits, plan } = stage(on, answers)
  on('turn.step', async function* (_$: any, e: any) { // main's requests fail; the engine reads its window at 100%
    const isWork = env.ANTHROPIC_AUTH_TOKEN === 't-work'
    rateLimits.splice(0, 9, { kind: 'five_hour', percentUsed: isWork ? 3 : 100 })
    return { turnId: e.turnId, index: e.index, answer: isWork ? 'ok' : '', toolUses: [], stopReason: isWork ? 'end_turn' : null, usage: null }
  })
  const step = async () => {
    const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    for (;;) {
      const r = await s.next()
      if (r.done) return r.value
    }
  }
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)
  const extra = { is_enabled: true, monthly_limit: 5000, used_credits: 1200, utilization: 24, currency: 'USD' }
  plan['t-main'] = { five_hour: { utilization: 100 }, extra_usage: extra } as any // what the usage endpoint says of main

  expect((await step()).stopReason).toBeNull() // extra usage pays for main: it failed for another reason
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  expect(answers).toEqual(['Switch to work']) // nobody asked

  extra.used_credits = 5000 // the monthly limit reached
  expect((await step()).answer).toBe('ok')
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t-work')
})

test('steps failing together switch once: the rest wait in short sleeps, then all go again on the new account', async ($, on) => {
  const answers = ['Switch to work']
  const { env, signIn, clock, rateLimits, argvs } = stage(on, answers)
  const sent: (string | undefined)[] = []
  on('turn.step', async function* (_$: any, e: any) { // main is used up
    sent.push(env.ANTHROPIC_AUTH_TOKEN)
    const isOut = env.ANTHROPIC_AUTH_TOKEN !== 't-work'
    rateLimits.splice(0, 9, { kind: 'five_hour', percentUsed: isOut ? 100 : 3 })
    return { turnId: e.turnId, index: e.index, answer: isOut ? '' : 'ok', toolUses: [], stopReason: isOut ? null : 'end_turn', usage: null }
  })
  const step = async (turnId: string) => {
    const s = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    for (;;) {
      const r = await s.next()
      if (r.done) return r.value
    }
  }
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)

  const [a, b] = await Promise.all([step('a1'), step('a2')]) // two subagents
  expect([a.answer, b.answer]).toEqual(['ok', 'ok'])
  expect(sent).toEqual([undefined, undefined, 't-work', 't-work'])
  expect(answers).toEqual([]) // asked once: a second question would have been dismissed
  expect(argvs).toContain('sleep 2') // the waiting step's budget stops while a $ call is in flight
})

test('the cache hit rate counts every turn of parallel subagents ending together', async ($, on) => {
  const { files } = stage(on)
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  const complete = (input: number, read: number) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1',
    usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' } } as any)
  await Promise.all([complete(1000, 0), complete(0, 3000)])
  await $.session.measure({ context: {} as any, rateLimits: [], changed: [] })
  expect(files['/home/u/.claude/profile-statusline/sess-1.txt']).toContain('Cache: 75%')
})

test('the status line is set once, and only where none was', async ($, on) => {
  const { files } = stage(on)
  const path = '/home/u/.claude/settings.json'
  files[path] = '{"enabledPlugins": {"profile@x": true}}'
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  expect(JSON.parse(files[path]!)).toEqual({
    enabledPlugins: { 'profile@x': true },
    statusLine: { type: 'command', command: 'sh ~/.claude/profile-statusline.sh', refreshInterval: 1 },
  })
  files[path] = '{}' // the user took it out
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  expect(files[path]).toBe('{}')
  // set by a version that re-ran it every 10s: once a second now; an interval of the user's own stays
  files[path] = '{"statusLine": {"type": "command", "command": "sh ~/.claude/profile-statusline.sh", "refreshInterval": 10}}'
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  expect(JSON.parse(files[path]!).statusLine.refreshInterval).toBe(1)
  files[path] = '{"statusLine": {"type": "command", "command": "sh ~/.claude/profile-statusline.sh", "refreshInterval": 5}}'
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  expect(JSON.parse(files[path]!).statusLine.refreshInterval).toBe(5)
})

test('a desktop app session: shown as the app\'s account, and never switched, since Claude Code there sends only that', async ($, on) => {
  const { env, signIn, clock, files, keychain } = stage(on)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)
  keychain['cc-swap-login|api'] = JSON.stringify({ apiKey: 'sk-ant-api03-test-0123456789abcdefghijWXYZ' })
  Object.assign(env, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_USER_EMAIL: 'w@x' })
  env.CLAUDE_PROFILE_USING = 'main' // switched by an earlier version, to no effect
  env.ANTHROPIC_AUTH_TOKEN = 't-main'
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  expect(await run($, 'list')).toContain('● work') // the app's account, not the live login (main)
  expect(env.CLAUDE_PROFILE_USING).toBeUndefined()
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()

  const config = files['/home/u/.claude.json']
  expect(await run($, 'main')).toContain('always uses the app\'s own account')
  expect(await run($, 'api')).toContain('always uses the app\'s own account')
  expect(files['/home/u/.claude.json']).toBe(config) // nothing switched, no key approved
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(await run($, '')).toContain('Accounts') // no picker of accounts it can't switch to
})

test('a status line of the user\'s own is kept', async ($, on) => {
  const { files } = stage(on)
  const path = '/home/u/.claude/settings.json'
  files[path] = '{"statusLine": {"type": "command", "command": "ccstatusline"}}'
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  expect(files[path]).toBe('{"statusLine": {"type": "command", "command": "ccstatusline"}}')
})

test('a status line the project sets in place of the plugin\'s brings the row back above the prompt', async ($, on) => {
  const { files } = stage(on)
  on('session.root', () => ({ value: '/p' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['engine'] }))
  files['/home/u/.claude/settings.json'] = '{"statusLine": {"type": "command", "command": "sh ~/.claude/profile-statusline.sh"}}'
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  const shown = async () => {
    await $.session.measure({ context: {} as any, rateLimits: [{ kind: 'five_hour', percentUsed: 5 }], changed: ['rateLimits'] })
    const ui = await $.ui.mount({
      plugin: 'profile', surface: 'terminal', component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    return (await ui.find({ type: 'Text' }))?.text !== 'engine'
  }
  expect(await shown()).toBe(false) // the plugin's status line prints it
  files['/p/.claude/settings.json'] = '{"statusLine": {"type": "command", "command": "my-line"}}'
  expect(await shown()).toBe(true)
  files['/p/.claude/settings.local.json'] = '{"statusLine": {"type": "command", "command": "cat ~/.claude/profile-status.txt"}}'
  expect(await shown()).toBe(false) // local settings over the project's
  files['/p/.claude/settings.local.json'] = '{"statusLine": {"type": "command", "command": "my-line"}}'
  delete files['/p/.claude/settings.json']
  expect(await shown()).toBe(true)
})

test('a narrow terminal drops the email, the countdowns, the cache, then the 7d bar, so the row never wraps', async ($, on) => {
  const { clock } = stage(on)
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 98_500, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' } } as any)
  const at = (min: number) => new Date(clock.now() + min * 60_000).toISOString()
  await $.session.measure({ context: {} as any, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: at(125) }, { kind: 'seven_day', percentUsed: 100, resetsAt: at(4560) }], changed: ['rateLimits'] } as any)
  // In full: ● main me@x │ 5h ▰▰▰▰▰▰▰▰▰▰ 100% ↻ 2h 5m │ 7d ▰▰▰▰▰▰▰▰▰▰ 100% ↻ 3d 4h │ Cache 99%, 81 cells.
  const row = async (bodyColumns: number) => {
    const ui = await $.ui.mount({
      plugin: 'profile', surface: 'terminal', component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    const has = async (text: string) => !!(await ui.find({ type: 'Text', text }))
    return [await has('me@x'), await has('↻ 2h 5m'), await has('↻ 3d 4h'), await has('Cache'), await has('7d'), await has('5h'), await has('main')]
  }
  expect(await row(81)).toEqual([true, true, true, true, true, true, true])
  expect(await row(80)).toEqual([false, true, true, true, true, true, true])
  expect(await row(75)).toEqual([false, false, false, true, true, true, true])
  expect(await row(59)).toEqual([false, false, false, false, true, true, true])
  expect(await row(47)).toEqual([false, false, false, false, false, true, true])
})

test('a weekly bar shows only on an account with a weekly limit; a window past its reset reads 0%', async ($, on) => {
  const { files, clock } = stage(on)
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  const row = () => files['/home/u/.claude/profile-status.txt']!.replace(/\x1b\[\d+m/g, '')
  await $.session.measure({ context: {} as any, rateLimits: [{ kind: 'five_hour', percentUsed: 5 }, { kind: 'seven_day', percentUsed: 40 }], changed: ['rateLimits'] })
  expect(row()).toBe('● main me@x │ 5h ▰▱▱▱▱▱▱▱▱▱ 5% │ 7d ▰▰▰▰▱▱▱▱▱▱ 40%\n')
  await $.session.measure({ context: {} as any, rateLimits: [{ kind: 'five_hour', percentUsed: 6 }], changed: ['rateLimits'] })
  expect(row()).toBe('● main me@x │ 5h ▰▱▱▱▱▱▱▱▱▱ 6%\n')
  const resetsAt = new Date(clock.now() + 10 * 60_000).toISOString()
  await $.session.measure({ context: {} as any, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], changed: ['rateLimits'] } as any)
  await clock.advance(11 * 60_000) // reset since, no response yet
  expect(row()).toBe('● main me@x │ 5h ▱▱▱▱▱▱▱▱▱▱ 0%\n')
})

test('the band above the prompt shows the account and its usage', async ($, on) => {
  const { clock, files, context } = stage(on)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['engine'] })) // Claude Code's own band
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensAfter: 12_000 })) // Claude Code's own compaction
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  const resetsAt = new Date(clock.now() + 125 * 60_000).toISOString()
  const measure = () => $.session.measure({ context: {} as any, rateLimits: [{ kind: 'five_hour', percentUsed: 62.4, resetsAt }], changed: ['rateLimits'] } as any)
  await measure()
  const band = () => $.ui.mount({
    plugin: 'profile', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  // The same row, coloured, for a status line to print.
  const plain = (path: string) => files[path]!.replace(/\x1b\[\d+m/g, '')
  expect(plain('/home/u/.claude/profile-status.txt')).toBe('● main me@x │ 5h ▰▰▰▰▰▰▱▱▱▱ 62% ↻ 2h 5m\n')
  // And this session's whole status line, ccstatusline's line above it, for profile-statusline.sh.
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 98_500, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' } } as any)
  await measure()
  expect(plain('/home/u/.claude/profile-statusline/sess-1.txt')).toBe(
    'Model: Opus 5.5@EFFORT@ | Ctx: 216.3k | Cache: 99% | Context: ▰▰▱▱▱▱▱▱▱▱ 216.3k/1.0M (22%)\n● main me@x │ 5h ▰▰▰▰▰▰▱▱▱▱ 62% ↻ 2h 5m\n')
  // the script since 0.4.4 counts down to it; the .txt above is for one from before, which another window may have written
  expect(plain('/home/u/.claude/profile-statusline/sess-1.live.txt')).toContain('62% ↻ @R7500@\n')
  expect(files['/home/u/.claude/profile-statusline.sh']).toContain('profile-statusline/$id')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'profile', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await ui.find({ text: 'main' })).toBeDefined()
    expect(await ui.find({ text: 'me@x' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '62%' }))?.props.color).toBe('warning')
    expect(await ui.find({ text: '↻ 2h 5m' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '99%' }))?.props.color).toBe('success') // the prompt cache's hit rate
    await ui.unmount()
  }
  // Once the status line prints the file, the row above the prompt steps aside.
  files['/home/u/.config/ccstatusline/settings.json'] = '{"commandPath": "cat ~/.claude/profile-status.txt"}'
  await measure()
  expect(await (await band()).find({ type: 'Text', text: 'main' })).toBeDefined() // ccstatusline isn't the status line
  files['/home/u/.claude/settings.json'] = '{"statusLine": {"type": "command", "command": "ccstatusline"}}'
  await measure()
  expect((await (await band()).find({ type: 'Text' }))?.text).toBe('engine')
  const desktop = await $.ui.mount({
    plugin: 'profile', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await desktop.find({ type: 'Text', text: 'main' })).toBeDefined() // no status line there
  // /compact is no turn, so no measure follows: the line shows the smaller context at once.
  delete context.tokens // the engine measures the context again only from the next response
  delete context.percent
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
  expect(plain('/home/u/.claude/profile-statusline/sess-1.txt')).toContain('Ctx: 12.0k | Cache: 99% | Context: ▱▱▱▱▱▱▱▱▱▱ 12.0k/1.0M (1%)')
  await clock.advance(60_000) // the minute's redraw keeps it
  expect(plain('/home/u/.claude/profile-statusline/sess-1.txt')).toContain('Ctx: 12.0k')
})

test('reconnects Remote Control after a switch when it is on at startup', async ($, on) => {
  const { files, remote, signIn, clock } = stage(on)
  files['/home/u/.claude/settings.json'] = '{"remoteControlAtStartup":true}'
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3500)
  expect(remote.length).toBe(1) // after add put main back
  await run($, 'work')
  await clock.advance(500)
  expect(remote.length).toBe(2) // after add put main back, and after the switch
})

test('reconnects Remote Control for a phone attached, not for the desktop app', async ($, on) => {
  const { remote, signIn, clock, surfaces } = stage(on)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3500)
  surfaces.splice(0, 1, 'desktop')
  await run($, 'work')
  await clock.advance(500)
  expect(remote.length).toBe(0)
  surfaces.push('mobile')
  await run($, 'main')
  await clock.advance(500)
  expect(remote.length).toBe(1)
})

test('in the desktop app, reconnects only a session that turned Remote Control on', async ($, on) => {
  const { files, remote, signIn, clock, surfaces } = stage(on)
  files['/home/u/.claude/settings.json'] = '{"remoteControlAtStartup":true}' // the terminal's auto-connect
  surfaces.splice(0, 1, 'desktop')
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3500)
  await run($, 'work')
  await clock.advance(500)
  expect(remote.length).toBe(0)
  await $.command.run({ command: 'remote-control', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as any)
  expect(remote.length).toBe(1) // the person turned it on
  await run($, 'main')
  await clock.advance(500)
  expect(remote.length).toBe(2)
})

test('reconnects Remote Control when another window switches the login', async ($, on) => {
  const { files, remote, signIn, clock } = stage(on)
  files['/home/u/.claude/settings.json'] = '{"remoteControlAtStartup":true}'
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  await clock.advance(5000)
  expect(remote.length).toBe(0) // nothing changed
  signIn('t-work', 'w@x') // e.g. /profile work in another window
  await clock.advance(5500)
  expect(remote.length).toBe(1)
  await clock.advance(5000)
  expect(remote.length).toBe(1) // once per change
})

test('a switched session follows token refreshes, so its copy is never the revoked one', async ($, on) => {
  const { keychain, env, signIn, clock } = stage(on)
  await $.session.start({ source: 'startup', cwd: '/p' } as any)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3500)
  await run($, 'work')
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t-work')
  keychain['Claude Code-credentials|me'] = creds('t-work-2') // another window refreshed work
  await clock.advance(60_000)
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t-work-2')
  await run($, 'main') // back on the startup login: no copy to keep
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
})

test("a saved copy nothing used for hours is renewed on a switch, never handed over dead; one that can't be is refused", async ($, on) => {
  const s = stage(on)
  await start($)
  await added($, s, 'work', 't-work', 'w@x')
  const work = JSON.parse(s.keychain['cc-swap-login|work']!)
  const idle = (refreshToken: string) => JSON.stringify({ ...work, creds: JSON.stringify({ claudeAiOauth: {
    accessToken: 't-work', refreshToken, expiresAt: s.clock.now() - 8 * 3_600_000, scopes: ['user:inference'] } }) })
  s.keychain['cc-swap-login|work'] = idle('r-spent')
  const was = JSON.stringify(s.keychain)
  expect(await run($, 'work')).toBe("! work's saved login has expired and couldn't be renewed · /profile remove work, then /profile add work")
  expect(JSON.stringify(s.keychain)).toBe(was) // nothing changed
  expect(s.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()

  s.keychain['cc-swap-login|work'] = idle('r-work')
  s.session.renewals['r-work'] = 't-work-2'
  expect(await run($, 'work')).toContain('✓ Switched to work (w@x)')
  expect([s.env.ANTHROPIC_AUTH_TOKEN, s.liveToken(), s.tokens().work]).toEqual(['t-work-2', 't-work-2', 't-work-2'])
  const saved = JSON.parse(JSON.parse(s.keychain['cc-swap-login|work']!).creds).claudeAiOauth
  expect(saved).toEqual({ accessToken: 't-work-2', refreshToken: 'r-t-work-2', expiresAt: s.clock.now() + 28_800_000, scopes: ['user:inference'] })
})

test('a switched session renews the token it holds once it expires, and reads its plan usage every minute, idle or mid-turn', async ($, on) => {
  const s = stage(on)
  await start($)
  const t0 = s.clock.now() // the minute's timer counts from here
  await added($, s, 'work', 't-work', 'w@x')
  await run($, 'work')
  // Work's token runs out in 90s, and no window sends it to renew it ahead.
  s.keychain[LIVE] = JSON.stringify({ claudeAiOauth: { accessToken: 't-work', refreshToken: 'r-t-work', expiresAt: t0 + 90_000 }, mcpOAuth: { linear: 'm1' } })
  s.session.renewals['r-t-work'] = 't-work-2'
  s.plan['t-work-2'] = { five_hour: { utilization: 42 } }
  await s.clock.set(t0 + 60_000) // due, not expired: windows sending the live login renew it first
  expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe('t-work')
  await s.clock.set(t0 + 120_000) // expired, and none did
  expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe('t-work-2')
  expect(JSON.parse(s.keychain[LIVE]!)).toMatchObject({ claudeAiOauth: { accessToken: 't-work-2' }, mcpOAuth: { linear: 'm1' } }) // MCP sign-ins stay
  expect(s.tokens().work).toBe('t-work-2') // the saved copy held the same token: renewed too
  // No response since the switch: the minute's timer read the plan, with the renewed token.
  expect(s.files['/home/u/.claude/profile-status.txt']!.replace(/\x1b\[\d+m/g, '')).toBe('● work w@x │ 5h ▰▰▰▰▱▱▱▱▱▱ 42%\n')
})

test('bare /profile picks from a dialog, falls back to the list', async ($, on) => {
  const { signIn, clock } = stage(on, ['work (w@x)'])
  expect(await run($, '')).toContain('● main  me@x · active')
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)
  expect(await run($, '')).toContain('✓ Switched to work (w@x)')
  expect(await run($, '')).toContain('● work  w@x · active') // dismissed: the list
})

test('autocompletes accounts and verbs', async ($, on) => {
  stage(on)
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  await run($, 'add work')
  const ac = (text: string, token: string) =>
    $.prompt.autocomplete({ text, cursor: text.length, token, start: text.length - token.length }).then(r => r.suggestions.map(s => s.text))
  expect(await ac('/profile w', 'w')).toEqual(['work'])
  expect(await ac('/profile r', 'r')).toEqual(['remove'])
})

test('on Linux the logins are files: ~/.claude/.credentials.json and ~/.claude/profile-logins', async ($, on) => {
  const files: Record<string, string> = {
    '/home/u/.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'me@x' } }),
    '/home/u/.claude/.credentials.json': creds('t-main'),
  }
  const argvs: string[] = []
  let isDiskFull = false
  const env: Record<string, string | undefined> = { HOME: '/home/u' }
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', (_$: any, e: any) => ((env[e.name] = e.value), { value: undefined }))
  mock.store(on)
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('fs.read', (_$: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', (_$: any, e: any) => ((files[e.path] = e.text), { value: undefined }))
  on('fs.list', (_$: any, e: any) => ({
    value: Object.keys(files).filter(f => f.startsWith(`${e.path}/`)).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', (_$: any, e: any) => {
    argvs.push(e.argv.join(' '))
    if (e.argv[0] === 'rm') delete files[e.argv[2]]
    if (e.argv[0] === 'sh' && e.argv[2].includes('mv -f')) {
      if (isDiskFull) return { value: { exitCode: 1, stdout: '', stderr: 'No space left on device', isStdoutTruncated: false, isStderrTruncated: false } }
      files[e.argv[4]] = e.init.stdin // the file moved into place
    }
    return { value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Linux\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await run($, 'add work')
  expect(argvs.some(a => a.includes('security'))).toBe(false)
  files['/home/u/.claude/.credentials.json'] = creds('t-work') // what `claude auth login` writes
  files['/home/u/.claude.json'] = JSON.stringify({ oauthAccount: { emailAddress: 'w@x' } })
  await clock.advance(3000)
  expect(files['/home/u/.claude/profile-logins/work.json']).toContain('t-work')
  expect(files['/home/u/.claude/.credentials.json']).toBe(creds('t-main')) // main put back
  expect(argvs.some(a => a.includes('umask 077'))).toBe(true)

  expect(await run($, 'work')).toContain('✓ Switched to work (w@x)')
  expect(files['/home/u/.claude/.credentials.json']).toBe(creds('t-work'))
  expect(await run($, 'list')).toContain('● work  w@x · active')
  await run($, 'main')
  isDiskFull = true // the write goes to a file moved into place: the old one stays whole
  expect(await run($, 'work')).toMatch(/^! Writing \/home\/u\/.claude\/\S+ failed/)
  expect(files['/home/u/.claude/.credentials.json']).toBe(creds('t-main'))
  isDiskFull = false
  expect(await run($, 'remove work')).toBe('✓ Removed work')
  expect(files['/home/u/.claude/profile-logins/work.json']).toBeUndefined()
})

// Failures the reliability audit reproduced: each test fails without its fix.

const CONSOLE_KEY = 'sk-ant-api03-test-0123456789abcdefghijWXYZ'
const LINE = (sid: string) => `/home/u/.claude/profile-statusline/${sid}.txt`
const start = ($: any) => $.session.start({ source: 'startup', cwd: '/p' } as any)

/** `/profile add <name>`, and the browser sign-in as `email`. */
async function added($: any, s: ReturnType<typeof stage>, name: string, tok: string, email: string) {
  expect(await run($, `add ${name}`)).toContain('✓ Sign-in for')
  s.signIn(tok, email)
  await s.clock.advance(3000)
}

async function step($: any, turnId = 't1') {
  const it = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for (;;) {
    const r = await it.next()
    if (r.done) return r.value
  }
}

/** The API: main (the login the session started on) is used up; another account or the Console key answers. */
function api(on: any, s: ReturnType<typeof stage>, before?: (turnId: string) => Promise<void>) {
  const sent: string[] = []
  on('turn.step', async function* (_$: any, e: any) {
    if (before) await before(e.turnId)
    const who = !s.env.ANTHROPIC_AUTH_TOKEN && s.env.ANTHROPIC_API_KEY === CONSOLE_KEY ? 'key' : s.env.ANTHROPIC_AUTH_TOKEN ?? 'main'
    sent.push(who)
    const isOut = who === 'main'
    s.rateLimits.splice(0, 9, ...(isOut ? [{ kind: 'five_hour', percentUsed: 100 }] : []))
    return { turnId: e.turnId, index: e.index, answer: isOut ? '' : 'ok', toolUses: [], stopReason: isOut ? null : 'end_turn', usage: null }
  })
  return sent
}

test('a sign-in is saved only once it is whole: retried after a failed write, held till its credential lands, a refresh of the previous login kept, one account under two names refused', async ($, on) => {
  const s = stage(on)
  // The slot write fails once: tried again, and main put back.
  expect(await run($, 'add work')).toContain('✓ Sign-in for work opened')
  s.session.isKeychainBroken = true
  s.signIn('t-work', 'w@x')
  await s.clock.advance(3000)
  s.session.isKeychainBroken = false
  await s.clock.advance(3000)
  expect(s.tokens().work).toBe('t-work')
  expect(s.liveEmail()).toBe('me@x')

  // ~/.claude.json names the new account before its credential is written.
  expect(await run($, 'add home')).toContain('✓ Sign-in for home opened')
  s.files[CONFIG] = JSON.stringify({ ...JSON.parse(s.files[CONFIG]!), oauthAccount: { emailAddress: 'h@x' } })
  await s.clock.advance(3000)
  expect(s.tokens().home).toBeUndefined()
  s.keychain[LIVE] = creds('t-home')
  await s.clock.advance(3000)
  expect(s.tokens().home).toBe('t-home')

  // A window refreshes main while the browser sign-in takes minutes: the fresh copy is the one put back.
  expect(await run($, 'add personal')).toContain('✓ Sign-in for personal opened')
  s.keychain[LIVE] = creds('t-main-2')
  await s.clock.advance(6000)
  s.signIn('t-personal', 'p@x')
  await s.clock.advance(3000)
  expect(s.liveToken()).toBe('t-main-2')

  // The browser reused home's claude.ai sign-in: not saved a second time.
  expect(await run($, 'add other')).toContain('✓ Sign-in for other opened')
  s.signIn('t-home-b', 'h@x')
  await s.clock.advance(3000)
  expect(s.tokens().other).toBeUndefined()
  expect(s.toasts.at(-1)).toContain("That sign-in is home's account")
  expect(s.liveEmail()).toBe('me@x')

  // `claude auth login` writes the credential, then the account seconds later: nothing lands on main.
  expect(await run($, 'add fourth')).toContain('✓ Sign-in for fourth opened')
  s.keychain[LIVE] = creds('t-fourth')
  await s.clock.advance(6000)
  s.signIn('t-fourth', 'f@x')
  await s.clock.advance(3000)
  expect([s.tokens().main, s.tokens().fourth, s.liveToken()]).toEqual(['t-main-2', 't-fourth', 't-main-2'])

  // The browser came back as the account you're on: the add ends once the sign-in has, keeping the new credential.
  s.session.loginPid = '777'
  expect(await run($, 'add fifth')).toContain('✓ Sign-in for fifth opened')
  s.signIn('t-main-3', 'me@x')
  await s.clock.advance(3000)
  expect(s.tokens().fifth).toBeUndefined() // still running: could be a refresh
  s.session.isLoginRunning = false
  await s.clock.advance(3000)
  expect(s.toasts.at(-1)).toContain("That sign-in is main's account, the one you're on, so fifth wasn't saved")
  expect(s.tokens().main).toBe('t-main-3')
  expect(await run($, 'add fifth')).toContain('✓ Sign-in for fifth opened') // no 10-minute wait
})

test("a login is never saved under another account's name: a failed config write rolls back, another window's half-done switch is caught, an unreadable account stops an add, a pending add holds switches", async ($, on) => {
  const s = stage(on, ['Switch to main'])
  on('turn.step', async function* (_$: any, e: any) { // home is used up
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  await added($, s, 'work', 't-work', 'w@x')
  await added($, s, 'home', 't-home', 'h@x')

  s.session.failWrite.add(CONFIG)
  expect(await run($, 'work')).toMatch(/^! /)
  expect(s.liveToken()).toBe('t-main') // the Keychain went back
  expect(await run($, 'work')).toContain('✓ Switched to work')
  expect(s.tokens().main).toBe('t-main')

  expect(await run($, 'main')).toContain('✓ Switched to main')
  s.keychain[LIVE] = creds('t-work') // another window's /profile work, between its two writes
  expect(await run($, 'home')).toContain('✓ Switched to home')
  expect(s.tokens().main).toBe('t-main')

  s.session.unreadable.add(CONFIG) // over 4 MiB: nothing to save the live login by
  expect(await run($, 'add personal')).toMatch(/^! Can't read your account/)
  expect(s.argvs.filter(a => a.includes('claude auth login'))).toHaveLength(2)
  s.session.unreadable.delete(CONFIG)

  expect(await run($, 'add personal')).toContain('✓ Sign-in for personal opened')
  expect(await run($, 'work')).toMatch(/^! The sign-in for personal isn't finished/)
  await s.clock.advance(3000)
  expect(s.tokens().personal).toBeUndefined()
  s.plan['t-home'] = { five_hour: { utilization: 100, resets_at: new Date(s.clock.now() + 3_600_000).toISOString() } }
  await step($) // home runs out: the switch picked is refused, and a notice says why
  expect(s.toasts.at(-1)).toContain("the switch didn't happen: The sign-in for personal isn't finished")
})

test("data that can't be read doesn't break the plugin: a failed uname, a name printed as hex, a cut-off account, a Keychain listing that fails at startup", async ($, on) => {
  const s = stage(on)
  s.session.isUnameBlocked = true // refused, never taken for Linux: no sign-in starts unwatched
  expect(await run($, 'add work')).toMatch(/^! /)
  expect(s.argvs.some(a => a.includes('claude auth login'))).toBe(false)
  s.session.isUnameBlocked = false

  s.session.isHexForNonAscii = true
  expect(await run($, 'add work')).toContain('✓ Sign-in for work opened')
  s.keychain[LIVE] = creds('t-work')
  s.files[CONFIG] = JSON.stringify({ ...JSON.parse(s.files[CONFIG]!), oauthAccount: { emailAddress: 'w@x', displayName: 'Zoë' } })
  await s.clock.advance(3000)
  expect(await run($, 'list')).toContain('○ work  w@x')

  s.keychain['cc-swap-login|bad'] = '{"creds":"{\\"claudeAiOauth' // cut off mid-write
  expect(await run($, 'list')).toContain('● main')
  expect(await run($, 'remove bad')).toBe('✓ Removed bad')

  s.signIn('t-work', 'w@x') // this window starts on work, and its first Keychain listing fails
  s.session.dumpFailures = 1
  await start($)
  expect(s.env.CLAUDE_PROFILE_STARTED_ON).toBe('work')
})

test('a half-written ~/.claude.json at startup still records the login this process loaded', async ($, on) => {
  const s = stage(on)
  s.keychain['cc-swap-login|main'] = JSON.stringify({ creds: creds('t-main'), oauthAccount: { emailAddress: 'me@x' } })
  s.keychain['cc-swap-login|work'] = JSON.stringify({ creds: creds('t-work'), oauthAccount: { emailAddress: 'w@x' } })
  s.session.tornReads = 2
  await start($)
  s.signIn('t-work', 'w@x') // later, another window makes work live
  expect(s.env.CLAUDE_PROFILE_STARTED_ON).toBe('main')
  expect(await run($, 'list')).toContain('● main  me@x · active')
})

test("remove: cancels a pending add from any window, says so when the delete fails, drops the name's old readings", async ($, on) => {
  const s = stage(on)
  await start($)
  s.files[MARK] = JSON.stringify({ name: 'work', prev: 'main', prevAccount: { emailAddress: 'me@x' }, until: s.clock.now() + 600_000, pid: '4242' })
  expect(await run($, 'remove work')).toBe('✓ Removed work') // another window's add
  expect(s.argvs).toContain('kill 4242') // its browser sign-in stops too
  s.files[MARK] = JSON.stringify({ name: 'home', prev: 'main', until: s.clock.now() + 600_000, pid: '4343' })
  s.session.isLoginRunning = false // exited: the pid may be another process's by now
  expect(await run($, 'remove home')).toBe('✓ Removed home')
  expect(s.argvs).not.toContain('kill 4343')

  await added($, s, 'work', 't-work', 'w@x')
  s.plan['t-work'] = { five_hour: { utilization: 100, resets_at: new Date(s.clock.now() + 4 * 3_600_000).toISOString() } }
  await run($, 'work')
  await run($, 'main')
  s.session.isDeleteBroken = true
  expect(await run($, 'remove work')).toMatch(/^! Couldn't remove work/)
  s.session.isDeleteBroken = false
  expect(await run($, 'remove work')).toBe('✓ Removed work')
  await added($, s, 'work', 't-work2', 'w2@x') // another account under the name
  expect(await run($, 'list')).not.toContain('w2@x · 5h')
})

test("plan readings land on the right account: one in flight during a switch keeps its own; a switched account the endpoint can't read goes by its last", async ($, on) => {
  const s = stage(on, ['Switch to main'])
  on('turn.step', async function* (_$: any, e: any) { // work is used up
    const isOut = s.env.ANTHROPIC_AUTH_TOKEN === 't-work'
    return { turnId: e.turnId, index: e.index, answer: isOut ? '' : 'ok', toolUses: [], stopReason: isOut ? null : 'end_turn', usage: null }
  })
  await start($)
  await added($, s, 'work', 't-work', 'w@x')
  s.plan['t-work'] = { five_hour: { utilization: 100, resets_at: new Date(s.clock.now() + 3_600_000).toISOString() } }
  s.plan['t-main'] = { five_hour: { utilization: 10 } }
  await run($, 'work')
  await s.clock.advance(61_000)
  const held = s.holdUsage('t-work')
  const measuring = $.session.measure({ context: {} as any, rateLimits: [], changed: ['context'] }) // reads work again
  await held.reached
  expect(await run($, 'main')).toContain('✓ Switched to main')
  held.open()
  await measuring
  expect(await run($, 'list')).toContain('● main  me@x · 5h 10%')

  expect(await run($, 'work')).toContain('✓ Switched to work')
  s.session.usageStatus['t-work'] = 429 // the endpoint takes a few reads a minute
  expect((await step($)).answer).toBe('ok')
  expect(s.asked).toEqual(['work is out of usage. Switch to main and continue?'])
})

test("goals and API credit: a goal the model sets runs unattended, an expired login that can't be renewed is named, clearing the goal stops the billing it took by itself", async ($, on) => {
  const s = stage(on) // nobody answers: a question is dismissed
  on('tool.call', { tool: 'ProposeGoal' }, (_$: any, e: any) => ({ result: { condition: e.condition, askUser: false } }))
  on('command.run', { command: 'goal' }, () => ({ text: '' }))
  const sent = api(on, s)
  await start($)
  await added($, s, 'work', 't-work', 'w@x')
  const work = JSON.parse(s.keychain['cc-swap-login|work']!)
  // Expired hours ago, and its refresh token spent elsewhere: the endpoint refuses it.
  s.keychain['cc-swap-login|work'] = JSON.stringify({ ...work, creds: JSON.stringify({ claudeAiOauth: { accessToken: 't-work', refreshToken: 'r-spent', expiresAt: s.clock.now() - 3_600_000 } }) })
  s.keychain['cc-swap-login|api'] = JSON.stringify({ apiKey: CONSOLE_KEY })

  await $.tool.call({ tool: 'ProposeGoal', condition: 'all tests pass', ask_user: false } as any)
  expect((await step($)).answer).toBe('ok')
  expect(sent).toEqual(['main', 'key'])
  expect(s.asked).toEqual([])
  expect(s.toasts.at(-1)).toContain("work: couldn't renew the saved login")

  await command($, 'goal', 'clear')
  expect(s.env.ANTHROPIC_API_KEY).toBeUndefined()
  sent.length = 0
  expect((await step($)).answer).toBe('') // asked, and dismissed: not billed
  expect(sent).toEqual(['main'])
  expect(s.asked[0]).toContain("work's saved login couldn't be renewed")
})

test('steps running out together ask once, even when the answer is to stay', async ($, on) => {
  const s = stage(on, ['Stay on main', 'Stay on main'])
  let bIn!: () => void
  let bGo!: () => void
  const isIn = new Promise<void>(r => (bIn = r))
  const go = new Promise<void>(r => (bGo = r))
  api(on, s, async turnId => {
    if (turnId !== 'b') return
    bIn() // b's request is in flight on main
    await go
  })
  await start($)
  await added($, s, 'work', 't-work', 'w@x')
  const b = step($, 'b')
  await isIn
  expect((await step($, 'a')).stopReason).toBeNull() // asked: stay
  bGo() // b's refusal lands a moment later
  expect((await b).stopReason).toBeNull()
  expect(s.asked).toHaveLength(1)
})

test('a key a tool started with stays blanked when the session leaves API credit while it runs', async ($, on) => {
  const s = stage(on)
  let ran!: () => void
  let done!: () => void
  const isRan = new Promise<void>(r => (ran = r))
  const isDone = new Promise<void>(r => (done = r))
  on('tool.call', { tool: 'Bash' }, async () => {
    const inherited = s.env.ANTHROPIC_API_KEY // what the child process got
    ran()
    await isDone // `sleep 90; env`
    const out = `ANTHROPIC_API_KEY=${inherited}\n`
    return { result: { stdout: out, stderr: '', interrupted: false }, text: out, ref: 1 }
  })
  await start($)
  await added($, s, 'work', 't-work', 'w@x')
  s.keychain['cc-swap-login|api'] = JSON.stringify({ apiKey: CONSOLE_KEY })
  expect(await run($, 'api')).toContain('✓ Switched to api')
  const printed = $.tool.call({ tool: 'Bash', command: 'sleep 90; env', description: 'env' } as any)
  await isRan
  expect(await run($, 'main')).toContain('✓ Switched to main')
  done()
  expect(JSON.stringify(await printed)).not.toContain(CONSOLE_KEY)
})

test('a token sync in flight never puts back a token a switch just dropped; a moment of unreadable ~/.claude.json is no login change', async ($, on) => {
  const s = stage(on)
  s.files['/home/u/.claude/settings.json'] = '{"remoteControlAtStartup":true}'
  await start($)
  const t0 = s.clock.now() // the minute's timer counts from here
  await added($, s, 'work', 't-work', 'w@x')
  await run($, 'work')
  s.keychain[LIVE] = creds('t-work-2') // another window refreshed work
  s.session.dumpDelayMs = 1000 // the Keychain is slow for a moment
  await s.clock.set(t0 + 60_000) // the minute's token sync starts, and waits on it
  s.session.dumpDelayMs = 0
  expect(await run($, 'main')).toContain('✓ Switched to main')
  await s.clock.advance(1000) // the slow read returns
  expect(s.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined() // still on main, the login this process loaded

  const reconnects = s.remote.length
  s.session.unreadable.add(CONFIG) // caught mid-write
  await s.clock.advance(5000)
  s.session.unreadable.delete(CONFIG)
  await s.clock.advance(5000)
  expect(s.remote.length).toBe(reconnects)
})

test('the status line follows the conversation: a compaction shows at once, /model and /usage are fresh, a /clear draws the next one and drops the last one\'s keys', async ($, on) => {
  const s = stage(on)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensAfter: 12_000 }))
  on('command.run', { command: 'model' }, () => ((s.model.id = 'claude-sonnet-4-5'), { text: '' }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  const line = (sid: string) => (s.files[LINE(sid)] ?? '').replace(/\x1b\[\d+m/g, '')
  await start($)

  // The engine still reports the old size to the hook: the compaction's own figure shows.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
  expect(line('sess-1')).toContain('Ctx: 12.0k')
  Object.assign(s.context, { tokens: 40_000, percent: 4 }) // the next turn's reading
  await $.session.measure({ context: {} as any, rateLimits: [], changed: ['context'] })
  expect(line('sess-1')).toContain('Ctx: 40.0k')

  await command($, 'model', 'sonnet')
  expect(line('sess-1')).toContain('Model: Sonnet 4.5')

  await added($, s, 'work', 't-work', 'w@x')
  s.plan['t-work'] = { five_hour: { utilization: 5 } }
  await run($, 'work')
  s.plan['t-work'] = { five_hour: { utilization: 50 } } // used meanwhile on claude.ai
  await s.clock.advance(61_000)
  expect((await command($, 'usage')).text).toContain('50%')

  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't',
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' } } as any)
  expect(s.store['cache:sess-1']).toBeDefined()
  s.session.id = 'sess-2' // /clear: the process goes on under a new id
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: {} } as any)
  await s.clock.advance(1000)
  expect(line('sess-2')).toContain('● work')
  expect(s.store['cache:sess-1']).toBeUndefined()
})

test('the login this process loaded: a Keychain read that fails at startup is tried again, and /login here changes it', async ($, on) => {
  const s = stage(on)
  on('command.run', { command: 'login' }, () => (s.signIn('t-work', 'w@x'), { text: '' }))
  s.keychain['cc-swap-login|main'] = JSON.stringify({ creds: creds('t-main'), oauthAccount: { emailAddress: 'me@x' } })
  s.keychain['cc-swap-login|work'] = JSON.stringify({ creds: creds('t-work'), oauthAccount: { emailAddress: 'w@x' } })
  s.session.readFailures = 1 // locked for a moment: not "logged out", which would pin a made-up name
  await start($)
  expect(s.env.CLAUDE_PROFILE_STARTED_ON).toBe('main')
  await command($, 'login')
  expect(s.env.CLAUDE_PROFILE_STARTED_ON).toBe('work')
  expect(await run($, 'main')).toContain('✓ Switched to main') // not "Already on main"
})
