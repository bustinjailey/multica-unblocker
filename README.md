# multica-unblocker

A small sidecar service that periodically scans Multica issues with status
`blocked`, parses `mention://issue/<id>` blocker links from the description
and the most-recent `Blocked: ...` comment, and **auto-resumes** the issue
when every linked blocker has reached a terminal state (`done` / `cancelled`
/ `completed`).

The intent is multi-issue projects: a parent ticket lists its sub-tickets
via `mention://issue/<uuid>` references in its description (or a "Blocked
on the children" comment), is moved to `blocked` while the children run,
and resumes automatically as soon as the last child finishes.

## How it works

Every `POLL_INTERVAL_MS` (default 60s):

1. `GET /api/issues?status=blocked&limit=200` — list blocked issues.
2. For each, fetch the timeline and:
   - Extract `mention://issue/<id>` references from the description.
   - Pick a single most-relevant comment to scan: prefer the most recent
     comment authored at/after the most recent `status_changed → blocked`
     activity whose text starts with `Blocked:`; otherwise the most recent
     comment in that window.
3. Resolve each ref to an issue and check its status.
4. If all referenced issues are in a terminal state (and there is at least
   one resolvable blocker — if zero, leave alone), restore the issue:
   - Status reverts to whatever the activity log shows it was before the
     `status_changed → blocked` transition (defaults to `todo` if the log
     doesn't carry that detail).
   - Assignee reverts to the `from_id` of an `assignee_changed` activity
     within ±2 minutes of the block (typical agent flow flips both fields
     in the same write).
   - Posts a comment: `Auto-resumed: blocker(s) SNA-X, SNA-Y are now done.
     Restoring status to **todo** and reassigning to the prior owner.`

State is in-memory only — Multica's `status` field is the source of truth
for "is this still blocked?", so nothing about restart re-orders behavior
beyond a 5-minute per-issue dedupe window to avoid double-acting.

## Install

Clone to a stable path on the host that will run the service (e.g.
`/opt/multica-unblocker`):

```bash
git clone https://github.com/bustinjailey/multica-unblocker /opt/multica-unblocker
cd /opt/multica-unblocker && CI=true bash deploy/install.sh
```

To update later:

```bash
cd /opt/multica-unblocker && git pull && CI=true bash deploy/install.sh
```

First run creates `/etc/multica-unblocker/env` with `DRY_RUN=true` and
`MULTICA_PAT` empty — fill the PAT, watch a few ticks of dry-run logs to
confirm the decisions make sense, then flip `DRY_RUN=false` and restart.

## Config (`/etc/multica-unblocker/env`)

| Var | Default | Meaning |
|---|---|---|
| `MULTICA_URL` | `http://localhost:8080` | Multica API base URL (use the internal address if running co-located with the backend) |
| `WORKSPACE_SLUG` | _required_ | your Multica workspace slug |
| `MULTICA_PAT` | _required_ | long-lived PAT with read+write |
| `POLL_INTERVAL_MS` | `60000` | scan cadence |
| `DEFAULT_RESUME_STATUS` | `todo` | fallback when activity log lacks a previous status |
| `LISTEN_PORT` | `7892` | health endpoint port (`GET /health`) |
| `LISTEN_HOST` | `127.0.0.1` | bind address |
| `DRY_RUN` | `true` (template default) | log decisions without acting |
| `MAX_RESUMES_PER_ISSUE` | `5` | give up after this many resumes against the *same* blocker set; `0` disables. Adding a new blocker reference resets the counter (signals fresh intent). When the cap is hit, a one-time give-up comment is posted and the issue is left blocked. In-memory only — service restart resets all counters. |

## Operate

```bash
systemctl status multica-unblocker
journalctl -u multica-unblocker -f --no-pager
curl -s http://localhost:7892/health
```

## Troubleshooting

- **All blocked issues skipped with "no parseable blockers"** — the
  blocker comments don't contain `mention://issue/<id>` markup. Either
  agents are writing blockers in prose (no link) or referencing them by
  identifier without the markdown form. Add a "Blocked: see <ID>…"
  comment with a proper mention link, or extend the parser to recognize
  bare identifiers in the "Blocked:" comment.
- **Issue auto-resumed but the agent didn't pick it up** — check whether
  reassigning to that agent triggers a fresh dispatch on your Multica
  build. If not, wire a follow-up `mention://agent/<id>` ping in the
  resume comment.
- **Wrong issue resumed** — check `chooseBlockerComment` in
  `src/index.ts`. The current heuristic scans only one comment per issue;
  bump the window size if you need more.
