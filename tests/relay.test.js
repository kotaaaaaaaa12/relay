import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker,{ TransferWorkflow } from '../src/worker.js';
import { validateURL,parseRange,filenameFrom,PART_SIZE,sha256,safeFetch } from '../src/core.js';

const schema=readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
const originalFetch=globalThis.fetch;
test.after(()=>{globalThis.fetch=originalFetch;});
function setup(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(schema);
  const env={DB:{prepare(sql){const query=sqlite.prepare(sql);let args=[];return {bind(...values){args=values;return this;},async first(){return query.get(...args)||null;},async all(){return {results:query.all(...args)};},async run(){const r=query.run(...args);return {meta:{changes:Number(r.changes)}};}};}},BUCKET:new Bucket(),TRANSFERS:{async create(){},async get(){return {async terminate(){}};}},ASSETS:{async fetch(){return new Response('Relay');}}};
  return {env,sqlite};
}
class Bucket{
  objects=new Map();uploads=new Map();
  async head(key){return this.objects.has(key)?{size:this.objects.get(key).length,httpEtag:'"r2-etag"'}:null;}
  async put(key,value){this.objects.set(key,new Uint8Array(value));}
  async delete(key){this.objects.delete(key);}
  async get(key,options={}){const b=this.objects.get(key);if(!b)return null;const r=options.range;return {body:new Response(r?b.slice(r.offset,r.offset+r.length):b).body,httpEtag:'"r2-etag"'};}
  async createMultipartUpload(key){const id=crypto.randomUUID();this.uploads.set(id,{key,parts:new Map()});return this.resumeMultipartUpload(key,id);}
  resumeMultipartUpload(key,id){const self=this;return {uploadId:id,async uploadPart(n,data){const u=self.uploads.get(id);if(!u)throw new Error('NoSuchUpload');u.parts.set(n,new Uint8Array(data));return {partNumber:n,etag:String(n)};},async abort(){if(!self.uploads.delete(id))throw new Error('NoSuchUpload');},async complete(parts){const u=self.uploads.get(id);if(!u)throw new Error('NoSuchUpload');const pieces=parts.map(p=>u.parts.get(p.partNumber));for(let i=0;i<pieces.length-1;i++)assert.ok(pieces[i].length>=5*1024**2);const total=pieces.reduce((n,p)=>n+p.length,0),bytes=new Uint8Array(total);let offset=0;for(const p of pieces){bytes.set(p,offset);offset+=p.length;}self.objects.set(key,bytes);self.uploads.delete(id);}};}
}
function steps({replayCompletion=false}={}){return {async do(name,options,fn){if(typeof options==='function'){fn=options;options={};}const retries=options.retries?.limit??1;for(let attempt=1;;attempt++){try{const result=await fn({attempt});if(name==='Complete transfer'&&replayCompletion)await fn({attempt});return result;}catch(e){if(e.constructor.name==='NonRetryableError'||attempt>retries)throw e;}}}};}
async function add(sqlite,values={}){const id=values.id||crypto.randomUUID(),now=Date.now();const row={id,owner:await sha256('a'.repeat(64)),url:'https://files.example.com/archive.zip',source_host:'files.example.com',name:'archive.zip',reserved:5*1024**3,download_token:'d'.repeat(64),object_key:'files/'+id,created_at:now,updated_at:now,...values};const columns=Object.keys(row);sqlite.prepare(`INSERT INTO jobs(${columns.join(',')}) VALUES(${columns.map(()=>'?')})`).run(...Object.values(row));return row;}
function source(data,{ranges=true,unknown=false,change=false}={}){return async(input,init={})=>{
  const u=new URL(String(input));if(u.hostname==='cloudflare-dns.com')return Response.json({Status:0,Answer:u.searchParams.get('type')==='A'?[{type:1,data:'93.184.215.14'}]:[]});
  const headers={'Content-Type':'application/zip',ETag:change&&init.headers?.['If-Range']?'"changed"':'"stable"'};
  const requested=init.headers?.Range;
  if(ranges&&requested){if(!data.length)return new Response(null,{status:416,headers:{'Content-Range':'bytes */0'}});const [a,b]=requested.slice(6).split('-').map(Number);headers['Content-Range']=`bytes ${a}-${b}/${data.length}`;headers['Content-Length']=String(b-a+1);return new Response(data.slice(a,b+1),{status:206,headers});}
  if(!unknown)headers['Content-Length']=String(data.length);
  const stream=new ReadableStream({start(controller){for(let i=0;i<data.length;i+=65536)controller.enqueue(data.slice(i,i+65536));controller.close();}});
  return new Response(stream,{headers});
};}
const request=(path,method='GET',body,key='a'.repeat(64))=>new Request('https://relay.example.com'+path,{method,headers:{'X-Relay-Key':key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});

test('URL and redirect validation blocks local, private, encoded, and unsupported targets',async()=>{
  for(const url of ['file:///etc/passwd','ftp://host.com/file','http://localhost/a','http://127.1/a','http://0x7f000001/a','http://10.0.0.1/a','http://169.254.169.254/latest','http://[::ffff:127.0.0.1]/a','https://name:secret@public.com/a','https://public.com:3000/a'])assert.throws(()=>validateURL(url));
  assert.equal(validateURL('https://public.com/a#fragment').href,'https://public.com/a');
  const mock=async input=>String(input).includes('dns-query')?Response.json({Status:0,Answer:[{type:1,data:'93.184.215.14'}]}):new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}});
  await assert.rejects(()=>safeFetch('https://public.com/file',{},mock),/not allowed/);
});
test('filenames and ranges preserve usable names and reject invalid ranges',()=>{
  assert.equal(filenameFrom(new Headers({'Content-Disposition':"attachment; filename*=UTF-8''my%20file.zip"}),'https://a.com/a'),'my file.zip');
  assert.equal(filenameFrom(new Headers(),'https://a.com/a%20b.zip?signature=secret'),'a b.zip');
  assert.deepEqual(parseRange('bytes=2-5',10),{offset:2,length:4});assert.deepEqual(parseRange('bytes=-4',10),{offset:6,length:4});
  for(const h of ['bytes=10-','bytes=0-1,4-5','bytes=-0','bytes=4-2'])assert.throws(()=>parseRange(h,10));
});
test('multipart transfer preserves exact bytes and completion is safe to replay',async()=>{
  const {env,sqlite}=setup(),data=new Uint8Array(PART_SIZE+131);for(let i=0;i<data.length;i++)data[i]=i%251;
  globalThis.fetch=source(data);const row=await add(sqlite);await new TransferWorkflow({},env).run({payload:{id:row.id}},steps({replayCompletion:true}));
  const saved=sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(row.id);assert.equal(saved.status,'completed');assert.equal(saved.total,data.length);assert.equal(saved.received,data.length);assert.equal(saved.upload_id,null);assert.deepEqual(env.BUCKET.objects.get(row.object_key),data);assert.equal(env.BUCKET.uploads.size,0);
});
test('unknown length source is streamed into uniform parts and reports final size',async()=>{
  const {env,sqlite}=setup(),data=new Uint8Array(PART_SIZE+217).fill(23);globalThis.fetch=source(data,{ranges:false,unknown:true});const row=await add(sqlite);await new TransferWorkflow({},env).run({payload:{id:row.id}},steps());
  assert.equal(sqlite.prepare('SELECT total FROM jobs WHERE id=?').get(row.id).total,data.length);assert.deepEqual(env.BUCKET.objects.get(row.object_key),data);
});
test('empty file completes and changed source is rejected without leaking parts',async()=>{
  const {env,sqlite}=setup();globalThis.fetch=source(new Uint8Array());const empty=await add(sqlite);await new TransferWorkflow({},env).run({payload:{id:empty.id}},steps());assert.equal(env.BUCKET.objects.get(empty.object_key).length,0);
  const changed=await add(sqlite);globalThis.fetch=source(new Uint8Array(1024),{change:true});await assert.rejects(()=>new TransferWorkflow({},env).run({payload:{id:changed.id}},steps()),/source file changed/);
  assert.equal(sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(changed.id).status,'failed');assert.equal(env.BUCKET.uploads.size,0);assert.equal(env.BUCKET.objects.has(changed.object_key),false);
});
test('size limits stop an unknown-length source and cancelled jobs cannot finish',async()=>{
  const {env,sqlite}=setup();env.MAX_FILE_BYTES='100';globalThis.fetch=source(new Uint8Array(150),{ranges:false,unknown:true});const row=await add(sqlite);await assert.rejects(()=>new TransferWorkflow({},env).run({payload:{id:row.id}},steps()),/size limit/);assert.equal(env.BUCKET.uploads.size,0);
  const cancelled=await add(sqlite,{status:'cancelled'});await assert.rejects(()=>new TransferWorkflow({},env).run({payload:{id:cancelled.id}},steps()),/cancelled/);assert.equal(sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(cancelled.id).status,'cancelled');
});
test('API isolates device lists, enforces active quotas, and denies untrusted origins',async()=>{
  const {env,sqlite}=setup();assert.equal((await worker.fetch(request('/api/jobs','POST',{url:'https://files.example.com/a.zip'}),env)).status,201);assert.equal((await worker.fetch(request('/api/jobs','POST',{url:'https://files.example.com/b.zip'}),env)).status,201);assert.equal((await worker.fetch(request('/api/jobs','POST',{url:'https://files.example.com/c.zip'}),env)).status,409);
  const other=await (await worker.fetch(request('/api/jobs','GET',null,'b'.repeat(64)),env)).json();assert.equal(other.jobs.length,0);assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM jobs').get().count,2);
  const cross=request('/api/jobs');cross.headers.set('Origin','https://evil.example');assert.equal((await worker.fetch(cross,env)).status,403);
});
test('downloads use a per-file capability, support ranges, and expire before cleanup',async()=>{
  const {env,sqlite}=setup(),row=await add(sqlite,{status:'completed',total:10,received:10,expires_at:Date.now()+60000});await env.BUCKET.put(row.object_key,new Uint8Array([0,1,2,3,4,5,6,7,8,9]));
  const path=`/api/files/${row.id}/${row.download_token}`;const req=request(path);req.headers.set('Range','bytes=3-6');const response=await worker.fetch(req,env);assert.equal(response.status,206);assert.equal(response.headers.get('Content-Range'),'bytes 3-6/10');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),new Uint8Array([3,4,5,6]));assert.match(response.headers.get('Content-Disposition'),/^attachment/);
  assert.equal((await worker.fetch(request(path.replace(row.download_token,'e'.repeat(64))),env)).status,410);
  sqlite.prepare('UPDATE jobs SET expires_at=? WHERE id=?').run(Date.now()-1,row.id);assert.equal((await worker.fetch(request(path),env)).status,410);let task;await worker.scheduled({},env,{waitUntil(p){task=p;}});await task;assert.equal(env.BUCKET.objects.has(row.object_key),false);
});
test('cleanup is not starved by already cleaned terminal rows',async()=>{
  const {env,sqlite}=setup(),now=Date.now();for(let i=0;i<105;i++)await add(sqlite,{status:'cancelled',cleaned_at:now,created_at:now-86400000});
  const expired=await add(sqlite,{status:'completed',total:1,received:1,expires_at:now-1});await env.BUCKET.put(expired.object_key,new Uint8Array([5]));let task;await worker.scheduled({},env,{waitUntil(p){task=p;}});await task;assert.equal(env.BUCKET.objects.has(expired.object_key),false);assert.equal(sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(expired.id).status,'expired');
});
