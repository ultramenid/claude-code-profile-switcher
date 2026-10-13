# claude-code-profile-switcher

Switch Claude Code's login between accounts with `/profile`. Each account is a full login: after a switch, `claude` opens on that account with its plan usage, email and claude.ai connectors.

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

A row above the prompt shows the account, its email and its plan usage, with a bar per window and the time until it resets: `● work  w@example.com   5h ██████░░░░ 62% ↻ 2h 5m`. Collapse it with `[-]`.

To show it in your status line under the prompt instead, print `~/.claude/profile-status.txt` there; the plugin keeps it current, with colours. In a status line script, add `cat ~/.claude/profile-status.txt`. In [ccstatusline](https://github.com/sirmalloc/ccstatusline), add a Custom Command widget with the command `cat ~/.claude/profile-status.txt 2>/dev/null || true` and preserve colors on. Once your status line's command or ccstatusline's config names that file, the row above the prompt hides. Your login when you first used the plugin is `main`. Tip: do the browser login in a private window, so it doesn't reuse the claude.ai account you're already signed into.

## How it works

`/profile add` runs `claude auth login`, which briefly makes the new account the live login; once it finishes, the plugin saves that login and puts your previous one back.

Claude Code keeps its login, and the account details in `oauthAccount` in `~/.claude.json`, in a place that depends on the OS. The plugin keeps a copy of both for each account next to it:

| OS | Claude Code's login | The plugin's saved accounts |
|---|---|---|
| macOS | Keychain entry `Claude Code-credentials` | Keychain, service `cc-swap-login` |
| Linux | `~/.claude/.credentials.json` | `~/.claude/profile-logins/<name>.json` (mode 600) |
| Windows | `%USERPROFILE%\.claude\.credentials.json` | `%USERPROFILE%\.claude\profile-logins\<name>.json` |
 A switch saves the live login into the current account's copy (keeping any token refresh), then writes the target's copy into Claude Code's entry and `~/.claude.json`. On macOS, secrets go to `security` on stdin, never on the command line. The account list and which one is live are read from those saved copies, so reinstalling the plugin loses nothing.

## Limitations

- **This session after a switch:** it loaded its login at start, so until you reopen, requests use the new account's access token, while Claude Code's own `/status` and claude.ai connectors still use the account the session started on. Plan usage still works: each response reports its account's 5-hour and 7-day usage, and from your first message on the new account `/usage`, `/profile list` and the row above the prompt show it. Claude Code rotates that token when it refreshes it, which revokes the old copy; the plugin picks up the fresh one before each message and every minute. If no window is using that account, nothing refreshes it and it expires after a few hours: reopen Claude Code, or `/profile` to it again in a window that started on it. Switching back to the account the session started on clears the token, so its usage and email show again without a reopen.
- **One login for all sessions:** every Claude Code window on this computer shares the live login. A switch moves new windows too, and an open window still on the old account may write its refreshed token back over the switch: reopen open windows after switching.
- **Remote Control:** Claude Code disconnects it whenever the signed-in account changes and shows a notice. If Remote Control is on at startup or the Claude mobile app is attached (not the desktop app, which runs Claude Code locally), the plugin runs `/remote-control` to reconnect it under the new account, in every open Claude Code window, whichever one did the switch (each window checks every 5 seconds).
- **Windows is untested:** macOS is tested in daily use and Linux by the test suite; Windows follows the same file layout as Linux but hasn't been run yet. Reports welcome.
- `CLAUDE_CONFIG_DIR` isn't supported: the plugin swaps the default login only.
- If something goes wrong, `/login` always gets you a working login again.
