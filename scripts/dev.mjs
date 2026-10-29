import { spawn } from 'node:child_process';
const args=process.argv.slice(2),forward=[];
for(let i=0;i<args.length;i++){
  if(args[i]==='--strictPort')continue;
  if(args[i]==='--host'){forward.push('--ip',args[++i]);continue;}
  forward.push(args[i]);
}
const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev',...forward],{stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code||0));
