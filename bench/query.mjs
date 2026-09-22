import { Facet } from '../dist/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = mkdtempSync(join(tmpdir(), 'facet-bench-'));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const sdk = Facet.open({ directory, pool: { maxWorkers: 2, maxQueue: 128 } });
const round = n => Math.round(n * 100) / 100;
const checked = r => { if (!r.ok) throw new Error(JSON.stringify(r)); return r; };
try {
  sdk.write({ table: 'items', records: [{ id: 1 }] });
  const sql = 'SELECT count(*) AS n FROM items';
  let t = performance.now(); checked(await sdk.sql(sql)); const coldMs = performance.now() - t;
  const warm = [];
  for (let i = 0; i < 30; i++) { t = performance.now(); checked(await sdk.sql(sql)); warm.push(performance.now() - t); }
  t = performance.now(); (await Promise.all(Array.from({ length: 100 }, () => sdk.sql(sql)))).forEach(checked);
  const burstMs = performance.now() - t;
  const pool = sdk.stats();
  t = performance.now();
  const session = spawnSync(process.execPath, [cli, 'sql', '--session', '--directory', directory], {
    input: Array.from({ length: 30 }, (_, id) => JSON.stringify({ id, sql })).join('\n') + '\n', encoding: 'utf8', timeout: 30000,
  });
  if (session.status !== 0) throw new Error(session.stderr);
  session.stdout.trim().split('\n').map(JSON.parse).forEach(checked);
  const session30Ms = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < 30; i++) {
    const result = spawnSync(process.execPath, [cli, 'sql', sql, '--directory', directory, '--jsonl'], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  console.log(JSON.stringify({ node: process.version, platform: platform(), arch: arch(), coldSdkMs: round(coldMs),
    warmSdk30TotalMs: round(warm.reduce((a,b) => a+b,0)), warmSdkMedianMs: round([...warm].sort((a,b)=>a-b)[15]),
    concurrent100Ms: round(burstMs), pool, cliSession30Ms: round(session30Ms), cliOneShot30Ms: round(performance.now()-t) }, null, 2));
} finally { await sdk.close(); rmSync(directory, { recursive: true, force: true }); }
