# Claude Code mods for Intelligent Terminal

Each mod stands alone: none needs another, and each is switched on or off by itself.
They need Claude Code 2.1.287 or later.

| Mod | What it does | Where to load it |
|---|---|---|
| `terminal` | Tools to see and use the terminal's panes (list, read, run, type, keys, open, delegate, profiles, focus, close), a note about the pane the user works in with each prompt, and a Fix line when a command fails in the same tab | Where you want terminal awareness, for example the agent pane |
| `sessions` | Every Claude Code session for every other: each shares its context and state, runs slash commands another session asks for, and one can watch the rest and compact them at good checkpoints | Every session |

## Switching a mod on or off

- **For one program, such as the agent pane:** add `--plugin-dir <this folder>\terminal` to its command line. Remove it to switch off.
- **For every session:** add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` of `~/.claude/settings.json` (folders separated by `;`). Remove it to switch off.
- **As installed plugins:** `claude plugin marketplace add <this folder>`, then `claude plugin install <mod>@intelligent-terminal-mods`, and turn each on or off in `/plugin`.

Check a mod with `claude plugin validate <folder>`.
