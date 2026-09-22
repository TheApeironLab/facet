#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Facet } from './sdk.js';
import type { IngestOptions, Relation } from './workspace.js';

const schema = 'facet.cli.v1';
const commands = [
  ['tables', 'List tables in the local database'],
  ['schema', '[TABLE]: show schema and business metadata for one or all tables'],
  ['workspace init', 'Create or open local workspace'],
  ['workspace status', 'Show workspace location and dataset count'],
  ['workspace verify', 'Check catalog/schema and execute a read query for each dataset'],
  ['dataset import', '--table NAME --file FILE|- [--format json|jsonl] [--select data.items] [--key id,other] [--mode upsert|append|replace] [--metadata FILE]'],
  ['dataset list', 'List datasets'],
  ['dataset describe', '--table NAME: show columns and scope; --full includes relations and all metadata'],
  ['relation add', '--file FILE containing a Relation object'],
  ['sql', '"SELECT ..." [--params JSON_ARRAY] [--max-rows N] [--out FILE]'],
  ['query run', '--sql SQL | --sql-file FILE; [--params JSON_ARRAY] [--max-rows N] [--timeout-ms N] [--out FILE]'],
  ['agent guide', 'Print agent instructions'],
  ['agent tools', 'Print framework-neutral tool definitions'],
  ['describe', 'Print command tree and exit codes'],
];
const help = `facet — local SQLite SDK + CLI\n\nUsage: facet tables | schema [TABLE] | sql "SELECT ..." [options]\nGlobal: --directory PATH (default .facet), --jsonl, --full, --help\n\n${commands.filter(([name]) => ['tables', 'schema', 'sql'].includes(name)).map(([name, text]) => `${name}\t${text}`).join('\n')}\n\nSDK writes data; CLI reads tables, schema and SQL. Run facet describe for additional maintenance commands.\nQuery: a single SELECT/WITH without a trailing semicolon. Default output: 20 rows.\nExit codes: 0 success, 2 validation/query, 4 not found, 5 conflict, 9 timeout/storage.\n`;
class CliError extends Error { constructor(readonly exit: number, message: string) { super(message); } }
const fail = (message: string): never => { throw new CliError(2, message); };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function parseJson(text: string): any { try { return JSON.parse(text); } catch { return fail('Invalid JSON input'); } }
function read(path: string): string { return readFileSync(path === '-' ? 0 : path, 'utf8'); }
function cell(value: unknown): string { return (typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n'); }

async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    directory: { type: 'string', default: '.facet' }, jsonl: { type: 'boolean' }, full: { type: 'boolean' }, help: { type: 'boolean' },
    table: { type: 'string' }, file: { type: 'string' }, format: { type: 'string', default: 'json' }, select: { type: 'string' }, key: { type: 'string' }, mode: { type: 'string' }, metadata: { type: 'string' },
    sql: { type: 'string' }, 'sql-file': { type: 'string' }, params: { type: 'string' }, 'max-rows': { type: 'string' }, 'timeout-ms': { type: 'string' }, out: { type: 'string' },
  } });
  const directSql = positionals[0] === 'sql';
  if (directSql && positionals.length > 2) fail('Quote the SQL as one argument: facet sql \"SELECT ...\"');
  if (directSql && positionals[1] !== undefined) {
    if (v.sql || v['sql-file']) fail('Provide SQL either as a positional argument or with --sql/--sql-file');
    v.sql = positionals[1];
  }
  const directSchema = positionals[0] === 'schema';
  if (directSchema && positionals.length > 2) fail('Usage: facet schema [TABLE]');
  if (directSchema && positionals[1] !== undefined) {
    if (v.table) fail('Provide table either positionally or with --table');
    v.table = positionals[1];
  }
  const command = directSql ? 'sql' : directSchema ? 'schema' : positionals.join(' ');
  if (v.help || !command) { process.stdout.write(help); return; }
  if (!commands.some(([name]) => name === command)) fail(`Unknown command: ${command}`);
  const emit = (data: Record<string, unknown>, rows?: Record<string, unknown>[]) => {
    if (v.jsonl) {
      process.stdout.write(JSON.stringify({ schema, ...data }) + '\n');
      for (const row of rows ?? []) process.stdout.write(JSON.stringify({ schema, kind: 'row', data: row }) + '\n');
    } else {
      process.stdout.write(`schema=${schema}\t${Object.entries(data).map(([k, val]) => `${k}=${cell(val)}`).join('\t')}\n`);
      if (rows?.length) {
        const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
        process.stdout.write(keys.map(cell).join('\t') + '\n');
        for (const row of rows) process.stdout.write(keys.map(k => cell(row[k])).join('\t') + '\n');
      }
    }
  };
  if (command === 'describe') { emit({ kind: 'commands', exitCodes: { success: 0, validation: 2, notFound: 4, conflict: 5, transient: 9 } }, commands.map(([command, usage]) => ({ command, usage }))); return; }
  const directory = resolve(v.directory);
  // Reads never create a workspace accidentally due to a path typo.
  if (command !== 'workspace init' && !existsSync(join(directory, 'data.sqlite'))) throw new CliError(4, 'Workspace not found; run workspace init with the same --directory');
  const required = (key: 'table' | 'file') => v[key] || fail(`--${key} is required`);
  const sdk = Facet.open({ directory });
  try {
    switch (command) {
      case 'workspace init': emit({ status: 'ready', directory, databasePath: sdk.databasePath }); break;
      case 'workspace status': emit({ status: 'ready', directory, datasets: sdk.datasets.list().length }); break;
      case 'workspace verify': {
        for (const dataset of sdk.datasets.list()) {
          const result = await sdk.query(`SELECT ${Object.keys(dataset.columns).map(k => `"${k}"`).join(',')} FROM "${dataset.name}" LIMIT 0`);
          if (!result.ok) throw new CliError(9, result.error.message);
        }
        emit({ status: 'verified', datasets: sdk.datasets.list().length }); break;
      }
      case 'tables':
      case 'dataset list': {
        const datasets = sdk.datasets.list();
        emit({ count: datasets.length }, datasets.map(d => ({ name: d.name, rows: d.rowCount, completeness: d.source.completeness, description: d.description ?? '' }))); break;
      }
      case 'schema': {
        const all = sdk.datasets.list();
        const names = v.table ? [v.table] : all.map(d => d.name);
        if (v.table && !all.some(d => d.name === v.table)) throw new CliError(4, `Unknown table: ${v.table}`);
        if (!names.length) emit({ count: 0 });
        for (const name of names) {
          const d = sdk.datasets.describe(name);
          if (v.jsonl || v.full) emit({ dataset: d });
          else emit({ name: d.name, description: d.description ?? '', rows: d.rowCount, source: d.source, grain: d.grain ?? '', primaryKey: d.primaryKey, relations: d.relations }, Object.entries(d.columns).map(([name, c]) => ({ name, ...c })));
        }
        break;
      }
      case 'dataset describe': {
        const name = required('table');
        if (!sdk.datasets.list().some(d => d.name === name)) throw new CliError(4, `Unknown dataset: ${name}`);
        const d = sdk.datasets.describe(name);
        if (v.full) emit({ dataset: d });
        else emit({ name: d.name, rows: d.rowCount, source: d.source, grain: d.grain ?? '' }, Object.entries(d.columns).map(([name, c]) => ({ name, ...c })));
        break;
      }
      case 'dataset import': {
        const table = required('table');
        const raw = read(required('file'));
        if (!['json', 'jsonl'].includes(v.format)) fail('--format must be json or jsonl');
        let records: unknown = v.format === 'jsonl' ? raw.split(/\r?\n/).filter(line => line.trim()).map(parseJson) : parseJson(raw);
        if (v.select) {
          if (v.format === 'jsonl') fail('--select only applies to JSON input');
          for (const key of v.select.split('.')) {
            if (!object(records) || !Object.hasOwn(records, key)) fail(`Missing --select path: ${v.select}`);
            records = (records as Record<string, unknown>)[key];
          }
        }
        if (!Array.isArray(records) || !records.every(object)) fail('Input must be an array of record objects; use --select for API envelopes');
        const metadata = v.metadata ? parseJson(read(v.metadata)) : {};
        if (!object(metadata) || Object.keys(metadata).some(k => !['description', 'grain', 'columns', 'source'].includes(k))) fail('Metadata accepts description, grain, columns and source only');
        const mode = v.mode ?? 'upsert';
        if (!['upsert', 'append', 'replace'].includes(mode)) fail('Invalid --mode');
        const result = sdk.datasets.write({ ...metadata, table, records: records as Record<string, unknown>[], mode: mode as IngestOptions['mode'], primaryKey: v.key?.split(',').map(k => k.trim()) });
        emit({ status: 'written', table, inputRows: (records as unknown[]).length, totalRows: result.rowCount, version: result.version }); break;
      }
      case 'relation add': {
        const relation = parseJson(read(required('file')));
        if (!object(relation) || !object(relation.from) || !object(relation.to) || !['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many'].includes(String(relation.cardinality))) fail('Invalid relation object');
        sdk.relations.add(relation as unknown as Relation); emit({ status: 'saved' }); break;
      }
      case 'sql':
      case 'query run': {
        if (!!v.sql === !!v['sql-file']) fail('Provide exactly one of --sql and --sql-file');
        const sql = v.sql ?? read(v['sql-file']!);
        const params = v.params ? parseJson(v.params) : [];
        const result = await sdk.query(sql, params, { maxRows: Number(v['max-rows'] ?? 20), timeoutMs: Number(v['timeout-ms'] ?? 5000) });
        if (!result.ok) throw new CliError(result.error.code === 'TIMEOUT' ? 9 : 2, result.error.message);
        const { rows, ...metadata } = result;
        if (v.out) {
          // Exclusive creation avoids accidentally overwriting inputs or existing reports.
          writeFileSync(v.out, JSON.stringify({ schema, kind: 'result', ...metadata }) + '\n' + rows.map(data => JSON.stringify({ schema, kind: 'row', data }) + '\n').join(''), { flag: 'wx', mode: 0o600 });
          emit({ status: 'exported', path: resolve(v.out), returnedRows: result.returnedRows, truncated: result.truncated });
        } else emit(metadata, rows);
        break;
      }
      case 'agent guide': {
        const instructions = sdk.agent.instructions().replace('Use list_datasets, then describe_dataset before querying.', 'Use facet tables, then facet schema [TABLE], then facet sql \"SELECT ...\". Add --directory PATH for the workspace written by the SDK.');
        if (v.jsonl) emit({ instructions }); else process.stdout.write(instructions + '\n');
        break;
      }
      case 'agent tools': emit({ count: 3 }, sdk.agent.tools().map(({ execute, ...definition }) => definition)); break;
    }
  } finally { await sdk.close(); }
}
main().catch((error: any) => {
  const exit = error instanceof CliError ? error.exit : error.code === 'ENOENT' ? 4 : error.code === 'EEXIST' || /UNIQUE constraint/.test(error.message) ? 5 : /BUSY|locked/.test(error.message) || error.code === 'STORAGE_ERROR' ? 9 : 2;
  process.stderr.write(`code: ${exit}\nmessage: ${cell(error.message)}\nretry: facet --help\n`);
  process.exitCode = exit;
});
