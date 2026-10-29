import json,re,hashlib
def check_docker_before(expected,live):
 for k in ['serviceId','serviceVersion','serviceSpecSansReplicaSha256','replicas','hostBootId']:
  if expected[k]!=live[k]:raise ValueError('docker_identity_or_spec_changed:'+k)
 if live['replicas']!=1 or len(live['containers'])!=1:raise ValueError('unexpected_replica_or_container_count')
 tasks=[t for t in live['tasks']if t['DesiredState']=='Running'or t['CurrentState'].startswith('Running')]
 if len(tasks)!=1 or tasks[0]['ID']!=live['containers'][0]['taskId']:raise ValueError('unaccounted_swarm_task')
 a,b=expected['containers'][0],live['containers'][0]
 for k in ['id','imageId','startedAt','hostPid','sourceFileHashes']:
  if a[k]!=b[k]:raise ValueError('old_container_changed:'+k)
 i=b['inside'];j=i['pid1']
 if b['pidMode']not in ('','private')or b['hostPid']<=1 or j['pid']!=1 or j['ppid']!=0 or i['selfPidNamespace']!=j['pidNamespace']:raise ValueError('not_private_pid_namespace')
 if a['inside']['pid1']['startTicks']!=j['startTicks'] or a['inside']['pid1']['pidNamespace']!=j['pidNamespace']:raise ValueError('old_init_changed')
 if b.get('privileged',False):raise ValueError('privileged_container_boundary_not_supported')
 for proc in i.get('processes',[]):
  if proc['pidNamespace']!=j['pidNamespace']:raise ValueError('unexpected_nested_process_namespace')
