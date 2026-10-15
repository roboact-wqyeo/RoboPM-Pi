import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkSessions } from '../src/core.ts';
import { isWorkPrompt, safeSummary, taskFrom } from '../src/types.ts';
import { accountId, projectId, taskId, otherTaskId, workspace, FakeRoboPM, MemoryStore, makeTask } from './helpers.ts';

function setup() {
  const store = new MemoryStore(); const api = new FakeRoboPM(); let time = Date.now();
  const work = new WorkSessions(store, api, 'session-test', workspace, () => time);
  return { store, api, work, advance: (minutes: number) => { time += minutes * 60_000; } };
}
async function automatic() { const s = setup(); await s.work.on(projectId); await s.work.enableAuto(); return s; }
async function reuse(work: WorkSessions, id = taskId) { await work.preparePrompt(); return work.decide({ action: 'reuse', task_id: id, summary: 'Implement and verify the work-session integration' }); }

test('off by default: startup, prompts, idle and shutdown perform no API calls', async () => {
  const { work, api, advance } = setup(); assert.equal(work.state.mode, 'off');
  await work.preparePrompt(); advance(30); await work.tick(false); await work.close(); assert.deepEqual(api.calls, []);
});
test('suggestion mode does not create tasks or change any timer', async () => {
  const { work, api } = setup(); await work.on(projectId); await work.preparePrompt();
  const result = await work.decide({ action: 'create', title: 'Add lifecycle safeguards', summary: 'Implement safeguards' });
  assert.equal(result.writes, false); assert.deepEqual(api.writes(), []); assert.equal(work.state.proposal?.action, 'create');
});
test('nested backend assignee parsing preserves account ownership', () => {
  assert.equal(taskFrom(makeTask()).assignee_user_id, accountId);
});
test('same-work follow-ups reuse one task and one clock, including during review', async () => {
  const { work, api, advance } = await automatic(); await reuse(work); const clockId = work.state.clockId;
  work.touch(); advance(5); await work.tick(false); await reuse(work);
  assert.equal(work.state.clockId, clockId); assert.equal(api.writes().filter(c => c.tool === 'start_clock').length, 1);
  assert.equal(api.writes().filter(c => c.tool === 'create_task').length, 0);
  await work.close(); assert.equal(api.clocks[0].status, 'paused');
});
test('new task creates self-assigned ToDo and measured clock, never history or workflow completion', async () => {
  const { work, api, store } = await automatic(); await work.preparePrompt();
  await work.decide({ action: 'create', title: 'Add restart recovery', summary: 'Recover persisted work safely' });
  assert.deepEqual(api.writes().map(c => c.tool), ['create_task', 'start_clock']);
  assert.deepEqual(api.writes()[0].args.fields, { title: 'Add restart recovery', description: 'Recover persisted work safely', assignee_user_id: accountId });
  assert.equal(api.writes()[1].args.billable, 'Not Sure');
  assert.ok(store.snapshots.some(s => s.pending?.tool === 'create_task' && !s.pending.dispatched));
  assert.ok(store.snapshots.some(s => s.pending?.tool === 'start_clock' && s.pending.dispatched));
  assert.equal(work.state.pending, undefined);
});
test('duplicate exact-title search reuses an existing task rather than creating', async () => {
  const { work, api } = await automatic(); await work.preparePrompt();
  await work.decide({ action: 'create', title: 'Implement Pi work sessions', summary: 'Continue the same feature' });
  assert.equal(work.state.task?.id, taskId); assert.deepEqual(api.writes().map(c => c.tool), ['start_clock']);
});
test('incomplete/repeating pagination prevents new-task creation', async () => {
  const { work, api } = await automatic(); api.repeatPage = true; await work.preparePrompt();
  await assert.rejects(work.decide({ action: 'create', title: 'A different task', summary: 'Different feature' }), /incomplete/);
  assert.deepEqual(api.writes(), []);
});
test('regular-project creation requires explicit due date and does not invent a sprint', async () => {
  const { work, api } = await automatic(); api.general = false; await work.preparePrompt();
  const decision = { action: 'create' as const, title: 'New regular work', summary: 'Implement the requested change' };
  await assert.rejects(work.decide(decision), /explicit due date/); assert.deepEqual(api.writes(), []);
  work.defaults('due', '2026-12-01'); await work.decide(decision);
  const fields = api.writes()[0].args.fields;
  assert.equal((fields as { due_date: string }).due_date, '2026-12-01');
  assert.ok(!('sprint_id' in (fields as object)));
});
test('unrelated manual timer blocks creation/start without pausing it', async () => {
  const { work, api } = await automatic(); api.clocks.push({ id: randomUUID(), task_id: otherTaskId, status: 'active' });
  await work.preparePrompt(); await assert.rejects(work.decide({ action: 'create', title: 'Separate work', summary: 'Separate task' }), /manual|unrelated/);
  assert.deepEqual(api.writes(), []); assert.equal(api.clocks[0].status, 'active');
});
test('matching manual clock is reused but never owned or paused by us', async () => {
  const { work, api, advance } = await automatic(); const id = randomUUID(); api.clocks.push({ id, task_id: taskId, status: 'active' });
  await reuse(work); assert.equal(work.state.clockId, id); assert.equal(work.state.clockOwned, false);
  advance(30); await work.tick(false); await work.pause(); await work.off(); await work.close();
  assert.deepEqual(api.writes(), []); assert.equal(api.clocks[0].status, 'active');
});
test('task switch pauses only our clock before starting the new one', async () => {
  const { work, api } = await automatic(); api.tasks.push(makeTask(otherTaskId, 'Different work')); await reuse(work);
  const first = work.state.clockId; await reuse(work, otherTaskId);
  assert.notEqual(work.state.clockId, first); assert.equal(api.clocks[0].status, 'paused');
  assert.deepEqual(api.writes().map(c => c.tool), ['start_clock', 'pause_clock', 'start_clock']);
});
test('manual pause sticks across prompts; resume starts a NEW clock, never completes work', async () => {
  const { work, api } = await automatic(); await reuse(work); const id = work.state.clockId;
  await work.pause(); await reuse(work); assert.equal(work.state.clockId, undefined);
  await work.resume(); assert.notEqual(work.state.clockId, id);
  assert.deepEqual(api.writes().map(c => c.tool), ['start_clock', 'pause_clock', 'start_clock']);
});
test('idle counts the grace period, does not stop busy work, and respects bounded holds', async () => {
  const { work, api, advance } = await automatic(); await reuse(work); advance(16); await work.tick(true);
  assert.equal(api.clocks[0].status, 'active'); work.hold(30); advance(20); await work.tick(false);
  assert.equal(api.clocks[0].status, 'active'); advance(11); await work.tick(false); assert.equal(api.clocks[0].status, 'paused');
  assert.equal(work.state.pausedByUser, false); await reuse(work); assert.equal(api.clocks[1].status, 'active');
  assert.throws(() => work.hold(181)); assert.throws(() => work.setIdle(0));
});
test('lost response blocks all fresh writes; explicit recovery uses identical durable operation', async () => {
  const { work, api, store } = await automatic(); api.lostResponse = 'create_task'; await work.preparePrompt();
  await assert.rejects(work.decide({ action: 'create', title: 'Durable operation test', summary: 'Verify safe recovery' }), /unresolved/);
  const pending = structuredClone(work.state.pending); assert.ok(pending); assert.ok(store.state?.pending);
  await assert.rejects(work.off(), /Unresolved/); assert.equal(api.tasks.length, 2);
  const reopened = new WorkSessions(store, api, 'session-test', workspace);
  await reopened.recover(); assert.equal(reopened.state.pending, undefined); assert.equal(reopened.state.task?.title, 'Durable operation test');
  const writes = api.writes(); assert.equal(writes.length, 2); assert.deepEqual(writes[0].args, writes[1].args); assert.equal(api.tasks.length, 2);
});
test('lost start receipt is recovered without a second timer', async () => {
  const { work, api } = await automatic(); api.lostResponse = 'start_clock';
  await assert.rejects(reuse(work), /unresolved/); assert.equal(api.clocks.length, 1);
  await work.recover(); assert.equal(api.clocks.length, 1); assert.equal(work.state.clockOwned, true);
  assert.deepEqual(api.writes()[0].args, api.writes()[1].args);
});
test('account change or another local owner prevents writes', async () => {
  const { work, api, store } = await automatic(); api.account = randomUUID();
  await work.preparePrompt(); assert.equal(work.needsDecision(), false); assert.deepEqual(api.writes(), []);
  api.account = accountId; store.conflict = true; await work.preparePrompt();
  await assert.rejects(work.decide({ action: 'reuse', task_id: taskId }), /Another session/); assert.deepEqual(api.writes(), []);
});
test('a failed read continues unavailable, without fabricated or retrospective clocks', async () => {
  const { work, api } = await automatic(); api.failRead = 'get_account'; const snapshot = await work.preparePrompt();
  assert.equal(snapshot.unavailable, true); assert.equal(work.needsDecision(), false); assert.deepEqual(api.writes(), []);
});
test('disk failure or cancellation BEFORE dispatch prevents writes', async () => {
  const { work, api, store } = await automatic(); await work.preparePrompt(); store.failSave = true;
  await assert.rejects(work.decide({ action: 'reuse', task_id: taskId }), /Disk full/); assert.deepEqual(api.writes(), []);
  store.failSave = false; const cancel = new AbortController(); cancel.abort();
  await assert.rejects(work.decide({ action: 'reuse', task_id: taskId }, cancel.signal)); assert.deepEqual(api.writes(), []);
});
test('invalid ownership/status/project and unsafe summaries are rejected', async () => {
  const { work, api } = await automatic(); api.tasks[0].assignee = { user_id: randomUUID() }; await work.preparePrompt();
  await assert.rejects(work.decide({ action: 'reuse', task_id: taskId }), /someone else/); assert.deepEqual(api.writes(), []);
  assert.throws(() => safeSummary('password = do-not-upload', 400));
});
test('a lost pause receipt preserves the user pause intent through recovery', async () => {
  const { work, api } = await automatic(); await reuse(work); api.lostResponse = 'pause_clock';
  await assert.rejects(work.pause(), /unresolved/); assert.equal(work.state.pausedByUser, true);
  await work.recover(); await reuse(work);
  assert.equal(work.state.clockId, undefined); assert.equal(api.clocks.length, 1); assert.equal(api.clocks[0].status, 'paused');
});
for (const mode of ['off', 'suggest'] as const) {
  test(`a lost ${mode} pause receipt restores the intended mode on recovery`, async () => {
    const { work, api, store } = await automatic(); await reuse(work); api.lostResponse = 'pause_clock';
    await assert.rejects(mode === 'off' ? work.off() : work.suggest(), /unresolved/);
    assert.equal(store.state?.pending?.afterMode, mode);
    const reopened = new WorkSessions(store, api, 'session-test', workspace);
    await reopened.recover(); assert.equal(reopened.state.mode, mode); assert.equal(reopened.state.clockId, undefined);
    assert.equal(store.locked, false); assert.equal(api.clocks.length, 1); assert.equal(api.clocks[0].status, 'paused');
  });
}
test('notifications, extension messages and acknowledgement-only prompts are not work', () => {
  assert.equal(isWorkPrompt('<background-task-notification>done</background-task-notification>'), false);
  assert.equal(isWorkPrompt('Thanks!'), false); assert.equal(isWorkPrompt('Fix the backend tests'), true);
});
