# -*- coding: utf-8 -*-
"""把 jiexiang-radio 上传到飞牛 NAS 并构建/部署"""
import os, sys, paramiko

HOST = "192.168.2.14"
USER = "admin"
PWD = "zzh116118"
LOCAL = os.path.dirname(os.path.abspath(__file__))
REMOTE = "/vol1/1000/docker/jiexiang-radio"

FILES = [
    "Dockerfile",
    "docker-compose.yml",
    "package.json",
    "server.js",
    "presets/china-radio.m3u",
    "presets/fm-radio.m3u",
    "presets/qingting-radio.m3u",
    "public/index.html",
    "public/style.css",
    "public/app.js",
    "public/vendor/hls.min.js",
]
import glob as _glob
for _fp in _glob.glob(os.path.join(LOCAL, "presets", "logos", "*")):
    if os.path.isfile(_fp):
        FILES.append("presets/logos/" + os.path.basename(_fp))


def run(c, cmd, timeout=600, show=True):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if show:
        print("$ " + cmd)
        if out.strip():
            print(out.strip())
        if err.strip():
            print("[stderr] " + err.strip()[:2000])
    return code, out, err


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PWD, timeout=20)
    sftp = c.open_sftp()

    def mkdirs(p):
        parts = [x for x in p.split("/") if x]
        cur = ""
        for part in parts:
            cur += "/" + part
            try:
                sftp.stat(cur)
            except IOError:
                sftp.mkdir(cur)

    mkdirs(REMOTE)
    mkdirs(REMOTE + "/public/vendor")
    mkdirs(REMOTE + "/presets")
    mkdirs(REMOTE + "/data")

    for rel in FILES:
        src = os.path.join(LOCAL, rel.replace("/", os.sep))
        dst = REMOTE + "/" + rel
        sftp.put(src, dst)
        print("uploaded", rel, os.path.getsize(src))
    sftp.close()

    print("\n===== 检查 node 基础镜像 =====")
    run(c, "docker images | grep node || echo NO_NODE_IMAGE")

    print("\n===== 开始构建 =====")
    code, out, err = run(c, "cd %s && docker build -t jiexiang-radio:latest . 2>&1 | tail -40" % REMOTE, timeout=900)
    if code != 0:
        print("BUILD FAILED")
        sys.exit(1)

    print("\n===== 启动容器 =====")
    run(c, "docker rm -f jiexiang-radio 2>/dev/null || true")
    run(c,
        "docker run -d --name jiexiang-radio --restart=unless-stopped "
        "-p 8081:8080 "
        "-v %s/data:/data "
        "-e TZ=Asia/Shanghai -e PORT=8080 -e DATA_DIR=/data "
        "jiexiang-radio:latest" % REMOTE)

    import time
    time.sleep(3)
    print("\n===== 容器日志 =====")
    run(c, "docker logs --tail 30 jiexiang-radio")

    print("\n===== /api/health =====")
    run(c, "curl -s http://127.0.0.1:8081/api/health")
    print()
    print("\n===== 首页 =====")
    run(c, "curl -s -o /dev/null -w 'index:%{http_code}\\n' http://127.0.0.1:8081/")

    c.close()


if __name__ == "__main__":
    main()
