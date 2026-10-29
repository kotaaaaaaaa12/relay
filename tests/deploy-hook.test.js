import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('deployment hook creates a missing database before migrating and skips remote work in dev',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-hook-'));
  try{
    mkdirSync(join(root,'scripts'));mkdirSync(join(root,'node_modules/wrangler/bin'),{recursive:true});
    copyFileSync(new URL('../scripts/prepare-database.mjs',import.meta.url),join(root,'scripts/prepare-database.mjs'));
    writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({d1_databases:[{binding:'DB',database_name:'relay-test-db'}]}));
    writeFileSync(join(root,'node_modules/wrangler/bin/wrangler.js'),`const fs=require('node:fs');fs.appendFileSync(process.env.RELAY_TEST_LOG,JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[3]==='info'){console.error("Couldn't find a D1 DB named 'relay-test-db'");process.exit(1);}`);
    const log=join(root,'calls.log');const env={...process.env,WRANGLER_COMMAND:'deploy',RELAY_TEST_LOG:log};
    const run=spawnSync(process.execPath,[join(root,'scripts/prepare-database.mjs')],{env,encoding:'utf8'});assert.equal(run.status,0,run.stderr);
    const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(calls.map(c=>c.slice(0,2)),[['d1','info'],['d1','create'],['d1','migrations']]);assert.ok(calls[2].includes('--remote'));
    rmSync(log);const dev=spawnSync(process.execPath,[join(root,'scripts/prepare-database.mjs')],{env:{...env,WRANGLER_COMMAND:'dev'},encoding:'utf8'});assert.equal(dev.status,0);assert.throws(()=>readFileSync(log));
  }finally{rmSync(root,{recursive:true,force:true});}
});
