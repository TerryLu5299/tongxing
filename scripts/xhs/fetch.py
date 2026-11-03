#!/usr/bin/env python3
"""小红书实测笔记 → 看点摘要 → 推送同行站 ingest。

用法: python scripts/xhs/fetch.py [--dry-run]

采集: 借 ego(lite) 浏览器（已登录小红书）搜关键词，读搜索结果卡片。
为什么非它不可: 小红书的搜索页没有公开接口，普通抓取一律被反爬挡掉；ego 用的是已登录的真实浏览器。
选料: 7 天内的笔记 + 标题讲到 AI/模型/工具 + 标题长度够（挡掉「出图」「打卡」这类空标题）。
版权: 只推标题、作者、链接和一句话看点，不存正文。
"""
import json, os, re, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

EGO = r"C:\Program Files\Citro Labs\ego lite\Application\0.6.1.13\ego-browser.exe"
COLLECT = os.path.join(HERE, "collect.mjs").replace("\\", "/")
WINDOW_H = 168                      # 只收一周内的笔记
MAX_ITEMS = 8                       # 单轮最多推几条（每条一次 LLM）
INGEST = "http://127.0.0.1:3001/api/ingest/items"
SOURCE_ID = "xhs-reviews"
SOURCE_NAME = "小红书实测"
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
    """跑 ego-browser 抓搜索结果；ego 会把脚本输出写到 stderr，两边都收。"""
    if not os.path.exists(EGO):
        log(f"  找不到 ego-browser: {EGO}")
        return []
    code = f"await import('file:///{COLLECT}')"
    try:
        p = subprocess.run([EGO, "nodejs", "-e", code], capture_output=True, timeout=420)
    except subprocess.TimeoutExpired:
        log("  采集超时（ego-browser 420s）")
        return []
    raw = (p.stdout or b"") + (p.stderr or b"")
    text = raw.decode("utf-8", errors="ignore")
    i, j = text.find("["), text.rfind("]")
    if i < 0 or j <= i:
        log(f"  采集输出无法解析: {text[-200:]}")
        return []
    try:
        return json.loads(text[i:j + 1])
    except json.JSONDecodeError as e:
        log(f"  采集 JSON 解析失败: {e}")
        return []


def age_hours(text):
    """小红书卡片的时间字样 → 小时数；认不出返回 None。"""
    t = (text or "").strip()
    now = datetime.now()
    if not t:
        return None
    if "刚刚" in t or "分钟前" in t:
        return 0.0
    m = re.search(r"(\d+)\s*小时前", t)
    if m:
        return float(m.group(1))
    if "昨天" in t:
        return 24.0
    m = re.search(r"(\d+)\s*天前", t)
    if m:
        return float(m.group(1)) * 24
    m = re.search(r"(\d{1,2})-(\d{1,2})", t)
    if m:
        try:
            d = datetime(now.year, int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
        delta = (now - d).total_seconds() / 3600
        if delta < -24 * 30:            # 跨年：如 12 月看到 1 月的日期
            d = d.replace(year=now.year - 1)
            delta = (now - d).total_seconds() / 3600
        return delta
    return None


def is_ai(text):
    low = (text or "").lower()
    return any(t.lower() in low for t in AI_TERMS)


def tidy(text):
    if not text:
        return None
    text = text.replace("**", "").replace("`", "")
    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln and ln not in ("-", "—")]
    out = "\n".join(lines).strip()
    bad = ("无法提炼", "暂无法", "没有可提炼", "无实质内容", "未提供任何实测")
    if not out or any(b in out[:60] for b in bad):
        return None
    return out[:600]


def viewpoint(title, keyword):
    """只有标题：允许概括，禁止编造数字、结论和实测细节。"""
    payload = {
        "model": LLM_MODEL,
        "max_tokens": 400,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content":
             "你在为技术资讯站提炼一条小红书笔记的看点。你只有标题和搜索词，没有正文。\n"
             "输出两行：\n"
             "第一行『看点：』+一句话（不超过40字），说清这条笔记在讲什么实验或什么工具；\n"
             "第二行『- 』+一句读者点进去能看到的东西（不超过30字）。\n"
             "标题里出现的型号、显存、参数量可以照抄；标题里没有的数字一律不许写；"
             "不许写「作者认为」「值得推荐」这类没有依据的判断。不用 Markdown。"},
            {"role": "user", "content": f"搜索词：{keyword}\n笔记标题：{title}"},
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
                 timeout=30, headers={"Authorization": "Bearer " + token})
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
    log(f"抓到 {len(rows)} 张卡片")
    seen, candidates = set(), []
    for it in rows:
        if it.get("error"):
            log(f"  关键词失败: {it.get('keyword')} → {it['error']}")
            continue
        href = it.get("href") or ""
        title = (it.get("title") or "").strip()
        if not href or href in seen or len(title) < 6:
            continue
        seen.add(href)
        if not is_ai(title):
            continue
        h = age_hours(it.get("timeText"))
        if h is None or h > WINDOW_H:
            continue
        candidates.append((h, it))

    candidates.sort(key=lambda x: x[0])
    log(f"可入选 {len(candidates)} 条（7 天内 + 讲到 AI）")

    pushed = []
    for h, it in candidates[:MAX_ITEMS]:
        title = it["title"]
        vp = viewpoint(title, it.get("keyword") or "")
        if not vp:
            log(f"  跳过（无看点）: {title[:32]}")
            continue
        pushed.append({
            "title": title,
            "url": "https://www.xiaohongshu.com" + it["href"],
            "publishedAt": datetime.now(timezone.utc).isoformat(),
            "author": it.get("author") or "小红书用户",
            "excerpt": vp,
            "raw": {"xhs": {"href": it["href"], "timeText": it.get("timeText"), "keyword": it.get("keyword")}},
        })
        log(f"  ✓ {it.get('author')} | {title[:32]}\n      → {vp.replace(chr(10), ' ⏎ ')[:110]}")
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
