import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {collect} from './collect.mjs';
import {build} from './build.mjs';
const root=new URL('./',import.meta.url),port=Number(process.env.NMV_NEWS_PREVIEW_PORT||4178);
const intervalMs=Math.max(1000,Number(process.env.NMV_NEWS_REFRESH_MS||3600000));
const routes=new Map([['/','index.html'],['/index.html','index.html'],['/data.json','data.json']]);
let refreshRuns=0,lastRefresh=null,refreshError=null;
async function refresh(){try{lastRefresh=await collect();refreshRuns++;refreshError=null;console.log(JSON.stringify({event:'refreshed',...lastRefresh}))}catch(error){refreshError=error.message;console.error('Preview refresh failed:',error.message)}}
await build();
const server=http.createServer(async(req,res)=>{
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return}
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/status.json'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({mode:'local-preview',intervalMs,refreshRuns,lastRefresh,refreshError}));return}
 const file=routes.get(path);if(!file){res.writeHead(404);res.end('Not found');return}
 try{const body=await readFile(new URL(file,root));res.writeHead(200,{'Content-Type':file.endsWith('json')?'application/json; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});res.end(req.method==='HEAD'?undefined:body)}catch{res.writeHead(503);res.end('Preview is rebuilding. Please reload.')}
});
server.listen(port,'127.0.0.1',()=>{console.log(`AI news preview http://localhost:${port} · refresh every ${intervalMs/60000} minutes`);void refresh()});
const timer=setInterval(()=>void refresh(),intervalMs);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{clearInterval(timer);server.close(()=>process.exit(0))});
