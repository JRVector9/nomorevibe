# Sent as reviewed source via SSH; reads its exact target/pinned snapshot from stdin.
import subprocess,json,pathlib,sys,time,hashlib,io,contextlib,os
v=json.load(sys.stdin);expected=v['expected'];service=v['service'];mode=v['mode']
REQUEST_ID=v['requestId']
# Expected snapshot comes ONLY from the operator-reviewed, hash-bound profile.
if service not in ('app-copy-primary-hard-drive-b5fhzd','nomorevibe-text-m3-ebmybu','app-reboot-optical-matrix-3bl2a4','app-hack-optical-monitor-v1ioak') or expected.get('serviceName')!=service or mode not in ('stop','verify-stopped','read-stop-progress','restore','read-restore-progress'):raise ValueError('boundary_action_denied')
PROGRESS_ROOT=pathlib.Path(v['progressRoot'])
if not PROGRESS_ROOT.is_absolute()or '..'in PROGRESS_ROOT.parts:raise ValueError('private_progress_path_required')
for name in ('reader','stoppedReader'):
 if hashlib.sha256(v[name].encode()).hexdigest()!=v.get(name+'Sha256'):raise ValueError('reviewed_source_changed')
if not isinstance(v.get('operationHash'),str) or len(v['operationHash'])!=64 or any(c not in '0123456789abcdef' for c in v['operationHash']):raise ValueError('exact_operation_hash_required')

def run(args,timeout=30):
 r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError('docker_command_failed')
 return r.stdout
def replica_body(meta,version,replicas):
 if meta['Version']['Index']!=version or type(replicas)is not int or replicas not in (0,1):raise ValueError('service_version_or_replica_invalid')
 body=json.loads(json.dumps(meta['Spec']));body['Mode']['Replicated']['Replicas']=replicas;return body
def scale_cas(meta,replicas):
 import http.client,socket,urllib.parse,os
 endpoint=os.environ.get('DOCKER_HOST')
 if not endpoint:endpoint=json.loads(run(['docker','context','inspect','--format','{{json .Endpoints.docker.Host}}']))
 url=urllib.parse.urlparse(endpoint)
 if url.scheme!='unix' or not url.path:raise RuntimeError('verified_unix_engine_required')
 class UnixConnection(http.client.HTTPConnection):
  def connect(self):
   self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(20);self.sock.connect(url.path)
 def call(method,path,body=None):
  c=UnixConnection('localhost',timeout=20)
  try:
   c.request(method,path,body=body,headers={'Content-Type':'application/json'}if body else{});r=c.getresponse();raw=r.read(1024*1024)
   if r.status!=200:raise RuntimeError('engine_service_cas_rejected_or_unknown')
   return json.loads(raw)if raw else{}
  finally:c.close()
 api=call('GET','/version')['ApiVersion'];body=replica_body(meta,meta['Version']['Index'],replicas)
 # Explicit VersionIndex closes the read/CLI-reload race. Original Spec (including env/mounts) is retained in memory.
 call('POST','/v'+api+'/services/'+meta['ID']+'/update?version='+str(meta['Version']['Index'])+'&registryAuthFrom=spec',json.dumps(body,separators=(',',':')).encode())
 return {'httpStatus':200,'expectedVersion':meta['Version']['Index'],'replicas':replicas}
def read():
 old=sys.argv;sys.argv=['readonly',service];buf=io.StringIO()
 try:
  with contextlib.redirect_stdout(buf):exec(compile(v['reader'],'<reviewed-reader>','exec'),{})
 finally:sys.argv=old
 return json.loads(buf.getvalue())
def spec():
 m=json.loads(run(['docker','service','inspect',service]))[0];s=m['Spec'];rep=s['Mode']['Replicated']['Replicas'];n=json.loads(json.dumps(s));n['Mode']['Replicated'].pop('Replicas',None)
 return m,rep,hashlib.sha256(json.dumps(n,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def write_progress(folder,phase,value):
 raw=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
 fd=os.open(folder/(phase+'.safe.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
 d=os.open(folder,os.O_RDONLY)
 try:os.fsync(d)
 finally:os.close(d)
def stopped(waitcode,stopversion):
 scope={'__name__':'reviewed_ingress_reader'}
 exec(compile(v['stoppedReader'],'<reviewed-stopped-reader>','exec'),scope)
 get,boot=scope['engine']()
 deadline=time.monotonic()+30
 while True:
  try:return scope['verify']({'expected':expected,'service':service,'waitExitCode':waitcode,'stoppedServiceVersion':stopversion},get,boot)
  except ValueError as error:
   if str(error)!='ingress_has_active_or_desired_running_task' or time.monotonic()>=deadline:raise
   time.sleep(min(1,max(0,deadline-time.monotonic())))
def restored_readback():
 deadline=time.monotonic()+150;result=None
 while time.monotonic()<deadline:
  ids=run(['docker','ps','--filter','label=com.docker.swarm.service.name='+service,'-q']).split()
  if len(ids)==1:
   c=json.loads(run(['docker','inspect',ids[0]]))[0];health=c['State'].get('Health',{}).get('Status')
   if c['Id']==expected['containers'][0]['id']:raise RuntimeError('old_incarnation_reused')
   if c['Image']!=expected['containers'][0]['imageId']:raise RuntimeError('restore_image_drift')
   if c['State']['Running']and (health=='healthy'if service in ('app-copy-primary-hard-drive-b5fhzd','nomorevibe-text-m3-ebmybu')else True):
    if service not in ('app-copy-primary-hard-drive-b5fhzd','nomorevibe-text-m3-ebmybu'):
     probe="import urllib.request,json;z=urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=5);d=json.load(z);print(json.dumps({'status':z.status,'ok':d.get('status')in('ok','healthy')}))"
     response=subprocess.run(['docker','exec',c['Id'],'python','-c',probe],capture_output=True,text=True,timeout=8)
     try:ok=response.returncode==0 and json.loads(response.stdout)['status']==200 and json.loads(response.stdout)['ok']
     except Exception:ok=False
     if not ok:time.sleep(2);continue
    m2,rep2,h2=spec()
    if m2['ID']!=expected['serviceId']or rep2!=expected['replicas']or h2!=expected['serviceSpecSansReplicaSha256']:raise RuntimeError('restore_final_spec_drift')
    fresh=read();check_docker_before(fresh,fresh)
    if fresh['serviceId']!=expected['serviceId']or fresh['serviceVersion']!=m2['Version']['Index']or fresh['replicas']!=expected['replicas']or fresh['serviceSpecSansReplicaSha256']!=expected['serviceSpecSansReplicaSha256']or fresh['containers'][0]['id']!=c['Id']or fresh['containers'][0]['imageId']!=c['Image']or fresh['containers'][0].get('running')is not True or(service in ('app-copy-primary-hard-drive-b5fhzd','nomorevibe-text-m3-ebmybu')and fresh['containers'][0].get('health')!='healthy'):raise RuntimeError('restore_final_identity_or_spec_drift')
    if fresh['hostBootId']!=expected['hostBootId']:raise RuntimeError('restore_host_boot_changed')
    result={'verified':True,'restoredIdentity':fresh,'newIncarnation':c['Id'],'imageId':c['Image'],'startedAt':c['State']['StartedAt'],'running':True,'health':health,'serviceVersion':m2['Version']['Index'],'specUnchanged':True};break
  time.sleep(2)
 if result is None:raise RuntimeError('restore_readback_not_ready_unknown_no_retry')
 return result
progress=None
if mode in ('stop','restore'):
 progress_root=PROGRESS_ROOT;progress_root.mkdir(mode=0o700,exist_ok=True)
 st=progress_root.lstat()
 if not progress_root.is_dir()or progress_root.is_symlink()or st.st_uid!=os.geteuid()or st.st_mode&0o777!=0o700:raise RuntimeError('private_progress_directory_required')
 key={'requestId':REQUEST_ID,'operationHash':v['operationHash'],'service':service,'oldCid':expected['containers'][0]['id'],'serviceVersion':expected['serviceVersion'],'mode':mode}
 progress=progress_root/hashlib.sha256(json.dumps(key,sort_keys=True).encode()).hexdigest();progress.mkdir(mode=0o700,exist_ok=False)
 fd=os.open(progress_root,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)
 write_progress(progress,'started',dict(key,retryCount=0))
if mode=='stop':
 live=read();check_docker_before(expected,live);old=expected['containers'][0]
 # Subscribe before scaling so a fast Swarm container removal cannot lose its exit acknowledgement.
 waiter=subprocess.Popen(['docker','wait',old['id']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 meta,rep,h=spec()
 if meta['ID']!=expected['serviceId'] or meta['Version']['Index']!=expected['serviceVersion'] or rep!=1 or h!=expected['serviceSpecSansReplicaSha256']:raise RuntimeError('identity_version_or_spec_changed_before_cas')
 changed=scale_cas(meta,0) # Exactly one versioned Engine mutation.
 write_progress(progress,'scale-ack',changed)
 stopped_meta,stopped_rep,stopped_hash=spec()
 if stopped_meta['ID']!=expected['serviceId']or stopped_rep!=0 or stopped_hash!=expected['serviceSpecSansReplicaSha256']:raise RuntimeError('post_scale_service_drift')
 stopped_version=stopped_meta['Version']['Index']
 write_progress(progress,'service-readback',{'serviceId':stopped_meta['ID'],'stoppedServiceVersion':stopped_version,'replicas':stopped_rep,'specSansReplicaSha256':stopped_hash})
 out,err=waiter.communicate(timeout=75)
 if waiter.returncode or err or not out.strip().isdigit():raise RuntimeError('old_container_wait_exit_unknown')
 write_progress(progress,'wait-ack',{'oldContainerId':old['id'],'dockerWaitReturnCode':waiter.returncode,'waitExitCode':int(out.strip()),'stoppedServiceVersion':stopped_version,'stderrEmpty':True})
 d=stopped(int(out.strip()),stopped_version);d['verified']=True;d['progressDirectory']=str(progress);write_progress(progress,'verified',d);print(json.dumps(d))
elif mode=='verify-stopped':
 d=stopped(v['waitExitCode'],v['stoppedServiceVersion']);d['verified']=True;print(json.dumps(d))
elif mode=='read-stop-progress':
 root=PROGRESS_ROOT
 st=root.lstat()
 if root.is_symlink()or not root.is_dir()or st.st_uid!=os.geteuid()or st.st_mode&0o777!=0o700:raise ValueError('private_progress_directory_required')
 key={'requestId':REQUEST_ID,'operationHash':v['operationHash'],'service':service,'oldCid':expected['containers'][0]['id'],'serviceVersion':expected['serviceVersion'],'mode':'stop'}
 folder=root/hashlib.sha256(json.dumps(key,sort_keys=True).encode()).hexdigest()
 st=folder.lstat()
 if folder.is_symlink()or not folder.is_dir()or st.st_uid!=os.geteuid()or st.st_mode&0o777!=0o700:raise ValueError('private_progress_directory_required')
 records={};hashes={}
 for phase in ('started','scale-ack','service-readback','wait-ack'):
  file=folder/(phase+'.safe.json');st=file.lstat()
  if file.is_symlink()or not file.is_file()or st.st_uid!=os.geteuid()or st.st_mode&0o777!=0o600:raise ValueError('private_ack_file_required')
  raw=file.read_bytes();records[phase]=json.loads(raw);hashes[phase]=hashlib.sha256(raw).hexdigest()
 start,scale,service_ack,wait=(records[x]for x in ('started','scale-ack','service-readback','wait-ack'))
 if start!=dict(key,retryCount=0)or scale!={'httpStatus':200,'expectedVersion':expected['serviceVersion'],'replicas':0}or service_ack.get('serviceId')!=expected['serviceId']or service_ack.get('replicas')!=0 or service_ack.get('specSansReplicaSha256')!=expected['serviceSpecSansReplicaSha256']or wait.get('oldContainerId')!=key['oldCid']or wait.get('dockerWaitReturnCode')!=0 or wait.get('stderrEmpty')is not True or wait.get('stoppedServiceVersion')!=service_ack.get('stoppedServiceVersion')or type(wait.get('waitExitCode'))is not int or not 0<=wait['waitExitCode']<=255:raise ValueError('durable_stop_ack_binding_invalid')
 d=stopped(wait['waitExitCode'],wait['stoppedServiceVersion']);d.update(verified=True,recoveredObservation=True,originalFullStopOutcome='failed_or_unknown',progressDirectory=str(folder),durableAcknowledgementHashes=hashes);print(json.dumps(d))
elif mode=='restore':
 m,rep,h=spec()
 if m['ID']!=expected['serviceId']or m['Version']['Index']!=v['stoppedServiceVersion']or rep!=0 or h!=expected['serviceSpecSansReplicaSha256']:raise RuntimeError('restore_service_drift_or_not_stopped')
 if run(['docker','ps','--filter','label=com.docker.swarm.service.name='+service,'-q']).split():raise RuntimeError('restore_has_replacement')
 changed=scale_cas(m,expected['replicas']) # Exactly one versioned Engine mutation; polling below is read only.
 write_progress(progress,'restore-scale-ack',changed)
 result=restored_readback()
 write_progress(progress,'restore-verified',result);print(json.dumps(result))
elif mode=='read-restore-progress':
 root=PROGRESS_ROOT
 def private(path,directory=False):
  st=path.lstat()
  if path.is_symlink()or st.st_uid!=os.geteuid()or st.st_mode&0o777!=(0o700 if directory else 0o600)or(not path.is_dir()if directory else not path.is_file()):raise ValueError('private_progress_directory_required')
 private(root,True)
 key={'requestId':REQUEST_ID,'operationHash':v['operationHash'],'service':service,'oldCid':expected['containers'][0]['id'],'serviceVersion':expected['serviceVersion'],'mode':'restore'}
 folder=root/hashlib.sha256(json.dumps(key,sort_keys=True).encode()).hexdigest();private(folder,True)
 records={};hashes={}
 for phase in ('started','restore-scale-ack'):
  path=folder/(phase+'.safe.json');private(path);raw=path.read_bytes();records[phase]=json.loads(raw);hashes[phase]=hashlib.sha256(raw).hexdigest()
 if records['started']!=dict(key,retryCount=0)or records['restore-scale-ack']!={'httpStatus':200,'expectedVersion':v['stoppedServiceVersion'],'replicas':expected['replicas']}:raise ValueError('durable_restore_ack_binding_invalid')
 m,rep,h=spec()
 if m['ID']!=expected['serviceId']or m['Version']['Index']<=v['stoppedServiceVersion']or rep!=expected['replicas']or h!=expected['serviceSpecSansReplicaSha256']:raise ValueError('restore_current_spec_drift')
 result=restored_readback();result.update(recoveredObservation=True,originalFullRestoreOutcome='failed_or_unknown',progressDirectory=str(folder),durableAcknowledgementHashes=hashes);print(json.dumps(result))
else:raise ValueError('unsupported_action')
