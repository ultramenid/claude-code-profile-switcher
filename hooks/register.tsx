import type { EngineInterface, Register } from 'claude-code'

// Swaps Claude Code's own /login. The live login is the Keychain entry
// "Claude Code-credentials" plus `oauthAccount` in ~/.claude.json; every account
// keeps a copy of both in the Keychain (service cc-swap-login). Switching saves
// the live login into the current account's copy and loads the target's, so the
// next `claude` starts fully on it: plan usage, email, connectors.
// This session loaded its login at start, so it also gets the target's access
// token as ANTHROPIC_AUTH_TOKEN until it ends.
// ponytail: macOS Keychain only; a .credentials.json branch when another OS needs it.
const LIVE = 'Claude Code-credentials'
const SLOT = 'cc-swap-login'
const NAME = /^[\w.-]+$/
const ADD = 'Add account…'
const FOOTER = '/profile <name> switch · /profile add <name> · /profile remove <name>'

type Login = { creds: string; oauthAccount?: { emailAddress?: string } }
type Row = { name: string; email?: string; isActive: boolean; isPending: boolean }

async function names($: EngineInterface): Promise<string[]> {
  return ((await $.store.get('logins')) as string[] | undefined) ?? ['main']
}

async function current($: EngineInterface): Promise<string> {
  return ((await $.store.get('current')) as string | undefined) ?? 'main'
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
  return `${await $.env.get('HOME')}/.claude.json`
}

async function liveLogin($: EngineInterface): Promise<Login | undefined> {
  const creds = await getKey($, LIVE)
  if (!creds) return undefined
  const config = JSON.parse(await $.fs.read(await configPath($)).catch(() => '{}'))
  return { creds, oauthAccount: config.oauthAccount }
}

async function slot($: EngineInterface, name: string): Promise<Login | undefined> {
  const raw = await getKey($, SLOT, name)
  return raw ? JSON.parse(raw) : undefined
}

/** Copies the live login into `name`'s slot (the token may have refreshed since it was loaded). */
async function save($: EngineInterface, name: string) {
  const live = await liveLogin($)
  if (live) await setKey($, SLOT, name, JSON.stringify(live))
}

/** Makes `name`'s slot the live login. */
async function load($: EngineInterface, name: string, login: Login) {
  await setKey($, LIVE, await liveAccount($), login.creds)
  const path = await configPath($)
  const config = JSON.parse(await $.fs.read(path).catch(() => '{}'))
  await $.fs.write(path, `${JSON.stringify({ ...config, oauthAccount: login.oauthAccount }, null, 2)}\n`)
  await $.store.set('current', name)
}

async function rows($: EngineInterface): Promise<Row[]> {
  const cur = await current($)
  return Promise.all((await names($)).map(async name => {
    const login = name === cur ? await liveLogin($) : await slot($, name)
    return { name, email: login?.oauthAccount?.emailAddress, isActive: name === cur, isPending: !login }
  }))
}

// Plain lines the model can read; the CommandOutput hook below draws them in colour.
function listText(list: Row[]): string {
  const w = Math.max(...list.map(r => r.name.length))
  const line = (r: Row) => {
    const detail = [r.email, r.isPending && 'sign-in pending', r.isActive && 'active'].filter(Boolean).join(' · ')
    return `${r.isActive ? '●' : '○'} ${r.name.padEnd(w)}  ${detail}`.trimEnd()
  }
  return ['Accounts', ...list.map(line), '', FOOTER].join('\n')
}

async function show($: EngineInterface) {
  $.ui.status(`account: ${await current($)}`)
}

/**
 * `claude auth login` replaces the live login; once it has, copy it into the new
 * account's slot and put the previous account back. Gives up after 10 minutes.
 */
function watchSignIn($: EngineInterface, name: string, prev: string, prevToken: string | undefined) {
  let ticks = 0
  const timer = $.clock.every(3000, () => void (async () => {
    if (++ticks > 200) return timer.cancel()
    const live = await liveLogin($)
    const tok = accessToken(live?.creds)
    if (!live || !tok || tok === prevToken || !live.oauthAccount?.emailAddress) return
    timer.cancel()
    await setKey($, SLOT, name, JSON.stringify(live))
    const back = await slot($, prev)
    if (back) await load($, prev, back)
    $.ui.toast(`✓ ${name} signed in as ${live.oauthAccount.emailAddress} · /profile ${name} to switch`, { timeoutMs: 8000 })
  })())
}

async function add($: EngineInterface, name: string): Promise<string> {
  if (!NAME.test(name)) return '! Usage: /profile add <name>  (letters, digits, . _ -)'
  if (await slot($, name)) return `! ${name} is already signed in · /profile ${name} to switch, /profile remove ${name} to start over`
  const cur = await current($)
  await save($, cur) // the login is about to replace it
  const prevToken = accessToken((await liveLogin($))?.creds)
  const log = `${await $.env.get('HOME')}/.claude/cc-swap-login.log`
  // Detached: login waits on the browser callback, far past a hook's 10s budget.
  await $.process.run(['sh', '-c', 'nohup env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_AUTH_TOKEN claude auth login >"$1" 2>&1 &', 'sh', log])
  const all = await names($)
  if (!all.includes(name)) await $.store.set('logins', [...all, name])
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
  // Back on the login this session started with: drop the token so usage and email return.
  const startedOn = (await $.store.get(`startedOn:${await $.session.id()}`)) as string | undefined
  await $.env.set('ANTHROPIC_AUTH_TOKEN', name === startedOn ? undefined : accessToken(login.creds))
  await show($)
  const email = login.oauthAccount?.emailAddress
  return [
    `✓ Switched to ${name}${email ? ` (${email})` : ''}`,
    `This session uses it from your next message; reopen Claude Code for its usage, email and connectors.`,
  ].join('\n')
}

async function remove($: EngineInterface, name: string): Promise<string> {
  if (!(await names($)).includes(name)) return '! Usage: /profile remove <name>'
  if ((await current($)) === name) return `! ${name} is the active login · switch away first`
  await $.process.run(['security', 'delete-generic-password', '-s', SLOT, '-a', name]).catch(() => undefined)
  await $.store.set('logins', (await names($)).filter(n => n !== name))
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
    // Before 0.10 `current` named an env-token account, not the live login.
    if (!(await $.store.get('logins'))) await $.store.delete('current')
    // The login this process loaded; a reload mid-switch (token set) keeps the first answer.
    const key = `startedOn:${await $.session.id()}`
    if (!(await $.env.get('ANTHROPIC_AUTH_TOKEN')) && !(await $.store.get(key))) await $.store.set(key, await current($))
    await show($)
    return next(e)
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
