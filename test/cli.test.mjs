import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Facet } from '../dist/index.js';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function run(directory, args, input) { return spawnSync(process.execPath, [cli, ...args, '--directory', directory, '--jsonl'], { encoding: 'utf8', input, timeout: 10000 }); }
function parsed(result) { assert.equal(result.status, 0, result.stderr); return result.stdout.trim().split('\n').map(line => JSON.parse(line)); }
test('CLI imports API/JSONL, retries upsert, shares SDK storage and exports bounded queries', async () => {
 const root = mkdtempSync(join(tmpdir(), 'agent-cli-')); const directory = join(root,'data');
 try {
  parsed(run(directory,['workspace','init']));
  const payload = JSON.stringify({data:{items:[{id:1,amount:10},{id:2,amount:20}]}});
  for(let i=0;i<2;i++) parsed(run(directory,['dataset','import','--table','orders','--file','-','--select','data.items','--key','id'],payload));
  parsed(run(directory,['dataset','import','--table','orders','--file','-','--format','jsonl'],'{"id":3,"amount":30}\n'));
  const sdk=Facet.open({directory});
  assert.equal(sdk.datasets.describe('orders').rowCount,3); await sdk.close();
  const output=parsed(run(directory,['sql','SELECT sum(amount) AS total FROM orders WHERE id > ?','--params','[1]']));
  assert.equal(output[1].data.total,50);
  const path=join(root,'result.jsonl');
  assert.equal(parsed(run(directory,['query','run','--sql','SELECT * FROM orders','--max-rows','1','--out',path]))[0].truncated,true);
  assert.equal(run(directory,['query','run','--sql','SELECT * FROM orders','--out',path]).status,5);
  parsed(run(directory,['workspace','verify']));
  parsed(run(directory,['dataset','describe','--table','orders','--full']));
  parsed(run(directory,['agent','tools']));
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('CLI read operations do not create missing databases; malformed input leaves data unchanged',()=>{
 const root=mkdtempSync(join(tmpdir(),'cli-errors-')); const directory=join(root,'data');
 try {
  assert.equal(run(directory,['dataset','list']).status,4); assert.equal(existsSync(directory),false);
  parsed(run(directory,['workspace','init']));
  assert.equal(run(directory,['dataset','import','--table','x','--file','-'],'invalid').status,2);
  assert.equal(parsed(run(directory,['dataset','list']))[0].count,0);
  assert.equal(run(directory,['query','run','--sql','DELETE FROM x']).status,2);
  assert.equal(run(directory,['unknown']).status,2);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('simple tables/schema commands read SDK metadata for one or all tables',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'facet-schema-'));
 try {
  const sdk=Facet.open({directory});
  sdk.datasets.write({table:'orders',records:[{id:1}],description:'Orders',grain:'One order',primaryKey:['id']});
  sdk.datasets.write({table:'suppliers',records:[{id:2}]});
  await sdk.close();
  assert.equal(parsed(run(directory,['tables']))[0].count,2);
  const all=parsed(run(directory,['schema']));assert.equal(all.length,2);
  assert.deepEqual(all.map(x=>x.dataset.name),['orders','suppliers']);
  const one=parsed(run(directory,['schema','orders']))[0].dataset;
  assert.equal(one.description,'Orders');assert.deepEqual(one.primaryKey,['id']);
  assert.equal(one.columns.id.type,'INTEGER');
  assert.equal(run(directory,['schema','missing']).status,4);
  assert.equal(run(directory,['schema','orders','extra']).status,2);
  const guide=parsed(run(directory,['agent','guide']))[0].instructions;
  assert.match(guide,/facet tables/);assert.match(guide,/facet schema/);
 } finally {rmSync(directory,{recursive:true,force:true});}
});
