import { fork, type ChildProcess } from 'node:child_process';
import { FacetError } from './errors.js';
import type { SqlResult } from './workspace.js';
export interface PoolOptions { maxWorkers?: number; maxQueue?: number }
export interface QueryRequest { sql: string; params: (string | number | null)[]; maxRows: number; maxBytes: number; timeoutMs: number }
interface Job { id: number; request: QueryRequest; start: number; resolve: (result: SqlResult) => void; timer?: NodeJS.Timeout; done: boolean }
interface Slot { child: ChildProcess; job?: Job; stopping: boolean }
const failure = (code: string, message: string): SqlResult => ({ ok: false, error: { code, message } });
export function poolLimits(options: PoolOptions = {}) {
  const maxWorkers = options.maxWorkers ?? 2;
  const maxQueue = options.maxQueue ?? 64;
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32 || !Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > 10000)
    throw new FacetError('INVALID_ARGUMENT', 'pool.maxWorkers must be 1..32 and pool.maxQueue must be 0..10000');
  return { maxWorkers, maxQueue };
}
/** Per-workspace bounded pool. A dying child still occupies a slot until exit. */
export class QueryPool {
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private readonly limits: ReturnType<typeof poolLimits>;
  private sequence = 0;
  private closing = false;
  private closePromise?: Promise<void>;
  private closed?: () => void;
  private spawned = 0;
  private peak = 0;
  constructor(private readonly path: string, options: PoolOptions = {}) { this.limits = poolLimits(options); }
  stats() { return { ...this.limits, workers: this.slots.size, workerPids: [...this.slots].map(s => s.child.pid).filter((pid): pid is number => pid !== undefined), active: [...this.slots].filter(s => s.job).length, queued: this.queue.length, spawned: this.spawned, peakWorkers: this.peak }; }
  run(request: QueryRequest): Promise<SqlResult> {
    if (this.closing) return Promise.resolve(failure('CLOSED', 'Query pool is closing'));
    const available = [...this.slots].some(s => !s.job && !s.stopping) || this.slots.size < this.limits.maxWorkers;
    if (!available && this.queue.length >= this.limits.maxQueue) return Promise.resolve(failure('QUEUE_FULL', 'Query queue is full; reduce concurrency or retry later'));
    return new Promise(resolve => {
      const job: Job = { id: ++this.sequence, request, start: performance.now(), resolve, done: false };
      job.timer = setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index !== -1) this.queue.splice(index, 1);
        const slot = [...this.slots].find(s => s.job === job);
        // Mark stopping before settling; do not reuse the timed-out process.
        if (slot) this.stop(slot);
        this.settle(job, failure('TIMEOUT', 'Query exceeded its total queue + execution time budget'));
        this.pump();
      }, request.timeoutMs);
      this.queue.push(job); this.pump();
    });
  }
  private settle(job: Job, result: SqlResult) {
    if (job.done) return;
    job.done = true; clearTimeout(job.timer);
    job.resolve(result.ok ? { ...result, elapsedMs: Math.round((performance.now() - job.start) * 100) / 100 } : result);
  }
  private stop(slot: Slot) { slot.stopping = true; slot.child.kill('SIGKILL'); }
  private spawn(): Slot {
    const child = fork(new URL('./query-worker.js', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    const slot: Slot = { child, stopping: false };
    this.slots.add(slot); this.spawned++; this.peak = Math.max(this.peak, this.slots.size);
    child.on('message', (message: any) => {
      if (slot.stopping || !slot.job || message.id !== slot.job.id) return;
      this.settle(slot.job, message.result);
      slot.job = undefined; this.pump();
    });
    child.on('error', error => {
      if (slot.job) this.settle(slot.job, failure('WORKER_ERROR', error.message));
      this.stop(slot);
    });
    // close also occurs after failed spawn; freeing only here bounds live children.
    child.once('close', () => {
      if (slot.job) this.settle(slot.job, failure('WORKER_ERROR', 'Query process exited before returning a result'));
      this.slots.delete(slot); this.pump();
    });
    return slot;
  }
  private pump() {
    while (this.queue.length) {
      let slot = [...this.slots].find(s => !s.job && !s.stopping);
      if (!slot && this.slots.size < this.limits.maxWorkers) {
        try { slot = this.spawn(); }
        catch (error) { this.settle(this.queue.shift()!, failure('WORKER_ERROR', String(error))); continue; }
      }
      if (!slot) break;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.child.send({ id: job.id, path: this.path, ...job.request }, error => {
        if (!error || slot!.job !== job) return;
        this.settle(job, failure('WORKER_ERROR', error.message)); this.stop(slot!);
      });
    }
    if (this.closing && !this.queue.length) {
      for (const slot of this.slots) if (!slot.job && !slot.stopping) this.stop(slot);
      if (!this.slots.size) this.closed?.();
    }
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = new Promise(resolve => { this.closed = resolve; });
      this.pump();
    }
    return this.closePromise;
  }
}
