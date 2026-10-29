import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { RelayError, PART_SIZE, limits, validateURL, safeFetch, filenameFrom, cleanName, parseRange, sha256, token, json, readBody } from './core.js';

const ACTIVE = "'queued','fetching','retrying'";
const SELECT = 'id,source_host,name,status,received,total,error,created_at,updated_at,expires_at,attempt';
const securityHeaders = { 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY', 'Permissions-Policy':'camera=(), microphone=(), geolocation=()' };

async function rateLimit(env, key, max, span = 3600000) {
  const window = Math.floor(Date.now()/span);
  const r = await env.DB.prepare(`INSERT INTO rate_limits(key,window,count) VALUES(?,?,1)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END, window=excluded.window RETURNING count`).bind(key,window).first();
  if (r.count > max) throw new RelayError('Too many requests. Try again later.',429,'RATE_LIMITED');
}
function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin || String(env.ALLOWED_ORIGINS || '').split(',').map(x=>x.trim()).includes(origin);
}
async function ownerOf(request) {
  const key = request.headers.get('X-Relay-Key') || '';
  if (!/^[a-f0-9]{64}$/.test(key)) throw new RelayError('Your device key is missing. Reload the page.',401,'UNAUTHORIZED');
  return sha256(key);
}
async function getJob(env, id, owner) {
  const row = await env.DB.prepare('SELECT * FROM jobs WHERE id=? AND owner=? AND status!=?').bind(id,owner,'deleted').first();
  if (!row) throw new RelayError('This transfer was not found.',404,'NOT_FOUND');
  return row;
}
async function createJob(request, env, owner, input) {
  const config = limits(env); const url = validateURL(input.url);
  await rateLimit(env, 'owner:'+owner, 30);
  const ip = request.headers.get('CF-Connecting-IP'); if (ip) await rateLimit(env, 'ip:'+await sha256(ip), 60);
  const id = crypto.randomUUID(); const now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO jobs
    (id,owner,url,source_host,name,reserved,download_token,object_key,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE
    (SELECT COUNT(*) FROM jobs WHERE owner=? AND status IN (${ACTIVE})) < ? AND
    (SELECT COUNT(*) FROM jobs WHERE status IN (${ACTIVE})) < ? AND
    (SELECT COALESCE(SUM(reserved),0) FROM jobs WHERE status IN (${ACTIVE},'completed')) + ? <= ? AND
    (SELECT COUNT(*) FROM jobs WHERE owner=? AND status!='deleted') < ?`).bind(
      id,owner,url.href,url.hostname,filenameFrom(new Headers(),url.href),config.maxBytes,token(),'files/'+id,now,now,
      owner,config.maxActive,config.maxGlobalActive,config.maxBytes,config.maxStoredBytes,owner,config.maxJobs).run();
  if (!result.meta.changes) throw new RelayError('The active transfer or storage limit has been reached. Delete a file or wait for a transfer to finish.',409,'LIMIT_REACHED');
  try { await env.TRANSFERS.create({ id, params:{ id } }); }
  catch {
    await env.DB.prepare("UPDATE jobs SET status='failed',reserved=0,error=?,updated_at=? WHERE id=?").bind('The transfer could not be started. Try again.',Date.now(),id).run();
    throw new RelayError('The transfer could not be started. Try again.',503,'START_FAILED');
  }
  return json({ id },201);
}
async function cleanObjects(env, row) {
  if (row.upload_id) {
    try { await env.BUCKET.resumeMultipartUpload(row.object_key,row.upload_id).abort(); }
    catch (e) { if (!/does not exist|not found|NoSuchUpload|10024/i.test(String(e))) throw e; }
  }
  await env.BUCKET.delete(row.object_key);
  await env.DB.prepare('UPDATE jobs SET upload_id=NULL,cleaned_at=? WHERE id=?').bind(Date.now(),row.id).run();
}
async function stopJob(env, row, status) {
  await env.DB.prepare('UPDATE jobs SET status=?,reserved=0,cleaned_at=NULL,updated_at=? WHERE id=?').bind(status,Date.now(),row.id).run();
  try { await (await env.TRANSFERS.get(row.id)).terminate(); } catch {}
  await cleanObjects(env,row);
}
async function download(request, env, id, capability) {
  const row = await env.DB.prepare('SELECT * FROM jobs WHERE id=? AND download_token=?').bind(id,capability).first();
  if (!row || row.status !== 'completed' || row.expires_at <= Date.now()) throw new RelayError('This download has expired or is unavailable.',410,'EXPIRED');
  let range;
  try { range = parseRange(request.headers.get('Range'),row.total); }
  catch (e) { if (e.status === 416) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${row.total}`}}); throw e; }
  const object = request.method === 'HEAD' ? await env.BUCKET.head(row.object_key) : await env.BUCKET.get(row.object_key,range ? {range} : {});
  if (!object) throw new RelayError('This file is no longer available.',410,'EXPIRED');
  if (range && request.headers.get('If-Range') && request.headers.get('If-Range') !== object.httpEtag) {
    await object.body?.cancel();
    const fresh = new Request(request); fresh.headers.delete('Range'); fresh.headers.delete('If-Range'); return download(fresh,env,id,capability);
  }
  const headers = new Headers({ ...securityHeaders, 'Content-Type':'application/octet-stream',
    'Content-Disposition': `attachment; filename="${row.name.replace(/[^\x20-\x7e]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`,
    'Content-Length':String(range?.length ?? row.total), 'Accept-Ranges':'bytes', 'Cache-Control':'private, no-store',
    'ETag':object.httpEtag, 'Content-Security-Policy':"default-src 'none'; sandbox" });
  if (range) headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${row.total}`);
  return new Response(request.method === 'HEAD' ? null : object.body,{status:range ? 206 : 200,headers});
}
async function api(request,env) {
  const url = new URL(request.url); const path = url.pathname;
  if (path === '/api/health' && request.method === 'GET') {
    try { await env.DB.prepare('SELECT id FROM jobs LIMIT 1').first(); }
    catch { return json({ok:false,error:'Apply the D1 migration to finish setup.',code:'DATABASE_NOT_READY'},503); }
    return json({ok:true,version:'1.0.0',...limits(env)});
  }
  const file = path.match(/^\/api\/files\/([a-f0-9-]{36})\/([a-f0-9]{64})$/);
  if (file && ['GET','HEAD'].includes(request.method)) return download(request,env,file[1],file[2]);
  const owner = await ownerOf(request);
  if (path === '/api/jobs' && request.method === 'GET') {
    const {results} = await env.DB.prepare(`SELECT ${SELECT} FROM jobs WHERE owner=? AND status!='deleted' ORDER BY created_at DESC LIMIT 100`).bind(owner).all();
    return json({jobs:results,limits:limits(env)});
  }
  if (path === '/api/jobs' && request.method === 'POST') return createJob(request,env,owner,await readBody(request));
  const match = path.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(cancel|retry|download))?$/);
  if (!match) throw new RelayError('This endpoint was not found.',404,'NOT_FOUND');
  const row = await getJob(env,match[1],owner); const action = match[2];
  if (action === 'download' && request.method === 'POST') {
    if (row.status !== 'completed' || row.expires_at <= Date.now()) throw new RelayError('This file is not ready to download.',410,'EXPIRED');
    return json({url:`/api/files/${row.id}/${row.download_token}`,name:row.name,size:row.total});
  }
  if (action === 'cancel' && request.method === 'POST') {
    if (!['queued','fetching','retrying'].includes(row.status)) throw new RelayError('This transfer is no longer active.',409);
    await stopJob(env,row,'cancelled'); return json({ok:true});
  }
  if (action === 'retry' && request.method === 'POST') {
    if (!['failed','cancelled','expired'].includes(row.status)) throw new RelayError('This transfer cannot be retried yet.',409);
    return createJob(request,env,owner,{url:row.url});
  }
  if (!action && request.method === 'DELETE') { await stopJob(env,row,'deleted'); return json({ok:true}); }
  if (!action && request.method === 'PATCH') {
    const body = await readBody(request); if (typeof body.name !== 'string' || !body.name.trim()) throw new RelayError('Enter a file name.');
    await env.DB.prepare('UPDATE jobs SET name=?,updated_at=? WHERE id=? AND owner=?').bind(cleanName(body.name),Date.now(),row.id,owner).run(); return json({ok:true});
  }
  throw new RelayError('This method is not supported.',405,'METHOD_NOT_ALLOWED');
}

export default {
  async fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith('/api/')) {
      const r = await env.ASSETS.fetch(request); const headers = new Headers(r.headers);
      for (const [key,value] of Object.entries(securityHeaders)) headers.set(key,value);
      return new Response(r.body,{status:r.status,headers});
    }
    if (!allowedOrigin(request,env)) return json({error:'This origin is not allowed.'},403);
    let response;
    if (request.method === 'OPTIONS') response = new Response(null,{status:204});
    else {
      try { response = await api(request,env); }
      catch (e) {
        if (!(e instanceof RelayError)) console.error('Relay API error',e.message);
        response = json({error:e instanceof RelayError ? e.message : 'The server could not complete this request.',code:e.code || 'SERVER_ERROR'},e.status || 500);
      }
    }
    const headers = new Headers(response.headers); const origin = request.headers.get('Origin');
    if (origin) { headers.set('Access-Control-Allow-Origin',origin); headers.set('Vary','Origin'); }
    headers.set('Access-Control-Allow-Methods','GET,HEAD,POST,PATCH,DELETE,OPTIONS');
    headers.set('Access-Control-Allow-Headers','Content-Type,X-Relay-Key,Range,If-Range');
    headers.set('Access-Control-Expose-Headers','Content-Length,Content-Range,Content-Disposition,ETag');
    return new Response(response.body,{status:response.status,headers});
  },
  async scheduled(_event,env,ctx) { ctx.waitUntil(sweep(env)); },
};

async function sweep(env) {
  const now = Date.now();
  const {results} = await env.DB.prepare(`SELECT * FROM jobs WHERE
    (status='completed' AND expires_at<=?) OR (status IN ('deleted','expired','failed','cancelled') AND (cleaned_at IS NULL OR created_at<?)) OR
    (status IN (${ACTIVE}) AND updated_at<?) ORDER BY created_at ASC LIMIT 100`).bind(now,now-7*86400000,now-3*3600000).all();
  for (const row of results) {
    try {
      if (['queued','fetching','retrying'].includes(row.status)) {
        await stopJob(env,row,'failed');
        await env.DB.prepare("UPDATE jobs SET error='The transfer timed out.' WHERE id=?").bind(row.id).run();
      } else {
        // Mark inaccessible before deleting the stored object.
        if (row.status === 'completed') await env.DB.prepare("UPDATE jobs SET status='expired',reserved=0 WHERE id=?").bind(row.id).run();
        await cleanObjects(env,row);
      }
      if (row.created_at < now-7*86400000 || (row.status==='deleted' && row.updated_at < now-86400000)) await env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(row.id).run();
    } catch (e) { console.error('Cleanup failed',row.id,e.message); }
  }
  await env.DB.prepare('DELETE FROM rate_limits WHERE window<?').bind(Math.floor(now/3600000)-48).run();
}

async function activeJob(env,id) {
  const row = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
  if (!row || !['queued','fetching','retrying'].includes(row.status)) throw new NonRetryableError('This transfer was cancelled.');
  return row;
}
function validateSource(r) {
  if (!r.ok) throw new RelayError(`The source returned HTTP ${r.status}.`,502,'SOURCE_HTTP_ERROR');
  if (/text\/html|application\/xhtml\+xml/i.test(r.headers.get('Content-Type') || '')) throw new RelayError('The URL returned a web page. Use a direct file URL.',400,'NOT_A_FILE');
}
function totalFromProbe(r) {
  if (r.headers.get('Content-Encoding') && r.headers.get('Content-Encoding') !== 'identity') return null;
  const raw = r.status === 206 ? /^bytes 0-0\/(\d+)$/.exec(r.headers.get('Content-Range') || '')?.[1] : r.headers.get('Content-Length');
  const n = raw === null || raw === undefined ? null : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
async function updateProgress(env,id,received) {
  const r = await env.DB.prepare(`UPDATE jobs SET received=?,updated_at=? WHERE id=? AND status IN (${ACTIVE})`).bind(received,Date.now(),id).run();
  if (!r.meta.changes) throw new NonRetryableError('This transfer was cancelled.');
}
async function trackedBytes(response,env,id,start,maximum,expected = null) {
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks = []; let bytes = 0, last = Date.now();
  while (true) {
    let timer; const piece = await Promise.race([reader.read(), new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The source stopped sending data.')),45000);})]).finally(()=>clearTimeout(timer));
    if (piece.done) break;
    bytes += piece.value.length;
    if (bytes > maximum || (expected !== null && bytes > expected)) { await reader.cancel(); throw new NonRetryableError('The source exceeded the permitted file size.'); }
    chunks.push(piece.value);
    if (Date.now()-last > 1000) { await updateProgress(env,id,start+bytes); last=Date.now(); }
  }
  if (expected !== null && bytes !== expected) throw new Error('The source ended before the file was complete.');
  const out = new Uint8Array(bytes); let offset=0; for (const c of chunks) {out.set(c,offset);offset+=c.length;}
  return out;
}

export class TransferWorkflow extends WorkflowEntrypoint {
  async run(event,step) {
    const env = this.env; const id = event.payload.id; const config = limits(env);
    try {
      const meta = await step.do('Inspect source',{retries:{limit:2,delay:'5 seconds',backoff:'exponential'},timeout:'2 minutes'},async()=>{
        const row = await activeJob(env,id); const {response:r,url,controller} = await safeFetch(row.url,{headers:{Range:'bytes=0-0'}});
        try {
          if (r.status === 416 && r.headers.get('Content-Range') === 'bytes */0') return {url,total:0,name:filenameFrom(r.headers,url),range:false,type:'application/octet-stream',validator:null};
          validateSource(r); const total = totalFromProbe(r);
          if (total !== null && total > config.maxBytes) throw new NonRetryableError('This file exceeds the configured size limit.');
          const etag = r.headers.get('ETag'); const modified = r.headers.get('Last-Modified');
          return {url,total,name:filenameFrom(r.headers,url),range:r.status===206 && total!==null && Boolean((etag && !etag.startsWith('W/')) || modified),type:r.headers.get('Content-Type') || 'application/octet-stream',validatorKind:(etag && !etag.startsWith('W/')) ? 'etag' : 'modified',validator:(etag && !etag.startsWith('W/')) ? etag : modified};
        } finally { controller.abort(); try{await r.body?.cancel();}catch{} }
      });
      await step.do('Prepare storage',async()=>{
        const row = await activeJob(env,id);
        const upload = row.upload_id ? env.BUCKET.resumeMultipartUpload(row.object_key,row.upload_id) : await env.BUCKET.createMultipartUpload(row.object_key,{httpMetadata:{contentType:meta.type}});
        await env.DB.prepare(`UPDATE jobs SET status='fetching',total=?,name=?,content_type=?,upload_id=?,updated_at=? WHERE id=? AND status IN (${ACTIVE})`).bind(meta.total,meta.name,meta.type,upload.uploadId,Date.now(),id).run();
      });
      let parts = [], actualTotal = 0;
      if (meta.range && meta.total > 0) {
        const count = Math.ceil(meta.total/PART_SIZE);
        for (let index=0; index<count; index++) {
          const part = await step.do('Fetch part '+(index+1),{retries:{limit:3,delay:'5 seconds',backoff:'exponential'},timeout:'30 minutes'},async(ctx)=>{
            const row = await activeJob(env,id); const start=index*PART_SIZE; const end=Math.min(meta.total-1,start+PART_SIZE-1);
            await env.DB.prepare(`UPDATE jobs SET status='fetching',attempt=?,received=?,updated_at=? WHERE id=? AND status IN (${ACTIVE})`).bind(ctx.attempt || 1,start,Date.now(),id).run();
            const {response:r,controller} = await safeFetch(meta.url,{headers:{Range:`bytes=${start}-${end}`,'If-Range':meta.validator}});
            try {
              if (r.status !== 206 || r.headers.get('Content-Range') !== `bytes ${start}-${end}/${meta.total}`) throw new NonRetryableError('The source changed or no longer supports partial downloads. Retry the transfer.');
              if (r.headers.get('Content-Encoding') && r.headers.get('Content-Encoding') !== 'identity') throw new NonRetryableError('The source returned an unsupported encoded byte range.');
              const currentValidator = meta.validatorKind === 'etag' ? r.headers.get('ETag') : r.headers.get('Last-Modified');
              if (currentValidator !== meta.validator) throw new NonRetryableError('The source file changed during transfer.');
              const bytes=await trackedBytes(r,env,id,start,config.maxBytes-start,end-start+1);
              const upload=env.BUCKET.resumeMultipartUpload(row.object_key,row.upload_id);
              const saved=await upload.uploadPart(index+1,bytes);
              await updateProgress(env,id,end+1); return saved;
            } finally { controller.abort(); try{await r.body?.cancel();}catch{} }
          });
          parts.push(part);
        }
        actualTotal=meta.total;
      } else {
        const result=await step.do('Stream source',{retries:{limit:2,delay:'10 seconds',backoff:'exponential'},timeout:'2 hours'},async(ctx)=>{
          const row=await activeJob(env,id);
          await env.DB.prepare(`UPDATE jobs SET received=0,attempt=?,updated_at=? WHERE id=? AND status IN (${ACTIVE})`).bind(ctx.attempt || 1,Date.now(),id).run();
          const {response:r,controller}=await safeFetch(meta.url);
          let reader;
          try {
            validateSource(r);
            const encoding=r.headers.get('Content-Encoding');
            const raw=r.headers.get('Content-Length'); const n=raw!==null?Number(raw):null; const expected=(!encoding || encoding==='identity') && Number.isSafeInteger(n) && n>=0 ? n : null;
            if (expected!==null && expected>config.maxBytes) throw new NonRetryableError('This file exceeds the configured size limit.');
            await env.DB.prepare(`UPDATE jobs SET total=? WHERE id=? AND status IN (${ACTIVE})`).bind(expected,id).run();
            reader=r.body?.getReader(); let total=0,index=1,offset=0,last=Date.now(); let buffer=new Uint8Array(PART_SIZE); const saved=[];
            const upload=env.BUCKET.resumeMultipartUpload(row.object_key,row.upload_id);
            if (reader) while(true) {
              let timer; const {done,value}=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The source stopped sending data.')),45000);})]).finally(()=>clearTimeout(timer));
              if(done) break;
              total+=value.length; if(total>config.maxBytes) throw new NonRetryableError('This file exceeds the configured size limit.');
              let cursor=0;
              while(cursor<value.length) {
                const n=Math.min(PART_SIZE-offset,value.length-cursor); buffer.set(value.subarray(cursor,cursor+n),offset); offset+=n;cursor+=n;
                if(offset===PART_SIZE) { saved.push(await upload.uploadPart(index++,buffer));buffer=new Uint8Array(PART_SIZE);offset=0; }
              }
              if(Date.now()-last>1000) {await updateProgress(env,id,total);last=Date.now();}
            }
            if(expected!==null && expected!==total) throw new Error('The source ended before the file was complete.');
            if(offset>0) saved.push(await upload.uploadPart(index,buffer.subarray(0,offset)));
            await updateProgress(env,id,total); return {parts:saved,total};
          } finally { controller.abort(); try{await reader?.cancel();}catch{} }
        });
        parts=result.parts;actualTotal=result.total;
      }
      await step.do('Complete transfer',{retries:{limit:3,delay:'5 seconds'},timeout:'2 minutes'},async()=>{
        const row=await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
        if (row?.status === 'completed') return;
        if (!row || !['queued','fetching','retrying'].includes(row.status)) throw new NonRetryableError('This transfer was cancelled.');
        // A completed R2 object makes this operation safe to replay after a crash.
        const existing=await env.BUCKET.head(row.object_key);
        if(!existing) {
          const upload=env.BUCKET.resumeMultipartUpload(row.object_key,row.upload_id);
          if(actualTotal===0) {await upload.abort();await env.BUCKET.put(row.object_key,new Uint8Array());}
          else await upload.complete(parts);
        }
        const result=await env.DB.prepare(`UPDATE jobs SET status='completed',received=?,total=?,reserved=?,upload_id=NULL,expires_at=?,updated_at=? WHERE id=? AND status IN (${ACTIVE})`).bind(actualTotal,actualTotal,actualTotal,Date.now()+config.retention,Date.now(),id).run();
        if(!result.meta.changes) {await env.BUCKET.delete(row.object_key);throw new NonRetryableError('This transfer was cancelled.');}
      });
    } catch(e) {
      await step.do('Clean up failed transfer',{retries:{limit:3,delay:'10 seconds'},timeout:'2 minutes'},async()=>{
        const row=await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first(); if(!row || row.status === 'completed') return;
        if(['queued','fetching','retrying'].includes(row.status)) {
          const reason=String(e?.message || 'The source could not be downloaded.').replace(/https?:\/\/\S+/g,'[source]').slice(0,240);
          await env.DB.prepare("UPDATE jobs SET status='failed',error=?,reserved=0,updated_at=? WHERE id=?").bind(reason,Date.now(),id).run();
        }
        await cleanObjects(env,row);
      });
      throw e;
    }
  }
}
