---
name: aolangai
description: Hand work to another Claude (a subagent on a secondary account) that runs on the account with the most quota left, to spare the quota of the account in use. Use when the user asks to delegate work to a subagent, to move work to another account or to their secondary account, or to spread tokens across several accounts, or when a large, independent piece of work can be handed off while you do something else.
---
<!-- aolangai-managed -->
# aolangai: delegate work to another Claude account

`aolangai` picks the Claude account with the most quota left and runs a worker there. Call it through Bash with the full path. If `~/.local/bin/aolangai` does not exist (Bash says `No such file or directory`, exit code 127), tell the user that aolangai is not installed and do the work yourself.

If the environment variable AOLANGAI_RUN_ID is set, you are the worker: do the task you were given yourself and do not call aolangai.

## Delegate

```
~/.local/bin/aolangai run "<prompt>" --cwd <folder> --label "<2-5 word label>"
```

- The worker **cannot see this conversation** and cannot ask you questions. The prompt must stand on its own: the goal, the relevant files, the constraints, what to report back.
- The worker edits files directly in `--cwd` (default: the current folder). For read-only work such as analysis, add `--read-only`.
- If the first stderr line contains `Also running in this folder`: another worker is running in the same folder and the two may edit the same files. Avoid delegating two runs that touch the same file at once.
- By default the worker may continue an earlier session in the same folder. For a clean context, add `--new`.
- Do not pick `--account` yourself; use it only when the user names an account.
- For a long or multi-line prompt, and whenever the prompt contains quotes, `$` or backticks, use `run -` and pass the prompt on stdin in a quoted heredoc, so the shell does not change it:

```
~/.local/bin/aolangai run - --cwd /path/to/project --label "fix test" <<'PROMPT'
In src/foo.ts, parse() is wrong for an empty string. Fix it and add a test in foo.test.ts.
Run npm test; report the files you changed and the test result.
PROMPT
```

- A run may take more than 2 minutes: run the command in the background in Bash (`run_in_background`) and do other work while you wait.
- By default at most 4 runs at once and 30 runs in 60 minutes (the user can change these in **Settings → Limits** of the app): beyond that the run is refused immediately (exit code 2), not queued. A worker cannot delegate further.
- By default each run lasts at most 30 minutes: past that, the run is stopped midway and reported as failed (exit code 1).

## Result

The worker's answer is **stdout**. Everything else (the `[aolangai] …` lines) is on stderr. The end of stdout may have a `[aolangai] Permission denied: …` paragraph: the worker's tools were blocked, so tell the user what was denied.

Exit codes:
- `0`: done, use stdout as the result.
- `1`: the run failed or timed out. Read stderr. The worker may have left some files half-edited: check `git status` in `--cwd` before retrying. Do not retry the same run more than once without telling the user.
- `2`: refused before running, or bad usage. Read the reason on stderr. If the user asked you to delegate, tell them why it was refused and do not do the work yourself unless they say so. If delegating was your own idea, do the work yourself.
- `3`: the account hit its limit mid-run. Retry exactly once (another account will be chosen).
- `130`: the run was stopped on purpose. Do not retry.

## Status and stop

```
~/.local/bin/aolangai status
~/.local/bin/aolangai stop <run number>
```

`status` shows each account's quota and the runs in progress (`#number` at the start of the line; `--json` for machines). The run number is also in the first stderr line of `run` (`run #N`). `stop <run number>` stops one run; `stop --all` stops every run.
