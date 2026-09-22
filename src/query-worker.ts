import { DatabaseSync, constants as c } from 'node:sqlite';
import { validateSingleSql } from './sql-validation.js';
import { asFacetError } from './errors.js';
let db: DatabaseSync | undefined;
process.on('disconnect', () => { db?.close(); process.exit(0); });
process.on('message', (input: any) => {
  const { id, path, sql, params, maxRows, maxBytes } = input;
  let result: unknown;
  try {
    validateSingleSql(sql);
    db ??= new DatabaseSync(path, { readOnly: true, allowExtension: false });
    db.setAuthorizer(null);
    db.exec('BEGIN');
    // Fresh catalog and data in the same read snapshot, on every request.
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
    // Validate the entire input first; no interpolated wrapper that can be escaped.
    const stmt = db.prepare(sql);
    stmt.setReadBigInts(true);
    const rows: Record<string, unknown>[] = [];
    let bytes = 0;
    let truncated = false;
    for (const row of stmt.iterate(...params)) {
      const safe = Object.fromEntries(Object.entries(row).map(([key, v]) => [key,
        v instanceof Uint8Array ? { $type: 'blob', encoding: 'base64', data: Buffer.from(v).toString('base64') }
        : typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString()) : v]));
      const size = Buffer.byteLength(JSON.stringify(safe));
      if (rows.length >= maxRows || bytes + size > maxBytes) { truncated = true; break; }
      rows.push(safe); bytes += size;
    }
    result = { ok: true, schemaVersion: 2, columns: stmt.columns().map(x => ({ name: x.name, type: x.type })), rows,
      returnedRows: rows.length, truncated, dataVersions: Object.fromEntries([...touched].map(t => [t, versions[t]])) };
  } catch (error) {
    const e = asFacetError(error, 'QUERY_ERROR');
    result = { ok: false, error: { code: e.code, message: e.message, hint: 'Inspect schema; use a single SELECT or WITH query without a trailing semicolon.' } };
  } finally {
    if (db) {
      db.setAuthorizer(null);
      if (db.isTransaction) db.exec('ROLLBACK');
    }
  }
  // Send only after clearing transaction and authorizer state for the next query.
  process.send?.({ id, result });
});
