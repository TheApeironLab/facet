import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Facet, FacetError } from '../dist/index.js';

test('SDK persists locally, accepts API responses, and applies agent query defaults', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-'));
  const directory = join(root, 'nested', 'data');
  let sdk = Facet.open({ directory, query: { maxRows: 1 } });
  try {
    sdk.datasets.fromResponse({ data: { items: [{ id: 'a', value: 1 }, { id: 'b', value: 2 }] } }, {
      table: 'items', select: response => response.data.items, primaryKey: ['id'], source: { completeness: 'complete' },
    });
    const tools = sdk.agent.tools();
    const query = tools.find(t => t.name === 'query');
    assert.equal((await query.execute({ sql: 'SELECT * FROM items' })).truncated, true);
    assert.equal((await sdk.query('SELECT * FROM items', [], { maxRows: 10 })).truncated, false);
    const active = sdk.query('SELECT sum(value) AS total FROM items');
    await sdk.close(); await sdk.close();
    assert.equal((await active).rows[0].total, 3);
    assert.throws(() => sdk.datasets.list(), e => e instanceof FacetError && e.code === 'CLOSED');
    assert.equal((await query.execute({ sql: 'SELECT * FROM items' })).error.code, 'CLOSED');
    sdk = Facet.open({ directory });
    assert.equal(sdk.datasets.describe('items').rowCount, 2);
    assert.equal((await sdk.query('SELECT count(*) AS n FROM items')).rows[0].n, 2);
  } finally { await sdk.close(); rmSync(root, { recursive: true, force: true }); }
});
test('SDK rejects invalid directory and query defaults', () => {
  assert.throws(() => Facet.open({ directory: '' }), FacetError);
  assert.throws(() => Facet.open({ directory: '.', query: { timeoutMs: -1 } }), FacetError);
});
