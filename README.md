# opencode-checkpoints

OpenCode plugin that creates git stash based checkpoints automatically and manually, so you can recover work before risky changes.

## Installation

```bash
npm install opencode-checkpoints
```

## OpenCode configuration

Add the plugin name to your OpenCode config file:

```json
{
  "plugins": ["opencode-checkpoints"]
}
```

## Available commands

| Command | Description |
| --- | --- |
| `/checkpoint [optional-label]` | Creates a manual checkpoint and keeps your working tree intact. |
| `/checkpoints` | Lists all available `opencode-*` checkpoints. |
| `/restore {n}` | Restores checkpoint number `n` by popping the matching stash. |
| `/restore-hard {n}` | Applies checkpoint number `n` without removing it from stash history. |

## How auto checkpoints work

1. On `session.idle`, the plugin creates an automatic stash checkpoint using the `opencode-auto-{timestamp}` label.
2. It re-applies your current changes so your working tree remains unchanged.
3. It logs `✓ Checkpoint auto guardado`.
4. It prunes old automatic checkpoints and keeps only the latest 10 entries with the `opencode-auto-` prefix.

The plugin also creates a pre-emptive checkpoint before destructive actions:
- Any `edit` tool execution.
- Any `write` tool execution.
- `bash` tool execution when the command looks destructive (`rm`, `DROP`, `truncate`, `git reset --hard`, `git clean`).

## Restore example (step by step)

1. Run `/checkpoints` to list existing checkpoints.
2. Identify the number you want, for example `3`.
3. Run `/restore 3` to recover that checkpoint and remove it from stash history.
4. If you prefer to keep the checkpoint in stash history, run `/restore-hard 3` instead.

## Notes

- All git commands run with `git -C {directory}` so the plugin works from any OpenCode project directory.
- In directories that are not git repositories, operations are skipped safely and the plugin logs: `⚠️ Checkpoint omitido: no es un repo git`.
