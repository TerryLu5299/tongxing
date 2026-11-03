#!/usr/bin/env python3
"""GitHub 新项目 / MCP 插件 → 看点摘要 → 推送同行站 ingest。

用法: python scripts/github/fetch.py [--dry-run]
选料:
  · github-repos  近 30 天新建、星标过线、落在 llm / ai-agents 话题下的项目——看的是"新东西"
  · mcp-servers   活跃维护、星标较高的 MCP 服务端——看的是"能给 Agent 装什么"
摘要: 仓库名 + 描述 + 话题 + 语言 + 星标 → LLM 一句话说明它解决什么问题、适合谁。
版权: 只推名称、链接、摘要和公开元数据，不搬 README。
"""
import json, os, re, sys, time, urllib.parse, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

SEARCH = "https://api.github.com/search/repositories"
INGEST = "http://127.0.0.1:3001/api/ingest/items"
MAX_PER_SOURCE = 6
DRY = "--dry-run" in sys.argv

# (sourceId, sourceName, 查询串, 该源一次最多推几条)
JOBS = [
    ("github-repos", "GitHub 新项目",
     "created:>{d30} stars:>=200 topic:llm", 6),
    ("github-repos", "GitHub 新项目",
     "created:>{d30} stars:>=150 topic:ai-agents", 4),
    ("mcp-servers", "Agent 插件（MCP）",
     "mcp in:name stars:>=200 pushed:>{d14}", 6),
]

BLACKLIST = ("aihot",)   # fork 上游与同名前身，别推到本站

AI_TERMS = ("llm", "model", "agent", "ai", "mcp", "rag", "embedding", "inference",
            "prompt", "finetune", "fine-tune", "transformer", "gpt", "diffusion")


def _load_env():
    env = {}
    try:
        for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


ENV = _load_env()
LLM_URL = ((ENV.get("LLM_BASE_URL") or "https://api.deepseek.com/v1").rstrip("/") + "/chat/completions")
LLM_KEY = ENV.get("LLM_API_KEY", "")
LLM_MODEL = ENV.get("LLM_MODEL", "deepseek-chat")
GITHUB_TOKEN = ENV.get("GITHUB_TOKEN", "")


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def gh_get(url, tries=2):
    """未认证搜索每分钟只给 10 次，撞到 403 就等一下再来，别把整轮丢掉。"""
    h = {"Accept": "application/vnd.github+json", "User-Agent": "tongxing-site"}
    if GITHUB_TOKEN:
        h["Authorization"] = "Bearer " + GITHUB_TOKEN
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) and i + 1 < tries:
                log(f"  限流（{e.code}），等 30 秒重试")
                time.sleep(30)
                continue
            raise


def llm(payload, timeout=60):
    req = urllib.request.Request(
        LLM_URL, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + LLM_KEY},
        method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def tidy(text):
    if not text:
        return None
    text = text.replace("**", "").replace("`", "")
    text = re.sub(r"^[\s*]*(眯点|看點|观点)：", "看点：", text, flags=re.M)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and ln.strip() not in ("-", "—")]
    out = "\n".join(lines).strip()
    return out[:600] or None


def viewpoint(repo, kind):
    desc = (repo.get("description") or "").strip()
    topics = ", ".join(repo.get("topics") or []) or "无"
    material = (f"仓库：{repo['full_name']}\n"
                f"描述：{desc or '（作者没写描述）'}\n"
                f"话题：{topics}\n"
                f"语言：{repo.get('language') or '未知'}　星标：{repo.get('stargazers_count')}　"
                f"创建：{(repo.get('created_at') or '')[:10]}")
    role = "新的开源项目" if kind == "repo" else "MCP 服务端（给 AI Agent 装的能力插件）"
    prompt = [
        {"role": "system", "content":
         f"你在给一个面向 AI 入门读者的站写{role}卡片。据下面的公开信息，输出两行到四行：\n"
         "第一行『看点：』+一句话说清它是什么、解决什么问题（不超过45字）；\n"
         "随后最多 3 行『- 』开头的要点：适合谁用、有什么特别之处、怎么开始（每行不超过35字）。\n"
         "只用给到的信息，不许编功能、不许编数字、不写客套话，不用任何 Markdown 标记。"},
        {"role": "user", "content": material},
    ]
    try:
        d = llm({"model": LLM_MODEL, "max_tokens": 500, "temperature": 0.25, "messages": prompt})
        return tidy((d["choices"][0]["message"]["content"] or "").strip())
    except Exception as e:
        log(f"  LLM 失败: {e}")
        return None


def ingest(source_id, source_name, items):
    token = ENV.get("INGEST_TOKEN", "")
    if not token:
        log("  .env 缺 INGEST_TOKEN")
        return
    body = json.dumps({"sourceId": source_id, "sourceName": source_name, "items": items}).encode()
    req = urllib.request.Request(INGEST, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            log(f"  ingest({source_id}): {r.read().decode()[:120]}")
    except urllib.error.HTTPError as e:
        log(f"  ingest HTTP {e.code}: {e.read().decode()[:160]}")
    except Exception as e:
        log(f"  ingest 失败: {e}")


def worth(repo):
    if repo.get("archived") or repo.get("disabled"):
        return False
    if any(b in repo.get("full_name", "").lower() for b in BLACKLIST):
        return False
    stars = repo.get("stargazers_count") or 0
    if stars > 400000:          # 明显不正常的数字，宁可不推
        return False
    text = " ".join([(repo.get("description") or ""), " ".join(repo.get("topics") or [])]).lower()
    return any(t in text for t in AI_TERMS)


def collect():
    out = {}
    d30 = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")
    d14 = (datetime.now(timezone.utc) - timedelta(days=14)).strftime("%Y-%m-%d")
    for source_id, source_name, query, cap in JOBS:
        q = query.format(d30=d30, d14=d14)
        url = f"{SEARCH}?q={urllib.parse.quote(q)}&sort=stars&order=desc&per_page=15"
        try:
            d = gh_get(url)
        except Exception as e:
            log(f"  查询失败 [{source_id}]: {e}")
            continue
        picked = []
        for repo in d.get("items") or []:
            if len(picked) >= cap:
                break
            if not worth(repo):
                continue
            picked.append(repo)
        out.setdefault((source_id, source_name), [])
        seen = {r["full_name"] for r in out[(source_id, source_name)]}
        out[(source_id, source_name)] += [r for r in picked if r["full_name"] not in seen]
        log(f"  {source_id} 「{q}」→ 取 {len(picked)} 条")
        time.sleep(2.0)          # 未认证搜索每分钟 10 次，留余量
    return out


def main():
    groups = collect()
    for (source_id, source_name), repos in groups.items():
        if not repos:
            log(f"{source_name}: 本轮无内容")
            continue
        kind = "mcp" if source_id == "mcp-servers" else "repo"
        items, seen = [], set()
        for repo in repos[:MAX_PER_SOURCE]:
            full = repo["full_name"]
            if full in seen:
                continue
            seen.add(full)
            vp = viewpoint(repo, kind)
            if not vp:
                continue
            items.append({
                "title": f"{full}｜{(repo.get('description') or '')[:40]}".rstrip("｜"),
                "url": repo["html_url"],
                "publishedAt": (repo.get("pushed_at") or repo.get("updated_at") or ""),
                "author": (repo.get("owner") or {}).get("login") or full.split("/")[0],
                "excerpt": vp,
                "raw": {"github": {"full_name": full, "stars": repo.get("stargazers_count"),
                                   "language": repo.get("language"),
                                   "topics": (repo.get("topics") or [])[:6],
                                   "created_at": repo.get("created_at")}},
            })
            log(f"  ✓ {full} ★{repo.get('stargazers_count')} → {vp.replace(chr(10), ' ⏎ ')[:100]}")
            time.sleep(0.8)
        if not items:
            log(f"{source_name}: 没有可推的")
            continue
        if DRY:
            log(f"[dry-run] {source_name} 跳过推送 {len(items)} 条")
            continue
        ingest(source_id, source_name, items)


if __name__ == "__main__":
    main()
