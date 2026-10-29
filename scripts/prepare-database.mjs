import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Wrangler invokes this hook itself, so the dashboard build command stays empty.
if(process.env.WRANGLER_COMMAND==='dev'||process.env.WRANGLER_COMMAND==='types'||process.env.RELAY_SKIP_DB_SETUP==='1')process.exit(0);
const root=fileURLToPath(new URL('..',import.meta.url));
const config=JSON.parse(readFileSync(resolve(root,'wrangler.jsonc'),'utf8'));
const database=config.d1_databases.find(db=>db.binding==='DB');
if(!database?.database_name)throw new Error('Set the DB database_name in wrangler.jsonc.');
const cli=resolve(root,'node_modules/wrangler/bin/wrangler.js');
const env={...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'};
function run(args,capture=false){
  const result=spawnSync(process.execPath,[cli,...args],{cwd:root,env,...(capture?{encoding:'utf8'}:{stdio:'inherit'})});
  if(result.error){console.error(result.error.message);process.exit(1);}return result;
}
const info=run(['d1','info','DB','--json'],true);
if(info.status!==0){
  const error=(info.stderr||'')+'\n'+(info.stdout||'');
  if(!/couldn't find a D1 DB|could not find|not found|does not exist/i.test(error)){
    console.error(error);process.exit(info.status||1);
  }
  console.log('Creating the Relay D1 database.');
  const created=run(['d1','create',database.database_name,'--location','apac','--update-config=false']);
  if(created.status!==0)process.exit(created.status||1);
}
const migrated=run(['d1','migrations','apply','DB','--remote']);
if(migrated.status!==0)process.exit(migrated.status||1);
console.log('Relay database is ready. Continuing deployment.');
