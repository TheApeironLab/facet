#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Facet } from './sdk.js';

const outputSchema = 'facet.cli.v2';
const help = `facet — local SQL for agents
Usage:
  facet tables
  facet schema [TABLE]
  facet sql 'SELECT ...' [--params '[...]']
Options:
  --directory PATH   Local directory (default .facet)
  --jsonl            Machine-readable output
  --sql-file FILE    Read SQL from a file, or - for stdin
  --max-rows N       Result cap (default 20, maximum 10000)
  --timeout-ms N     Time budget (default 5000, maximum 30000)
  --out FILE         Save SQL results as JSONL; refuses overwrite
  --help             Show this help
SDK writes data. CLI reads it. Use a single SELECT/WITH without a trailing semicolon.
Exit codes: 0 success, 2 invalid input/SQL, 4 not found, 5 conflict, 9 timeout/storage.
`;
class CliError extends Error { constructor(readonly exit: number, message: string) { super(message); } }
const fail = (message: string): never => { throw new CliError(2, message); };
function cell(value: unknown): string { return (typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n'); }
async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    directory: { type: 'string', default: '.facet' }, jsonl: { type: 'boolean' }, help: { type: 'boolean' },
    'sql-file': { type: 'string' }, params: { type: 'string' }, 'max-rows': { type: 'string' }, 'timeout-ms': { type: 'string' }, out: { type: 'string' },
  } });
  if (v.help || !positionals.length) { process.stdout.write(help); return; }
  const [command, argument] = positionals;
  if (!['tables', 'schema', 'sql'].includes(command)) fail(`Unknown command: ${command}. Use tables, schema or sql.`);
  if (positionals.length > (command === 'tables' ? 1 : 2)) fail('Too many arguments; quote SQL as one argument');
  if (command !== 'sql' && ['sql-file', 'params', 'max-rows', 'timeout-ms', 'out'].some(k => v[k as keyof typeof v] !== undefined)) fail('SQL options require the sql command');
  if (command === 'sql' && (argument !== undefined) === (v['sql-file'] !== undefined)) fail('Provide SQL as one argument or --sql-file FILE');
  const directory = resolve(v.directory);
  if (!existsSync(join(directory, 'data.sqlite'))) throw new CliError(4, 'Local database not found; use the SDK to write data to this directory first');
  const emit = (metadata: Record<string, unknown>, rows?: Record<string, unknown>[]) => {
    if (v.jsonl) {
      process.stdout.write(JSON.stringify({ schema: outputSchema, ...metadata }) + '\n');
      for (const data of rows ?? []) process.stdout.write(JSON.stringify({ schema: outputSchema, kind: 'row', data }) + '\n');
    } else {
      process.stdout.write(`schema=${outputSchema}\t${Object.entries(metadata).map(([k, value]) => `${k}=${cell(value)}`).join('\t')}\n`);
      if (rows?.length) {
        const keys = [...new Set(rows.flatMap(Object.keys))];
        process.stdout.write(keys.join('\t') + '\n');
        for (const row of rows) process.stdout.write(keys.map(k => cell(row[k])).join('\t') + '\n');
      }
    }
  };
  const facet = Facet.open({ directory });
  try {
    if (command === 'tables') {
      const tables = facet.tables(); emit({ count: tables.length }, tables); return;
    }
    if (command === 'schema') {
      if (argument && !facet.tables().some(t => t.name === argument)) throw new CliError(4, `Unknown table: ${argument}`);
      const tables = argument === undefined ? facet.schema() : [facet.schema(argument)];
      if (!tables.length) emit({ count: 0 });
      for (const table of tables) {
        if (v.jsonl) emit({ table });
        else {
          const { columns, ...metadata } = table;
          emit(metadata, Object.entries(columns).map(([name, column]) => ({ name, ...column })));
        }
      }
      return;
    }
    const sql = argument ?? readFileSync(v['sql-file'] === '-' ? 0 : v['sql-file']!, 'utf8');
    let params;
    try { params = JSON.parse(v.params ?? '[]'); } catch { fail('Invalid JSON --params'); }
    const result = await facet.sql(sql, params, { maxRows: Number(v['max-rows'] ?? 20), timeoutMs: Number(v['timeout-ms'] ?? 5000) });
    if (!result.ok) throw new CliError(result.error.code === 'TIMEOUT' ? 9 : 2, result.error.message);
    const { rows, ...metadata } = result;
    if (v.out) {
      writeFileSync(v.out, JSON.stringify({ schema: outputSchema, kind: 'result', ...metadata }) + '\n' + rows.map(data => JSON.stringify({ schema: outputSchema, kind: 'row', data }) + '\n').join(''), { flag: 'wx', mode: 0o600 });
      emit({ status: 'exported', path: resolve(v.out), returnedRows: result.returnedRows, truncated: result.truncated });
    } else emit(metadata, rows);
  } finally { await facet.close(); }
}
main().catch((error: any) => {
  const exit = error instanceof CliError ? error.exit : error.code === 'ENOENT' ? 4 : error.code === 'EEXIST' ? 5 : /BUSY|locked/.test(error.message) || error.code === 'STORAGE_ERROR' ? 9 : 2;
  process.stderr.write(`code: ${exit}\nmessage: ${cell(error.message)}\nretry: facet --help\n`);
  process.exitCode = exit;
});
