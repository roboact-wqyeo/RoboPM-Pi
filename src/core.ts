import { randomUUID } from 'node:crypto';
import { hash } from './store.ts';
import { clockFrom, object, safeSummary, taskFrom, text, uuid, type Account, type Clock, type Decision, type JsonObject, type PendingOperation, type Profile, type Project, type SessionState, type StateStore, type Task, type Transport, type WriteTool } from './types.ts';

export class WorkSessions {
  state: SessionState;
  profile: Profile;
  private store: StateStore;
  private client: Transport;
  private now: () => number;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private decisionRequired = false;
  constructor(store: StateStore, client: Transport, sessionId: string, workspace: string, now = Date.now) {
    this.store = store; this.client = client; this.now = now; this.profile = store.loadProfile();
    this.state = store.loadState() ?? { version: 1, sessionId, workspace, server: this.profile.server,
      mode: 'off', clockOwned: false, pausedByUser: false, lastActivityAt: now(), holdUntil: 0 };
    if (this.state.server !== this.profile.server) throw new Error('Server binding changed. Reconcile the old session before editing its profile.');
    if (this.state.pending) this.state.problem = 'An unresolved write exists. Inspect RoboPM and use /pm recover.';
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  private save(): void { this.store.saveState(this.state); }
  private key(): string {
    if (!this.state.accountId) throw new Error('No verified account.');
    return this.profile.server + '\0' + this.state.accountId;
  }
  private async account(): Promise<Account> {
    const raw = await this.client.call('get_account');
    const account = { id: uuid(raw.id), display_name: text(raw.display_name) };
    if (this.state.accountId && this.state.accountId !== account.id) throw new Error('The signed-in account changed. Restore the original sign-in and reconcile this session before switching accounts.');
    return account;
  }
  private writable(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed || this.state.mode !== 'auto' || !this.profile.autoAllowed || this.state.projectId !== this.profile.projectId) throw new Error('Automatic mode is not opted in for this workspace/project.');
    if (this.state.pending) throw new Error('Unresolved write: inspect RoboPM and use /pm recover before any new writes.');
    this.store.acquire(this.key());
  }
  private async rows(tool: string, args: JsonObject = {}): Promise<{ items: JsonObject[]; complete: boolean }> {
    const items: JsonObject[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await this.client.call(tool, { ...args, page, per_page: 25 });
      if (!Array.isArray(result.items) || typeof result.last_page !== 'number' || typeof result.page !== 'number') throw new Error('Unexpected pagination data.');
      if (result.page !== page) return { items, complete: false };
      items.push(...result.items.map(object));
      if (page >= result.last_page) return { items, complete: true };
    }
    return { items, complete: false };
  }
  async projects(): Promise<Project[]> {
    const page = await this.rows('list_projects');
    return page.items.map(p => ({ id: uuid(p.id), name: text(p.name), status: text(p.status), is_general: p.is_general === true }));
  }
  private async project(): Promise<Project> {
    const id = this.state.projectId;
    if (!id) throw new Error('Choose a project using /pm on first.');
    const projects = await this.projects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      // Direct explicit project IDs still get server-side visibility validation when lists are incomplete.
      await this.rows('list_sprints', { project_id: id });
      return { id, name: id, is_general: false };
    }
    if (project.status === 'Archived') throw new Error('Archived projects cannot be tracked automatically.');
    return project;
  }
  private async active(): Promise<Clock[]> {
    const result = await this.client.call('get_my_current_clock');
    if (!Array.isArray(result.items)) throw new Error('Unexpected current-clock result.');
    return result.items.map(clockFrom);
  }
  private async task(id: string): Promise<Task> {
    const task = taskFrom(await this.client.call('get_task', { project_id: this.state.projectId, task_id: uuid(id) }));
    if (task.project_id !== this.state.projectId) throw new Error('Task does not belong to the selected project.');
    if (['Done', 'Cancelled', 'Blocked'].includes(task.status)) throw new Error('Choose an unfinished, unblocked task; automatic tracking cannot bypass workflow gates.');
    if (task.assignee_user_id && task.assignee_user_id !== this.state.accountId) throw new Error('This task is assigned to someone else.');
    return task;
  }
  private applyReceipt(op: PendingOperation, result: JsonObject): void {
    if (op.tool === 'create_task') {
      const task = taskFrom(result);
      if (task.project_id !== this.state.projectId) throw new Error('Created task receipt has the wrong project.');
      this.state.task = task;
    } else {
      const clock = clockFrom(result);
      if (op.tool === 'start_clock') {
        if ((clock.subtask_id ?? clock.task_id) !== this.state.task?.id || clock.status !== 'active') throw new Error('Unexpected start-clock receipt.');
        this.state.clockId = clock.id; this.state.clockOwned = true;
      } else {
        if (clock.id !== op.args.session_id || clock.status === 'active') throw new Error('Unexpected pause-clock receipt.');
        this.state.clockId = undefined; this.state.clockOwned = false;
        if (op.afterMode) this.state.mode = op.afterMode;
      }
    }
  }
  private async write(tool: WriteTool, args: JsonObject, signal?: AbortSignal, afterMode?: 'off' | 'suggest'): Promise<void> {
    this.writable(signal);
    const op: PendingOperation = { tool, args: { ...args, operation_id: randomUUID() }, dispatched: false };
    if (afterMode) op.afterMode = afterMode;
    this.state.pending = op; this.save();
    op.dispatched = true; this.save(); // Persist dispatch intent before calling the server.
    try {
      const result = await this.client.call(tool, op.args);
      this.applyReceipt(op, result);
      this.state.pending = undefined; this.state.problem = undefined; this.save();
    } catch {
      this.state.pending = op;
      this.state.problem = 'Write outcome unresolved. Inspect current records; use /pm recover, not a new operation.';
      this.save();
      throw new Error(this.state.problem);
    }
  }
  private async pauseOwned(reason: string, signal?: AbortSignal, afterMode?: 'off' | 'suggest'): Promise<void> {
    if (!this.state.clockId || !this.state.clockOwned) return;
    await this.account();
    const clock = clockFrom(await this.client.call('get_my_clock_record', { session_id: this.state.clockId }));
    if ((clock.subtask_id ?? clock.task_id) !== this.state.task?.id) throw new Error('Owned clock/task binding changed; inspect it before continuing.');
    if (clock.status !== 'active') {
      this.state.clockId = undefined; this.state.clockOwned = false; this.save(); return;
    }
    await this.write('pause_clock', { session_id: clock.id, pause_reason: reason }, signal, afterMode);
  }
  private async ensureClock(summary: string, signal?: AbortSignal): Promise<void> {
    if (this.state.pausedByUser) return;
    const task = this.state.task;
    if (!task) throw new Error('No selected task.');
    const clocks = await this.active();
    if (clocks.length > 1) throw new Error('Multiple active clocks need manual reconciliation.');
    const unrelated = clocks.filter(c => c.id !== this.state.clockId && (c.subtask_id ?? c.task_id) !== task.id);
    if (unrelated.length) throw new Error('An unrelated active timer exists. Pause it yourself or keep this session in suggestion mode.');
    const matching = clocks.find(c => (c.subtask_id ?? c.task_id) === task.id);
    if (matching) {
      this.state.clockOwned = this.state.clockOwned && this.state.clockId === matching.id;
      this.state.clockId = matching.id; this.save(); return;
    }
    if (clocks.length) throw new Error('Another active timer would be interrupted; refusing to start.');
    this.state.clockId = undefined; this.state.clockOwned = false; this.save();
    const tag = hash(this.state.sessionId).slice(0, 12);
    await this.write('start_clock', { task_id: task.id, note: `Pi work: ${summary}\n[pi-work:${tag}]`, billable: 'Not Sure' }, signal);
  }
  private async assertNoForeignClock(targetTask?: string): Promise<void> {
    const clocks = await this.active();
    if (clocks.some(c => (c.id !== this.state.clockId || !this.state.clockOwned) && (c.subtask_id ?? c.task_id) !== targetTask)) throw new Error('A manual or unrelated active timer exists. No task creation or timer switching will be performed.');
  }
  on(projectId: string): Promise<void> {
    return this.serial(async () => {
      if (this.state.pending || this.state.clockOwned) throw new Error('Pause/reconcile the current session before choosing a project.');
      const account = await this.account();
      const id = uuid(projectId);
      this.state.accountId = account.id; this.state.projectId = id;
      await this.project();
      if (this.profile.projectId !== id) this.profile.autoAllowed = false;
      this.profile.projectId = id; this.store.saveProfile(this.profile);
      this.state.mode = 'suggest'; this.state.pausedByUser = false; this.state.task = undefined;
      this.state.clockId = undefined; this.state.clockOwned = false; this.state.problem = undefined;
      this.state.proposal = undefined; this.state.lastActivityAt = this.now(); this.save(); this.store.release();
    });
  }
  enableAuto(): Promise<void> {
    return this.serial(async () => {
      await this.account(); await this.project();
      if (this.state.mode === 'off' || this.state.pending) throw new Error('Start suggestion mode and reconcile pending writes first.');
      this.store.acquire(this.key());
      this.profile.autoAllowed = true; this.store.saveProfile(this.profile);
      this.state.mode = 'auto'; this.state.pausedByUser = false; this.state.lastActivityAt = this.now(); this.save();
    });
  }
  preparePrompt(): Promise<JsonObject> {
    return this.serial(async () => {
      if (this.state.mode === 'off') return { mode: 'off' };
      this.state.lastActivityAt = this.now(); this.save();
      try {
        const account = await this.account();
        if (!this.state.accountId) this.state.accountId = account.id;
        const project = await this.project();
        const tasks = await this.rows('list_tasks', { project_id: project.id, include_subtasks: true });
        if (this.state.pending) throw new Error('Pending write needs explicit recovery.');
        this.state.problem = undefined; this.decisionRequired = true; this.save();
        return { mode: this.state.mode, project, currentTask: this.state.task ?? null, lastSuggestion: this.state.proposal ?? null,
          tasks: tasks.items.map(taskFrom), tasksComplete: tasks.complete, paused: this.state.pausedByUser,
          creationDefaults: { dueDate: this.profile.dueDate ?? null, sprintId: this.profile.sprintId ?? null } };
      } catch {
        this.decisionRequired = false;
        this.state.problem = 'Bookkeeping unavailable or unresolved. Use /pm status and /pm recover; do not fabricate timesheets.'; this.save();
        return { mode: this.state.mode, unavailable: true, problem: this.state.problem };
      }
    });
  }
  needsDecision(): boolean { return this.decisionRequired; }
  endAssessment(): void { this.decisionRequired = false; }
  suggest(): Promise<void> {
    return this.serial(async () => {
      if (this.state.pending) throw new Error('Reconcile the pending write first.');
      if (this.state.mode === 'off') throw new Error('Select a project using /pm on first.');
      await this.pauseOwned('Pi work session: suggestion mode', undefined, 'suggest');
      this.state.mode = 'suggest'; this.state.pausedByUser = false; this.save(); this.store.release();
    });
  }
  decide(decision: Decision, signal?: AbortSignal): Promise<JsonObject> {
    return this.serial(async () => {
      if (!this.decisionRequired || this.state.mode === 'off') throw new Error('No genuine user-prompt assessment is pending.');
      const result = await this.select(decision, signal);
      this.decisionRequired = false;
      return result;
    });
  }
  private async select(decision: Decision, signal?: AbortSignal): Promise<JsonObject> {
    signal?.throwIfAborted();
    if (decision.action === 'skip') {
      this.state.proposal = undefined; this.save();
      return { skipped: true, note: 'No new task or clock change.' };
    }
    await this.account(); await this.project();
    if (this.state.pending) throw new Error('Resolve the pending write first.');
    let selected: Task | undefined;
    const summary = safeSummary(decision.summary ?? decision.title ?? 'Continue the selected work', 400);
    if (decision.action === 'reuse') selected = await this.task(uuid(decision.task_id));
    else if (decision.action === 'create') {
      const title = safeSummary(decision.title, 120);
      const candidates = await this.rows('list_tasks', { project_id: this.state.projectId, search: title, include_subtasks: true });
      const exact = candidates.items.map(taskFrom).find(t => t.title.normalize('NFKC').toLowerCase() === title.normalize('NFKC').toLowerCase());
      if (exact) selected = await this.task(exact.id);
      if (!selected && !candidates.complete) throw new Error('Duplicate search was incomplete. Select an existing task explicitly instead of creating one.');
      decision = { action: 'create', title, summary };
    } else throw new Error('Unknown work decision.');
    if (this.state.mode === 'suggest') {
      if (selected) decision = { action: 'reuse', task_id: selected.id, summary };
      this.state.proposal = decision; this.save();
      return { suggestion: decision, writes: false, next: 'Review this proposal. /pm auto opts in; /pm apply applies the proposal.' };
    }
    this.writable(signal);
    if (!selected || selected.id !== this.state.task?.id) {
      await this.assertNoForeignClock(selected?.id);
      // Never lose the original task binding before its own clock is safely paused.
      await this.pauseOwned('Pi work session: switching task', signal);
    }
    if (!selected) {
      const fields: JsonObject = { title: decision.title, description: summary, assignee_user_id: this.state.accountId };
      if (this.profile.dueDate) fields.due_date = this.profile.dueDate;
      const project = await this.project();
      if (!project.is_general && !this.profile.dueDate) throw new Error('Set an explicit due date with /pm due YYYY-MM-DD before creating a regular-project task.');
      if (this.profile.sprintId) {
        const sprints = await this.rows('list_sprints', { project_id: this.state.projectId });
        if (!sprints.items.some(s => s.id === this.profile.sprintId && s.status === 'Active')) throw new Error('Configured sprint is not an accessible active sprint. Update /pm sprint.');
        fields.sprint_id = this.profile.sprintId;
      }
      await this.write('create_task', { project_id: this.state.projectId, fields }, signal);
      selected = this.state.task;
    }
    if (!selected) throw new Error('No task receipt was returned.');
    this.state.task = selected; this.state.proposal = undefined; this.save();
    await this.ensureClock(summary, signal);
    return { task: selected, clockId: this.state.clockId ?? null, manualClock: Boolean(this.state.clockId && !this.state.clockOwned), paused: this.state.pausedByUser };
  }
  applyProposal(): Promise<JsonObject> {
    return this.serial(async () => {
      if (this.state.mode !== 'auto' || !this.state.proposal) throw new Error('Enable automatic mode and review a suggestion first.');
      return this.select(this.state.proposal);
    });
  }
  pause(user = true): Promise<void> {
    return this.serial(async () => {
      if (this.state.pending) throw new Error('Pending write blocks automatic pause. Inspect the live tracker and /pm recover.');
      this.state.pausedByUser = user; this.state.holdUntil = 0; this.save();
      await this.pauseOwned(user ? 'Pi work session: user pause' : 'Pi work session: idle timeout');
    });
  }
  resume(): Promise<void> {
    return this.serial(async () => {
      this.writable(); await this.account();
      this.state.pausedByUser = false; this.state.lastActivityAt = this.now(); this.save();
      if (this.state.task) { this.state.task = await this.task(this.state.task.id); await this.ensureClock('Resume selected work'); }
    });
  }
  off(): Promise<void> {
    return this.serial(async () => {
      if (this.state.pending) throw new Error('Unresolved write: inspect the live tracker and /pm recover before ending the session.');
      await this.pauseOwned('Pi work session: ended', undefined, 'off');
      this.state.mode = 'off'; this.state.pausedByUser = true; this.state.holdUntil = 0;
      this.decisionRequired = false; this.state.proposal = undefined; this.save(); this.store.release();
    });
  }
  tick(busy: boolean): Promise<void> {
    return this.serial(async () => {
      if (this.closed || busy || this.state.mode !== 'auto' || !this.state.clockOwned || !this.state.clockId || this.state.pending || this.state.problem) return;
      const deadline = Math.max(this.state.lastActivityAt + this.profile.idleMinutes * 60_000, this.state.holdUntil);
      if (this.now() < deadline) return;
      await this.pauseOwned('Pi work session: idle timeout'); this.state.holdUntil = 0; this.save();
    });
  }
  touch(): void { if (this.state.mode !== 'off') { this.state.lastActivityAt = this.now(); this.save(); } }
  setIdle(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error('Idle minutes must be between 1 and 240.');
    this.profile.idleMinutes = minutes; this.store.saveProfile(this.profile);
  }
  hold(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 180) throw new Error('Hold must be 0–180 minutes.');
    this.state.holdUntil = minutes ? this.now() + minutes * 60_000 : 0; this.save();
  }
  defaults(field: 'due' | 'sprint', value: string): void {
    if (field === 'due') {
      if (value === 'clear') this.profile.dueDate = undefined;
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw new Error('Use a real date in YYYY-MM-DD form.');
        this.profile.dueDate = value;
      }
    } else this.profile.sprintId = value === 'clear' ? undefined : uuid(value);
    this.store.saveProfile(this.profile);
  }
  inspect(): Promise<JsonObject> {
    return this.serial(async () => ({ mode: this.state.mode, account: await this.account(),
      task: this.state.task ?? null, currentClocks: (await this.active()).map(c => ({ id: c.id, task_id: c.subtask_id ?? c.task_id, status: c.status })),
      pendingTool: this.state.pending?.tool ?? null, problem: this.state.problem ?? null }));
  }
  recover(): Promise<void> {
    return this.serial(async () => {
      await this.account();
      if (this.store.recoverLease) this.store.recoverLease(this.key()); else this.store.acquire(this.key());
      const op = this.state.pending;
      try {
        if (op) {
          const result = await this.client.call(op.tool, op.args); // Explicit recovery, same ID and exact arguments only.
          this.applyReceipt(op, result); this.state.pending = undefined;
        }
        this.state.problem = undefined; this.state.lastActivityAt = this.now(); this.save();
        if (this.state.mode !== 'auto') this.store.release();
      } catch (error) {
        if (op) this.state.pending = op;
        throw error;
      }
    });
  }
  close(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      try {
        if (!this.state.pending) await this.pauseOwned('Pi work session: session shutdown/reload');
      } finally { this.closed = true; this.decisionRequired = false; this.store.release(); }
    });
  }
}
