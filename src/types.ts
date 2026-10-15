export type JsonObject = Record<string, unknown>;
export type Mode = 'off' | 'suggest' | 'auto';
export type Decision = { action: 'reuse' | 'create' | 'skip'; task_id?: string; title?: string; summary?: string };
export type Task = { id: string; title: string; status: string; project_id?: string; assignee_user_id?: string | null };
export type Clock = { id: string; task_id: string | null; subtask_id?: string | null; status: string; note?: string | null; started_at?: string };
export type Account = { id: string; display_name: string };
export type Project = { id: string; name: string; status?: string; is_general?: boolean };
export type Profile = {
  version: 1; workspace: string; server: string; projectId?: string; autoAllowed: boolean;
  idleMinutes: number; dueDate?: string; sprintId?: string;
};
export type WriteTool = 'create_task' | 'start_clock' | 'pause_clock';
export type PendingOperation = { tool: WriteTool; args: JsonObject; dispatched: boolean; afterMode?: 'off' | 'suggest' };
export type SessionState = {
  version: 1; sessionId: string; workspace: string; server: string; mode: Mode;
  accountId?: string; projectId?: string; task?: Task; clockId?: string; clockOwned: boolean;
  pausedByUser: boolean; lastActivityAt: number; holdUntil: number;
  pending?: PendingOperation; problem?: string; proposal?: Decision;
};
export interface Transport { call(tool: string, args?: JsonObject): Promise<JsonObject> }
export interface StateStore {
  loadState(): SessionState | undefined;
  saveState(state: SessionState): void;
  loadProfile(): Profile;
  saveProfile(profile: Profile): void;
  acquire(accountKey: string): void;
  recoverLease?(accountKey: string): void;
  release(): void;
}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected RoboPM response shape.');
  return value as JsonObject;
}
export function text(value: unknown, max = 200): string {
  if (typeof value !== 'string') throw new Error('Expected text.');
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max);
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('A valid UUID is required.');
  return value.toLowerCase();
}
export function safeSummary(value: unknown, max: number): string {
  const result = text(value, max);
  if (!result || /(?:bearer\s+[a-z0-9_.-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|(?:password|api[_-]?key|client[_-]?secret)\s*[:=])/i.test(result)) throw new Error('Use a brief non-secret work summary.');
  return result;
}
export function decisionFrom(value: unknown): Decision {
  const v = object(value);
  if (v.action === 'skip') return { action: 'skip' };
  if (v.action === 'reuse') return { action: 'reuse', task_id: uuid(v.task_id), summary: safeSummary(v.summary, 400) };
  if (v.action === 'create') return { action: 'create', title: safeSummary(v.title, 120), summary: safeSummary(v.summary, 400) };
  throw new Error('Invalid saved work proposal.');
}
export function taskFrom(value: unknown): Task {
  const v = object(value);
  const result: Task = { id: uuid(v.id), title: text(v.title), status: text(v.status) };
  if (typeof v.project_id === 'string') result.project_id = uuid(v.project_id);
  if (v.assignee != null) result.assignee_user_id = uuid(object(v.assignee).user_id);
  else if (typeof v.assignee_user_id === 'string') result.assignee_user_id = uuid(v.assignee_user_id);
  return result;
}
export function clockFrom(value: unknown): Clock {
  const v = object(value);
  return { id: uuid(v.id), task_id: v.task_id == null ? null : uuid(v.task_id),
    ...(typeof v.subtask_id === 'string' ? { subtask_id: uuid(v.subtask_id) } : {}),
    status: text(v.status), note: typeof v.note === 'string' ? v.note : null,
    ...(typeof v.started_at === 'string' ? { started_at: v.started_at } : {}) };
}
export function isWorkPrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (!p || /^<(?:(?:background-task|subagent|mcp-oauth)-notification|background-task-notification|summary)[\s>]/i.test(p)) return false;
  return !/^(?:thanks(?: a lot)?|thank you(?: very much)?|ok(?:ay)?|great|nice|got it|understood|cheers)[\s!.🙂👍]*$/i.test(p);
}
export function defaultProfile(workspace: string): Profile {
  return { version: 1, workspace, server: 'robopm', autoAllowed: false, idleMinutes: 15 };
}
