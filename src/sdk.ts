import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DataWorkspace } from './workspace.js';
import type { AgentTool, IngestOptions, QueryOptions, QueryResult, Relation } from './workspace.js';

export interface FacetOptions {
  /** Local directory, relative to process.cwd(). Created automatically. */
  directory: string;
  /** Defaults shared by direct queries and agent tools. */
  query?: QueryOptions;
}
export interface ResponseIngestOptions<T> extends Omit<IngestOptions, 'records'> {
  /** Extract API records without teaching the SDK your HTTP/auth protocol. */
  select: (response: T) => Record<string, unknown>[];
}
export class FacetError extends Error {
  constructor(readonly code: 'CLOSED' | 'INVALID_ARGUMENT' | 'STORAGE_ERROR', message: string, cause?: unknown) {
    super(message, { cause }); this.name = 'FacetError';
  }
}
function validateLimits(options: QueryOptions) {
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
  private readonly defaults: QueryOptions;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly pending = new Set<Promise<QueryResult>>();

  static open(options: FacetOptions): Facet { return new Facet(options); }

  private constructor(options: FacetOptions) {
    if (!options || typeof options.directory !== 'string' || !options.directory.trim()) {
      throw new FacetError('INVALID_ARGUMENT', 'directory must be a non-empty local path');
    }
    this.defaults = { ...options.query };
    validateLimits(this.defaults);
    this.directory = resolve(options.directory);
    this.databasePath = join(this.directory, 'data.sqlite');
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.workspace = new DataWorkspace(this.databasePath);
    } catch (error) { throw new FacetError('STORAGE_ERROR', 'Cannot open local data directory', error); }
  }

  private ensureOpen() {
    if (this.closing) throw new FacetError('CLOSED', 'This SDK instance is closed or closing; open a new instance');
  }

  readonly datasets = {
    /** Atomic synchronous batch write. Intended for bounded API result sets. */
    write: (input: IngestOptions) => { this.ensureOpen(); return this.workspace.ingest(input); },
    fromResponse: <T>(response: T, options: ResponseIngestOptions<T>) => {
      this.ensureOpen();
      const { select, ...input } = options;
      const records = select(response);
      if (!Array.isArray(records)) throw new FacetError('INVALID_ARGUMENT', 'select must return an array of records');
      return this.workspace.ingest({ ...input, records });
    },
    list: () => { this.ensureOpen(); return this.workspace.listDatasets(); },
    describe: (name: string) => { this.ensureOpen(); return this.workspace.describeDataset(name); },
  };

  readonly relations = {
    add: (relation: Relation) => { this.ensureOpen(); this.workspace.addRelation(relation); },
  };

  readonly agent = {
    instructions: () => { this.ensureOpen(); return this.workspace.agentGuide(); },
    tools: (): AgentTool[] => {
      this.ensureOpen();
      return this.workspace.agentTools().map(tool => ({ ...tool, execute: async input => {
        if (this.closing) return { ok: false, error: { code: 'CLOSED', message: 'SDK is closed or closing' } };
        if (tool.name === 'query') {
          if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Expected an object' } };
          const { sql, params } = input as { sql: string; params?: (string | number | null)[] };
          return this.query(sql, params);
        }
        return tool.execute(input);
      } }));
    },
  };

  async query(sql: string, params: (string | number | null)[] = [], options: QueryOptions = {}): Promise<QueryResult> {
    if (this.closing) return { ok: false, error: { code: 'CLOSED', message: 'SDK is closed or closing' } };
    const request = this.workspace.query(sql, params, { ...this.defaults, ...options });
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
