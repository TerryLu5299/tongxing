#!/usr/bin/env python3
"""B站抓取 cron 入口：跑 fetch.py 并记录日志。

2026-10-14 变更：LLM 由本地 8082（Strata SC117）切换为 DeepSeek 官方 API，
不再需要"确保本地模型活着 → 拉 bat → 等就绪"这一段，本脚本退化为纯入口 + 日志。
原模型保障逻辑见 git 历史；如需回滚，恢复 fetch.py.bak_local_* 与本文件旧版。
"""
import os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "fetch.log")


def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def main():
    log("running fetch.py ...")
    r = subprocess.run([sys.executable, os.path.join(HERE, "fetch.py")],
                       cwd=os.path.dirname(os.path.dirname(HERE)),
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    tail = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()[-25:]
    for l in tail:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(l + "\n")
    log(f"fetch exit={r.returncode}")
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
