import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, canonicalWorkspace, hash } from '../src/store.ts';
import type { SessionState } from '../src/types.ts';
import { accountId, projectId, makeTask } from './helpers.ts';
import { taskFrom } from '../src/types.ts';
import { randomUUID } from 'node:crypto';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'robopm-pi-test-')); const cwd = join(dir, 'workspace'); mkdirSync(cwd);
  const root = join(dir, 'state'); const a = new FileStore(root, cwd, 'a');
  const state: SessionState = { version: 1, workspace: canonicalWorkspace(cwd), sessionId: 'a', server: 'robopm', mode: 'auto',
    accountId, projectId, clockOwned: false, pausedByUser: false, lastActivityAt: 100, holdUntil: 0, task: taskFrom(makeTask()) };
  return { a, state, cwd, root, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test('atomic state/profile round-trip preserves journal, task, proposal and metadata', () => {
  const f = fixture(); try {
    f.state.pending = { tool: 'create_task', args: { operation_id: randomUUID(), project_id: projectId, fields: { title: 'Recovery task' } }, dispatched: true };
    f.state.proposal = { action: 'reuse', task_id: String(makeTask().id), summary: 'Continue this feature' };
    f.a.saveState(f.state); assert.deepEqual(f.a.loadState(), f.state);
    const p = f.a.loadProfile(); p.projectId = projectId; p.autoAllowed = true; f.a.saveProfile(p);
    assert.deepEqual(f.a.loadProfile(), p);
    assert.equal(readdirSync(join(f.root, 'sessions')).length, 1);
    assert.ok(readdirSync(join(f.root, 'sessions'))[0].endsWith('.json'));
  } finally { f.cleanup(); }
});
test('one account lease across workspaces/sessions; active process recovery cannot steal it', () => {
  const f = fixture(); const b = new FileStore(f.root, f.cwd, 'b'); try {
    f.a.acquire('robopm\0' + accountId); f.a.acquire('robopm\0' + accountId);
    assert.throws(() => b.acquire('robopm\0' + accountId), /Another session/);
    assert.throws(() => b.recoverLease('robopm\0' + accountId), /still alive/);
    f.a.release(); b.acquire('robopm\0' + accountId); b.release();
  } finally { f.cleanup(); }
});
test('a different account has its own lease; releasing one cannot delete the other', () => {
  const f = fixture(); const b = new FileStore(f.root, f.cwd, 'b'); try {
    f.a.acquire('first'); b.acquire('second'); f.a.release();
    assert.equal(readdirSync(join(f.root, 'locks')).length, 1); b.release();
  } finally { f.cleanup(); }
});
test('ownership token changes fail closed on release', () => {
  const f = fixture(); try {
    f.a.acquire('key'); const path = join(f.root, 'locks', hash('key') + '.json');
    const owner = JSON.parse(readFileSync(path, 'utf8')); owner.token = randomUUID(); writeFileSync(path, JSON.stringify(owner));
    assert.throws(() => f.a.release(), /ownership changed/); assert.ok(readdirSync(join(f.root, 'locks')).includes(hash('key') + '.json'));
  } finally { f.cleanup(); }
});
test('malformed JSON, wrong session bindings and invalid operations do not reset to fresh state', () => {
  const f = fixture(); try {
    const path = join(f.root, 'sessions', hash(f.a.workspace + '\0a') + '.json');
    writeFileSync(path, '{broken'); assert.throws(() => f.a.loadState(), /unreadable/);
    f.a.saveState({ ...f.state, sessionId: 'wrong' }); assert.throws(() => f.a.loadState(), /Invalid session/);
    f.a.saveState(f.state); const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.pending = { tool: 'delete_task', args: { operation_id: randomUUID() }, dispatched: true };
    writeFileSync(path, JSON.stringify(raw)); assert.throws(() => f.a.loadState(), /Invalid operation/);
  } finally { f.cleanup(); }
});
test('new/forked session has no inherited active timer or pending write', () => {
  const f = fixture(); try { f.a.saveState(f.state); const b = new FileStore(f.root, f.cwd, 'fork'); assert.equal(b.loadState(), undefined); }
  finally { f.cleanup(); }
});
