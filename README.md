# RoboPM work sessions for Pi

An opt-in Pi extension that coordinates **meaningful tasks and explicit work sessions**, not one task or timesheet entry per prompt. The main agent assesses the user's work; deterministic extension code validates that decision, persists operation IDs, and manages timers through RoboPM's existing MCP tools.

**Starts OFF.** Installing or loading this package does not create tasks, start clocks, or authenticate another MCP client. `/pm on` starts **suggestions only**. Automatic writes require a separate UI confirmation for the workspace/project.

## Requirements and installation

- Node.js **22.18+**; tested with Node 24.
- Pi **1.2.0+** (1.x).
- `pi-mcp-adapter` enabled, with a working authenticated `robopm` server. This extension uses its documented runtime event API, not a private import, token bridge, or independent connection.
- RoboPM's immediate-write MCP server (1.1.0+) and existing account/project permissions. Read operations need `mcp:use`, `pm:read`, `clock:read`; automatic work sessions additionally need `tasks:write` and `clock:write`. **Deletion and clock-correction scopes are not needed.**

From a local checkout:

```sh
npm ci
npm run check
pi install /absolute/path/to/RoboPM-Pi
```

Or install the Git source with Pi's package manager:

```sh
pi install git@github.com:roboact-wqyeo/RoboPM-Pi.git
```

Use `/reload` in an existing Pi session. Package installation does not replace or modify any MCP configuration, OAuth credentials, or other servers. The configured server name is `robopm`; keep that adapter entry and its default tool prefix. Global installation makes the command available everywhere, but each **canonical working directory** has its own opt-in profile. No mapping is inferred from repository names, parent directories, remotes, or branches.

## First session: validate task matching without writes

1. Run `/pm on` and select a permitted project, or `/pm on <project-UUID>`.
2. Give Pi a normal work request.
3. Pi calls `pm_prepare_work` to propose **reuse**, **create**, or **skip**. It should reuse the same task for related follow-ups, search existing work before proposing a new task, and ask when the target or required metadata is unclear.
4. Check `/pm status`. Suggestion mode does **not** create tasks or change timers.
5. To track automatically, run `/pm auto` and confirm the project and consequences. `/pm apply` then applies the last proposal; otherwise the next genuine work prompt makes a fresh assessment.

Automatic mode can create a ToDo task **assigned to the connected account** and start a clock at the actual current time. Normal RoboPM assignment, acknowledgement, workflow, and visibility rules still apply. Regular projects require an explicit due-date default (`/pm due YYYY-MM-DD`); the extension does not invent one. Sprint assignment is optional and only sent when explicitly configured with `/pm sprint <UUID>` and verified active. A duplicate normalized exact title is reused; broader semantic matching is the agent's responsibility and can be wrong.

## Controls

| Command | Effect |
| --- | --- |
| `/pm on [project-UUID]` | Select/map this working directory; enter suggestions only. |
| `/pm auto` | Explicit UI opt-in to automatic writes for this workspace/project. No immediate clock start. |
| `/pm apply` | Revalidate and apply the saved suggestion in automatic mode. |
| `/pm task <task-UUID>` | Explicit task suggestion/selection; starts tracking only in automatic mode. |
| `/pm suggest` | Pause our timer and return to suggestions. |
| `/pm pause` | Pause **our** clock; stay paused until `/pm resume`. |
| `/pm resume` | Start a **new** measured clock for the selected task, or await task selection. |
| `/pm off` | Pause our clock and end the explicit work session, without completing the task. |
| `/pm due YYYY-MM-DD\|clear` | Set/clear the explicit creation due-date default. |
| `/pm sprint UUID\|clear` | Set/clear the creation sprint default. |
| `/pm idle 15` | Set idle grace period, 1–240 minutes; default **15 minutes**. |
| `/pm hold 30` | Defer idle pause for up to 180 minutes; `/pm hold 0` clears it. |
| `/pm status` | Show local mode, bindings, pending-write warning and idle setting; no network calls. |
| `/pm inspect` | Read the connected account/current clocks and show synchronization status. |
| `/pm recover` | Inspect first, confirm recovery, reclaim only a dead-process lease and/or replay the identical journaled operation. |
| `/pm help` | Quick command reference. |

### What time means

An agent response finishing does **not** stop an explicit work session: review and testing can continue. While the agent is running, automatic idle pause is suppressed. After the last activity, idle pause takes effect after the configured grace period; **the grace period is counted**, not retrospectively subtracted. Aborting an agent run does not itself mean you stopped working. Use `/pm pause` or `/pm off` when you stop.

A detached/background job is not proof that a human is still working. If you deliberately want to keep a session open while waiting, use a bounded `/pm hold`. Shutdown, reload, and session changes attempt to pause the extension-owned timer. A process crash, machine sleep, network failure, or kill cannot guarantee an immediate remote pause. Inspect RoboPM after an unclean exit. The extension never fabricates an end timestamp or rewrites history to conceal a gap.

Clock writes explicitly use `billable: "Not Sure"`. Elapsed work-session time is **not certified human attendance or billable time**. Parallel agents do not start additional clocks through this coordinator.

## Safety and recovery

- The coordinator's transport allowlist contains only account/project/sprint/task/current-clock reads, `create_task`, `start_clock`, and `pause_clock`. It cannot delete/complete tasks, add historical entries, correct records, or perform bulk writes.
- Authorized server writes execute immediately. This package does not disable OAuth, scopes, server permissions, revision checks, auditing, or the adapter's configured approval behavior.
- Known unrelated/manual active timers block creation and timer switching. A matching manual timer can be observed but is **not adopted**: idle/pause/off/shutdown leave it alone.
- **Concurrency limitation:** an exclusive account lease protects cooperating Pi sessions **on this machine and state directory only**. The server's current-clock read and `start_clock` are separate operations; another device/app can start a clock between them, and RoboPM's existing `start_clock` automatically pauses competing clocks. This package cannot provide a cross-device atomic “start only if no other timer” guarantee. Do not operate competing timers in parallel; a strict guarantee would require an additive backend API guard.
- A UUID operation ID and exact arguments are durably recorded before dispatch. Lost responses or unparseable write receipts leave the operation unresolved and block fresh writes. No automatic retry with a new ID occurs.
- `/pm recover` is deliberate: it repeats the **same** ID and arguments, so saved server success can be recovered without duplicating effects. If the request never reached the server it can execute then. A server-side `running`/`unknown` result remains blocked and may need operator investigation; recovery is **not** a promise to resolve every failure. OAuth-client changes can also prevent replay of an older request.
- Leases are not stolen because they are old. A live owner process blocks recovery. Inspect/stop the other session before taking over. PID reuse is handled conservatively by refusing recovery.
- Server/tool results and stored JSON are validated at their boundaries. Incomplete searches prevent automatic creation. Unreadable/truncated results fail closed, not as “no matching tasks.”
- A workflow guard requests the preflight decision before ordinary tools, with at most one completion reminder. This is coordination, **not a sandbox or authorization boundary**: other trusted extensions, independent MCP tools, and the main agent remain subject to their own permissions and policies.
- Bookkeeping failures are surfaced through the tool result/footer; ordinary user work can continue without fabricated time. Unresolved timers still need human inspection.

## Privacy and local storage

The extension does not copy the raw user prompt, code, transcripts, or attachments into RoboPM. The agent supplies a short work title/summary; simple credential-pattern checks are best-effort, **not a secret scanner**. Review suggestions before opting into automatic mode. Candidate task data is treated as untrusted context and the injected preview is bounded.

State lives under `~/.pi/agent/robopm-work-sessions/`, or under `$PI_CODING_AGENT_DIR/robopm-work-sessions/` when set:

- `profiles/`: hashed canonical workspace mappings and explicit defaults;
- `sessions/`: workspace/session/account/project bindings, task/clock ownership, last activity, proposal and unresolved operation journal;
- `locks/`: account leases and explicit-recovery guards.

JSON replacement uses a same-directory temporary file and rename. Files request mode `0600` and directories `0700`; **Windows ACLs control effective access**, and writes do not claim filesystem/power-loss transactional durability. State contains task titles/summaries/IDs but no OAuth tokens. Do not sync it between machines, manually delete unresolved journals, or retarget the server entry underneath an active session.

State is outside the conversation tree: rewind/branch operations cannot undo a remote write. A new/forked session starts off; a resumed session restores its own state. A reload attempts cleanup first, then restores the binding. No task is implicitly completed or deleted on any of these events.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run check
```

Tests use Node's built-in runner, fake RoboPM responses and temporary local directories. They do **not** call production MCP tools or an LLM. Coverage includes off-by-default behavior, consent, suggestion-only mode, reuse and duplicate prevention, due-date validation, manual timer ownership, task switching, idle/busy/hold handling, account/local-session conflicts, durable same-operation recovery, cancellation/storage failure, notification filtering and lifecycle cleanup.

Live automatic task/timer writes should be tested only after explicit operator authorization in a disposable project. Model-driven semantic matching and real adapter/host integration require interactive smoke testing; unit tests are not a substitute for that rollout step.
