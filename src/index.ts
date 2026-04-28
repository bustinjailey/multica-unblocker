// multica-unblocker — periodically scans blocked issues, parses mention://issue/<id>
// blocker links from the description + most-recent "Blocked:" comment, and
// auto-resumes (status, assignee, comment) when every linked blocker is in a
// terminal state. Designed to run as a systemd service alongside Multica.
//
// Design notes:
//   * Stateless across restarts. Multica's own status field is the source of
//     truth for "is this still blocked?" — once we transition the issue out
//     of `blocked`, we won't pick it up again on the next tick.
//   * No-op safe. If an issue has no parseable blockers, we leave it alone
//     (option (a) in the design discussion). Add a TTL-based fallback later
//     if we want to retry "blocked on a vibe" issues.
//   * Per-tick in-memory dedupe protects against double-acting if the user
//     manually unblocks at the same time as a tick fires.

import http from 'node:http';

// ===================== Config =====================

interface Config {
  multicaUrl: string;
  multicaPat: string;
  workspaceSlug: string;
  pollIntervalMs: number;
  defaultResumeStatus: string;  // fallback when we can't read previous status from activity log
  listenPort: number;
  listenHost: string;
  dryRun: boolean;
}

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`missing env: ${k}`);
    process.exit(1);
  }
  return v;
}

const config: Config = {
  multicaUrl: process.env.MULTICA_URL || 'http://localhost:8080',
  multicaPat: requireEnv('MULTICA_PAT'),
  workspaceSlug: requireEnv('WORKSPACE_SLUG'),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 60_000),
  defaultResumeStatus: process.env.DEFAULT_RESUME_STATUS || 'todo',
  listenPort: Number(process.env.LISTEN_PORT || 7892),
  listenHost: process.env.LISTEN_HOST || '127.0.0.1',
  dryRun: (process.env.DRY_RUN || 'false').toLowerCase() === 'true',
};

const TERMINAL_BLOCKER_STATUSES = new Set(['done', 'cancelled', 'completed']);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]*-\d+)\b/g;

// ===================== Multica API client =====================

const headers = (): Record<string, string> => ({
  'Authorization': `Bearer ${config.multicaPat}`,
  'X-Workspace-Slug': config.workspaceSlug,
  'Content-Type': 'application/json',
});

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(config.multicaUrl + path, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null as T;
  const ct = r.headers.get('content-type') || '';
  const payload = ct.includes('application/json') ? await r.json() : await r.text();
  if (!r.ok) {
    const msg = (payload && typeof payload === 'object' && 'error' in payload)
      ? (payload as { error: string }).error
      : (typeof payload === 'string' ? payload : `HTTP ${r.status}`);
    throw new Error(`${method} ${path} -> ${r.status}: ${msg}`);
  }
  return payload as T;
}

// ===================== Multica types (subset we use) =====================

interface Issue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  description?: string | null;
  assignee_type?: string | null;
  assignee_id?: string | null;
}

interface CommentEntry {
  type: 'comment';
  id: string;
  content: string;
  created_at: string;
  actor_type?: string;
  actor_id?: string;
}

interface ActivityEntry {
  type: 'activity';
  id: string;
  action: string;
  created_at: string;
  actor_type?: string;
  actor_id?: string;
  details?: Record<string, unknown>;
}

type TimelineEntry = CommentEntry | ActivityEntry;

// ===================== Blocker extraction =====================

// Pull mention://issue/<uuid-or-key> links out of a chunk of markdown. Returns
// raw refs (UUIDs preferred; identifier strings allowed as a fallback).
function extractIssueRefs(text: string): string[] {
  if (!text) return [];
  const refs = new Set<string>();
  const mentionRe = /mention:\/\/issue\/([A-Za-z0-9-]+)/g;
  for (const m of text.matchAll(mentionRe)) {
    refs.add(m[1]);
  }
  return [...refs];
}

// Decide which comments to scan for blocker links. Priority:
//   1. The most recent comment whose body starts with "Blocked:" (case-insensitive),
//      written at or after the most recent status->blocked transition.
//   2. The most recent comment authored at or after the status->blocked transition.
// We scan ONE comment, not all of them — many issues link to siblings or
// parents in random comments and we don't want to treat those as blockers.
function chooseBlockerComment(timeline: TimelineEntry[]): CommentEntry | null {
  const blockedAt = mostRecentBlockTimestamp(timeline);
  const eligible = timeline
    .filter((t): t is CommentEntry => t.type === 'comment')
    .filter(c => !blockedAt || c.created_at >= blockedAt)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (!eligible.length) return null;
  const labelled = eligible.find(c => /^\s*blocked\b/i.test(c.content || ''));
  return labelled || eligible[0];
}

function mostRecentBlockTimestamp(timeline: TimelineEntry[]): string | null {
  const activities = timeline
    .filter((t): t is ActivityEntry => t.type === 'activity')
    .filter(a => a.action === 'status_changed' && (a.details as { to?: string } | undefined)?.to === 'blocked')
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return activities[0]?.created_at || null;
}

// Walk the activity log to recover what the issue looked like before it was
// blocked, so we can put it back. Returns nulls when the log doesn't carry
// that info — caller substitutes defaults.
function findPreBlockState(timeline: TimelineEntry[]): {
  previousStatus: string | null;
  previousAssignee: { type: string; id: string } | null;
} {
  const activities = timeline
    .filter((t): t is ActivityEntry => t.type === 'activity')
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  let previousStatus: string | null = null;
  let blockedAt: string | null = null;
  for (const a of activities) {
    const d = a.details as { to?: string; from?: string } | undefined;
    if (a.action === 'status_changed' && d?.to === 'blocked') {
      previousStatus = d.from || null;
      blockedAt = a.created_at;
      break;
    }
  }

  let previousAssignee: { type: string; id: string } | null = null;
  if (blockedAt) {
    // Look for an assignee_changed within ~2 minutes of the block — the
    // typical agent flow flips status + assignee in the same write.
    const blockedTime = Date.parse(blockedAt);
    const candidate = activities.find(a => {
      if (a.action !== 'assignee_changed') return false;
      const dt = Math.abs(Date.parse(a.created_at) - blockedTime);
      return dt < 2 * 60 * 1000;
    });
    const cd = candidate?.details as { from_type?: string; from_id?: string } | undefined;
    if (cd?.from_type && cd?.from_id) {
      previousAssignee = { type: cd.from_type, id: cd.from_id };
    }
  }

  return { previousStatus, previousAssignee };
}

// ===================== Resolve refs to issues =====================

const issueCache = new Map<string, { issue: Issue; ts: number }>();
const ISSUE_CACHE_TTL = 60_000;

async function resolveIssue(ref: string): Promise<Issue | null> {
  const cached = issueCache.get(ref);
  if (cached && Date.now() - cached.ts < ISSUE_CACHE_TTL) return cached.issue;
  // Try direct fetch (works for UUIDs; some backends also accept identifiers).
  try {
    const issue = await api<Issue>('GET', `/api/issues/${ref}`);
    if (issue?.id) {
      issueCache.set(ref, { issue, ts: Date.now() });
      // Cross-cache by identifier too, for the second-pass case.
      if (issue.identifier) issueCache.set(issue.identifier.toUpperCase(), { issue, ts: Date.now() });
      return issue;
    }
  } catch {
    // Fall through to identifier search.
  }
  // Identifier fallback: scan a window of issues for a matching identifier.
  if (ISSUE_KEY_RE.test(ref) || /^[A-Z]/i.test(ref)) {
    try {
      const want = ref.toUpperCase();
      const url = `/api/issues?limit=500&q=${encodeURIComponent(ref)}`;
      const resp = await api<Issue[] | { issues: Issue[] }>('GET', url);
      const arr = Array.isArray(resp) ? resp : (resp.issues || []);
      const hit = arr.find(i => (i.identifier || '').toUpperCase() === want);
      if (hit) {
        issueCache.set(ref, { issue: hit, ts: Date.now() });
        return hit;
      }
    } catch {
      return null;
    }
  }
  return null;
}

// ===================== Core decision =====================

interface UnblockDecision {
  unblock: boolean;
  blockers: { ref: string; identifier: string; status: string }[];
  pending: { ref: string; identifier: string; status: string }[];
  resumeStatus: string;
  resumeAssignee: { type: string; id: string } | null;
  reason: string;
}

async function evaluate(issue: Issue): Promise<UnblockDecision | null> {
  const timeline = await api<TimelineEntry[]>('GET', `/api/issues/${issue.id}/timeline`);

  const refs = new Set<string>();
  for (const r of extractIssueRefs(issue.description || '')) refs.add(r);
  const comment = chooseBlockerComment(timeline || []);
  if (comment) {
    for (const r of extractIssueRefs(comment.content)) refs.add(r);
  }

  if (refs.size === 0) {
    return { unblock: false, blockers: [], pending: [], resumeStatus: '', resumeAssignee: null, reason: 'no parseable blockers' };
  }

  const blockers: { ref: string; identifier: string; status: string }[] = [];
  const pending: { ref: string; identifier: string; status: string }[] = [];
  for (const ref of refs) {
    if (ref === issue.id) continue; // self-reference, ignore
    const blocker = await resolveIssue(ref);
    if (!blocker) {
      pending.push({ ref, identifier: ref, status: 'unknown' });
      continue;
    }
    const entry = { ref, identifier: blocker.identifier || ref, status: blocker.status };
    blockers.push(entry);
    if (!TERMINAL_BLOCKER_STATUSES.has(blocker.status)) pending.push(entry);
  }

  if (pending.length > 0 || blockers.length === 0) {
    return { unblock: false, blockers, pending, resumeStatus: '', resumeAssignee: null, reason: pending.length ? `${pending.length} blocker(s) still pending` : 'no resolvable blockers' };
  }

  const { previousStatus, previousAssignee } = findPreBlockState(timeline || []);
  return {
    unblock: true,
    blockers,
    pending: [],
    resumeStatus: previousStatus || config.defaultResumeStatus,
    resumeAssignee: previousAssignee,
    reason: 'all blockers cleared',
  };
}

// ===================== Action =====================

async function unblock(issue: Issue, decision: UnblockDecision): Promise<void> {
  const cleared = decision.blockers.map(b => b.identifier).join(', ');
  const body = decision.resumeAssignee
    ? {
        status: decision.resumeStatus,
        assignee_type: decision.resumeAssignee.type,
        assignee_id: decision.resumeAssignee.id,
      }
    : { status: decision.resumeStatus };

  if (config.dryRun) {
    console.log(`[dry-run] would unblock ${issue.identifier} -> status=${decision.resumeStatus} assignee=${JSON.stringify(decision.resumeAssignee)} cleared=[${cleared}]`);
    return;
  }

  await api<unknown>('PUT', `/api/issues/${issue.id}`, body);
  await api<unknown>('POST', `/api/issues/${issue.id}/comments`, {
    content: `Auto-resumed: blocker(s) ${cleared} are now done. Restoring status to **${decision.resumeStatus}**${decision.resumeAssignee ? ' and reassigning to the prior owner' : ''}.`,
  });
  console.log(`[unblock] ${issue.identifier} -> ${decision.resumeStatus} (cleared: ${cleared})`);
}

// ===================== Tick loop =====================

const recentlyActed = new Map<string, number>();
const RECENT_TTL = 5 * 60 * 1000;

async function tick(): Promise<void> {
  // Snapshot of dedupe set on each tick — drop entries older than the TTL.
  const cutoff = Date.now() - RECENT_TTL;
  for (const [k, ts] of recentlyActed) if (ts < cutoff) recentlyActed.delete(k);

  let blocked: Issue[] = [];
  try {
    const resp = await api<Issue[] | { issues: Issue[] }>('GET', '/api/issues?status=blocked&limit=200');
    blocked = Array.isArray(resp) ? resp : (resp.issues || []);
  } catch (e) {
    console.warn(`[tick] list blocked failed: ${(e as Error).message}`);
    return;
  }

  if (blocked.length === 0) return;
  console.log(`[tick] scanning ${blocked.length} blocked issue(s)`);

  for (const issue of blocked) {
    if (recentlyActed.has(issue.id)) continue;
    try {
      const decision = await evaluate(issue);
      if (!decision) continue;
      if (!decision.unblock) {
        console.log(`[skip] ${issue.identifier}: ${decision.reason}`);
        continue;
      }
      await unblock(issue, decision);
      recentlyActed.set(issue.id, Date.now());
    } catch (e) {
      console.warn(`[err] ${issue.identifier}: ${(e as Error).message}`);
    }
  }
}

let stopping = false;
async function loop(): Promise<void> {
  while (!stopping) {
    const start = Date.now();
    try { await tick(); }
    catch (e) { console.warn(`[loop] tick threw: ${(e as Error).message}`); }
    const elapsed = Date.now() - start;
    const wait = Math.max(1000, config.pollIntervalMs - elapsed);
    await new Promise(r => setTimeout(r, wait));
  }
}

// ===================== Health endpoint =====================

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, recentlyActed: recentlyActed.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(config.listenPort, config.listenHost, () => {
  console.log(`[http] listening on ${config.listenHost}:${config.listenPort}`);
});

// ===================== Boot =====================

console.log(`[boot] poll interval ${config.pollIntervalMs}ms, default resume status '${config.defaultResumeStatus}', dry-run=${config.dryRun}`);
process.on('SIGTERM', () => { stopping = true; server.close(); });
process.on('SIGINT', () => { stopping = true; server.close(); });
loop().then(() => process.exit(0));
