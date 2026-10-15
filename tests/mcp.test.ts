import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { AdapterTransport } from '../src/mcp.ts';
import { object } from '../src/types.ts';

test('documented runtime event uses configured server and preserves operation arguments', async () => {
  const events: ExtensionAPI['events'] = {
    on: () => () => {},
    emit(channel, data) {
      assert.equal(channel, 'pi-mcp-adapter:runtime-tool-call:v1');
      const req = object(data); assert.equal(req.server, 'robopm'); assert.equal(req.tool, 'robopm_get_account');
      assert.deepEqual(req.args, {});
      req.result = Promise.resolve({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ id: 'test-id', display_name: 'Test user' }) }] } });
    },
  };
  assert.deepEqual(await new AdapterTransport(events).call('get_account'), { id: 'test-id', display_name: 'Test user' });
});
test('missing adapter and denied calls fail closed without exposing raw errors', async () => {
  const events: ExtensionAPI['events'] = { on: () => () => {}, emit() {} };
  await assert.rejects(new AdapterTransport(events).call('get_account'), /unavailable/);
  events.emit = (_channel, data) => { object(data).result = Promise.resolve({ ok: false, error: new Error('secret-token-should-not-leak') }); };
  await assert.rejects(new AdapterTransport(events).call('start_clock', {}), error => error instanceof Error && !error.message.includes('secret-token'));
});
test('coordinator allowlist cannot complete/delete/edit history or call another server tool', async () => {
  let count = 0; const events: ExtensionAPI['events'] = { on: () => () => {}, emit() { count++; } };
  for (const name of ['delete_task', 'complete_clock_work', 'edit_my_clock_record', 'add_manual_clock_entry', 'drawio_export']) {
    await assert.rejects(new AdapterTransport(events).call(name), /cannot invoke/);
  }
  assert.equal(count, 0);
});
test('truncated/non-JSON content is rejected, structured content decoded at boundary', async () => {
  const events: ExtensionAPI['events'] = { on: () => () => {}, emit(_channel, data) {
    object(data).result = Promise.resolve({ ok: true, result: { content: [{ type: 'text', text: '{"items": [TRUNCATED' }] } });
  } };
  await assert.rejects(new AdapterTransport(events).call('list_tasks'), /unreadable|truncated/);
  events.emit = (_channel, data) => { object(data).result = Promise.resolve({ ok: true, result: { content: [], details: { structuredContent: { items: [] } } } }); };
  assert.deepEqual(await new AdapterTransport(events).call('list_tasks'), { items: [] });
});
