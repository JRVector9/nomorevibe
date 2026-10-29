import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { providerBoundaryPlanSchema, providerBoundaryReceiptSchema, validateProviderBoundary } from "@/lib/llm/provider-boundary-contract";
import { boundaryFixture } from "./fixtures/provider-boundary-release";

it("정식 Python coordinator의 prepare→plan→stop→V1 영수증→역순 복원 변환을 실제 schema로 검증한다", () => {
  const parent = mkdtempSync(join(process.cwd(), ".ops-runner-adapter-")), id = "ad2b84de-4ddf-4b2e-9dbd-605c64f7d728";
  const dir = join(parent, id); mkdirSync(dir, { mode: 0o700 });
  try {
    const script = String.raw`
import ast,datetime,hashlib,importlib.util,json,pathlib,sys,types
input=json.load(sys.stdin);plan=input['fixture']['plan'];root=pathlib.Path(input['directory'])
p=pathlib.Path('scripts/ops/admin-models-boundary-adapter.py')
spec=importlib.util.spec_from_file_location('adapter_test',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
# Filesystem ownership is a separate test. This fixture exercises transformations, with ALL remote calls replaced below.
m.private=lambda p,directory=False:pathlib.Path(p)
targets=[];services=['app-copy-primary-hard-drive-b5fhzd','app-reboot-optical-matrix-3bl2a4','app-hack-optical-monitor-v1ioak']
for index,identity in enumerate([plan['owner'],*plan['gateways']]):
 identity.update(service=services[index],cgroup='cgroup:[4]:/scope')
 expected={'serviceId':'service'+str(index),'serviceName':services[index],'serviceVersion':1,'serviceSpecSansReplicaSha256':'f'*64,'replicas':1,'hostBootId':identity['hostBootId'],
 'tasks':[{'ID':'task'+str(index),'DesiredState':'Running','CurrentState':'Running'}],
 'containers':[{'id':identity['incarnationId'],'imageId':'image','startedAt':identity['startedAt'],'hostPid':identity['pid'],'sourceFileHashes':{},'privileged':False,'pidMode':'','taskId':'task'+str(index),
 'inside':{'pid1':{'pid':1,'ppid':0,'startTicks':12345,'pidNamespace':'pid:[4026531836]'},'selfPidNamespace':'pid:[4026531836]','cgroupNamespace':'cgroup:[4]','cgroupRelativePath':'/scope',
 'processes':[{'pid':2,'pidNamespace':'pid:[4026531836]','owner':plan['request']['owner']}]}}]}
 targets.append({'key':'target'+str(index),'role':'owner'if index==0 else'gateway','kind':'container','host':'fixture@'+identity['host'],'identity':identity,'expected':expected,'progressRoot':'/private/fixture'})
i=plan['provider'];i.update(service='vllm.service',serviceRevision='a'*64,cgroup='/system.slice/vllm.service')
expected={'operatorUid':0,'unit':'vllm.service','unitFileSha256':'b'*64,'unitConfigurationSha256':'a'*64,'hostBootId':i['hostBootId'],
 'unitProperties':{'ControlGroup':'/system.slice/vllm.service','MainPID':'100','InvocationID':i['incarnationId'],'ExecMainStartTimestamp':'Sat 2026-10-24 16:00:00 UTC'},
 'processes':[{'pid':100,'startTicks':12345,'pidNamespace':'pid:[4026531836]'}]}
targets.append({'key':'provider','role':'provider','kind':'systemd','host':'fixture@supa','identity':i,'expected':expected,'progressRoot':'/private/fixture'})
manifest={'version':1,'id':input['id'],'action':'request-release','targetId':plan['request']['requestId'],'requiresSudo':False,'stateDirectory':str(root),'targets':targets,
 'sourceHashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest()for p in pathlib.Path('scripts/ops/admin_models_helpers').glob('*.py')}}
raw=json.dumps(manifest).encode();file=root/'manifest.json';file.write_bytes(raw)
envelope={'id':input['id'],'action':'request-release','targetId':plan['request']['requestId'],'material':{'path':str(file),'sha256':hashlib.sha256(raw).hexdigest()},'context':{'original':dict(plan['control'],mode='open'),'request':plan['request']}}
mutations=[];fail_restore=True
def fake_run(args,**options):
 global fail_restore
 tree=ast.parse(options['input']);data=None;argv=None
 for node in tree.body:
  if isinstance(node,ast.Assign)and isinstance(node.targets[0],ast.Attribute)and isinstance(node.targets[0].value,ast.Name)and node.targets[0].value.id=='sys':
   if node.targets[0].attr=='stdin':data=json.loads(ast.literal_eval(node.value.args[0].args[0]))
   if node.targets[0].attr=='argv':argv=ast.literal_eval(node.value)
 if not data:
  value=next(t['expected']for t in targets if t['host']==args[5]and(t['kind']=='systemd'or t['expected']['serviceName']==argv[1]))
 else:
  if data['mode']in('stop','restore'):mutations.append((data['service'],data['mode']))
  if data['mode']=='restore'and data['service']==services[1]and fail_restore:
   fail_restore=False;raise TimeoutError('synthetic_lost_ack')
  if data['mode']=='read-restore-progress'and data['service']!='vllm.service':assert data['stoppedServiceVersion']==2

  value={'verified':True,'pidMode':'','status':'exited','waitExitCode':0,'serviceVersion':3 if data.get('mode')=='restore'else 2}
 return types.SimpleNamespace(returncode=0,stderr='',stdout=json.dumps(value))
m.subprocess.run=fake_run
assert m.main('prepare',envelope)['ok']
envelope['context']['drained']=plan['control']
assert m.main('plan',envelope)['ok']
assert m.main('stop',envelope)['ok']
assert m.main('resume-stop',envelope)['ok']
receipt=m.main('verify-stop',envelope)
try:m.main('restore',envelope)
except TimeoutError:pass
else:raise AssertionError('fixture did not lose restore ACK')
assert m.main('resume-restore',envelope)['ok']
assert m.main('verify-restored',envelope)['ok']
assert [mode for _,mode in mutations]==['stop']*4+['restore']*4,mutations
assert [service for service,mode in mutations if mode=='restore']==list(reversed([t['expected'].get('serviceName','vllm.service')for t in targets]))
print(json.dumps(receipt))
`;
    // Script and JSON use separate file descriptors: no shell interpolation or actual SSH/device/DB traffic.
    const result = JSON.parse(execFileSync("/usr/bin/python3", ["-I", "-B", "-c", script], { encoding: "utf8",
      input: JSON.stringify({ fixture: boundaryFixture(), id, directory: dir }) }));
    const plan = providerBoundaryPlanSchema.parse(result.plan), receipt = providerBoundaryReceiptSchema.parse(result.receipt);
    expect(validateProviderBoundary(plan, receipt, new Date().toISOString())).toBe(true);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
