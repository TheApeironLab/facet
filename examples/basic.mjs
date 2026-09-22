import { Facet } from '@theapeironlab/facet';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'facet-example-'));
const sdk = Facet.open({ directory });
try {
  const response = { items: [{ id: 'o1', supplier: 'A', amount: 100 }, { id: 'o2', supplier: 'A', amount: 200 }] };
  sdk.writeResponse(response, {
    table: 'orders', select: result => result.items, primaryKey: ['id'], mode: 'upsert',
    description: '采购订单', grain: '一行一张订单',
    columns: { amount: { type: 'INTEGER', description: '含税金额（分）', unit: 'CNY cent' } },
    source: { name: 'orders_api', completeness: 'complete', filters: { year: 2026 } },
  });
  const tools = sdk.tools();
  console.log(JSON.stringify(await tools.find(t => t.name === 'sql').execute({ sql: 'SELECT supplier, sum(amount) AS total FROM orders GROUP BY supplier' }), null, 2));
} finally { await sdk.close(); rmSync(directory, { recursive: true, force: true }); }
