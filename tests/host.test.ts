import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createWorkSessionExtension } from '../src/index.ts';
import { FakeRoboPM } from './helpers.ts';

// A real Pi 1.2.0 host, isolated settings/resources, no prompts/provider requests or live MCP.
test('actual Pi host loads/binds the package off without touching credentials or remote tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robopm-pi-host-')); const api = new FakeRoboPM();
  const errors: string[] = [];
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resources = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createWorkSessionExtension({ root: join(dir, 'work-state'), transport: api })] });
  try {
    await resources.reload();
    assert.deepEqual(resources.getExtensions().errors, []);
    assert.equal(resources.getExtensions().extensions.length, 1);
    // tools: [] is an allowlist denying ALL tools, including registered extension tools.
    // Keep the normal host tool registry; this test never prompts or executes any tools.
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: resources,
      settingsManager: settings, sessionManager: SessionManager.inMemory(dir) });
    try {
      await session.bindExtensions({ onError: error => { errors.push(error.error); } });
      assert.ok(session.getAllTools().some(tool => tool.name === 'pm_prepare_work'));
      assert.ok(!session.getActiveToolNames().includes('pm_prepare_work'));
      assert.deepEqual(api.calls, []); assert.deepEqual(errors, []);
    } finally { session.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
