#!/bin/bash
# 29877f65 해제 근거: Swarm 서비스·작업·컨테이너 읽기 전용 수집 (m3ultra 또는 9mini).
# 쓰기 0: docker service inspect/ps, docker ps/inspect, docker service ls, docker cp <컨테이너>:<파일> - (표준출력 tar)만 사용한다.
# exec·restart·update·파일 생성 없음. 결과 묶음 JSON은 stdout, 그 SHA-256은 stderr 마지막 줄.
#   xa-ssh m3ultra /bin/bash -s -- --host=m3ultra < collect-docker.sh > bundle-m3ultra.json
#   xa-ssh 9mini   /bin/bash -s -- --host=9mini   < collect-docker.sh > bundle-9mini.json
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"
HOST=""
for arg in "$@"; do
  case "$arg" in
    --host=m3ultra|--host=9mini) HOST="${arg#--host=}" ;;
    *) echo '{"error":"collect_docker_usage","expected":"--host=m3ultra|--host=9mini"}' >&2; exit 2 ;;
  esac
done
[ -n "$HOST" ] || { echo '{"error":"collect_docker_host_required"}' >&2; exit 2; }
command -v docker >/dev/null || { echo '{"error":"docker_cli_missing"}' >&2; exit 2; }
PY=/usr/bin/python3; [ -x "$PY" ] || PY="$(command -v python3)"
"$PY" -I - "$HOST" <<'PY'
import base64, datetime, hashlib, io, json, socket, subprocess, sys, tarfile
host = sys.argv[1]
ROLES = {"m3ultra": [("owner", "nomorevibe-text-m3-ebmybu"), ("gateway-m3", "app-reboot-optical-matrix-3bl2a4")],
         "9mini": [("gateway-mini", "app-hack-optical-monitor-v1ioak")]}[host]
# The reviewed gateway sources (same list as admin_models_helpers/docker_reader.py). Read via `docker cp ... -`, never executed.
GATEWAY_SOURCES = ["/app/app/routers/ollama_proxy.py", "/app/app/models/ollama.py", "/app/app/services/vllm_client.py", "/app/app/services/mlx_concurrency.py"]
def now(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
def run(args, text=True):
    return subprocess.run(args, capture_output=True, text=text, check=True, timeout=30).stdout
def task_rows(name):
    rows = []
    for line in run(["docker", "service", "ps", "--no-trunc", "--format", "{{json .}}", name]).splitlines():
        t = json.loads(line)
        rows.append({k: t.get(k) for k in ("ID", "Name", "Node", "DesiredState", "CurrentState", "Error")})
    return rows
services, warnings = [], []
for role, name in ROLES:
    meta = json.loads(run(["docker", "service", "inspect", name]))[0]
    tasks = task_rows(name)
    ids = run(["docker", "ps", "-q", "--no-trunc", "--filter", "label=com.docker.swarm.service.name=" + name]).split()
    containers = []
    for cid in ids:
        x = json.loads(run(["docker", "inspect", cid]))[0]
        containers.append({"id": x["Id"], "name": x["Name"], "image": x["Image"],
            "taskId": (x["Config"].get("Labels") or {}).get("com.docker.swarm.task.id"),
            "running": x["State"]["Running"], "startedAt": x["State"]["StartedAt"],
            "privileged": x["HostConfig"].get("Privileged", False), "pidMode": x["HostConfig"].get("PidMode", "")})
    spec = meta["Spec"]
    capture = {"serviceId": meta["ID"], "serviceName": name, "replicas": spec.get("Mode", {}).get("Replicated", {}).get("Replicas"),
               "observedAt": now(), "containers": containers, "tasks": tasks}
    if len(containers) != 1: warnings.append(role + ":running_containers=" + str(len(containers)))
    services.append({"role": role, "capture": capture, "serviceVersion": meta["Version"]["Index"],
        "updateState": (meta.get("UpdateStatus") or {}).get("State"),
        "endpointPorts": (meta.get("Endpoint") or {}).get("Ports") or [],
        "networks": [n.get("Target") for n in spec.get("TaskTemplate", {}).get("Networks", []) or []],
        "imageReferenceSha256": hashlib.sha256(spec["TaskTemplate"]["ContainerSpec"]["Image"].encode()).hexdigest()})
service_list = [{k: s.get(k) for k in ("ID", "Name", "Image", "Mode", "Replicas", "Ports")}
                for s in map(json.loads, run(["docker", "service", "ls", "--format", "{{json .}}"]).splitlines())]
bundle = {"kind": "nmv-release-29877f65-docker-bundle", "version": 1, "host": host, "hostname": socket.gethostname(),
          "services": services, "serviceList": service_list, "warnings": warnings}
if host == "m3ultra":
    gateway = next(s for s in services if s["role"] == "gateway-m3")["capture"]["containers"]
    files = []
    if len(gateway) == 1:
        for path in GATEWAY_SOURCES:
            raw = subprocess.run(["docker", "cp", gateway[0]["id"] + ":" + path, "-"], capture_output=True, check=True, timeout=30).stdout
            with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
                member = next(m for m in archive.getmembers() if m.isfile())
                data = archive.extractfile(member).read()
            files.append({"path": path, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "base64": base64.b64encode(data).decode()})
    bundle["gatewaySource"] = {"containerId": gateway[0]["id"] if len(gateway) == 1 else None, "files": files}
bundle["observedAt"] = now()
out = (json.dumps(bundle, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
sys.stdout.buffer.write(out); sys.stdout.flush()
sys.stderr.write(json.dumps({"bundle": "docker", "host": host, "warnings": warnings, "sha256": hashlib.sha256(out).hexdigest()}) + "\n")
PY
