"""Privileged root-reviewed Darwin operation helper. No automatic retry or model POST.
Local wrapper owns exact plan/source hashes, one-shot markers and transport-unknown handling.
JSON/sha binds operator observations; it is not independent physical authority.
"""
import ctypes,datetime,errno,hashlib,json,os,pathlib,plistlib,re,socket,subprocess,sys,urllib.request
DOMAIN='gui/501';LABEL='com.jr.deepseek';SERVICE=DOMAIN+'/'+LABEL
PLIST=pathlib.Path('/Users/jr/Library/LaunchAgents/com.jr.deepseek.plist')
ENTRY='/Users/jr/deepseek-serve/start.sh'
MATERIAL_SHA=None # Bound by the reviewed coordinator manifest, never supplied by the web.
DIAGNOSTIC_SOURCE_SHA='ae4476b17937541b844f4a588f0fb4406eff28fa16f665e3b318cef1b93bff94'
# The following selected functions/class are verbatim from frozen diagnostic-v3.
class ProcBsdInfo(ctypes.Structure):
 _fields_=[(k,ctypes.c_uint32)for k in ['flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','reserved']]+[('comm',ctypes.c_char*16),('name',ctypes.c_char*32)]+[(k,ctypes.c_uint32)for k in ['nfiles','pgid','pjobc','ttydev','ttypgid']]+[('nice',ctypes.c_int32),('start_sec',ctypes.c_uint64),('start_usec',ctypes.c_uint64)]

def utc(value):
 if not isinstance(value,str)or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z',value):raise ValueError('explicit_utc_required')
 return datetime.datetime.fromisoformat(value.replace('Z','+00:00'))

def digest(raw):return hashlib.sha256(raw).hexdigest()

def run(args,allow_empty=False):
 r=subprocess.run(args,capture_output=True,timeout=12)
 if len(r.stdout)>2*1024*1024:raise ValueError('command_output_cap')
 if r.stderr or r.returncode and not(allow_empty and r.returncode==1 and not r.stdout and not r.stderr):raise ValueError('readonly_command_failed')
 return r.stdout.decode('utf-8',errors='strict')

def parse_launch(text):
 fields={'state':'state','pid':'pid','runs':'runs','last exit code':'lastExitCode','last terminating signal':'lastTerminatingSignal'};out={};depth=0
 has_header=any(line.strip()==SERVICE+' = {'for line in text.splitlines())
 for line in text.splitlines():
  if line.strip()=='}':depth-=1;continue
  m=re.fullmatch(r'\s*(state|pid|runs|last exit code|last terminating signal) = ([A-Za-z0-9_-]+)\s*',line)if depth==(1 if has_header else 0)else None
  if m:
   key,value=m.groups()
   if key=='state':out[fields[key]]=value
   elif re.fullmatch(r'\d+',value):out[fields[key]]=int(value)
  if re.search(r'=\s*\{\s*$',line):depth+=1
 if not isinstance(out.get('pid'),int)or out['pid']<=1:raise ValueError('launch_pid_missing')
 return out

def project_plist(raw):
 p=plistlib.loads(raw)
 if p.get('Label')!=LABEL or p.get('ProgramArguments')!=['/bin/bash',ENTRY]or p.get('KeepAlive')is not True:raise ValueError('exact_launchd_identity_changed')
 paths=[]
 for k in ['StandardOutPath','StandardErrorPath']:
  value=p.get(k)
  if not isinstance(value,str)or not pathlib.Path(value).is_absolute()or '\x00'in value:raise ValueError('absolute_log_path_missing')
  paths.append((k,value))
 options={}
 for source,key in [('AbandonProcessGroup','abandonProcessGroup'),('EnablePressuredExit','enablePressuredExit'),('LaunchOnlyOnce','launchOnlyOnce'),('EnableTransactions','enableTransactions')]:
  if source in p and type(p[source])is not bool:raise ValueError('launchd_option_type_changed')
  options[key]=p.get(source,False);options[key+'Explicit']=source in p
 return {'label':LABEL,'domain':DOMAIN,'plistPath':str(PLIST),'plistSha256':digest(raw),'keepAlive':True,'runAtLoad':p.get('RunAtLoad'),'exitTimeOut':p.get('ExitTimeOut'),'exitTimeoutLegacySpelling':p.get('ExitTimeout'),'throttleInterval':p.get('ThrottleInterval'),'processType':p.get('ProcessType'),'entryPath':ENTRY,**options},paths

def parse_ps(text):
 rows={}
 for line in text.splitlines():
  if not line.strip():continue
  if not re.fullmatch(r'\s*\d+\s+\d+\s*',line):raise ValueError('process_table_malformed')
  pid,ppid=map(int,line.split())
  if pid in rows:raise ValueError('process_table_duplicate')
  rows[pid]=ppid
 if len(rows)>32768:raise ValueError('process_table_cap')
 return rows

def descendants(rows,root):
 found=set();front={root}
 while front:
  children={pid for pid,parent in rows.items()if parent in front}
  if root in children or children&found:raise ValueError('process_tree_cycle')
  found|=children;front=children
  if len(found)>128:raise ValueError('descendant_cap_no_complete_claim')
 return sorted(found)

def parse_listener_pids(text):
 values=[];current_pid=None
 for line in text.splitlines():
  if re.fullmatch(r'p[1-9]\d*',line):current_pid=int(line[1:]);values.append(current_pid)
  elif re.fullmatch(r'f\d+',line)and current_pid is not None:continue
  else:raise ValueError('listener_identity_malformed')
 return sorted(set(values))

def process_identity(pid):
 if sys.platform!='darwin':raise ValueError('darwin_required')
 lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
 lib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int];lib.proc_pidinfo.restype=ctypes.c_int
 lib.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32];lib.proc_pidpath.restype=ctypes.c_int
 info=ProcBsdInfo();n=lib.proc_pidinfo(pid,3,0,ctypes.byref(info),ctypes.sizeof(info))
 if n!=ctypes.sizeof(info):return {'pid':pid,'identityReadable':False,'libprocBytes':n,'errno':ctypes.get_errno()}
 if info.pid!=pid or info.start_usec>999999 or info.start_sec==0:raise ValueError('libproc_identity_invalid')
 path=ctypes.create_string_buffer(4096);size=lib.proc_pidpath(pid,path,len(path))
 if size<=0:raise ValueError('executable_path_unreadable')
 cwd=run(['/usr/sbin/lsof','-a','-p',str(pid),'-d','cwd','-Fn'])
 dirs=[v[1:]for v in cwd.splitlines()if v.startswith('n')]
 if len(dirs)!=1 or not pathlib.Path(dirs[0]).is_absolute():raise ValueError('process_cwd_unreadable')
 return {'pid':pid,'identityReadable':True,'parentPid':info.ppid,'processGroupId':info.pgid,'sessionId':os.getsid(pid),'startTimeSeconds':info.start_sec,'startTimeMicroseconds':info.start_usec,'startTimeUnixUs':str(info.start_sec*1000000+info.start_usec),'executable':path.value.decode(),'cwd':dirs[0],'uid':info.uid,'libprocFlavor':'PROC_PIDTBSDINFO','libprocBytes':n}

# End verbatim diagnostic helpers. Operator-specific guards below.
class GuardError(ValueError):pass
def need(ok,code):
 if not ok:raise GuardError(code)
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def canonical_sha(value):return digest(json.dumps(value,sort_keys=True,separators=(',',':')).encode())
def without_target(overrides):
 need(isinstance(overrides,dict)and all(isinstance(k,str)and type(v)is bool for k,v in overrides.items()),'disabled_map_invalid')
 return {k:v for k,v in overrides.items()if k!=LABEL}
def check_material(material):need(canonical_sha(material)==MATERIAL_SHA,'material_hash_changed')
def check_expected(material,e):
 check_material(material);p=material['process'];l=material['launchd']
 fields={'kind':'launchd','hostBootId':material['bootSessionUuid'],'pid':p['pid'],'startSec':str(p['startTimeSeconds']),'startUsec':p['startTimeMicroseconds'],'uid':p['uid'],'ppid':p['parentPid'],'pgid':p['processGroupId'],'sid':p['sessionId'],'domain':DOMAIN,'label':LABEL,'service':SERVICE,'plistSha256':l['plistSha256'],'entrySha256':l['entrySha256'],'topologyProofSha256':material['topologyProofSha256'],'inferenceScope':'in_process_threads_only','knownDescendantPids':material['knownDescendantPids'],'listenerPort':8010}
 need(all(e.get(k)==v and type(e.get(k))is type(v)for k,v in fields.items()),'expected_identity_changed')
 start=datetime.datetime.fromtimestamp(p['startTimeSeconds'],datetime.timezone.utc).replace(microsecond=p['startTimeMicroseconds'])
 need(e.get('startedAt')==start.isoformat(timespec='milliseconds').replace('+00:00','Z')and e['pgid']==e['pid']and e['uid']==501,'expected_native_identity_changed')
 need(all(isinstance(e.get(k),str)and e[k].strip()==e[k]and e[k]for k in ['host','serviceRevision','incarnationId','servingRevision']),'expected_revision_missing')
def guard_static(material,e,o):
 check_expected(material,e)
 need(o.get('bootSessionUuid')==material['bootSessionUuid'],'boot_changed')
 need(o.get('sourceHashes')==material['sources']and o.get('configHashes')==material['configs'],'source_or_config_changed')
 need(o.get('plistSha256')==material['launchd']['plistSha256']and o.get('entrySha256')==material['launchd']['entrySha256'],'launchd_source_changed')
def guard_models(material,o):
 need(o.get('models')==material['expectedModels'],'resident_engine_changed')
 need(o.get('healthStatus')==200,'health_not_200')
 need(all(type(o.get('runtimeStatus',{}).get(k))is int and o['runtimeStatus'][k]==v for k,v in [('models_loaded',2),('models_loading',0)]),'models_not_loaded')
def guard_before(material,e,o,disabled=False):
 guard_static(material,e,o);without_target(o['disabledOverrides'])
 need(o['disabledOverrides'].get(LABEL)is True if disabled else o['disabledOverrides'].get(LABEL)is not True,'preexisting_disabled_or_disable_not_observed')
 need(o.get('process')==material['process'],'old_process_identity_changed')
 need(all(o.get('launchd',{}).get(k)==v for k,v in material['launchd'].items()),'launchd_projection_changed')
 need(o['launchd'].get('pid')==e['pid']and o['launchd'].get('state')=='running'and o['launchd'].get('abandonProcessGroup')is False,'launchd_not_exact_running')
 need(o.get('treeStable')is True and o.get('descendantPids')==e['knownDescendantPids'],'descendant_changed')
 need(o.get('groupMembers')==sorted([e['pid'],*e['knownDescendantPids']]),'foreign_process_group')
 need(o.get('listenerPids')==[e['pid']],'listener_owner_changed');guard_models(material,o)
 need(o['runtimeStatus'].get('active_requests')==0 and o['runtimeStatus'].get('waiting_requests')==0,'shared_native_mlx_busy')
def guard_disabled(before,after,target):
 need(without_target(before)==without_target(after),'other_disabled_override_changed')
 need(after.get(LABEL)is target,'target_disabled_override_not_observed')
def guard_stopped(material,e,o,before):
 guard_static(material,e,o);guard_disabled(before,o['disabledOverrides'],True)
 for k in ['launchdUnloaded','oldPidLibprocESRCH','oldPidKillESRCH','processGroupESRCH','tcpConnectionRefused']:need(o.get(k)is True,'exit_fact_missing_'+k)
 need(o.get('groupMembers')==[]and o.get('replacementPids')==[]and o.get('listenerPids')==[],'process_group_or_listener_not_empty')
 need(o.get('descendantsESRCH')=={str(pid):True for pid in e['knownDescendantPids']},'known_descendant_exit_not_proven')
def guard_restored(material,e,o,before,stopped_at):
 guard_static(material,e,o);guard_disabled(before,o['disabledOverrides'],False);guard_models(material,o)
 p=o.get('process',{});old=material['process'];stop_us=int(utc(stopped_at).timestamp()*1000000)
 need(p.get('identityReadable')is True and type(p.get('pid'))is int and p['pid']!=old['pid']and int(p.get('startTimeUnixUs','0'))>stop_us,'new_process_identity_required')
 for k in ['uid','parentPid','executable','cwd']:need(p.get(k)==old[k],'restored_process_scope_changed')
 need(p.get('processGroupId')==p['pid']and o.get('launchd',{}).get('pid')==p['pid']and o['launchd'].get('state')=='running','new_private_process_group_required')
 need(o.get('treeStable')is True and o.get('descendantPids')==[]and o.get('groupMembers')==[p['pid']]and o.get('listenerPids')==[p['pid']],'restored_process_tree_or_listener_changed')
 need(all(o['launchd'].get(k)==v for k,v in material['launchd'].items()),'restored_launchd_projection_changed')
def parse_disabled(text):
 out={};lines=[x.strip()for x in text.splitlines()if x.strip()]
 need(len(lines)>=2 and lines[0]=='disabled services = {'and lines[-1]=='}','disabled_output_shape')
 for line in lines[1:-1]:
  m=re.fullmatch(r'"([^"\x00-\x1f]+)"\s*=>\s*(true|false|enabled|disabled)',line);need(m is not None,'disabled_output_row')
  need(m[1]not in out,'disabled_duplicate_label');out[m[1]]=m[2]in ('true','disabled')
 return out
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
class System:
 def __init__(self,material):
  need(sys.platform=='darwin'and os.getuid()==501 and not sys.flags.optimize,'exact_darwin_uid_required');check_material(material);self.material=material;self.credentials=None
 def boot(self):return run(['/usr/sbin/sysctl','-n','kern.bootsessionuuid']).strip().lower()
 def safe_file(self,p,cap):
  p=pathlib.Path(p);need(not p.is_symlink()and p.is_file()and all(not q.is_symlink()for q in p.parents),'file_identity_changed')
  with p.open('rb')as f:
   raw=f.read(cap+1);need(len(raw)<=cap,'file_read_cap')
  return raw
 def static(self):
  m=self.material;root=pathlib.Path(m['sourceRoot']);hashes={};total=0
  for rel in m['sources']:
   need(rel.endswith('.py')and '..'not in pathlib.Path(rel).parts and not pathlib.Path(rel).is_absolute(),'source_path_changed')
   raw=self.safe_file(root/rel,1048576);total+=len(raw);need(total<=32*1048576,'source_total_cap');hashes[rel]=digest(raw)
  configs={}
  for name in m['configs']:
   raw=self.safe_file(pathlib.Path('/Users/jr/deepseek-serve/state')/name,2097152);configs[name]=digest(raw)
   if name=='settings.json':self.credentials=json.loads(raw)
  plist=self.safe_file(PLIST,65536);projection,_=project_plist(plist);entry=self.safe_file(ENTRY,65536)
  projection['entrySha256']=digest(entry)
  o={'bootSessionUuid':self.boot(),'sourceHashes':hashes,'configHashes':configs,'plistSha256':digest(plist),'entrySha256':digest(entry)}
  need(hashes==m['sources']and configs==m['configs']and o['plistSha256']==m['launchd']['plistSha256']and o['entrySha256']==m['launchd']['entrySha256'],'fixed_source_or_config_changed')
  return o,projection
 def disabled(self):return parse_disabled(run(['/bin/launchctl','print-disabled',DOMAIN]))
 def json_get(self,path):
  need(self.credentials['server']['port']==8010 and path in ['/health','/api/status','/v1/models/status'],'fixed_get_required')
  req=urllib.request.Request('http://127.0.0.1:8010'+path,headers={'Authorization':'Bearer '+self.credentials['auth']['api_key']})
  with urllib.request.build_opener(NoRedirect()).open(req,timeout=5)as response:
   raw=response.read(1048577);need(response.status==200 and len(raw)<=1048576,'bounded_get_200_required');return json.loads(raw),{'path':path,'status':200,'bodySha256':digest(raw),'bodyBytes':len(raw)}
 def process_table(self):
  raw=run(['/bin/ps','-axo','pid=,ppid=,pgid=,command=']);out=[]
  for line in raw.splitlines():
   if not line.strip():continue
   match=re.fullmatch(r'\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)',line);need(match is not None,'process_table_shape')
   out.append({'pid':int(match[1]),'ppid':int(match[2]),'pgid':int(match[3]),'command':match[4]})
  need(len(out)<=32768 and len({x['pid']for x in out})==len(out),'process_table_cap_or_duplicate');return out
 def listeners(self):return parse_listener_pids(run(['/usr/sbin/lsof','-nP','-a','-iTCP:8010','-sTCP:LISTEN','-Fp'],allow_empty=True))
 def running(self):
  static,projection=self.static();launch=parse_launch(run(['/bin/launchctl','print',SERVICE]));pid=launch['pid'];p=process_identity(pid);table=self.process_table();children=descendants({x['pid']:x['ppid']for x in table},pid)
  listeners=self.listeners();models,mr=self.json_get('/v1/models/status');health,hr=self.json_get('/health');status,sr=self.json_get('/api/status')
  names={x['id']for x in self.material['expectedModels']};keys=list(self.material['expectedModels'][0]);rows=sorted([{k:x.get(k)for k in keys}for x in models['models']if x.get('loaded')is True or x.get('is_loading')is True or x.get('id')in names],key=lambda x:x['id'])
  need(len(rows)==2,'resident_model_count_changed');p_after=process_identity(pid);after=self.process_table();children_after=descendants({x['pid']:x['ppid']for x in after},pid)
  static_after,projection_after=self.static();need(static_after==static and projection_after==projection and p_after==p,'running_observation_changed')
  return {**static,'process':p,'launchd':{**projection,**launch},'disabledOverrides':self.disabled(),'descendantPids':children,'treeStable':children==children_after,'groupMembers':sorted(x['pid']for x in table if x['pgid']==p.get('processGroupId')),'listenerPids':listeners,'models':rows,'healthStatus':hr['status'],'runtimeStatus':{k:status.get(k)for k in ['models_loaded','models_loading','active_requests','waiting_requests']},'httpObservations':[mr,hr,sr]}
 def unloaded(self):
  r=subprocess.run(['/bin/launchctl','print',SERVICE],capture_output=True,timeout=12)
  need(len(r.stdout)+len(r.stderr)<=131072,'launchctl_output_cap')
  # Darwin launchctl distinguishes absent job (113) from missing/foreign domain.
  text=r.stderr.decode('utf8',errors='strict').strip()
  return r.returncode==113 and not r.stdout and re.fullmatch(r'Bad request\.\nCould not find service "'+re.escape(LABEL)+r'" in domain for user gui: 501',text)is not None
 def kill_esrch(self,pid,group=False):
  try:
   (os.killpg if group else os.kill)(pid,0);return False
  except OSError as error:
   need(error.errno==errno.ESRCH,'signal_probe_not_esrch');return True
 def absent(self,pid):
  p=process_identity(pid)
  return p.get('identityReadable')is False and p.get('libprocBytes')==0 and p.get('errno')==errno.ESRCH
 def refused(self):
  try:
   with socket.create_connection(('127.0.0.1',8010),timeout=2):return False
  except OSError as error:
   need(error.errno==errno.ECONNREFUSED,'tcp_not_exact_refused');return True
 def stopped(self,e):
  static,_=self.static();unloaded=self.unloaded();a=self.absent(e['pid']);b=self.kill_esrch(e['pid']);g=self.kill_esrch(e['pgid'],True);table=self.process_table()
  child={str(pid):self.absent(pid)and self.kill_esrch(pid)for pid in e['knownDescendantPids']};listeners=self.listeners();refused=self.refused()
  parents={x['pid']:x['ppid']for x in table};transport=[];cursor=os.getpid()
  while cursor:
   need(cursor in parents and cursor not in transport and len(transport)<128,'operator_transport_ancestry_unreadable');transport.append(cursor);cursor=parents[cursor]
  need(e['pid']not in transport,'provider_is_not_operator_transport')
  replacements=sorted(x['pid']for x in table if x['pid']not in transport and('/Users/jr/deepseek-serve/'in x['command']or re.search(r'(?:^|\s)omlx(?:\.cli|\.server)?(?:\s|$)',x['command'])))
  after,_=self.static();need(after==static,'stopped_source_or_boot_changed')
  return {**static,'disabledOverrides':self.disabled(),'launchdUnloaded':unloaded and self.unloaded(),'oldPidLibprocESRCH':a,'oldPidKillESRCH':b,'processGroupESRCH':g,'groupMembers':sorted(x['pid']for x in table if x['pgid']==e['pgid']),'descendantsESRCH':child,'listenerPids':listeners,'tcpConnectionRefused':refused,'replacementPids':replacements,'operatorTransportAncestorPids':transport}
 def mutate(self,operation):
  args={'disable':['disable',SERVICE],'bootout':['bootout',SERVICE],'enable':['enable',SERVICE],'bootstrap':['bootstrap',DOMAIN,str(PLIST)]}[operation]
  r=subprocess.run(['/bin/launchctl',*args],capture_output=True,timeout=45)
  need(len(r.stdout)+len(r.stderr)<=131072,'mutation_output_cap')
  result={'operation':operation,'returncode':r.returncode,'stdoutSha256':digest(r.stdout),'stderrSha256':digest(r.stderr)}
  need(r.returncode==0 and not r.stderr,'mutation_failed');return result

def perform(action,request,rt):
 material=request['material'];e=request['expectedIdentity'];check_expected(material,e)
 out={'version':1,'action':action,'startedAt':stamp(),'expectedIdentity':e,'materialCanonicalSha256':MATERIAL_SHA,'mutations':[],'mutationAttempts':[],'modelCalls':0,'databaseQueries':0,'sourceWrites':0,'directNonzeroKillSignalsSent':0}
 stage='start';mutation_unknown=False
 def change(operation):
  nonlocal mutation_unknown,stage
  stage=operation;mutation_unknown=True;out['mutationAttempts'].append({'operation':operation,'startedAt':stamp()});value=rt.mutate(operation);mutation_unknown=False;out['mutations'].append(value)
 try:
  if action=='inspect':
   stage='inspect';obs=rt.running();guard_before(material,e,obs);out.update(state='inspect_verified',before=obs,beforeDisabledOverrides=obs['disabledOverrides'])
  elif action=='stop':
   stage='prestop';before=rt.running();guard_before(material,e,before);out['beforeDisabledOverrides']=before['disabledOverrides'];out['before']=before
   change('disable');guard_disabled(out['beforeDisabledOverrides'],rt.disabled(),True)
   stage='post-disable-exact-cas';again=rt.running();guard_before(material,e,again,disabled=True);guard_disabled(out['beforeDisabledOverrides'],again['disabledOverrides'],True)
   change('bootout');stage='verify-stop';obs=rt.stopped(e);out['exitFacts']=obs;guard_stopped(material,e,obs,out['beforeDisabledOverrides']);out['state']='stop_verified'
  elif action in ['verify','restore']:
   receipt=request['stopped']
   verified=receipt.get('state')in ['stop_verified','verify_stop_verified']
   acknowledged=(action=='verify'and receipt.get('action')=='stop'and receipt.get('state')=='failed'and receipt.get('stage')=='verify-stop'and receipt.get('mutationEndState')=='no_unknown_mutation_in_this_helper'and [x.get('operation')for x in receipt.get('mutationAttempts',[])]==['disable','bootout']and [(x.get('operation'),x.get('returncode'))for x in receipt.get('mutations',[])]==[('disable',0),('bootout',0)])
   need((verified or acknowledged)and receipt.get('expectedIdentity')==e and receipt.get('materialCanonicalSha256')==MATERIAL_SHA,'stopped_receipt_required')
   out['priorReceiptCanonicalSha256']=canonical_sha(receipt)
   out['beforeDisabledOverrides']=receipt['beforeDisabledOverrides'];stage='verify-stop';obs=rt.stopped(e);out['exitFacts']=obs;guard_stopped(material,e,obs,out['beforeDisabledOverrides'])
   if action=='verify':out['state']='verify_stop_verified'
   else:
    out['stopVerifiedAt']=stamp();change('enable');guard_disabled(out['beforeDisabledOverrides'],rt.disabled(),False)
    stage='prebootstrap-source-cas';again,_=rt.static();guard_static(material,e,again);need(rt.unloaded(),'job_must_remain_unloaded');guard_disabled(out['beforeDisabledOverrides'],rt.disabled(),False);change('bootstrap');out['state']='restore_started'
    out['overrideTransition']={'before':out['beforeDisabledOverrides'].get(LABEL),'after':False,'note':'launchctl enable records explicit false; it does not remove a previously absent override.'}
  elif action=='verify-restored':
   receipt=request['restoring'];need(receipt.get('state')=='restore_started'and receipt.get('expectedIdentity')==e and receipt.get('materialCanonicalSha256')==MATERIAL_SHA,'restore_receipt_required')
   stage='verify-restored';obs=rt.running();guard_restored(material,e,obs,receipt['beforeDisabledOverrides'],receipt['stopVerifiedAt']);out.update(state='restore_verified',restored=obs)
  else:raise GuardError('action_invalid')
 except Exception as error:
  out.update(state='failed',stage=stage,errorCode=str(error)if isinstance(error,GuardError)else type(error).__name__,mutationEndState='unknown'if mutation_unknown else 'no_unknown_mutation_in_this_helper')
 out['completedAt']=stamp();return out
if __name__=='__main__':
 try:
  raw=sys.stdin.buffer.read(4*1048576+1);need(len(raw)<=4*1048576,'request_read_cap');request=json.loads(raw);action=request['action'];material=request['material'];MATERIAL_SHA=request['materialSha256'];check_material(material)
  value=perform(action,request,System(material));print(json.dumps(value,sort_keys=True));raise SystemExit(0 if value.get('state')!='failed'else 1)
 except Exception as error:
  print(json.dumps({'state':'failed_before_action','errorCode':str(error)if isinstance(error,GuardError)else type(error).__name__,'modelCalls':0,'databaseQueries':0}));raise SystemExit(1)
