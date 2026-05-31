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

Or save a token for `ghp` to pass as `GH_TOKEN` when it runs `gh`:

```bash
echo ghp_xxxxxxxxxxxx | ghp auth
```

Configure the default project:

```bash
ghp set-default <owner> <project-number>
```

Config is stored at `$GHP_CONFIG` when set, otherwise at:

```text
~/.config/ghp/config.json
```

## Commands

```bash
ghp add "task title" --status backlog
ghp add "task title" --body "details here" --status ready
ghp add https://github.com/org/repo/issues/123 --status ready

ghp ls
ghp ls -q "status:Backlog"
ghp ls -q 'status:"In progress"'
ghp ls --json

ghp show 152396987
ghp show PVTI_lADOD1nQwc4BNmeozgkVZLs

ghp edit 152396987 --title "new title"
ghp edit 152396987 --body "updated description"
ghp edit 152396987 --status "in progress" --priority P1

ghp mv 152396987 done
ghp archive 152396987
ghp delete 152396987

ghp id 152396987
ghp id PVTI_lADOD1nQwc4BNmeozgkVZLs
```

Field values are discovered by `ghp set-default` and matched case-insensitively.
