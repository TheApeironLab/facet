
import { DatabaseSync, constants as c } from 'node:sqlite';
process.once('message', (input: any) => {
const { path, sql, params, maxRows, maxBytes } = input;
let db: DatabaseSync | undefined;
try {
  db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  db.exec('BEGIN');
  const catalog = db.prepare('SELECT name, metadata FROM _agent_catalog').all();
  const allowed = new Set(catalog.map(r => String(r.name)));
  const versions = Object.fromEntries(catalog.map(r => [r.name, JSON.parse(String(r.metadata)).version]));
  const touched = new Set<string>();
  db.setAuthorizer((action, a, b, database) => {
    if (action === c.SQLITE_SELECT || action === c.SQLITE_RECURSIVE) return c.SQLITE_OK;
    if (action === c.SQLITE_FUNCTION && b !== 'load_extension') return c.SQLITE_OK;
    if (action === c.SQLITE_READ && (database === 'main' || (database === null && b === '')) && a && allowed.has(a)) {
      touched.add(a); return c.SQLITE_OK;
    }
    return c.SQLITE_DENY;
  });
  // Subquery wrapper requires one result-producing statement, rejecting trailing SQL.
  const stmt = db.prepare(`SELECT * FROM (\n${sql}\n) AS _agent_result`);
  stmt.setReadBigInts(true);
  const rows: unknown[] = [];
  let bytes = 0;
  let truncated = false;
  for (const row of stmt.iterate(...params)) {
    const safe = JSON.parse(JSON.stringify(row, (_, v) => typeof v === 'bigint'
      ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString()) : v));
    const size = Buffer.byteLength(JSON.stringify(safe));
    if (rows.length >= maxRows || bytes + size > maxBytes) { truncated = true; break; }
    rows.push(safe); bytes += size;
  }
  process.send!({ ok: true, schemaVersion: 1, columns: stmt.columns().map(x => ({ name: x.name, type: x.type })), rows,
    returnedRows: rows.length, truncated, dataVersions: Object.fromEntries([...touched].map(t => [t, versions[t]])) });
} catch (error) {
  process.send!({ ok: false, error: { code: 'QUERY_ERROR', message: String((error as Error).message), hint: 'Inspect describe_dataset; use a single SELECT or WITH query without a trailing semicolon.' } });
} finally { db?.close(); process.disconnect?.(); }
});
