import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { FacetError, asFacetError } from './errors.js';
import { poolLimits, type PoolOptions } from './query-pool.js';
export { FacetError } from './errors.js';
import { DataWorkspace } from './workspace.js';
import type { AgentTool, WriteOptions, SqlOptions, SqlResult, Relation } from './workspace.js';

export interface FacetOptions {
  /** Local directory, relative to process.cwd(). Created automatically. */
  directory: string;
  /** Defaults shared by direct queries and agent tools. */
  sql?: SqlOptions;
  /** Persistent query processes and bounded waiting queue, per SDK instance. */
  pool?: PoolOptions;
}
export interface ResponseWriteOptions<T> extends Omit<WriteOptions, 'records'> {
  /** Extract API records without teaching the SDK your HTTP/auth protocol. */
  select: (response: T) => Record<string, unknown>[];
}
function validateLimits(options: SqlOptions) {
  for (const [name, max] of [['maxRows', 10000], ['maxBytes', 10 * 1024 * 1024], ['timeoutMs', 30000]] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > max)) {
      throw new FacetError('INVALID_ARGUMENT', `${name} must be an integer between 1 and ${max}`);
    }
  }
}

/** Embedded local SDK. No server, remote storage or model client required. */
export class Facet {
  readonly directory: string;
  readonly databasePath: string;
  private readonly workspace: DataWorkspace;
  private readonly defaults: SqlOptions;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly pending = new Set<Promise<SqlResult>>();

  static open(options: FacetOptions): Facet { return new Facet(options); }

  private constructor(options: FacetOptions) {
    if (!options || typeof options.directory !== 'string' || !options.directory.trim()) {
      throw new FacetError('INVALID_ARGUMENT', 'directory must be a non-empty local path');
    }
    this.defaults = { ...options.sql };
    validateLimits(this.defaults);
    poolLimits(options.pool);
    this.directory = resolve(options.directory);
    this.databasePath = join(this.directory, 'data.sqlite');
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.workspace = new DataWorkspace(this.databasePath, options.pool);
    } catch (error) { throw new FacetError('STORAGE_ERROR', 'Cannot open local data directory', error); }
  }

  private ensureOpen() {
    if (this.closing) throw new FacetError('CLOSED', 'This SDK instance is closed or closing; open a new instance');
  }

  write(input: WriteOptions) { this.ensureOpen(); return this.workspace.write(input); }
  writeResponse<T>(response: T, options: ResponseWriteOptions<T>) {
    this.ensureOpen();
    if (!options || typeof options.select !== 'function') throw new FacetError('INVALID_ARGUMENT', 'writeResponse requires a select function');
    const { select, ...input } = options;
    let records: Record<string, unknown>[];
    try { records = select(response); } catch (error) { throw asFacetError(error, 'INVALID_ARGUMENT'); }
    if (!Array.isArray(records)) throw new FacetError('INVALID_ARGUMENT', 'select must return an array of records');
    return this.workspace.write({ ...input, records });
  }
  tables() {
    this.ensureOpen();
    return this.workspace.tables().map(({ name, description, rowCount, source }) => ({ name, description, rowCount, source }));
  }
  schema(): ReturnType<DataWorkspace['schema']>[];
  schema(name: string): ReturnType<DataWorkspace['schema']>;
  schema(name?: string) {
    this.ensureOpen();
    return name === undefined ? this.workspace.tables().map(t => this.workspace.schema(t.name)) : this.workspace.schema(name);
  }
  relate(relation: Relation) { this.ensureOpen(); try { this.workspace.relate(relation); } catch (error) { throw asFacetError(error, 'INVALID_ARGUMENT'); } }
  drop(name: string, options: { ifExists?: boolean } = {}) { this.ensureOpen(); return this.workspace.drop(name, options); }
  stats() { this.ensureOpen(); return this.workspace.stats(); }
  instructions() { this.ensureOpen(); return this.workspace.instructions(); }
  tools(): AgentTool[] {
    this.ensureOpen();
    return this.workspace.tools().map(tool => ({ ...tool, execute: async input => {
      if (this.closing) return { ok: false, error: { code: 'CLOSED', message: 'SDK is closed or closing' } };
      if (tool.name === 'sql') {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Expected an object' } };
        const { sql, params } = input as { sql: string; params?: (string | number | null)[] };
        return this.sql(sql, params);
      }
      return tool.execute(input);
    } }));
  }

  async sql(sql: string, params: (string | number | null)[] = [], options: SqlOptions = {}): Promise<SqlResult> {
    if (this.closing) return { ok: false, error: { code: 'CLOSED', message: 'SDK is closed or closing' } };
    const request = this.workspace.sql(sql, params, { ...this.defaults, ...options });
    this.pending.add(request);
    try { return await request; } finally { this.pending.delete(request); }
  }

  /** Reject new work, drain in-flight queries, then release the local database. */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = Promise.allSettled([...this.pending]).then(() => this.workspace.close());
    }
    return this.closePromise;
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}
