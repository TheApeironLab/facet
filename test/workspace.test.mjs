import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataWorkspace } from '../dist/workspace.js';
async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'facet-'));
  const ws = new DataWorkspace(join(dir, 'test.db'));
  try { await fn(ws); } finally { await ws.close(); rmSync(dir, { recursive: true, force: true }); }
}
test('API records, schema, partial upsert, relation and persistence', () => fixture(async ws => {
  ws.write({ table: 'suppliers', records: [{ id: 's1', name: 'A' }], primaryKey: ['id'] });
  ws.write({ table: 'orders', records: [{ id: 1, supplier: 's1', amount: 20, paid: true, tags: ['a'] }], primaryKey: ['id'], source: { completeness: 'complete', filters: { year: 2026 } } });
  ws.relate({ from: { table: 'orders', column: 'supplier' }, to: { table: 'suppliers', column: 'id' }, cardinality: 'many_to_one' });
  ws.write({ table: 'orders', records: [{ id: 1, amount: 30, memo: 'updated' }], mode: 'upsert' });
  const result = await ws.sql('SELECT s.name, sum(o.amount) AS total, o.paid FROM orders o JOIN suppliers s ON s.id=o.supplier GROUP BY s.name');
  assert.equal(result.ok, true); assert.deepEqual(result.rows, [{ name: 'A', total: 30, paid: 1 }]);
  assert.equal(Object.keys(result.dataVersions).length, 2);
  assert.equal(ws.schema('orders').source.completeness, 'unknown');
  assert.equal(ws.schema('orders').relations.length, 1);
  const reopened = new DataWorkspace(ws.path); assert.equal(reopened.schema('orders').rowCount, 1); await reopened.close();
}));
test('schema change and replace roll back atomically', () => fixture(async ws => {
  ws.write({ table: 'items', records: [{ id: 1, value: 2 }], primaryKey: ['id'] });
  assert.throws(() => ws.write({ table: 'items', mode: 'replace', records: [{ id: 2, value: 'bad', newcol: 'x' }] }));
  assert.equal(ws.schema('items').columns.newcol, undefined);
  const result = await ws.sql('SELECT * FROM items'); assert.deepEqual(result.rows, [{ id: 1, value: 2 }]);
  assert.throws(() => ws.write({ table: 'items', records: [{ id: 1, value: 9 }] }));
  assert.throws(() => ws.write({ table: 'items', records: [{ id: null, value: 9 }] }));
}));
test('SQL restrictions, bindings, JSON, bounds and timeout', () => fixture(async ws => {
  ws.write({ table: 'items', records: [{ id: 1, json: { x: 2 } }, { id: 2, json: { x: 3 } }] });
  for (const sql of ['DELETE FROM items', 'SELECT * FROM items; DELETE FROM items', "ATTACH DATABASE '/tmp/x.db' AS x", 'SELECT * FROM _agent_catalog', 'SELECT * FROM sqlite_master', "SELECT * FROM pragma_table_info('items')", "SELECT load_extension('x')"]) {
    const r = await ws.sql(sql); assert.equal(r.ok, false, sql);
  }
  assert.deepEqual((await ws.sql("SELECT json_extract(json, '$.x') AS x FROM items WHERE id=?", [2])).rows, [{ x: 3 }]);
  assert.equal((await ws.sql('SELECT * FROM items', [], { maxRows: 1 })).truncated, true);
  assert.equal((await ws.sql('SELECT * FROM items', [], { maxRows: 2 })).truncated, false);
  assert.equal((await ws.sql('SELECT * FROM items', [], { maxBytes: 1 })).truncated, true);
  assert.equal((await ws.sql('SELECT * FROM items', [], { maxRows: -1 })).ok, false);
  const timed = await ws.sql('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n', [], { timeoutMs: 100 });
  assert.equal(timed.error.code, 'TIMEOUT');
  assert.equal((await ws.sql('SELECT count(*) AS n FROM items')).rows[0].n, 2);
}));
test('100k API records and agent tool flow', () => fixture(async ws => {
  ws.write({ table: 'events', records: Array.from({ length: 100000 }, (_, id) => ({ id, amount: id % 10 })), primaryKey: ['id'], grain: 'one event' });
  const tools = Object.fromEntries(ws.tools().map(t => [t.name, t]));
  assert.equal((await tools.tables.execute({}))[0].rowCount, 100000);
  assert.equal((await tools.schema.execute({ table: 'events' })).grain, 'one event');
  const r = await tools.sql.execute({ sql: 'SELECT count(*) AS n, sum(amount) AS total FROM events' });
  assert.deepEqual(r.rows, [{ n: 100000, total: 450000 }]);
  assert.equal((await tools.sql.execute({})).ok, false);
}));
