import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Facet } from '../dist/index.js';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function run(directory, args) { return spawnSync(process.execPath, [cli, ...args, '--directory', directory, '--jsonl'], { encoding: 'utf8', timeout: 10000 }); }
function parsed(result) { assert.equal(result.status, 0, result.stderr); return result.stdout.trim().split('\n').map(JSON.parse); }
test('SDK writes; CLI tables/schema/sql use the same names, data and metadata', async () => {
 const directory=mkdtempSync(join(tmpdir(),'facet-unified-'));
 try {
  const sdk=Facet.open({directory});
  sdk.writeResponse({items:[{id:1,amount:10},{id:2,amount:20}]},{table:'orders',select:r=>r.items,primaryKey:['id'],description:'Orders',grain:'One order'});
  sdk.write({table:'suppliers',records:[{id:1}]});
  const tables=sdk.tables(); const schemas=sdk.schema();
  assert.equal('datasets' in sdk,false);assert.equal('query' in sdk,false);
  assert.deepEqual(sdk.tools().map(t=>t.name),['tables','schema','sql']);
  assert.deepEqual(await sdk.tools()[1].execute({}),schemas);
  assert.deepEqual(await sdk.tools()[1].execute({table:'orders'}),sdk.schema('orders'));
  await sdk.close();
  assert.deepEqual(parsed(run(directory,['tables'])).slice(1).map(r=>r.data),JSON.parse(JSON.stringify(tables)));
  const all=parsed(run(directory,['schema']));
  assert.deepEqual(all.map(r=>r.table),JSON.parse(JSON.stringify(schemas)));
  assert.equal(all[0].schema,'facet.cli.v2');
  assert.equal(parsed(run(directory,['schema','orders']))[0].table.description,'Orders');
  assert.equal(parsed(run(directory,['sql','SELECT sum(amount) AS n FROM orders WHERE id > ?','--params','[0]']))[1].data.n,30);
  const path=join(directory,'result.jsonl');
  assert.equal(parsed(run(directory,['sql','SELECT * FROM orders','--max-rows','1','--out',path]))[0].truncated,true);
  assert.equal(run(directory,['sql','SELECT * FROM orders','--out',path]).status,5);
  const sqlFile=join(directory,'q.sql');writeFileSync(sqlFile,'SELECT count(*) AS n FROM orders');
  assert.equal(parsed(run(directory,['sql','--sql-file',sqlFile]))[1].data.n,2);
  for(const args of [['dataset','list'],['query','run'],['schema','orders','extra'],['tables','--params','[]'],['sql','DELETE FROM orders']]) assert.equal(run(directory,args).status,2);
  assert.equal(run(directory,['schema','missing']).status,4);
 } finally {rmSync(directory,{recursive:true,force:true});}
});
test('CLI missing paths are not created and empty schemas are explicit',async()=>{
 const root=mkdtempSync(join(tmpdir(),'facet-empty-'));const directory=join(root,'data');
 try {
  assert.equal(run(directory,['tables']).status,4);assert.equal(existsSync(directory),false);
  const sdk=Facet.open({directory});await sdk.close();
  assert.equal(parsed(run(directory,['schema']))[0].count,0);
  assert.equal(parsed(run(directory,['tables']))[0].count,0);
 } finally {rmSync(root,{recursive:true,force:true});}
});
