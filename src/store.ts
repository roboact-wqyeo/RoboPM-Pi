import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { decisionFrom, defaultProfile, object, taskFrom, text, uuid, type JsonObject, type Mode, type PendingOperation, type Profile, type SessionState, type StateStore } from './types.ts';

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export function canonicalWorkspace(path: string): string {
  const result = realpathSync.native(resolve(path));
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
export function dataDirectory(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'robopm-work-sessions');
}
function readJson(path: string): JsonObject | undefined {
  try { return object(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Local work-session data is unreadable; repair it before continuing.'); }
}
function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Session state is external to the conversation tree: a fork cannot undo remote writes. */
export class FileStore implements StateStore {
  readonly workspace: string;
  readonly sessionId: string;
  readonly root: string;
  private lease?: { path: string; token: string };
  constructor(root: string, workspace: string, sessionId: string) {
    this.root = root; this.workspace = canonicalWorkspace(workspace); this.sessionId = sessionId;
    for (const dir of ['profiles', 'sessions', 'locks']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  }
  private statePath(): string { return join(this.root, 'sessions', hash(this.workspace + '\0' + this.sessionId) + '.json'); }
  private profilePath(): string { return join(this.root, 'profiles', hash(this.workspace) + '.json'); }
  loadState(): SessionState | undefined {
    const raw = readJson(this.statePath());
    if (raw === undefined) return undefined;
    const s = raw;
    if (s.version !== 1 || s.workspace !== this.workspace || s.sessionId !== this.sessionId || typeof s.server !== 'string' || !/^[\w-]+$/.test(s.server) || typeof s.lastActivityAt !== 'number' || !Number.isFinite(s.lastActivityAt) || typeof s.holdUntil !== 'number' || !Number.isFinite(s.holdUntil) || typeof s.clockOwned !== 'boolean' || typeof s.pausedByUser !== 'boolean') throw new Error('Invalid session state; do not discard unresolved operations.');
    let mode: Mode;
    if (s.mode === 'off' || s.mode === 'suggest' || s.mode === 'auto') mode = s.mode;
    else throw new Error('Invalid session mode.');
    let pending: PendingOperation | undefined;
    if (s.pending !== undefined) {
      const op = object(s.pending);
      if (op.tool !== 'create_task' && op.tool !== 'start_clock' && op.tool !== 'pause_clock') throw new Error('Invalid operation journal.');
      if (typeof op.dispatched !== 'boolean') throw new Error('Invalid dispatch state.');
      const args = object(op.args);
      uuid(args.operation_id);
      pending = { tool: op.tool, args, dispatched: op.dispatched };
      if (op.afterMode !== undefined) {
        if (op.tool !== 'pause_clock' || (op.afterMode !== 'off' && op.afterMode !== 'suggest')) throw new Error('Invalid post-pause intent.');
        pending.afterMode = op.afterMode;
      }
    }
    return { version: 1, sessionId: this.sessionId, workspace: this.workspace, server: s.server, mode,
      clockOwned: s.clockOwned, pausedByUser: s.pausedByUser, lastActivityAt: s.lastActivityAt, holdUntil: s.holdUntil,
      ...(s.accountId !== undefined ? { accountId: uuid(s.accountId) } : {}),
      ...(s.projectId !== undefined ? { projectId: uuid(s.projectId) } : {}),
      ...(s.task !== undefined ? { task: taskFrom(s.task) } : {}),
      ...(s.clockId !== undefined ? { clockId: uuid(s.clockId) } : {}),
      ...(pending ? { pending } : {}), ...(s.problem !== undefined ? { problem: text(s.problem, 400) } : {}),
      ...(s.proposal !== undefined ? { proposal: decisionFrom(s.proposal) } : {}) };
  }
  saveState(state: SessionState): void { atomicJson(this.statePath(), state); }
  loadProfile(): Profile {
    const raw = readJson(this.profilePath());
    if (raw === undefined) return defaultProfile(this.workspace);
    const p = raw;
    if (p.version !== 1 || p.workspace !== this.workspace || typeof p.server !== 'string' || !/^[\w-]+$/.test(p.server) || typeof p.autoAllowed !== 'boolean' || typeof p.idleMinutes !== 'number' || !Number.isInteger(p.idleMinutes) || p.idleMinutes < 1 || p.idleMinutes > 240) throw new Error('Invalid workspace profile.');
    return { version: 1, workspace: this.workspace, server: p.server, autoAllowed: p.autoAllowed, idleMinutes: p.idleMinutes,
      ...(p.projectId !== undefined ? { projectId: uuid(p.projectId) } : {}),
      ...(p.sprintId !== undefined ? { sprintId: uuid(p.sprintId) } : {}),
      ...(p.dueDate !== undefined ? { dueDate: text(p.dueDate, 10) } : {}) };
  }
  saveProfile(profile: Profile): void { atomicJson(this.profilePath(), profile); }
  acquire(accountKey: string): void {
    const path = join(this.root, 'locks', hash(accountKey) + '.json');
    if (this.lease?.path === path) return;
    if (this.lease) throw new Error('Release the current account lease before switching accounts.');
    const token = randomUUID();
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ token, pid: process.pid, sessionId: this.sessionId })); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another session owns this account’s tracker, or a crash left a lease. Use /pm recover after inspecting the other session.');
      throw error;
    }
    this.lease = { path, token };
  }
  /** Explicit stale-lease recovery, serialized separately; age alone never permits stealing. */
  recoverLease(accountKey: string): void {
    if (this.lease) return;
    const path = join(this.root, 'locks', hash(accountKey) + '.json');
    const guard = path + '.recovery';
    let fd: number;
    try { fd = openSync(guard, 'wx', 0o600); }
    catch { throw new Error('Lease recovery is already in progress; inspect the recovery guard before retrying.'); }
    try {
      const raw = readJson(path);
      if (raw !== undefined) {
        const owner = object(raw);
        if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Malformed lease: manual inspection required.');
        let dead = false;
        try { process.kill(owner.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!dead) throw new Error('The owning Pi process is still alive; pause/off there before taking over.');
        unlinkSync(path);
      }
      this.acquire(accountKey);
    } finally { closeSync(fd); unlinkSync(guard); }
  }
  release(): void {
    if (!this.lease) return;
    const { path, token } = this.lease;
    const raw = readJson(path);
    if (raw !== undefined && object(raw).token !== token) throw new Error('Tracker lease ownership changed; refusing to remove it.');
    if (raw !== undefined) unlinkSync(path);
    this.lease = undefined;
  }
}
