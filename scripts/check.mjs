import { spawnSync } from 'node:child_process';
const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--outdir','.check'],{
  stdio:'inherit',env:{...process.env,RELAY_SKIP_DB_SETUP:'1',WRANGLER_SEND_METRICS:'false'},
});
if(result.error)console.error(result.error.message);
process.exit(result.status??1);
