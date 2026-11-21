import { PROTOCOL_VERSION } from "./protocol";

/**
 * `window.paseo` for ```app pages: a small client for the JSON-RPC bridge, injected before the page's
 * own HTML. It performs `ui/initialize`, then exposes
 *
 *   paseo.ready                      Promise<HostContext>
 *   paseo.context                    latest HostContext (null until ready)
 *   paseo.sendMessage(text)          post a user message to the chat (the user is asked first)
 *   paseo.openLink(url)              open an https link (the user is asked first)
 *   paseo.requestDisplayMode(mode)   "inline" | "fullscreen"; resolves the mode actually set
 *   paseo.storage.get/set/delete/keys   JSON values saved on the daemon, 1 MB per app
 *   paseo.load(path)                 read a file like Load() does; resolves the parsed value
 *   paseo.download({filename, mimeType, text | base64})
 *   paseo.ai(prompt, {system, maxTokens})   resolves the answer text (asked once per app)
 *   paseo.onContextChange(cb)        cb(context) after theme or display mode changes; returns an unsubscribe
 *
 * It also applies `hostContext.styles.variables` to the root element, so theme changes reach the
 * page without a reload. Plain ES5 on purpose: it runs before anything else, in every WebView.
 */
export const PASEO_CLIENT_SOURCE = `(function(){
if(window.paseo)return;
var w=window,p=w.parent,seq=0,pending={},changeCbs=[],ctx=null,tearCbs=[];
function send(m){p.postMessage(m,"*");}
function fail(e){var m=e&&e.message?String(e.message):"request failed";var x=new Error(m);if(e&&e.code!==undefined)x.code=e.code;return x;}
function rpc(method,params){return new Promise(function(resolve,reject){
var id=++seq;pending[id]={resolve:resolve,reject:reject};
send({jsonrpc:"2.0",id:id,method:method,params:params===undefined?{}:params});});}
function applyVars(c){
if(!c||!c.styles||!c.styles.variables)return;
var s=document.documentElement.style,v=c.styles.variables;
for(var k in v){if(Object.prototype.hasOwnProperty.call(v,k)&&typeof v[k]==="string")s.setProperty(k,v[k]);}
if(c.theme){document.documentElement.style.colorScheme=c.theme;document.documentElement.dataset.paseoTheme=c.theme;}}
w.addEventListener("message",function(e){
if(e.source!==p)return;
var d=e.data;if(!d||d.jsonrpc!=="2.0")return;
if(d.method==="ui/notifications/host-context-changed"){
var patch=d.params||{},prev=ctx||{},vars=null;
if(patch.styles&&patch.styles.variables){vars=Object.assign({},(prev.styles&&prev.styles.variables)||{},patch.styles.variables);}
ctx=Object.assign({},prev,patch);
if(vars)ctx.styles=Object.assign({},ctx.styles,{variables:vars});
applyVars(patch);
for(var i=0;i<changeCbs.length;i++){try{changeCbs[i](ctx);}catch(x){}}
return;}
if(d.method==="ui/resource-teardown"){
if(d.id!==undefined){
for(var t=0;t<tearCbs.length;t++){try{tearCbs[t](d.params);}catch(x){}}
send({jsonrpc:"2.0",id:d.id,result:{}});}
return;}
if(d.method){if(d.id!==undefined)send({jsonrpc:"2.0",id:d.id,error:{code:-32601,message:"method not found"}});return;}
if(d.id!==undefined&&Object.prototype.hasOwnProperty.call(pending,d.id)){
var q=pending[d.id];delete pending[d.id];
if(d.error)q.reject(fail(d.error));else q.resolve(d.result);}
});
var ready=rpc("ui/initialize",{protocolVersion:${JSON.stringify(PROTOCOL_VERSION)},appInfo:{name:"paseo-app",version:"1"},appCapabilities:{availableDisplayModes:["inline","fullscreen"]}}).then(function(r){
ctx=(r&&r.hostContext)||{};applyVars(ctx);
send({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}});
return ctx;});
ready.catch(function(){});
function after(name,params,pick){return ready.then(function(){return rpc(name,params);}).then(pick);}
function nothing(){}
w.paseo={
ready:ready,
get context(){return ctx;},
sendMessage:function(text){return after("ui/message",{role:"user",content:{type:"text",text:String(text)}},nothing);},
openLink:function(url){return after("ui/open-link",{url:String(url)},nothing);},
requestDisplayMode:function(mode){return after("ui/request-display-mode",{mode:mode},function(r){return r.mode;});},
storage:{
get:function(key){return after("paseo/storage/get",{key:key},function(r){return r.value===undefined?null:r.value;});},
set:function(key,value){return after("paseo/storage/set",{key:key,value:value},nothing);},
delete:function(key){return after("paseo/storage/delete",{key:key},nothing);},
keys:function(){return after("paseo/storage/keys",{},function(r){return r.keys;});}},
load:function(path){return after("paseo/load",{path:path},function(r){return r.value;});},
download:function(file){return after("paseo/download",file,nothing);},
ai:function(prompt,opts){var o=opts||{};var params={prompt:String(prompt)};
if(o.system!==undefined)params.system=String(o.system);
if(o.maxTokens!==undefined)params.maxTokens=o.maxTokens;
return after("paseo/ai",params,function(r){return r.text;});},
onContextChange:function(cb){changeCbs.push(cb);return function(){var i=changeCbs.indexOf(cb);if(i>=0)changeCbs.splice(i,1);};},
onTeardown:function(cb){tearCbs.push(cb);return function(){var i=tearCbs.indexOf(cb);if(i>=0)tearCbs.splice(i,1);};}
};
})();`;
