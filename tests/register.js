import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:new URL('./runtime-stub.js',import.meta.url).href,shortCircuit:true};
  if(specifier==='cloudflare:workflows')return {url:new URL('./runtime-stub.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
