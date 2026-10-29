# Ported from the reviewed 2026-10-29 V1 procedure; no model POST.
import subprocess,json,pathlib,hashlib,datetime,sys,os
service=sys.argv[1]
is_owner=service in ('app-copy-primary-hard-drive-b5fhzd','nomorevibe-text-m3-ebmybu')
if service not in ('app-copy-primary-hard-drive-b5fhzd','nomorevibe-text-m3-ebmybu','app-reboot-optical-matrix-3bl2a4','app-hack-optical-monitor-v1ioak'):raise ValueError('exact_84d_ingress_only')
def run(a):return subprocess.run(a,capture_output=True,text=True,check=True).stdout
meta=json.loads(run(['docker','service','inspect',service]))[0]
ids=run(['docker','ps','--filter','label=com.docker.swarm.service.name='+service,'-q']).split()
if len(ids)!=1:raise RuntimeError('exact_single_current_container_required')
node=r"const fs=require('fs');const link=p=>fs.readlinkSync(p);const text=p=>fs.readFileSync(p,'utf8');const stat=text('/proc/1/stat');const v=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);const procs=fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)).map(x=>{try{const r=text('/proc/'+x+'/stat');const a=r.slice(r.lastIndexOf(')')+2).trim().split(/\s+/);const env=Object.fromEntries(text('/proc/'+x+'/environ').split('\0').filter(v=>v.startsWith('ROLE_LEASE_INSTANCE_ID=')||v.startsWith('ROLE_LEASE_BOOT_ID=')).map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1)]}));return {pid:Number(x),ppid:Number(a[1]),startTicks:Number(a[19]),comm:text('/proc/'+x+'/comm').trim(),pidNamespace:link('/proc/'+x+'/ns/pid'),owner:{instanceId:env.ROLE_LEASE_INSTANCE_ID??null,bootId:env.ROLE_LEASE_BOOT_ID??null}}}catch{return null}}).filter(Boolean);console.log(JSON.stringify({hostBootId:text('/proc/sys/kernel/random/boot_id').trim(),pid1:{pid:1,ppid:Number(v[1]),startTicks:Number(v[19]),comm:text('/proc/1/comm').trim(),pidNamespace:link('/proc/1/ns/pid')},selfPidNamespace:link('/proc/self/ns/pid'),cgroupNamespace:link('/proc/1/ns/cgroup'),cgroupRelativePath:text('/proc/1/cgroup').trim(),cgroupEvents:text('/sys/fs/cgroup/cgroup.events'),cgroupProcesses:text('/sys/fs/cgroup/cgroup.procs').trim().split(/\s+/).map(Number),processes:procs}));"
python="import pathlib,json\nP=pathlib.Path\nraw=P('/proc/1/stat').read_text();v=raw[raw.rfind(')')+2:].split();rows=[]\nfor p in P('/proc').iterdir():\n if p.name.isdigit():\n  try:rows.append({'pid':int(p.name),'comm':(p/'comm').read_text().strip(),'pidNamespace':str((p/'ns/pid').readlink())})\n  except FileNotFoundError:pass\nprint(json.dumps({'hostBootId':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'pid1':{'pid':1,'ppid':int(v[1]),'startTicks':int(v[19]),'comm':P('/proc/1/comm').read_text().strip(),'pidNamespace':str(P('/proc/1/ns/pid').readlink())},'selfPidNamespace':str(P('/proc/self/ns/pid').readlink()),'cgroupNamespace':str(P('/proc/1/ns/cgroup').readlink()),'cgroupRelativePath':P('/proc/1/cgroup').read_text().strip(),'cgroupEvents':P('/sys/fs/cgroup/cgroup.events').read_text(),'cgroupProcesses':[int(x)for x in P('/sys/fs/cgroup/cgroup.procs').read_text().split()],'processes':rows}))"
rows=[]
for cid in ids:
 x=json.loads(run(['docker','inspect',cid]))[0]
 args=['node','-e',node]if is_owner else['python','-c',python]
 probe=subprocess.run(['docker','exec',cid,*args],capture_output=True,text=True)
 if probe.returncode:raise RuntimeError('inside_identity_probe_failed')
 inside=json.loads(probe.stdout)
 rows.append({'id':x['Id'],'name':x['Name'],'imageId':x['Image'],'taskId':x['Config'].get('Labels',{}).get('com.docker.swarm.task.id'),'startedAt':x['State']['StartedAt'],'running':x['State']['Running'],'health':x['State'].get('Health',{}).get('Status'),'hostPid':x['State']['Pid'],'privileged':x['HostConfig'].get('Privileged',False),'pidMode':x['HostConfig']['PidMode'],'cgroupParent':x['HostConfig'].get('CgroupParent'),'inside':inside})
boot=rows[0]['inside']['hostBootId']if rows else None

if is_owner:
 paths=['lib/operations/dr/provider-boundary-release.ts', 'lib/llm/provider-boundary-contract.ts', 'lib/llm/capacity-repository.ts', 'lib/operations/pipeline-control-repository.ts', 'lib/operations/pipeline-control.ts', 'lib/llm/capacity.ts', 'lib/operations/dr/epoch.ts']
 probe="const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries("+json.dumps(paths)+".map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))))"
 actual=json.loads(run(['docker','exec','-w','/app',rows[0]['id'],'node','-e',probe]))
else:
 paths=['app/routers/ollama_proxy.py','app/models/ollama.py','app/services/vllm_client.py','app/services/mlx_concurrency.py']
 probe="import pathlib,hashlib,json;print(json.dumps({p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()for p in "+repr(paths)+"}))"
 actual=json.loads(run(['docker','exec','-w','/app',rows[0]['id'],'python','-c',probe]))
rows[0]['sourceFileHashes']=actual
tasks=run(['docker','service','ps','--no-trunc','--format','{{json .}}',service]);taskRows=[]
for line in tasks.splitlines():
 t=json.loads(line);taskRows.append({k:t.get(k)for k in ['ID','Name','Node','DesiredState','CurrentState']})
spec=meta['Spec'];replicas=spec.get('Mode',{}).get('Replicated',{}).get('Replicas');norm=json.loads(json.dumps(spec));norm.get('Mode',{}).get('Replicated',{}).pop('Replicas',None)
print(json.dumps({'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'hostBootId':boot,'serviceId':meta['ID'],'serviceName':service,'serviceVersion':meta['Version']['Index'],'replicas':replicas,'restartPolicy':spec['TaskTemplate'].get('RestartPolicy'),'stopGracePeriodNanoseconds':spec['TaskTemplate']['ContainerSpec'].get('StopGracePeriod'),'imageReferenceSha256':hashlib.sha256(spec['TaskTemplate']['ContainerSpec']['Image'].encode()).hexdigest(),'serviceSpecSansReplicaSha256':hashlib.sha256(json.dumps(norm,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'updateState':meta.get('UpdateStatus',{}).get('State'),'containers':rows,'tasks':taskRows}))
