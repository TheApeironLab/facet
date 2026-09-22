import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from '@photostructure/sqlite';
import { Facet, FacetError } from '../dist/index.js';
const infinite = 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n';
async function fixture(fn, pool) {
  const directory=mkdtempSync(join(tmpdir(),'facet-regression-'));
  const sdk=Facet.open({directory,pool});
  try { await fn(sdk); } finally { await sdk.close(); rmSync(directory,{recursive:true,force:true}); }
}
test('30 sequential queries reuse a process; 100 concurrent queries never exceed pool bound',()=>fixture(async sdk=>{
  await sdk.sql('SELECT 1');
  const pids=sdk.stats().workerPids;
  for(let i=0;i<30;i++) assert.equal((await sdk.sql('SELECT 1')).ok,true);
  assert.deepEqual(sdk.stats().workerPids,pids);
  const burst=Array.from({length:100},()=>sdk.sql('SELECT 1'));
  assert.equal(sdk.stats().workers,2);assert.equal(sdk.stats().queued,98);
  assert.ok(sdk.stats().workerPids.every(pid=>{process.kill(pid,0);return true;}));
  assert.ok((await Promise.all(burst)).every(r=>r.ok));
  assert.equal(sdk.stats().spawned,2);assert.equal(sdk.stats().peakWorkers,2);
},{maxWorkers:2,maxQueue:128}));
test('queue has backpressure, queued timeout, in-flight timeout recovery and bounded replacement',()=>fixture(async sdk=>{
  await sdk.sql('SELECT 1');
  const long=sdk.sql(infinite,[],{timeoutMs:150});
  const queued=sdk.sql('SELECT 2',[],{timeoutMs:40});
  assert.equal((await sdk.sql('SELECT 3')).error.code,'QUEUE_FULL');
  assert.equal((await queued).error.code,'TIMEOUT');
  assert.equal((await long).error.code,'TIMEOUT');
  // A stopping worker still consumes the slot. Wait for close, not an arbitrary sleep.
  while(sdk.stats().workers) await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await sdk.sql('SELECT 4')).rows[0]['4'],4);
  assert.equal(sdk.stats().peakWorkers,1);
},{maxWorkers:1,maxQueue:1}));
test('child crash settles its query and queued query recovers; close drains and reaps children',()=>fixture(async sdk=>{
  await sdk.sql('SELECT 1');
  const pid=sdk.stats().workerPids[0];
  const query=sdk.sql(infinite);
  const next=sdk.sql('SELECT 42 AS answer');
  process.kill(pid,'SIGKILL');
  assert.equal((await query).error.code,'WORKER_ERROR');
  assert.equal((await next).rows[0].answer,42);
  const pids=sdk.stats().workerPids;
  const final=sdk.sql('SELECT 7');
  await sdk.close();await sdk.close();
  assert.equal((await final).ok,true);
  for(const pid of pids) assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
  assert.equal((await sdk.sql('SELECT 8')).error.code,'CLOSED');
},{maxWorkers:1}));
test('entire SQL is checked, quotes/comments remain valid, BLOB is lossless base64',()=>fixture(async sdk=>{
 sdk.write({table:'t',records:[{id:1}]});
 for(const sql of ['SELECT 1) ; DROP TABLE t; --','SELECT 1; SELECT 2','SELECT 1\0; DROP TABLE t', 'SELECT 1 --comment\n; SELECT 2', 'SELECT 1 /* unterminated', 'SELECT 1) --']) {
  assert.equal((await sdk.sql(sql)).ok,false,sql);
 }
 for(const sql of ["SELECT ';' AS x", "SELECT 'it''s;ok' AS x", 'SELECT 1 AS "a;b"', 'SELECT 1 AS [a;b]', 'SELECT 1 AS `a;b`', '/* ; */ SELECT 1 -- ;', 'WITH a AS (SELECT 1) SELECT * FROM a']) assert.equal((await sdk.sql(sql)).ok,true,sql);
 assert.equal((await sdk.sql('SELECT count(*) AS n FROM t')).rows[0].n,1);
 const result=await sdk.sql("SELECT x'F16500FF' AS payload, x'' AS empty");
 assert.deepEqual(result.rows[0].payload,{$type:'blob',encoding:'base64',data:'8WUA/w=='});
 assert.equal(result.rows[0].empty.data,'');assert.equal(result.schemaVersion,2);
 assert.equal((await sdk.sql("SELECT zeroblob(100) AS b",[],{maxBytes:20})).truncated,true);
}));
test('writes classify errors; inferred INTEGER widens atomically while explicit types stay strict',()=>fixture(async sdk=>{
 sdk.write({table:'t',records:[{id:1,qty:2}],primaryKey:['id']});
 const db=new DatabaseSync(sdk.databasePath);db.exec('CREATE INDEX qty_idx ON t(qty)');db.close();
 await sdk.sql('SELECT * FROM t');
 const original=sdk.schema('t').version;
 sdk.write({table:'t',records:[{id:2,qty:2.5}]});
 assert.equal(sdk.schema('t').columns.qty.type,'REAL');
 assert.deepEqual((await sdk.sql('SELECT qty FROM t ORDER BY id')).rows,[{qty:2},{qty:2.5}]);
 assert.notEqual((await sdk.sql('SELECT * FROM t')).dataVersions.t,original);
 const inspect=new DatabaseSync(sdk.databasePath);assert.equal(inspect.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='qty_idx'").get().n,1);inspect.close();
 const code=(fn,expected)=>assert.throws(fn,e=>e instanceof FacetError && e.code===expected);
 code(()=>sdk.write({table:'t',records:[{id:2,qty:3}]}),'CONFLICT');
 code(()=>sdk.write({table:'t',records:[{id:3,qty:'bad'}]}),'TYPE_MISMATCH');
 code(()=>sdk.write({table:'oops',records:null}),'INVALID_ARGUMENT');
 code(()=>sdk.writeResponse({}, {table:'x',select(){throw new Error('selector failed');}}),'INVALID_ARGUMENT');
 sdk.write({table:'strict',records:[{id:1,qty:2}],primaryKey:['id'],columns:{qty:{type:'INTEGER'}}});
 code(()=>sdk.write({table:'strict',records:[{id:2,qty:2.5}]}),'TYPE_MISMATCH');
 // A failure after a table rebuild restores both original rows and type metadata.
 sdk.write({table:'rollback',records:[{id:1,qty:2}],primaryKey:['id']});
 code(()=>sdk.write({table:'rollback',records:[{id:1,qty:2.5}]}),'CONFLICT');
 assert.equal(sdk.schema('rollback').columns.qty.type,'INTEGER');
 assert.deepEqual((await sdk.sql('SELECT * FROM rollback')).rows,[{id:1,qty:2}]);
}));
test('drop atomically removes table/catalog/relations and pooled readers see subsequent changes',()=>fixture(async sdk=>{
 sdk.write({table:'a',records:[{id:1}]});sdk.write({table:'b',records:[{id:2}]});
 sdk.relate({from:{table:'a',column:'id'},to:{table:'b',column:'id'},cardinality:'many_to_one'});
 await sdk.sql('SELECT * FROM a');
 assert.deepEqual(sdk.drop('a'),{dropped:true});
 assert.equal(sdk.schema('b').relations.length,0);
 assert.equal((await sdk.sql('SELECT * FROM a')).ok,false);
 assert.throws(()=>sdk.drop('a'),e=>e.code==='NOT_FOUND');
 assert.deepEqual(sdk.drop('a',{ifExists:true}),{dropped:false});
 sdk.write({table:'a',records:[{other:'new schema'}]});
 assert.deepEqual((await sdk.sql('SELECT * FROM a')).rows,[{other:'new schema'}]);
}));
test('schema tool requires table; CLI TSV hides trace metadata; session reuses queries and returns per-request errors',()=>fixture(async sdk=>{
 sdk.write({table:'orders',records:[{id:1}]});
 const tool=sdk.tools().find(t=>t.name==='schema');assert.deepEqual(tool.inputSchema.required,['table']);
 for(const input of [{},{table:''},{table:2}]) assert.equal((await tool.execute(input)).error.code,'INVALID_ARGUMENT');
 assert.equal((await tool.execute({table:'missing'})).error.code,'NOT_FOUND');
 const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
 const exec=(args,input)=>spawnSync(process.execPath,[cli,...args,'--directory',sdk.directory],{encoding:'utf8',input,timeout:10000});
 const tsv=exec(['schema','orders']);assert.equal(tsv.status,0,tsv.stderr);assert.doesNotMatch(tsv.stdout,/version=|updatedAt=|inferred/);
 const json=JSON.parse(exec(['schema','orders','--jsonl']).stdout);assert.ok(json.table.version);assert.ok(json.table.updatedAt);
 const requests=[{id:1,sql:'SELECT 1 AS n'},{id:2,sql:'SELECT randomblob(4) AS b'},{id:3,sql:'SELECT 1; SELECT 2'},{id:4,sql:'SELECT count(*) AS n FROM orders'}];
 const result=exec(['sql','--session'],requests.map(JSON.stringify).join('\n')+'\n');assert.equal(result.status,0,result.stderr);
 const results=result.stdout.trim().split('\n').map(JSON.parse);assert.equal(results.length,4);
 assert.deepEqual(results.map(r=>r.id),[1,2,3,4]);assert.equal(results[2].ok,false);assert.equal(results[3].rows[0].n,1);
 assert.equal(results[1].rows[0].b.$type,'blob');
}));

test('default pool admits 2 active + 64 queued, rejects excess without forking',()=>fixture(async sdk=>{
 const results=await Promise.all(Array.from({length:100},()=>sdk.sql('SELECT 1')));
 assert.equal(results.filter(r=>r.ok).length,66);
 assert.equal(results.filter(r=>!r.ok && r.error.code==='QUEUE_FULL').length,34);
 assert.equal(sdk.stats().spawned,2);assert.equal(sdk.stats().peakWorkers,2);
}));
test('inferred widening persists across reopen; invalid pool options fail before database creation',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'facet-types-'));
 try {
  let sdk=Facet.open({directory});sdk.write({table:'t',records:[{qty:2}]});await sdk.close();
  sdk=Facet.open({directory});
  try {sdk.write({table:'t',records:[{qty:2.5}]});assert.equal(sdk.schema('t').columns.qty.type,'REAL');}
  finally {await sdk.close();}
  assert.throws(()=>Facet.open({directory,pool:{maxWorkers:0}}),e=>e.code==='INVALID_ARGUMENT');
 } finally {rmSync(directory,{recursive:true,force:true});}
});
