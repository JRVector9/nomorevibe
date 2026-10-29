"""Fresh read-only old-ingress observation. Never scales, stops, starts or restores a service."""
import hashlib,http.client,json,os,re,socket,subprocess,sys,time,urllib.parse,uuid
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def verify(payload,get,read_boot):
 expected=payload['expected'];service=payload.get('service',expected['serviceName']);waitcode=payload['waitExitCode'];stopversion=payload['stoppedServiceVersion']
 if service!=expected['serviceName']or len(expected['containers'])!=1 or type(waitcode)is not int or not 0<=waitcode<=255 or type(stopversion)is not int or stopversion<=expected['serviceVersion']:raise ValueError('original_stop_binding_invalid')
 old=expected['containers'][0];init=old['inside']['pid1'];cid=old['id']
 if not re.fullmatch('[a-f0-9]{64}',cid)or old['pidMode']not in('','private')or old.get('privileged',False)or old['hostPid']<=1 or init['pid']!=1 or init['ppid']!=0 or old['inside']['selfPidNamespace']!=init['pidNamespace']:raise ValueError('original_private_namespace_identity_invalid')
 status,meta=get('/services/'+urllib.parse.quote(expected['serviceId'],safe=''))
 if status!=200:raise ValueError('current_service_not_observed')
 spec=meta['Spec'];normal=json.loads(json.dumps(spec));normal['Mode']['Replicated'].pop('Replicas',None)
 if meta['ID']!=expected['serviceId']or spec['Name']!=service or meta['Version']['Index']!=stopversion or spec['Mode']['Replicated']['Replicas']!=0 or digest(normal)!=expected['serviceSpecSansReplicaSha256']:raise ValueError('stopped_service_version_or_spec_changed')
 status,container=get('/containers/'+cid+'/json')
 if status==404:
  if not isinstance(container,dict)or not isinstance(container.get('message'),str):raise ValueError('container_absence_response_invalid')
  state='removed';finished=None;response_hash=digest(container)
 elif status==200:
  if container.get('Id')!=cid or container['State']['Status']!='exited'or container['State']['Running']is not False or container['State']['Pid']!=0 or container['State']['ExitCode']!=waitcode:raise ValueError('old_container_not_exited')
  state='exited';finished=container['State']['FinishedAt'];response_hash=None
 else:raise ValueError('old_container_read_not_authoritative')
 status,running=get('/containers/json?'+urllib.parse.urlencode({'filters':json.dumps({'label':['com.docker.swarm.service.name='+service]},separators=(',',':'))}))
 if status!=200 or not isinstance(running,list)or running:raise ValueError('ingress_has_running_replacement')
 status,tasks=get('/tasks?'+urllib.parse.urlencode({'filters':json.dumps({'service':[expected['serviceId']]},separators=(',',':'))}))
 active={'new','allocated','pending','assigned','accepted','preparing','ready','starting','running'}
 if status!=200 or not isinstance(tasks,list)or any(t['ServiceID']!=expected['serviceId']or t.get('DesiredState')=='running'or t.get('Status',{}).get('State')in active for t in tasks):raise ValueError('ingress_has_active_or_desired_running_task')
 boot,boot_container=read_boot()
 if str(uuid.UUID(boot))!=expected['hostBootId']:raise ValueError('current_host_boot_changed')
 return {'verified':True,'replicas':0,'specUnchanged':True,'running':False,'pid':0,'status':state,'waitExitCode':waitcode,'replacementCount':0,'finishedAt':finished,'serviceVersion':stopversion,'pidMode':old['pidMode'],'proof':'docker_wait_plus_private_namespace_init_exit','hostPidDirectReadAvailable':False,'cgroupDirectReadAvailable':False,'oldContainerId':cid,'oldContainerHttpStatus':404 if state=='removed'else 200,'absenceResponseHash':response_hash,'hostBootId':boot,'hostBootReadContainerId':boot_container,'activeTaskCount':0,'modelCalls':0,'serviceMutations':0,'dockerExecBootReads':getattr(read_boot,'attempts',1)}
def engine():
 endpoint=os.environ.get('DOCKER_HOST')
 if not endpoint:
  r=subprocess.run(['docker','context','inspect','--format','{{json .Endpoints.docker.Host}}'],capture_output=True,text=True,check=True,timeout=15);endpoint=json.loads(r.stdout)
 url=urllib.parse.urlparse(endpoint)
 if url.scheme!='unix'or not url.path:raise ValueError('reviewed_unix_engine_required')
 class Unix(http.client.HTTPConnection):
  def connect(self):
   self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(15);self.sock.connect(url.path)
 def raw(path):
  conn=Unix('localhost',timeout=15)
  try:
   conn.request('GET',path);r=conn.getresponse();body=r.read(2*1024*1024+1)
   if len(body)>2*1024*1024:raise ValueError('engine_response_too_large')
   return r.status,json.loads(body)
  finally:conn.close()
 status,v=raw('/version')
 if status!=200 or not re.fullmatch(r'\d+\.\d+',v.get('ApiVersion','')):raise ValueError('engine_version_unverified')
 get=lambda path:raw('/v'+v['ApiVersion']+path)
 def boot():
  # Every candidate and its exec use the same verified unix Engine, never a default CLI context.
  # A scratch image or a container stopping during rollout may not support cat; that is not host-exit evidence.
  deadline=time.monotonic()+25;boot.attempts=0
  status,rows=get('/containers/json?'+urllib.parse.urlencode({'limit':8,'filters':json.dumps({'status':['running']},separators=(',',':'))}))
  if status!=200 or not isinstance(rows,list)or not rows:raise ValueError('existing_boot_read_container_unavailable')
  seen=set()
  def running_identity(cid):
   status,meta=get('/containers/'+cid+'/json')
   if status==404:return None
   if status!=200 or not isinstance(meta,dict)or meta.get('Id')!=cid:raise ValueError('boot_read_container_identity_invalid')
   state=meta.get('State',{})
   if state.get('Running')is not True or state.get('Status')!='running':return None
   if type(state.get('Pid'))is not int or state['Pid']<=1 or not isinstance(state.get('StartedAt'),str)or not state['StartedAt']or not isinstance(meta.get('Image'),str)or not meta['Image']:raise ValueError('boot_read_container_identity_invalid')
   return (cid,meta['Image'],state['Pid'],state['StartedAt'])
  env=dict(os.environ);env.pop('DOCKER_CONTEXT',None);env.pop('DOCKER_HOST',None)
  for row in rows[:8]:
   if time.monotonic()>=deadline:break
   cid=row.get('Id')if isinstance(row,dict)else None
   if not isinstance(cid,str)or not re.fullmatch('[a-f0-9]{64}',cid)or cid in seen:raise ValueError('boot_read_container_identity_invalid')
   seen.add(cid);before=running_identity(cid)
   if before is None:continue
   remaining=deadline-time.monotonic()
   if remaining<=0:break
   boot.attempts+=1
   try:r=subprocess.run(['docker','--host',endpoint,'exec',cid,'cat','/proc/sys/kernel/random/boot_id'],env=env,capture_output=True,text=True,timeout=min(5,remaining))
   except (subprocess.TimeoutExpired,OSError):continue
   if r.returncode or r.stderr:continue
   value=r.stdout.strip()
   if not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',value):raise ValueError('existing_container_boot_read_invalid')
   if running_identity(cid)!=before:continue
   if time.monotonic()>=deadline:break
   return value,cid
  raise ValueError('existing_container_boot_read_failed')
 return get,boot
if __name__=='__main__':
 payload=json.load(sys.stdin);get,boot=engine();print(json.dumps(verify(payload,get,boot)))
