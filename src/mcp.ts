import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { object, type JsonObject, type Transport } from './types.ts';

const READ_TOOLS = ['get_account', 'list_projects', 'list_sprints', 'list_tasks', 'get_task', 'get_my_current_clock', 'get_my_clock_record'];
const WRITE_TOOLS = ['create_task', 'start_clock', 'pause_clock'];
export const ALLOWED_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS]);
const EVENT = 'pi-mcp-adapter:runtime-tool-call:v1';
type Outcome = { ok: true; result: { content: unknown[]; details?: unknown; structuredContent?: unknown } } | { ok: false; error: Error };
type Request = { version: 1; server: string; tool: string; args: JsonObject; result?: Promise<Outcome> };

/** Adapter's documented event API: normal server/approval settings apply; no token handling. */
export class AdapterTransport implements Transport {
  private events: ExtensionAPI['events'];
  private server: string;
  constructor(events: ExtensionAPI['events'], server = 'robopm') { this.events = events; this.server = server; }
  async call(tool: string, args: JsonObject = {}): Promise<JsonObject> {
    if (!ALLOWED_TOOLS.has(tool)) throw new Error('This work-session integration cannot invoke that MCP tool.');
    const request: Request = { version: 1, server: this.server, tool: `${this.server}_${tool}`, args };
    this.events.emit(EVENT, request);
    if (!request.result) throw new Error('pi-mcp-adapter is unavailable. Keep its extension enabled and reload Pi.');
    const response = await request.result;
    if (!response.ok) throw new Error('RoboPM call failed or was denied. Check /mcp-adapter; uncertain writes require /pm recover.');
    const result = response.result;
    if (result.structuredContent !== undefined) return object(result.structuredContent);
    if (result.details && typeof result.details === 'object') {
      const details = object(result.details);
      if (details.structuredContent !== undefined) return object(details.structuredContent);
    }
    for (const block of result.content) {
      const value = object(block);
      if (value.type !== 'text' || typeof value.text !== 'string') continue;
      try { return object(JSON.parse(value.text)); } catch { /* A truncated or non-JSON result is not trusted. */ }
    }
    throw new Error('RoboPM returned an unreadable or truncated result. No automatic recovery writes will be attempted.');
  }
}
