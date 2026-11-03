#!/usr/bin/env python3
"""知乎实测长文 → 同行站 ingest（带正文，分析质量比只有标题的源高一大截）。

用法: python scripts/zhihu/fetch.py [--dry-run]

采集: ego(lite) 搜索 → 逐条进详情页读发布时间、作者和正文开头（已登录，不受登录墙限制）。
为什么值得接: 知乎的长文实测是这类内容里最扎实的——同口径跑分、显存实测、成本账，都是零基础用户缺的。
版权: 只推标题、作者、链接和正文前 700 字做摘要依据，不存全文。
"""
import json, os, re, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

EGO = r"C:\Program Files\Citro Labs\ego lite\Application\0.6.1.13\ego-browser.exe"
COLLECT = os.path.join(HERE, "collect.mjs").replace("\\", "/")
WINDOW_DAYS = 400                   # 实测是常青内容，一年内都收
MAX_ITEMS = 6
INGEST = "http://127.0.0.1:3001/api/ingest/items"
SOURCE_ID = "zhihu-reviews"
SOURCE_NAME = "知乎实测"
DRY = "--dry-run" in sys.argv

AI_TERMS = (
    "AI", "大模型", "模型", "LLM", "GPT", "Claude", "Gemini", "DeepSeek", "Kimi", "Qwen", "GLM",
    "智能体", "Agent", "MCP", "RAG", "提示词", "Prompt", "微调", "推理", "量化", "本地部署",
    "Ollama", "vLLM", "llama", "GPU", "显存", "显卡", "Cursor", "Codex", "Copilot", "开源",
    "文生图", "文生视频", "多模态", "评测", "实测", "跑分", "部署", "算力", "蒸馏", "token",
)


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


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def post(url, payload, timeout=25, headers=None):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def collect():
    if not os.path.exists(EGO):
        log(f"  找不到 ego-browser: {EGO}")
        return []
    # 手动跑（--takeover）时放标记文件把浏览器控制权拿回来；cron 不放，免得跟用户抢浏览器。
    flag = os.path.join(HERE, ".takeover")
    if "--takeover" in sys.argv:
        open(flag, "w").close()
    try:
        p = subprocess.run([EGO, "nodejs", "-e", f"await import('file:///{COLLECT}')"],
                           capture_output=True, timeout=600)
    except subprocess.TimeoutExpired:
        log("  采集超时（600s）")
        return []
    finally:
        if os.path.exists(flag):
            os.remove(flag)
    text = ((p.stdout or b"") + (p.stderr or b"")).decode("utf-8", errors="ignore")
    i, j = text.find("[{"), text.rfind("]")
    if i < 0 or j <= i:
        log(f"  采集输出无法解析: {text[-260:]}")
        return []
    try:
        return json.loads(text[i:j + 1])
    except json.JSONDecodeError as e:
        log(f"  采集 JSON 解析失败: {e}")
        return []


def pub_date(item):
    """发布时间 → datetime；知乎详情页给 datetime 属性或「编辑于 2025-01-01」这类文字。"""
    raw = (item.get("timeText") or "").strip()
    if not raw:
        return None
    m = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", raw)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=timezone.utc)
        except ValueError:
            return None
    m = re.search(r"(\d+)\s*天前", raw)
    if m:
        return datetime.now(timezone.utc) - __import__("datetime").timedelta(days=int(m.group(1)))
    if "小时前" in raw or "分钟前" in raw or "刚刚" in raw:
        return datetime.now(timezone.utc)
    return None


def is_ai(text):
    low = (text or "").lower()
    return any(t.lower() in low for t in AI_TERMS)


def tidy(text):
    if not text:
        return None
    out = text.replace("**", "").replace("`", "").strip()
    bad = ("无法提炼", "暂无法", "没有可提炼", "无实质内容", "未提供任何实测")
    if len(out) < 12 or any(b in out[:60] for b in bad):
        return None
    return out[:600]


def viewpoint(title, body, keyword):
    payload = {
        "model": LLM_MODEL,
        "max_tokens": 400,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content":
             "你在为技术资讯站提炼一条知乎实测长文的看点。读者是想学 AI 但没有基础的人。\n"
             "输出两行：\n"
             "第一行『看点：』+一句话（不超过45字），说清这条写了什么实测、测了什么、结论是什么；\n"
             "第二行『- 』+一句读者能从中拿走的具体东西（不超过32字），例如某个数字、某条结论、某个坑。\n"
             "只许使用给出的正文里出现的事实和数字，没写的不要补；不许写「作者认为值得」「建议关注」这类空话。"
             "不用 Markdown，不用引号。"},
            {"role": "user", "content": f"搜索词：{keyword}\n标题：{title}\n正文开头：{body[:700]}"},
        ],
    }
    try:
        d = post(LLM_URL, payload, timeout=60, headers={"Authorization": "Bearer " + LLM_KEY})
        return tidy((d["choices"][0]["message"]["content"] or "").strip())
    except Exception as e:
        log(f"  LLM 失败: {e}")
        return None


def ingest(items):
    token = ENV.get("INGEST_TOKEN", "")
    if not token:
        log("  .env 缺 INGEST_TOKEN")
        return False
    try:
        d = post(INGEST, {"sourceId": SOURCE_ID, "sourceName": SOURCE_NAME, "items": items},
                 timeout=40, headers={"Authorization": "Bearer " + token})
        log(f"  ingest: {json.dumps(d, ensure_ascii=False)[:160]}")
        return True
    except urllib.error.HTTPError as e:
        log(f"  ingest HTTP {e.code}: {e.read().decode()[:200]}")
        return False
    except Exception as e:
        log(f"  ingest 失败: {e}")
        return False


def main():
    rows = collect()
    log(f"抓到 {len(rows)} 条")
    seen, cand = set(), []
    horizon = datetime.now(timezone.utc).timestamp() - WINDOW_DAYS * 86400
    for it in rows:
        if it.get("error"):
            log(f"  关键词失败: {it.get('keyword')} → {it['error']}")
            continue
        title = (it.get("title") or "").strip()
        href = (it.get("href") or "").strip()
        body = (it.get("body") or "").strip()
        if not title or not href or href in seen or len(title) < 8:
            continue
        seen.add(href)
        if not is_ai(title + " " + body[:200]):
            continue
        if len(body) < 150:
            log(f"  跳过（读不到正文）: {title[:30]}")
            continue
        d = pub_date(it)
        if d is None:
            log(f"  跳过（无发布时间，不敢当新内容推）: {title[:28]}")
            continue
        if d.timestamp() < horizon:
            continue
        cand.append((d, it))

    cand.sort(key=lambda x: x[0], reverse=True)
    log(f"可入选 {len(cand)} 条")

    pushed = []
    for d, it in cand[:MAX_ITEMS]:
        vp = viewpoint(it["title"], it["body"], it.get("keyword") or "")
        if not vp:
            log(f"  跳过（无看点）: {it['title'][:30]}")
            continue
        pushed.append({
            "title": it["title"],
            "url": it["href"],
            "publishedAt": d.isoformat(),
            "author": (it.get("author") or "知乎用户")[:60],
            "excerpt": vp,
            "bodyText": it["body"][:2000],
            "raw": {"zhihu": {"timeText": it.get("timeText"), "keyword": it.get("keyword")}},
        })
        log(f"  ✓ {it.get('author') or '?'} | {it['title'][:32]}\n      → {vp.replace(chr(10), ' ⏎ ')[:110]}")
        time.sleep(0.6)

    if not pushed:
        log("本轮无新内容")
        return
    if DRY:
        log(f"[dry-run] 跳过推送 {len(pushed)} 条")
        return
    for i in range(0, len(pushed), 20):
        ingest(pushed[i:i + 20])


if __name__ == "__main__":
    main()
