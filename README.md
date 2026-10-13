# claude-code-profile-switcher

Switch Claude Code's login between accounts with `/profile`. Each account is a full login: after a switch, `claude` opens on that account with its plan usage, email and claude.ai connectors. The plugin also shows which account you're on and how much of its plan you've used.

## Install

```
/plugin install profile --marketplace ultramenid/claude-code-profile-switcher
```

Works in the terminal and in the Code tab of the Claude desktop app: both run Claude Code with the same plugins and the same login, so a switch in one applies to the other.

> [!WARNING]
> **Switch only with `/profile`.** Claude Code refreshes the live login every few hours, and the old refresh key stops working. The plugin saves the latest version when you switch away with `/profile`. If the login changes another way (you run `/login`, or another open Claude Code window writes its old login back), that account's saved copy may stop working, and switching to it leaves you logged out.
>
> Fix: `/profile remove <name>`, then `/profile add <name>`, or `/login` while on it. Reopen other Claude Code windows after switching.

## Commands

| Command | Effect |
|---|---|
| `/profile` | Picker: switch to another signed-in account, or add one |
| `/profile list` | All accounts with email and last plan usage (`5h 23% 7d 40%`); `●` marks the live login |
| `/profile add <name>` | Opens a browser login for another account; a notice says when it's saved. Your current login stays live |
| `/profile <name>` | Makes that account the login. This session uses it from your next message; reopen for its usage, email and connectors |
| `/profile remove <name>` | Forgets a saved account (not the live one) |
| `/usage` | On a switched session, the switched account's plan usage (5-hour and 7-day bars with reset times); otherwise Claude Code's own `/usage` |

Your login when you first use the plugin is saved as `main`. Tip: do the browser login for `/profile add` in a private window, so it doesn't reuse the claude.ai account you're already signed into.

## When an account runs out

![main runs out: during a /goal the plugin switches to work by itself and the goal goes on; without one it asks first](docs/fallback.gif)

When a request is refused because the account's plan is used up (its 5-hour or 7-day window at 100%), the plugin switches to the next signed-in account with usage left and sends the same request again, so the turn carries on instead of ending:

- **While a `/goal` runs**, it switches by itself and says so in a notice: the goal keeps going instead of pausing.
- **Otherwise it asks first**: `main is out of usage. Switch to work and continue?` Say no, or dismiss it, and the turn ends as it would have.

Accounts are tried in `/profile list` order. It skips one whose last reading has a used-up window that hasn't reset yet, and one whose saved login has expired because no window used it for hours (a notice names it: `/profile` to it and reopen Claude Code to renew it). The switch is a `/profile <name>`, with the same effects on other windows.

## What you see

**In the terminal**, the plugin is your status line, in the style of ccstatusline:

![The status line: model, effort, context, cache hit rate and a context bar, then the account with its 5-hour and 7-day usage bars](docs/statusline.svg)

**In the desktop app**, which has no status line, the same account row sits above the prompt (collapse it with `[-]`):

![The row above the prompt in the desktop app: account, email, 5-hour and 7-day usage bars with reset times, cache hit rate](docs/band.svg)

- **Model, Effort:** the session's model and its effort level, which follows `/effort` within seconds.
- **Ctx, Context:** how much of the context window the conversation fills.
- **Cache:** the share of the session's input tokens read from the prompt cache, counted from the first message after the plugin loaded.
- **5h, 7d:** the account's plan usage per window and the time until it resets (`↻`). Both come with each response, so they update together. 7d shows only on an account that has a weekly limit.
- Numbers turn yellow and then red as a window or the context fills, and as the cache hit rate drops.

### Setup

None: the first time it runs, the plugin sets itself as the status line. It never replaces one you already have, and if you remove it, it stays removed. While you keep your own status line, the account row shows above the prompt in the terminal too.

To switch from your own status line to the plugin's, set this in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "sh ~/.claude/profile-statusline.sh", "refreshInterval": 10 }
```

To keep your own status line and add just the account row to it, print `~/.claude/profile-status.txt` (in ccstatusline: a Custom Command widget running `cat ~/.claude/profile-status.txt 2>/dev/null || true`, with preserve colors on).

After uninstalling the plugin, the status line prints nothing; remove the `statusLine` entry as well.

## How it works

`/profile add` runs `claude auth login`, which briefly makes the new account the live login; once it finishes, the plugin saves that login and puts your previous one back.

Claude Code keeps its login, and the account details in `oauthAccount` in `~/.claude.json`, in a place that depends on the OS. The plugin keeps a copy of both for each account next to it:

| OS | Claude Code's login | The plugin's saved accounts |
|---|---|---|
| macOS | Keychain entry `Claude Code-credentials` | Keychain, service `cc-swap-login` |
| Linux | `~/.claude/.credentials.json` | `~/.claude/profile-logins/<name>.json` (mode 600) |
| Windows | `%USERPROFILE%\.claude\.credentials.json` | `%USERPROFILE%\.claude\profile-logins\<name>.json` |

A switch saves the live login into the current account's copy (keeping any token refresh), then writes the target's copy into Claude Code's entry and `~/.claude.json`. On macOS, secrets go to `security` on stdin, never on the command line. The account list and which one is live are read from those saved copies, so reinstalling the plugin loses nothing.

The status line is a small script, `~/.claude/profile-statusline.sh`, that prints a file the plugin keeps current for each session.

## Limitations

- **This session after a switch:** it loaded its login at start, so until you reopen, requests use the new account's access token, while Claude Code's own `/status` and claude.ai connectors still use the account the session started on. Plan usage still works: each response reports its account's 5-hour and 7-day usage, and from your first message on the new account `/usage`, `/profile list`, the status line and the row above the prompt show it. Claude Code rotates that token when it refreshes it, which revokes the old copy; the plugin picks up the fresh one before each message and every minute. If no window is using that account, nothing refreshes it and it expires after a few hours: reopen Claude Code, or `/profile` to it again in a window that started on it. Switching back to the account the session started on clears the token, so its usage and email show again without a reopen.
- **One login for all sessions:** every Claude Code window on this computer shares the live login. A switch moves new windows too, and an open window still on the old account may write its refreshed token back over the switch: reopen open windows after switching.
- **Remote Control:** Claude Code disconnects it whenever the signed-in account changes and shows a notice. The plugin runs `/remote-control` to reconnect it under the new account, in every open window, whichever one did the switch (each window checks every 5 seconds), where that window had Remote Control: you ran `/remote-control` there, the Claude mobile app is attached, or, in the terminal, `remoteControlAtStartup` is on. The desktop app's and VS Code's own auto-connect toggles can't be read by a plugin, so after a switch run `/remote-control` there yourself once.
- **Windows is untested:** macOS is tested in daily use and Linux by the test suite; Windows follows the same file layout as Linux but hasn't been run yet, and the status line isn't set up there automatically. Reports welcome.
- **A goal that ends by itself:** a plugin can't see a goal being met or judged impossible, so until `/goal clear` or `/clear` a used-up plan still switches without asking.
- `CLAUDE_CONFIG_DIR` isn't supported: the plugin swaps the default login only.
- If something goes wrong, `/login` always gets you a working login again.
