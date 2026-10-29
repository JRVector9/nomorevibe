import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("native 실제 helper는 bootout 직후의 미확인을 재확인으로만 풀고 모든 종료 사실을 요구한다", () => {
  const script = String.raw`
import importlib.util,pathlib
p=pathlib.Path('scripts/ops/admin_models_helpers/native_action.py')
spec=importlib.util.spec_from_file_location('native_test',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.MATERIAL_SHA='a'*64
m.check_expected=lambda material,e:None
m.guard_static=lambda material,e,o:None
m.guard_before=lambda material,e,o,disabled=False:None
m.LABEL='fixture'
e={'hostBootId':'boot','knownDescendantPids':[]}
class Fake:
 def __init__(self):self.unloaded=False;self.changes=[]
 def running(self):return {'disabledOverrides':{'fixture':bool(self.changes)}}
 def disabled(self):return {'fixture':True}
 def mutate(self,op):self.changes.append(op);return {'operation':op,'returncode':0}
 def stopped(self,e):return {'disabledOverrides':{'fixture':True},'launchdUnloaded':self.unloaded,'oldPidLibprocESRCH':True,'oldPidKillESRCH':True,'processGroupESRCH':True,'tcpConnectionRefused':True,'groupMembers':[],'replacementPids':[],'listenerPids':[],'descendantsESRCH':{}}
r=Fake();request={'material':{},'expectedIdentity':e}
a=m.perform('stop',request,r)
assert a['state']=='failed' and a['stage']=='verify-stop' and a['errorCode']=='exit_fact_missing_launchdUnloaded',a
assert r.changes==['disable','bootout']
b=m.perform('verify',dict(request,stopped=a),r)
assert b['state']=='failed' and b['errorCode']=='exit_fact_missing_launchdUnloaded'
r.unloaded=True
c=m.perform('verify',dict(request,stopped=a),r)
assert c['state']=='verify_stop_verified' and r.changes==['disable','bootout']
for missing in ['oldPidLibprocESRCH','oldPidKillESRCH','processGroupESRCH','tcpConnectionRefused']:
 facts=r.stopped(e);facts[missing]=False
 try:m.guard_stopped({},e,facts,{'fixture':False})
 except m.GuardError:pass
 else:raise AssertionError('accepted missing '+missing)
print('native helper observed stop/verify success/failure PASS')
`;
  expect(execFileSync("/usr/bin/python3", ["-I", "-B", "-"], { input: script, encoding: "utf8" })).toContain("PASS");
});
it("모든 이동한 Python helper를 컴파일하고 관측 출력은 raw Docker 설정을 노출하지 않는다", () => {
  execFileSync("/usr/bin/python3", ["-I", "-B", "-c", "import ast,pathlib;[ast.parse(p.read_text())for p in [pathlib.Path('scripts/ops/admin-models-boundary-adapter.py'),*pathlib.Path('scripts/ops/admin_models_helpers').glob('*.py')]]"]);
  const source = readFileSync("scripts/ops/admin_models_helpers/docker_reader.py", "utf8");
  expect(source).not.toContain("rawServiceInspect"); expect(source).not.toContain("rawContainerInspect");
  expect(readFileSync("scripts/ops/admin_models_helpers/systemd_action.py", "utf8")).not.toMatch(/\[['"]sudo['"]/);
});
it("웹·maintenance 모듈은 물리 실행기를 import하지 않고 같은 runner 진입점만 사용한다", () => {
  const action = readFileSync("app/(operator)/admin/models/ops-runner-actions.ts", "utf8");
  const job = readFileSync("lib/jobs/model-capacity-reclaim.ts", "utf8");
  expect(action).toContain("submitModelOpsCommand"); expect(action).not.toMatch(/child_process|ops-runner\/operator|ssh/);
  expect(job).toContain("runModelOpsRunner"); expect(job).not.toContain("releaseEvidencedDispatches");
  expect(readFileSync("lib/operations/ops-runner/operator.ts", "utf8")).toContain("runModelOpsRunner({ state:");
});
