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
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', (_$: any, e: any) => ((env[e.name] = e.value), { value: undefined }))
  mock.store(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { name: 'profile' } }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  const clock = mock.clock(on)
  on('fs.read', (_$: any, e: any) => (e.path in files ? { value: files[e.path] } : { error: 'ENOENT' }))
  on('fs.write', (_$: any, e: any) => ((files[e.path] = e.text), { value: undefined }))
  on('process.run', (_$: any, e: any) => {
    const a: string[] = e.argv
    argvs.push(a.join(' '))
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
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
  return { keychain, env, argvs, signIn, liveEmail, clock }
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
