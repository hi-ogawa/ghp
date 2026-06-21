# ghp

Ergonomic CLI wrapper for GitHub Projects.

## Install

```bash
npm install -g github:hi-ogawa/ghp
```

Requires Node.js 18 or newer and the GitHub CLI (`gh`) with project access.

## Setup

Authenticate with `gh`:

```bash
gh auth login -s project
```

Initialize project metadata:

```bash
ghp setup <owner> <project-number>
ghp status
```

Config is stored at `$GHP_CONFIG` when set, otherwise at:

```text
~/.config/ghp/config.json
```

## Commands

### Status

```bash
ghp status
```

### Add Item

```bash
ghp add "task title" --status backlog
ghp add "task title" --body "details here" --status ready
ghp add https://github.com/org/repo/issues/123 --status ready
ghp add "urgent fix" --status ready --priority P0
```

### List Items

```bash
ghp ls
ghp ls -q "status:Backlog"
ghp ls -q 'status:"In progress"'
ghp ls --json
ghp ls -L 200
```

### Show Item

Accepts browser URL numeric `itemId` or `PVTI_` node ID:

```bash
ghp show 152396987
ghp show PVTI_lADOD1nQwc4BNmeozgkVZLs
```

### Edit Item

```bash
ghp edit 152396987 --title "new title"
ghp edit 152396987 --body "updated description"
ghp edit 152396987 --status "in progress" --priority P1
```

When passing Markdown bodies containing backticks, `$`, `*`, or shell-looking text, use a quoted heredoc so the shell does not execute or expand the content:

```bash
ghp edit 152396987 --body "$(cat <<'EOF'
## Context

- `literal backticks stay literal`
- $HOME does not expand
EOF
)"
```

Do not put Markdown with backticks inside a double-quoted shell argument directly.

### Move Item

```bash
ghp mv 152396987 done
ghp mv 152396987 "in progress"
```

### Archive / Delete

```bash
ghp archive 152396987
ghp delete 152396987
```

### ID Conversion

```bash
ghp id 152396987
ghp id PVTI_lADOD1nQwc4BNmeozgkVZLs
```

## Field Values

Run `ghp setup` to initialize project metadata, including available fields and options. Run `ghp status` to inspect the configured project and discovered field values.

Typical values:

- **Status**: `Backlog`, `Ready`, `In progress`, `In review`, `Done`
- **Priority**: `P0`, `P1`, `P2`
- **Size**: `XS`, `S`, `M`, `L`, `XL`

All field value arguments are matched case-insensitively: `done`, `Done`, and `DONE` all work.
