import os,subprocess,json,pathlib,datetime,hashlib,urllib.request
keys=['MainPID','ActiveState','SubState','ExecMainStartTimestamp','ControlGroup','KillMode','KillSignal','TimeoutStopUSec','Restart','FragmentPath','InvocationID']
r=subprocess.run(['/usr/bin/systemctl','show','vllm.service',*[x for k in keys for x in ['-p',k]]],capture_output=True,text=True,check=True)
meta=dict(l.split('=',1)for l in r.stdout.splitlines()if'='in l);cg=pathlib.Path('/sys/fs/cgroup')/meta['ControlGroup'].lstrip('/')
def proc(pid):
 p=pathlib.Path('/proc')/str(pid)
 try:
  raw=(p/'stat').read_text();rest=raw[raw.rfind(')')+2:].split()
  return {'pid':pid,'startTicks':int(rest[19]),'comm':(p/'comm').read_text().strip(),'pidNamespace':str((p/'ns/pid').readlink()),'cgroups':(p/'cgroup').read_text().splitlines()}
 except FileNotFoundError:return {'pid':pid,'absent':True}
ids=set()
for f in cg.rglob('cgroup.procs'):
 try:ids.update(int(v)for v in f.read_text().split())
 except FileNotFoundError:pass
for v in (cg/'cgroup.procs').read_text().split():ids.add(int(v))
config=subprocess.run(['/usr/bin/systemctl','cat','vllm.service'],capture_output=True,text=True,check=True).stdout
settings=subprocess.run(['/usr/bin/systemctl','show','vllm.service','-p','Environment','-p','EnvironmentFiles','-p','WorkingDirectory','-p','User','-p','Group'],capture_output=True,text=True,check=True).stdout
files=subprocess.run(['/usr/bin/systemctl','show','vllm.service','-p','EnvironmentFiles','--value'],capture_output=True,text=True,check=True).stdout.strip()
if files:raise RuntimeError('external_environment_file_requires_explicit_source_pin')
configurationHash=hashlib.sha256((config+'\n'+settings).encode()).hexdigest()
fragment=pathlib.Path(meta['FragmentPath'])
with urllib.request.urlopen('http://127.0.0.1:8000/metrics',timeout=5)as response:metrics=response.read(2*1024*1024+1).decode()
if len(metrics)>2*1024*1024:raise ValueError('metrics_too_large')
with urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=5)as response:
 if response.status!=200:raise ValueError('native_health_not_200')
again=subprocess.run(['/usr/bin/systemctl','show','vllm.service',*[x for k in keys for x in ['-p',k]]],capture_output=True,text=True,check=True).stdout
if again!=r.stdout:raise ValueError('native_identity_changed_during_metrics')
print(json.dumps({'operatorUid':os.geteuid(),'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'hostBootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'unit':'vllm.service','unitProperties':meta,'unitFileSha256':hashlib.sha256(fragment.read_bytes()).hexdigest(),'unitConfigurationSha256':configurationHash,'cgroupEvents':(cg/'cgroup.events').read_text(),'processes':[proc(pid)for pid in sorted(ids)],'activity':{'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'invocationId':meta['InvocationID'],'mainPid':int(meta['MainPID']),'metrics':metrics}}))
