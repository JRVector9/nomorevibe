"""Exact Supa operation; inert on import. The coordinator pins this source and the reader."""
import contextlib,datetime,hashlib,io,json,os,pathlib,re,subprocess,sys,time,urllib.request
REQUEST=None
BOOT=None
INVOCATION=None
OLD_PID=None
def sha(v):return hashlib.sha256(v).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def private(path,directory=False):
    st=path.lstat()
    if path.is_symlink()or st.st_uid!=os.geteuid()or st.st_mode&0o777!=(0o700 if directory else 0o600)or (not path.is_dir()if directory else not path.is_file()):raise ValueError('private_progress_required')
def write(folder,name,value):
    fd=os.open(folder/(name+'.safe.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb')as f:f.write(canonical(value)+b'\n');f.flush();os.fsync(f.fileno())
    fd=os.open(folder,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)
def validate_expected(e):
    m=e['unitProperties']
    if not re.fullmatch('[a-f0-9]{64}',e['unitConfigurationSha256'])or e['hostBootId']!=BOOT or e.get('unit')!='vllm.service'or int(m['MainPID'])!=OLD_PID or OLD_PID<=1 or m['InvocationID']!=INVOCATION or m['KillMode']!='control-group'or m['Restart']!='on-failure'or m['ControlGroup']!='/system.slice/vllm.service':raise ValueError('pinned_systemd_identity_required')
    main=[p for p in e['processes']if p['pid']==OLD_PID]
    if len(main)!=1 or not isinstance(main[0]['startTicks'],int)or main[0]['startTicks']<=0 or not re.fullmatch(r'pid:\[[1-9][0-9]*\]',main[0]['pidNamespace']):raise ValueError('pinned_systemd_process_required')
def before(expected,live):
    if any(live[k]!=expected[k]for k in ['hostBootId','unitFileSha256','unitConfigurationSha256','unitProperties','processes']):raise ValueError('original_supa_identity_changed')
def empty(d):
    if d.get('activeState')!='inactive'or d.get('mainPid')!=0 or d.get('populated')is not False or d.get('pids')!=[]or d.get('oldIdentitiesAbsent')is not True or d.get('unitUnchanged')is not True or d.get('hostBootId')!=BOOT:raise ValueError('supa_full_cgroup_exit_unproved')
def zero(v,e):
    if v.get('bootId')!=e['hostBootId']or v.get('invocationId')!=e['unitProperties']['InvocationID']or v.get('mainPid')!=int(e['unitProperties']['MainPID']):raise ValueError('native_metrics_identity_changed')
    found={}
    for line in v.get('metrics','').splitlines():
        if line.startswith(('vllm:num_requests_running{','vllm:num_requests_waiting{')):
            match=re.fullmatch(r'vllm:num_requests_(running|waiting)\{([^}]+)\} ([0-9]+(?:\.[0-9]+)?)',line)
            if not match or 'model_name="local-llm"'not in match[2]or 'engine="0"'not in match[2]or match[1]in found or float(match[3])!=0:raise ValueError('shared_supa_busy_or_unknown')
            found[match[1]]=0
    if set(found)!={'running','waiting'}:raise ValueError('complete_supa_metrics_required')
def restored(value,e):
    x=value['restoredIdentity'];m=x['unitProperties']
    if value.get('healthStatus')!=200 or x['hostBootId']!=e['hostBootId']or x['unitFileSha256']!=e['unitFileSha256']or x['unitConfigurationSha256']!=e['unitConfigurationSha256']or m['ActiveState']!='active'or int(m['MainPID'])<=1 or m['InvocationID']==e['unitProperties']['InvocationID']:raise ValueError('supa_restore_config_or_identity_changed')
def operate(v,backend,root,sleep=time.sleep):
    global REQUEST,BOOT,INVOCATION,OLD_PID
    e=v['expected'];mode=v['mode']
    REQUEST=v['requestId'];BOOT=e['hostBootId'];INVOCATION=e['unitProperties']['InvocationID'];OLD_PID=int(e['unitProperties']['MainPID'])
    if v.get('requestId')!=REQUEST or v.get('service')!='vllm.service'or mode not in ('stop','read-stop-progress','verify-stopped','restore','read-restore-progress')or not re.fullmatch('[a-f0-9]{64}',v.get('operationHash','')):raise ValueError('exact_d435_supa_only')
    if sha(v['reader'].encode())!=v.get('readerSha256'):raise ValueError('pinned_supa_reader_changed')
    validate_expected(e)
    if mode=='verify-stopped':
        d=backend.wait_stopped();empty(d);d['verified']=True;return d
    phase='restore'if mode in ('restore','read-restore-progress')else'stop'
    key={'requestId':REQUEST,'operationHash':v['operationHash'],'unit':'vllm.service','oldInvocation':INVOCATION,'oldPid':OLD_PID,'configurationHash':e['unitConfigurationSha256'],'mode':phase}
    root.mkdir(mode=0o700,exist_ok=True);private(root,True);folder=root/sha(canonical(key))
    ack={'accepted':True,'unit':'vllm.service','oldInvocation':INVOCATION,'oldPid':OLD_PID,'configurationHash':e['unitConfigurationSha256'],'returncode':0}
    if mode.startswith('read-'):
        private(folder,True);files={}
        for name in ('started','stop-ack'if phase=='stop'else'start-ack'):
            f=folder/(name+'.safe.json');private(f);files[name]=json.loads(f.read_bytes())
        if files['started']!=dict(key,retryCount=0)or files['stop-ack'if phase=='stop'else'start-ack']!=ack:raise ValueError('durable_supa_ack_binding_invalid')
        d=backend.wait_stopped()if phase=='stop'else backend.wait_ready()
        empty(d)if phase=='stop'else restored(d,e)
        return dict(d,verified=True,recoveredObservation=True,progressDirectory=str(folder),originalFullOutcome='failed_or_unknown',durableAckHash=sha((folder/('stop-ack.safe.json'if phase=='stop'else'start-ack.safe.json')).read_bytes()))
    folder.mkdir(mode=0o700,exist_ok=False)
    fd=os.open(root,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)
    write(folder,'started',dict(key,retryCount=0))
    if mode=='stop':
        before(e,backend.read())
        samples=[]
        for n in range(2):
            if n:sleep(1)
            value=backend.activity();zero(value,e);samples.append(value)
        write(folder,'zero-activity',{'samples':samples,'nativeModelCalls':0})
        before(e,backend.read())
        backend.stop() # One manual stop; systemd has no atomic process-version CAS. Exact identity is re-read immediately before dispatch.
        write(folder,'stop-ack',ack)
        d=backend.wait_stopped();empty(d)
    else:
        empty(backend.wait_stopped());backend.start();write(folder,'start-ack',ack)
        d=backend.wait_ready();restored(d,e)
    result=dict(d,verified=True,progressDirectory=str(folder));write(folder,'verified',result);return result
class NativeBackend:
    def __init__(self,v):self.v=v;self.expected=v['expected']
    def run(self,args,timeout=20):
        r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
        if r.returncode:raise ValueError('systemd_or_read_command_failed')
        return r.stdout
    def read(self):
        buf=io.StringIO()
        with contextlib.redirect_stdout(buf):exec(compile(self.v['reader'],'<pinned-supa-reader>','exec'),{})
        return json.loads(buf.getvalue())
    def show(self):
        keys=['MainPID','ActiveState','SubState','ExecMainStartTimestamp','ControlGroup','KillMode','KillSignal','TimeoutStopUSec','Restart','FragmentPath','InvocationID']
        return dict(x.split('=',1)for x in self.run(['systemctl','show','vllm.service',*[a for k in keys for a in ['-p',k]]]).splitlines()if'='in x)
    def config(self):
        unit=self.run(['systemctl','cat','vllm.service']);settings=self.run(['systemctl','show','vllm.service','-p','Environment','-p','EnvironmentFiles','-p','WorkingDirectory','-p','User','-p','Group'])
        if self.run(['systemctl','show','vllm.service','-p','EnvironmentFiles','--value']).strip():raise ValueError('external_environment_file_not_supported')
        return sha((unit+'\n'+settings).encode())
    def activity(self):
        a=self.show()
        with urllib.request.urlopen('http://127.0.0.1:8000/metrics',timeout=5)as r:raw=r.read(2*1024*1024+1)
        if len(raw)>2*1024*1024:raise ValueError('metrics_too_large')
        b=self.show()
        if a!=b:raise ValueError('native_changed_during_metrics')
        return {'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'invocationId':a['InvocationID'],'mainPid':int(a['MainPID']),'metrics':raw.decode(),'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    def stop(self):
        if os.geteuid()!=0:raise ValueError('human_on_device_sudo_stop_restore_required')
        self.run(['systemctl','stop','--no-block','vllm.service'])
    def start(self):
        if os.geteuid()!=0:raise ValueError('human_on_device_sudo_stop_restore_required')
        self.run(['systemctl','start','--no-block','vllm.service'])
    def stopped(self):
        e=self.expected;m=self.show();
        if not pathlib.Path('/sys/fs/cgroup/cgroup.controllers').is_file():raise ValueError('cgroup_v2_required')
        cg=pathlib.Path('/sys/fs/cgroup')/e['unitProperties']['ControlGroup'].lstrip('/');ids=set();events=''
        if cg.exists():
            for f in [cg/'cgroup.procs',*cg.rglob('cgroup.procs')]:
                try:ids.update(int(x)for x in f.read_text().split())
                except FileNotFoundError:pass
            events=(cg/'cgroup.events').read_text();match=re.search(r'^populated ([01])$',events,re.M)
            if not match:raise ValueError('cgroup_population_unobserved')
            populated=match[1]=='1'
        else:populated=False
        absent=True
        for old in e['processes']:
            try:
                raw=(pathlib.Path('/proc')/str(old['pid'])/'stat').read_text()
                if int(raw[raw.rfind(')')+2:].split()[19])==old['startTicks']:absent=False
            except FileNotFoundError:pass
        return {'activeState':m['ActiveState'],'mainPid':int(m['MainPID']),'populated':populated,'pids':sorted(ids),'oldIdentitiesAbsent':absent,'unitUnchanged':sha(pathlib.Path(m['FragmentPath']).read_bytes())==e['unitFileSha256']and self.config()==e['unitConfigurationSha256'],'hostBootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'invocationId':m['InvocationID'],'cgroupEvents':events}
    def wait_stopped(self):
        deadline=time.monotonic()+110
        while True:
            d=self.stopped()
            try:empty(d);return d
            except ValueError:
                if time.monotonic()>=deadline:raise ValueError('supa_exit_unknown_no_retry')
                time.sleep(1)
    def wait_ready(self):
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            m=self.show()
            if m['ActiveState']=='active'and int(m['MainPID'])>1 and m['InvocationID']!=INVOCATION:
                health_started=time.monotonic_ns()
                try:
                    with urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=5)as r:healthy=r.status==200
                except Exception:healthy=False
                health_finished=time.monotonic_ns()
                if healthy:
                    fresh=self.read();after=self.show();identity_finished=time.monotonic_ns();props=fresh['unitProperties'];activity=fresh.get('activity',{})
                    if props!=m or after!=m or fresh['hostBootId']!=self.expected['hostBootId']or activity.get('bootId')!=fresh['hostBootId']or activity.get('invocationId')!=m['InvocationID']or activity.get('mainPid')!=int(m['MainPID']):raise ValueError('supa_readiness_identity_race')
                    if not 0<=health_finished-health_started<=10_000_000_000 or not health_finished<=identity_finished<=health_started+30_000_000_000:raise ValueError('supa_readiness_observation_bounds')
                    return {'healthStatus':200,'restoredIdentity':fresh,'newIncarnation':m['InvocationID'],'mainPid':int(m['MainPID']),'activeState':'active','healthObservation':{'startedMonotonicNs':health_started,'finishedMonotonicNs':health_finished,'identityFinishedMonotonicNs':identity_finished,'invocationId':m['InvocationID'],'mainPid':int(m['MainPID']),'hostBootId':fresh['hostBootId']}}
            time.sleep(2)
        raise ValueError('supa_restore_unknown_no_retry')
if __name__=='__main__':
    v=json.load(sys.stdin);root=pathlib.Path(v['progressRoot'])
    if not root.is_absolute()or '..'in root.parts:raise ValueError('private_progress_path_required')
    print(json.dumps(operate(v,NativeBackend(v),root)))
