const paths = {
  relay:'M4 7h14l-4-4m4 4-4 4M20 17H6l4 4m-4-4 4-4',
  'arrow-right':'M4 12h16m-6-6 6 6-6 6','arrow-up-right':'M6 18 18 6M6 6h12v12',
  link:'M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l2-2',
  clock:'M12 8v5l3 2|circle:12,12,9',
  box:'M3 7 12 3l9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v10M7 5l9 4',
  file:'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 14h8M8 17h5',
  clipboard:'M9 4H6a2 2 0 0 0-2 2v14h16V6a2 2 0 0 0-2-2h-3M9 2h6v4H9V2Z',
  shield:'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Zm-4 9 3 3 5-6',
  search:'M16.5 16.5 21 21|circle:10.5,10.5,6.5',
  refresh:'M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9',
  sun:'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5|circle:12,12,4',
  moon:'M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z',
  settings:'m10 3-.6 2.2-2 .8-2-.6-2 3.5L5 10.5v2.2L3.4 14l2 3.5 2-.6 2 .9.6 2.2h4l.6-2.2 2-.9 2 .6 2-3.5-1.6-1.3v-2.2l1.6-1.6-2-3.5-2 .6-2-.8L14 3h-4Z|circle:12,12,3',
  activity:'M2 12h5l3-8 4 16 3-8h5',info:'M12 11v6M12 7v.1|circle:12,12,9',
  x:'M6 6l12 12M6 18 18 6',download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  more:'M5 12h.01M12 12h.01M19 12h.01',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  edit:'m4 16-1 5 5-1L20 8l-4-4L4 16Zm9-9 4 4',check:'m5 12 4 4L19 6',
};
const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function icon(name) {
  const [d,extra]=(paths[name]||paths.file).split('|'); let shape=`<path d="${d}"/>`;
  if(extra){const [cx,cy,r]=extra.slice(7).split(',');shape+=`<circle cx="${cx}" cy="${cy}" r="${r}"/>`;}
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${shape}</svg>`;
}
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
const storage={get(key,fallback=''){try{return localStorage.getItem(key)??fallback;}catch{return fallback;}},set(key,value){try{localStorage.setItem(key,value);return true;}catch{return false;}}};
const state={connected:false,jobs:[],filter:'all',search:'',busy:false,rates:new Map(),device:new Map()};
let deviceKey=storage.get('relay.device-key');
if(!/^[a-f0-9]{64}$/.test(deviceKey)){deviceKey=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');if(!storage.set('relay.device-key',deviceKey))setTimeout(()=>toast('Browser storage is unavailable. Transfer history may not survive a reload.'),1000);}
async function api(path,options={}) {
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Relay-Key':deviceKey,...options.headers},signal:options.signal||AbortSignal.timeout(30000),cache:'no-store'});
  const result=await response.json().catch(()=>({error:'The server returned an invalid response.'}));
  if(!response.ok)throw new Error(result.error||'The request could not be completed.');return result;
}
function bytes(n) {
  if(n===null||n===undefined||!Number.isFinite(Number(n)))return 'Size unknown';
  const v=Math.max(0,Number(n));if(v<1024)return `${v} B`;
  const i=Math.min(4,Math.floor(Math.log(v)/Math.log(1024)));return `${(v/1024**i).toLocaleString('en-US',{maximumFractionDigits:1})} ${['B','KiB','MiB','GiB','TiB'][i]}`;
}
function duration(s){if(!Number.isFinite(s)||s<=0)return 'Calculating time remaining';if(s<60)return `${Math.ceil(s)}s remaining`;if(s<3600)return `${Math.ceil(s/60)}m remaining`;return `${Math.floor(s/3600)}h ${Math.ceil(s%3600/60)}m remaining`;}
function expires(t){const left=t-Date.now();return left<=0?'Expired':left<3600000?`Expires in ${Math.max(1,Math.ceil(left/60000))}m`:`Expires in ${Math.ceil(left/3600000)}h`;}
function ago(t){const n=Math.max(0,(Date.now()-t)/1000);return n<60?'Just now':n<3600?`${Math.floor(n/60)}m ago`:n<86400?`${Math.floor(n/3600)}h ago`:new Date(t).toLocaleDateString('en-US',{month:'short',day:'numeric'});}
const active=j=>['queued','fetching','retrying'].includes(j.status);
function allJobs(){return state.jobs.map(j=>j.status==='completed'&&j.expires_at<=Date.now()?{...j,status:'expired'}:j);}
function speed(job){
  const now=performance.now();let old=state.rates.get(job.id);
  if(!old||job.received<old.bytes){state.rates.set(job.id,{time:now,bytes:job.received,speed:0});return 0;}
  if(now-old.time>=1000){const rate=Math.max(0,(job.received-old.bytes)/((now-old.time)/1000));old={time:now,bytes:job.received,speed:old.speed?old.speed*.35+rate*.65:rate};state.rates.set(job.id,old);}
  return old.speed;
}
function progress(job){
  const local=state.device.get(job.id),received=local?local.received:job.received,total=local?local.total:job.total,known=total!==null&&total!==undefined,rate=local?local.speed:speed(job);
  const percent=known&&total>0?Math.min(99.9,received/total*100):0;
  const status=local?'Saving to your device':job.status==='queued'?'Waiting to start':received===total&&total>0?'Finalizing file':job.attempt>1?`Fetching file · attempt ${job.attempt}`:'Fetching file';
  return `<div class="progress-caption"><span><strong>${bytes(received)}</strong>${known?' / '+bytes(total):' / size unknown'}</span><span class="percent">${known?(total===0?'0':percent.toFixed(percent<10||percent>99?1:0))+'%':'In progress'}</span></div><div class="progress-track ${known?'':'indeterminate'}" role="progressbar" aria-label="${local?'Device download':'Server transfer'}" ${known?`aria-valuenow="${Math.floor(percent)}" aria-valuemin="0" aria-valuemax="100"`:''} aria-valuetext="${escapeHTML(bytes(received)+(known?' of '+bytes(total):' received'))}"><div class="progress-fill" style="width:${percent}%"></div></div><div class="progress-detail"><span>${status}</span><span>${rate>0?bytes(rate)+'/s'+(known&&total>received?' · '+duration((total-received)/rate):''):'Connecting to source…'}</span></div>`;
}
function sourceURL(job){try{const url=new URL(job.url);return ['https:','http:'].includes(url.protocol)?url.href:'';}catch{return '';}}
function sourceLink(job,menu=false){const url=sourceURL(job);if(!url)return menu?'':`<span>${escapeHTML(job.source_host)}</span>`;return `<a class="source-link" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="Open original URL in a new tab">${menu?icon('arrow-up-right')+' Open source':escapeHTML(job.source_host)}</a>`;}
const statusLabels={queued:'Queued',fetching:'Fetching',retrying:'Retrying',completed:'Ready',failed:'Failed',cancelled:'Cancelled',expired:'Expired'};
function actions(job){const id=job.id;return `${job.status==='completed'?`<button class="download-button" data-action="download" data-id="${id}">${icon('download')} Download</button>`:''}${active(job)?`<button class="icon-button" data-action="cancel" data-id="${id}" title="Cancel transfer" aria-label="Cancel transfer">${icon('x')}</button>`:''}${['failed','cancelled','expired'].includes(job.status)?`<button class="download-button" data-action="retry" data-id="${id}">${icon('refresh')} Retry</button>`:''}<details class="file-menu"><summary aria-label="More actions for ${escapeHTML(job.name)}">${icon('more')}</summary><div class="menu-content">${sourceLink(job,true)}${job.status==='completed'&&window.showSaveFilePicker?`<button data-action="save" data-id="${id}">${icon('download')} Save with progress</button>`:''}<button data-action="rename" data-id="${id}">${icon('edit')} Rename file</button><button class="danger" data-action="delete" data-id="${id}">${icon('trash')} Delete file</button></div></details>`;}
function card(job){const archive=/\.(zip|7z|rar|tar|gz|bz2|xz)$/i.test(job.name),show=active(job)||state.device.has(job.id);return `<div class="file-type-icon ${archive?'archive':''}">${icon(archive?'box':'file')}</div><div class="file-body"><div class="file-name-line"><span class="file-name" title="${escapeHTML(job.name)}">${escapeHTML(job.name)}</span><span class="status-tag ${job.status}">${statusLabels[job.status]||'Unknown'}</span></div><div class="file-meta">${sourceLink(job)}<span class="meta-dot">·</span><span>${bytes(job.total)}</span><span class="meta-dot">·</span><span class="age-label">${job.status==='completed'?expires(job.expires_at):ago(job.created_at)}</span></div><div class="progress-wrap" ${show?'':'hidden'}>${show?progress(job):''}</div>${job.error?`<div class="error-message">${escapeHTML(job.error)}</div>`:''}</div><div class="file-actions">${actions(job)}</div>`;}
function render(){
  const jobs=allJobs(),filtered=jobs.filter(j=>(state.filter==='all'||(state.filter==='active'?active(j):j.status==='completed'))&&j.name.toLowerCase().includes(state.search.toLowerCase()));
  $('transfer-count').textContent=jobs.length;$('all-count').textContent=jobs.length;$('active-count').textContent=jobs.filter(active).length;$('ready-count').textContent=jobs.filter(j=>j.status==='completed').length;
  $('empty-state').hidden=Boolean(filtered.length);$('empty-title').textContent=jobs.length?'No matching files':'No transfers yet';
  $('empty-description').innerHTML=jobs.length?'Try a different filter or search.':'Add a file URL to begin.';
  const keep=new Set(filtered.map(j=>j.id));for(const el of [...$('file-list').children])if(!keep.has(el.dataset.id))el.remove();
  for(const [index,job] of filtered.entries()){
    let node=[...$('file-list').children].find(el=>el.dataset.id===job.id);
    const structure=JSON.stringify([job.name,job.url,job.status,job.total,job.error,state.device.has(job.id)]);
    if(!node){node=document.createElement('article');node.className='file-row';node.dataset.id=job.id;$('file-list').appendChild(node);}
    if($('file-list').children[index]!==node)$('file-list').insertBefore(node,$('file-list').children[index]||null);
    if(node.dataset.structure!==structure){node.innerHTML=card(job);node.dataset.structure=structure;node.setAttribute('aria-label',job.name);}
    else{const p=node.querySelector('.progress-wrap');if(active(job)||state.device.has(job.id)){p.hidden=false;p.innerHTML=progress(job);}node.querySelector('.age-label').textContent=job.status==='completed'?expires(job.expires_at):ago(job.created_at);}
  }
  const stored=jobs.filter(j=>j.status==='completed').reduce((n,j)=>n+j.total,0);$('list-summary').textContent=`${filtered.length} of ${jobs.length} ${jobs.length===1?'file':'files'} · ${bytes(stored)} stored`;
  document.querySelectorAll('[data-filter]').forEach(el=>{el.classList.toggle('active',el.dataset.filter===state.filter);el.setAttribute('aria-selected',String(el.dataset.filter===state.filter));el.tabIndex=el.dataset.filter===state.filter?0:-1;});
}
let toastTimer;function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
function openDialog(id){const dialog=$(id),previous=document.activeElement;dialog.showModal();dialog.setAttribute('tabindex','-1');dialog.focus({preventScroll:true});dialog.addEventListener('close',()=>{if(previous instanceof HTMLElement){previous.focus({preventScroll:true});previous.blur();}},{once:true});}
async function connect(){
  try{const r=await fetch('/api/health',{signal:AbortSignal.timeout(10000),cache:'no-store'}),data=await r.json();if(!r.ok||!data.ok)throw new Error(data.error||'The service is unavailable.');
    state.connected=true;$('connection').className='connection online';$('connection').innerHTML='<i></i><span>Ready to relay</span>';$('retention-label').textContent=`${Math.round(data.retention/3600000)}-hour storage`;$('limit-label').textContent=`Up to ${bytes(data.maxBytes)} per file`;$('offline-note').hidden=true;await refresh();
  }catch(e){state.connected=false;$('connection').className='connection';$('connection').innerHTML='<i></i><span>Unavailable</span>';$('offline-note').textContent='Could not connect to Relay. '+(e.message.includes('JSON')?'Please try again shortly.':e.message);$('offline-note').hidden=false;}
}
let refreshing=false;async function refresh(){if(!state.connected||refreshing)return;refreshing=true;try{const result=await api('/api/jobs');state.jobs=result.jobs;$('offline-note').hidden=true;render();}catch(e){$('offline-note').textContent='Could not refresh transfers. '+e.message;$('offline-note').hidden=false;}finally{refreshing=false;}}
$('fetch-form').addEventListener('submit',async event=>{
  event.preventDefault();$('form-error').textContent='';if(!state.connected){await connect();if(!state.connected){$('form-error').textContent='The service is unavailable. Please try again shortly.';return;}}
  let url;try{url=new URL($('url-input').value.trim());if(!['https:','http:'].includes(url.protocol))throw new Error();}catch{$('form-error').textContent='Enter a valid HTTP or HTTPS file URL.';return;}
  if(state.busy)return;state.busy=true;$('fetch-button').disabled=true;
  try{await api('/api/jobs',{method:'POST',body:JSON.stringify({url:url.href})});$('url-input').value='';state.filter='all';state.search='';$('search-input').value='';await refresh();toast('Transfer queued. Relay will keep fetching if you close this page.');}
  catch(e){$('form-error').textContent=e.message;}finally{state.busy=false;$('fetch-button').disabled=false;}
});
$('paste-button').onclick=async()=>{try{$('url-input').value=(await navigator.clipboard.readText()).trim();$('url-input').focus();}catch{toast('Paste the file URL directly into the input.');$('url-input').focus();}};
$('settings-button').onclick=()=>openDialog('settings-dialog');$('how-button').onclick=()=>openDialog('how-dialog');
const systemTheme=matchMedia('(prefers-color-scheme: dark)');
function applyTheme(value){const theme=value==='system'?(systemTheme.matches?'dark':'light'):value;document.documentElement.dataset.theme=theme;$('theme-select').value=value;$('theme-button').innerHTML=icon(theme==='dark'?'moon':'sun');document.querySelector('meta[name="theme-color"]').content=theme==='dark'?'#181a1b':'#fafafa';}
applyTheme(storage.get('relay.theme','system'));$('theme-select').onchange=event=>{storage.set('relay.theme',event.target.value);applyTheme(event.target.value);event.target.blur();};
$('theme-button').onclick=()=>{const t=document.documentElement.dataset.theme==='dark'?'light':'dark';storage.set('relay.theme',t);applyTheme(t);};systemTheme.addEventListener('change',()=>{if(storage.get('relay.theme','system')==='system')applyTheme('system');});
document.querySelectorAll('[data-filter]').forEach(el=>el.onclick=()=>{state.filter=el.dataset.filter;render();});
document.querySelector('.filter-tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('[data-filter]')];let i=tabs.indexOf(document.activeElement);i=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[i].click();tabs[i].focus();});
$('search-input').oninput=event=>{state.search=event.target.value;render();};$('refresh-button').onclick=()=>state.connected?refresh():connect();
document.addEventListener('pointerdown',event=>{for(const d of document.querySelectorAll('.file-menu[open]'))if(!d.contains(event.target))d.open=false;});
document.addEventListener('pointerup',event=>{const el=event.target.closest('button');if(el&&event.pointerType!=='mouse')requestAnimationFrame(()=>el.blur());});
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
let pendingAction=null;
function showAction(action,job){pendingAction={action,job};const rename=action==='rename';$('action-title').textContent=rename?'Rename file':action==='cancel'?'Cancel this transfer?':'Delete this file?';$('action-description').textContent=rename?'Choose the name used when downloading this file.':action==='cancel'?'The current transfer will stop and its temporary data will be removed.':`“${job.name}” will be removed from your transfers and temporary storage.`;$('rename-input').hidden=!rename;$('rename-input').value=job.name;$('rename-input').required=rename;$('action-confirm').textContent=rename?'Save name':action==='cancel'?'Cancel transfer':'Delete file';openDialog('action-dialog');}
$('action-close').onclick=$('action-cancel').onclick=()=>$('action-dialog').close();
$('action-form').onsubmit=async event=>{event.preventDefault();if(!pendingAction)return;const {action,job}=pendingAction;$('action-confirm').disabled=true;
  try{if(action==='rename')await api('/api/jobs/'+job.id,{method:'PATCH',body:JSON.stringify({name:$('rename-input').value})});else if(action==='cancel')await api('/api/jobs/'+job.id+'/cancel',{method:'POST'});else await api('/api/jobs/'+job.id,{method:'DELETE'});$('action-dialog').close();await refresh();toast(action==='rename'?'File renamed.':action==='cancel'?'Transfer cancelled.':'File deleted.');}catch(e){toast(e.message);}finally{$('action-confirm').disabled=false;}
};
async function startDownload(job,withProgress=false){
  if(state.device.has(job.id)){toast('This file is already being saved.');return;}
  let handle;if(withProgress){try{handle=await window.showSaveFilePicker({suggestedName:job.name});}catch(e){if(e.name!=='AbortError')toast(e.message);return;}}
  try{const ticket=await api('/api/jobs/'+job.id+'/download',{method:'POST'});
    if(!withProgress){const a=document.createElement('a');a.href=ticket.url;a.download=ticket.name;a.rel='noreferrer';document.body.appendChild(a);a.click();a.remove();toast('Download opened. Check your browser’s download manager for progress.');return;}
    const response=await fetch(ticket.url,{cache:'no-store'});if(!response.ok||!response.body)throw new Error('The file could not be downloaded.');
    const writable=await handle.createWritable(),reader=response.body.getReader(),p={received:0,total:ticket.size,speed:0};state.device.set(job.id,p);let last=performance.now(),lastBytes=0;render();
    try{while(true){const {done,value}=await reader.read();if(done)break;await writable.write(value);p.received+=value.length;const now=performance.now();if(now-last>500){p.speed=(p.received-lastBytes)/((now-last)/1000);last=now;lastBytes=p.received;render();}}if(p.received!==ticket.size)throw new Error('The download ended before the file was complete.');await writable.close();toast('File saved to your device.');}
    catch(e){await writable.abort().catch(()=>{});await reader.cancel().catch(()=>{});throw e;}finally{state.device.delete(job.id);render();}
  }catch(e){toast(e.message);}
}
$('file-list').addEventListener('click',async event=>{const source=event.target.closest('a.source-link');if(source){source.closest('details')?.removeAttribute('open');return;}const button=event.target.closest('[data-action]');if(!button)return;const job=allJobs().find(j=>j.id===button.dataset.id);if(!job)return;button.closest('details')?.removeAttribute('open');const action=button.dataset.action;
  if(['rename','cancel','delete'].includes(action)){showAction(action,job);return;}
  button.disabled=true;try{if(action==='download'||action==='save')await startDownload(job,action==='save');else if(action==='retry'){await api('/api/jobs/'+job.id+'/retry',{method:'POST'});state.filter='all';await refresh();toast('A new transfer has been queued.');}}catch(e){toast(e.message);}finally{button.disabled=false;}
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)state.connected?refresh():connect();});
let cycles=0;setInterval(()=>{if(document.hidden)return;if(state.connected)refresh();else if(++cycles%10===0)connect();},1500);
render();connect();
