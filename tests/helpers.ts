import { randomUUID } from 'node:crypto';
import { defaultProfile, object, type JsonObject, type Profile, type SessionState, type StateStore, type Transport } from '../src/types.ts';
export const accountId = '11111111-1111-4111-8111-111111111111';
export const projectId = '22222222-2222-4222-8222-222222222222';
export const taskId = '33333333-3333-4333-8333-333333333333';
export const otherTaskId = '44444444-4444-4444-8444-444444444444';
export const workspace = process.cwd();
export const makeTask = (id = taskId, title = 'Implement Pi work sessions'): JsonObject => ({ id, title, status: 'ToDo', project_id: projectId, assignee: { user_id: accountId, display_name: 'Test user' } });
export class MemoryStore implements StateStore {
  profile = defaultProfile(workspace);
  state?: SessionState;
  locked = false;
  conflict = false;
  snapshots: SessionState[] = [];
  failSave = false;
  loadState(): SessionState | undefined { return this.state ? structuredClone(this.state) : undefined; }
  saveState(state: SessionState): void {
    if (this.failSave) throw new Error('Disk full');
    this.state = structuredClone(state); this.snapshots.push(structuredClone(state));
  }
  loadProfile(): Profile { return structuredClone(this.profile); }
  saveProfile(profile: Profile): void { this.profile = structuredClone(profile); }
  acquire(): void { if (this.conflict) throw new Error('Another session owns tracker'); this.locked = true; }
  release(): void { this.locked = false; }
}
export class FakeRoboPM implements Transport {
  calls: { tool: string; args: JsonObject }[] = [];
  tasks = [makeTask()];
  clocks: JsonObject[] = [];
  account = accountId;
  general = true;
  lostResponse?: string;
  failRead?: string;
  repeatPage = false;
  receipts = new Map<string, JsonObject>();
  async call(tool: string, args: JsonObject = {}): Promise<JsonObject> {
    this.calls.push({ tool, args: structuredClone(args) });
    if (tool === this.failRead) throw new Error('Network unavailable');
    const operation = args.operation_id;
    if (typeof operation === 'string' && this.receipts.has(operation)) return structuredClone(this.receipts.get(operation)!);
    let result: JsonObject;
    switch (tool) {
      case 'get_account': return { id: this.account, display_name: 'Test user' };
      case 'list_projects': return { items: [{ id: projectId, name: 'Pi integration', status: 'Active', is_general: this.general }], page: 1, last_page: 1 };
      case 'list_sprints': return { items: [], page: 1, last_page: 1 };
      case 'list_tasks': return { items: this.tasks.filter(t => !args.search || String(t.title).toLowerCase().includes(String(args.search).toLowerCase())), page: this.repeatPage ? 1 : args.page ?? 1, last_page: this.repeatPage ? 2 : 1 };
      case 'get_task': {
        const task = this.tasks.find(t => t.id === args.task_id); if (!task) throw new Error('Not found'); return structuredClone(task);
      }
      case 'get_my_current_clock': return { items: this.clocks.filter(c => c.status === 'active') };
      case 'get_my_clock_record': {
        const clock = this.clocks.find(c => c.id === args.session_id); if (!clock) throw new Error('Clock not found'); return structuredClone(clock);
      }
      case 'create_task': {
        const fields = object(args.fields);
        result = makeTask(randomUUID(), String(fields.title)); this.tasks.push(result); break;
      }
      case 'start_clock': {
        for (const clock of this.clocks) if (clock.status === 'active') clock.status = 'paused';
        result = { id: randomUUID(), task_id: args.task_id, status: 'active', note: args.note, started_at: new Date().toISOString() };
        this.clocks.push(result); break;
      }
      case 'pause_clock': {
        const clock = this.clocks.find(c => c.id === args.session_id); if (!clock) throw new Error('Clock not found');
        clock.status = 'paused'; result = clock; break;
      }
      default: throw new Error(`Unexpected tool: ${tool}`);
    }
    if (typeof operation !== 'string') throw new Error('Write without operation ID');
    this.receipts.set(operation, structuredClone(result));
    if (tool === this.lostResponse) { this.lostResponse = undefined; throw new Error('Lost response after commit'); }
    return structuredClone(result);
  }
  writes(): { tool: string; args: JsonObject }[] { return this.calls.filter(c => ['create_task', 'start_clock', 'pause_clock'].includes(c.tool)); }
}
