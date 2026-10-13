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

/** A fake Keychain behind `security`, and ~/.claude.json, starting logged in as me@x. */
function stage(on: any, answers: string[] = []) {
  const keychain: Record<string, string> = { 'Claude Code-credentials|me': creds('t-main') }
  const files: Record<string, string> = { '/home/u/.claude.json': JSON.stringify({ theme: 'dark', oauthAccount: { emailAddress: 'me@x' } }) }
  const env: Record<string, string | undefined> = { HOME: '/home/u', USER: 'me' }
  const argvs: string[] = []
  const remote: string[] = []
  on('command.run', { command: 'remote-control' }, () => (remote.push('run'), { text: '' }))
  const surfaces = ['terminal']
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.status', () => ({ value: undefined }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 216_300, window: 1_000_000, percent: 22 }, rateLimits: [] } }))
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', (_$: any, e: any) => ((env[e.name] = e.value), { value: undefined }))
  mock.store(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { name: 'profile' } }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  const clock = mock.clock(on)
  on('fs.read', (_$: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', (_$: any, e: any) => ((files[e.path] = e.text), { value: undefined }))
  on('process.run', (_$: any, e: any) => {
    const a: string[] = e.argv
    argvs.push(a.join(' '))
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'uname') return out('Darwin\n')
    if (a[0] === 'sh' && a[2]!.includes('dump-keychain'))
      return out(Object.keys(keychain).filter(k => k.startsWith('cc-swap-login|')).map(k => `    "acct"<blob>="${k.split('|')[1]}"`).join('\n'))
    if (a[0] !== 'security') return out('')
    if (a[1] === '-i') {
      const [, s, acct, hex] = /-s "([^"]+)" -a "([^"]+)" -X (\w+)/.exec(e.init.stdin)!
      keychain[`${s}|${acct}`] = unhex(hex!)
      return out('')
    }
    const s = a[a.indexOf('-s') + 1]
    const acct = a.includes('-a') ? a[a.indexOf('-a') + 1] : undefined
    const key = Object.keys(keychain).find(k => k.startsWith(`${s}|`) && (!acct || k === `${s}|${acct}`))
    if (a[1] === 'delete-generic-password') return key ? (delete keychain[key], out('')) : out('', 44)
    if (!key) return out('', 44)
    return a.includes('-w') ? out(keychain[key]!) : out(`attributes:\n    "acct"<blob>="${key.split('|')[1]}"\n`)
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
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
  return { keychain, env, argvs, signIn, liveEmail, clock, files, remote, surfaces }
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

test('plan usage from each response is kept per account', async ($, on) => {
  const { signIn, clock } = stage(on)
  const measure = (five: number, seven: number) =>
    $.session.measure({ context: {} as any, rateLimits: [{ kind: 'five_hour', percentUsed: five }, { kind: 'seven_day', percentUsed: seven }], changed: ['rateLimits'] })
  await measure(23.4, 40)
  await run($, 'add work')
  signIn('t-work', 'w@x')
  await clock.advance(3000)
  await run($, 'work')
  await measure(5, 12)
  expect(await run($, 'list')).toContain('○ main  me@x · 5h 23% 7d 40%\n● work  w@x · 5h 5% 7d 12% · active')
  const usage = await $.command.run({ command: 'usage', args: '', origin: { kind: 'plugin', name: 'profile' }, presentation: { isFullscreen: false, columns: 80 } } as any)
  expect(usage.text).toContain('Plan usage · work (w@x)')
  expect(usage.text).toContain('5h  █░░░░░░░░░░░░░░░░░░░ 5%')
})

test('the band above the prompt shows the account and its usage', async ($, on) => {
  const { clock, files } = stage(on)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['engine'] })) // Claude Code's own band
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
  expect(plain('/home/u/.claude/profile-status.txt')).toBe('● main me@x   5h ██████░░░░ 62% ↻ 2h 5m\n')
  // And this session's whole status line, ccstatusline's line above it, for profile-statusline.sh.
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 98_500, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' } } as any)
  await measure()
  expect(plain('/home/u/.claude/profile-statusline/sess-1.txt')).toBe(
    'Model: Opus 5.5 | Ctx: 216.3k | Total: 100.0k | Context: ██░░░░░░░░ 216.3k/1.0M (22%)\n● main me@x   5h ██████░░░░ 62% ↻ 2h 5m\n')
  expect(files['/home/u/.claude/profile-statusline.sh']).toContain('profile-statusline/$id.txt')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'profile', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await ui.find({ text: 'main' })).toBeDefined()
    expect(await ui.find({ text: 'me@x' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '62%' }))?.props.color).toBe('warning')
    expect(await ui.find({ text: '↻ 2h 5m' })).toBeDefined()
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
    return { value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Linux\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await run($, 'add work')
  expect(argvs.some(a => a.includes('security'))).toBe(false)
  files['/home/u/.claude/.credentials.json'] = creds('t-work') // what `claude auth login` writes
  files['/home/u/.claude.json'] = JSON.stringify({ oauthAccount: { emailAddress: 'w@x' } })
  await clock.advance(3000)
  expect(files['/home/u/.claude/profile-logins/work.json']).toContain('t-work')
  expect(files['/home/u/.claude/.credentials.json']).toBe(creds('t-main')) // main put back
  expect(argvs.some(a => a.includes('chmod 600'))).toBe(true)

  expect(await run($, 'work')).toContain('✓ Switched to work (w@x)')
  expect(files['/home/u/.claude/.credentials.json']).toBe(creds('t-work'))
  expect(await run($, 'list')).toContain('● work  w@x · active')
  await run($, 'main')
  expect(await run($, 'remove work')).toBe('✓ Removed work')
  expect(files['/home/u/.claude/profile-logins/work.json']).toBeUndefined()
})
