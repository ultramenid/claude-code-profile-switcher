# claude-code-profile-switcher

Switch Claude Code's login between accounts with `/profile`. Each account is a full login: after a switch, `claude` opens on that account with its plan usage, email and claude.ai connectors.

## Install

```
/plugin install profile --marketplace ultramenid/claude-code-profile-switcher
```

## Commands

| Command | Effect |
|---|---|
| `/profile` | Picker: switch to another signed-in account, or add one |
| `/profile list` | All accounts with email and last plan usage (`5h 23% 7d 40%`); `●` marks the live login |
| `/profile add <name>` | Opens a browser login for another account; a notice says when it's saved. Your current login stays live |
| `/profile <name>` | Makes that account the login. This session uses it from your next message; reopen for its usage, email and connectors |
| `/profile remove <name>` | Forgets a saved account (not the live one) |

Your login when you first used the plugin is `main`. Tip: do the browser login in a private window, so it doesn't reuse the claude.ai account you're already signed into.

## How it works

Claude Code keeps its login in the macOS Keychain entry `Claude Code-credentials`, and the account details in `oauthAccount` in `~/.claude.json`. The plugin keeps a copy of both for each account in the Keychain (service `cc-swap-login`). A switch saves the live login into the current account's copy (keeping any token refresh), then writes the target's copy into Claude Code's entry and `~/.claude.json`. Secrets go to `security` on stdin, never on the command line.

## Limitations

- **This session after a switch:** it loaded its login at start, so until you reopen, requests use the new account's access token, while the email and connectors still show the account the session started on. Plan usage still works: each response reports its account's 5-hour and 7-day usage, and from your first message on the new account `/usage`, `/profile list` and the status line show it. The token expires after a few hours; reopen before then. Switching back to the account the session started on clears the token, so its usage and email show again without a reopen.
- **One login for all sessions:** every Claude Code window on this Mac shares the live login. A switch moves new windows too, and an open window still on the old account may write its refreshed token back over the switch: reopen open windows after switching.
- **Refreshed tokens:** an account's saved copy is updated only when you switch away from it. If a copy stops working, `/profile remove <name>` and `/profile add <name>` again.
- **Remote Control:** Claude Code disconnects it whenever the signed-in account changes and shows a notice. If Remote Control is on at startup or a remote client is attached, the plugin runs `/remote-control` after each switch to reconnect it under the new account.
- **macOS only:** the logins live in the macOS Keychain.
- If something goes wrong, `/login` always gets you a working login again.
