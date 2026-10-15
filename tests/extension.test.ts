import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createWorkSessionExtension } from '../src/index.ts';
import type { JsonObject } from '../src/types.ts';
import { projectId, taskId, workspace, MemoryStore, FakeRoboPM } from './helpers.ts';

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type Execute = (id: string, params: JsonObject, signal: AbortSignal, update: undefined, ctx: ExtensionContext) => Promise<unknown>;
function hostStub<T extends object>(members: Partial<T>): T {
  // SAFETY: test-only partial host; any unimplemented API fails loudly rather than faking success.
  return new Proxy(members, { get(target, key, receiver) {
    if (!Reflect.has(target, key)) throw new Error(`Unimplemented test host API: ${String(key)}`);
    return Reflect.get(target, key, receiver);
  } }) as T;
}
function fixture() {
  const handlers = new Map<string, Handler>(); const tools = new Map<string, Execute>();
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let active = ['read', 'bash', 'mcp']; const notices: string[] = []; const statuses = new Map<string, string | undefined>(); let consent = false;
  const store = new MemoryStore(); const api = new FakeRoboPM();
  // SAFETY: these partial host/context mocks implement every API exercised by this extension;
  // event and tool inputs below are controlled fixtures, not values from a remote server.
  const partial: Partial<ExtensionAPI> = {
    on(name, handler) { handlers.set(name, handler as Handler); return () => { handlers.delete(name); }; },
    registerTool(definition) { tools.set(definition.name, definition.execute as Execute); },
    registerCommand(_name, definition) { command = definition.handler; },
    getActiveTools: () => active,
    setActiveTools: names => { active = names; },
    sendMessage: () => {},
    events: { emit: () => {}, on: () => () => {} },
  };
  const ctx = hostStub<ExtensionCommandContext>({
    cwd: workspace, hasUI: true, signal: new AbortController().signal, isIdle: () => true,
    sessionManager: hostStub<ExtensionContext['sessionManager']>({ getSessionId: () => 'extension-session' }),
    ui: hostStub<ExtensionContext['ui']>({ notify: (message: string) => { notices.push(message); }, setStatus: (key: string, value?: string) => { statuses.set(key, value); }, confirm: async () => consent }),
  });
  createWorkSessionExtension({ store: () => store, transport: api, timerMs: 60_000 })(partial as ExtensionAPI);
  const emit = async (name: string, event: JsonObject = {}) => handlers.get(name)?.(event as never, ctx);
  const cmd = async (args: string) => { assert.ok(command); await command(args, ctx); };
  const prepare = async (prompt: string, source = 'interactive') => {
    await emit('input', { source, text: prompt });
    return emit('before_agent_start', { prompt, messageType: 'user', systemPrompt: 'Host system prompt' });
  };
  const decide = async (params: JsonObject) => tools.get('pm_prepare_work')!('tool-id', params, new AbortController().signal, undefined, ctx);
  return { api, store, notices, statuses, ctx, emit, cmd, prepare, decide, active: () => active, consent: (value: boolean) => { consent = value; } };
}

test('loading/off has no remote calls or active bookkeeping tool and preserves unrelated tools', async () => {
  const f = fixture(); await f.emit('session_start');
  await f.prepare('Implement this feature'); assert.deepEqual(f.api.calls, []); assert.deepEqual(f.active(), ['read', 'bash', 'mcp']);
  await f.cmd('status'); assert.deepEqual(f.api.calls, []); await f.emit('session_shutdown');
});
test('user opt-in starts suggestions, helper gates work, and auto requires UI consent', async () => {
  const f = fixture(); try {
    await f.emit('session_start'); await f.cmd(`on ${projectId}`);
    assert.ok(f.active().includes('pm_prepare_work')); assert.ok(f.active().includes('mcp'));
    const preflight = await f.prepare('Implement the Pi work-session extension'); assert.ok(preflight);
    const blocked = await f.emit('tool_call', { toolName: 'bash', input: { command: 'echo change' } }); assert.ok(blocked);
    await f.decide({ action: 'reuse', task_id: taskId, summary: 'Implement work sessions' });
    assert.deepEqual(f.api.writes(), []); assert.equal(await f.emit('tool_call', { toolName: 'bash', input: {} }), undefined);
    await f.cmd('auto'); assert.equal(f.store.state?.mode, 'suggest');
    f.consent(true); await f.cmd('auto'); assert.equal(f.store.state?.mode, 'auto');
    await f.cmd('apply'); assert.deepEqual(f.api.writes().map(c => c.tool), ['start_clock']);
    await f.emit('agent_settled'); assert.equal(f.api.clocks[0].status, 'active');
    await f.cmd('off'); assert.equal(f.api.clocks[0].status, 'paused'); assert.deepEqual(f.active(), ['read', 'bash', 'mcp']);
  } finally { await f.emit('session_shutdown'); }
});
test('background/system/extension inputs and acknowledgements cause no preflight', async () => {
  const f = fixture(); try {
    await f.emit('session_start'); await f.cmd(`on ${projectId}`); f.api.calls = [];
    assert.equal(await f.prepare('<background-task-notification>done</background-task-notification>'), undefined);
    assert.equal(await f.prepare('Extension-injected summary', 'extension'), undefined);
    assert.equal(await f.prepare('Thanks!'), undefined);
    assert.deepEqual(f.api.calls, []);
    await f.emit('before_agent_start', { messageType: 'custom', prompt: 'Background work finished' }); assert.deepEqual(f.api.calls, []);
  } finally { await f.emit('session_shutdown'); }
});
test('aborted turn clears the gate; reminder is bounded and never runs on abort', async () => {
  const f = fixture(); try {
    await f.emit('session_start'); await f.cmd(`on ${projectId}`); await f.prepare('Implement this feature');
    assert.ok(await f.emit('agent_before_settle', { outcome: 'completed' }));
    assert.equal(await f.emit('agent_before_settle', { outcome: 'completed' }), undefined);
    await f.emit('agent_settled', { outcome: 'aborted' });
    assert.equal(await f.emit('tool_call', { toolName: 'read', input: {} }), undefined);
    await f.prepare('A separate unit of work'); assert.equal(await f.emit('agent_before_settle', { outcome: 'aborted' }), undefined);
    assert.deepEqual(f.api.writes(), []);
  } finally { await f.emit('session_shutdown'); }
});
