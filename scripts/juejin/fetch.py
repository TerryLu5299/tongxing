#!/usr/bin/env python3
"""掘金「人工智能」分类最新文章 → 看点摘要 → 推送同行站 ingest。

用法: python scripts/juejin/fetch.py [--dry-run]
选料: 72 小时内的新文，标题或简介要真讲到 AI，且有最低互动门槛（点赞/阅读/阅读时长），
      避免把「用 AI 写周报」这类空壳选进来。
摘要: title + 作者自写的 brief_content → LLM 一句话看点 + 最多三条要点；不写客套话，不编细节。
版权: 只推标题、链接、作者和摘要，不存全文。
"""
import json, os, re, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

AI_CATE = "6809637773935378440"      # 掘金「人工智能」
WINDOW_H = 72                        # 只收三天内的新文
MAX_ITEMS = 12                       # 单轮最多处理（LLM 慢，防卡死）
FEED = "https://api.juejin.cn/recommend_api/v1/article/recommend_cate_feed"
INGEST = "http://127.0.0.1:3001/api/ingest/items"
SOURCE_ID = "juejin-ai"
SOURCE_NAME = "掘金 AI 实测"
DRY = "--dry-run" in sys.argv

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")

# 标题或简介里得真讲到模型、工具、部署、评测才算数；纯前端/后端工程文不算。
AI_TERMS = (
    "AI", "大模型", "模型", "LLM", "GPT", "Claude", "Gemini", "DeepSeek", "Kimi", "Qwen",
    "智能体", "Agent", "MCP", "RAG", "提示词", "Prompt", "微调", "蒸馏", "推理", "量化",
    "本地部署", "Ollama", "vLLM", "llama", "GPU", "显存", "Cursor", "Codex", "Copilot",
    "文生图", "文生视频", "多模态", "embedding", "向量", "算力", "训练",
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
    h = {"Content-Type": "application/json", "User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def feed_page(cursor="0"):
    try:
        d = post(FEED, {"cate_id": AI_CATE, "cursor": cursor, "id_type": 2,
                        "limit": 20, "sort_type": 300})
    except Exception as e:
        log(f"  拉取失败: {e}")
        return [], "0"
    return (d.get("data") or []), str(d.get("cursor") or "0")


def is_ai(text):
    low = (text or "").lower()
    return any(t.lower() in low for t in AI_TERMS)


def read_minutes(a):
    """read_time 形如 "20分钟"，也可能是纯数字。"""
    m = re.search(r"\d+", str(a.get("read_time") or ""))
    return int(m.group(0)) if m else 0


def wanted(a):
    """72 小时内 + 讲到 AI + 有最低互动门槛。"""
    try:
        age_h = (time.time() - int(a.get("ctime") or 0)) / 3600
    except (TypeError, ValueError):
        return False, "无发布时间"
    if age_h > WINDOW_H or age_h < 0:
        return False, f"{age_h:.0f}h 前，超窗"
    title = a.get("title") or ""
    brief = a.get("brief_content") or ""
    if not is_ai(title + " " + brief):
        return False, "不涉及 AI"
    digg = int(a.get("digg_count") or 0)
    view = int(a.get("view_count") or 0)
    read_min = read_minutes(a)
    if digg < 2 and view < 400 and read_min < 4:
        return False, f"热度不足（赞{digg}/阅{view}/{read_min}分）"
    return True, "ok"


def tidy(text):
    """去掉模型爱加的 Markdown 装饰和空行；认不出看点就判为无看点。"""
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


def viewpoint(title, brief):
    """一句话看点 + 最多三条要点。只有标题和作者简介时不许编细节。"""
    material = (brief or "").strip()
    label = "作者写的简介" if material else "只有标题（没有正文与简介，只据标题概括，严禁编造数字和结论）"
    payload = {
        "model": LLM_MODEL,
        "max_tokens": 600,
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content":
             "你是技术文章看点提炼员。根据标题和" + label + "，输出两部分：\n"
             "第一行『看点：』+一句话核心结论（不超过45字，说清作者实测了什么、结论是什么）；\n"
             "随后最多3行『- 』开头的要点（每行不超过35字，只留可核实的事实与数字）。\n"
             "不写客套话，不复述标题，不用任何 Markdown 标记。"
             "材料里没有实测内容或数据时，只写『看点：』后面能确认的一句话，不要写“无法提炼”这类说明。"},
            {"role": "user", "content": f"标题：{title}\n\n{label}：\n{material[:2000]}"},
        ],
    }
    try:
        d = post(LLM_URL, payload, timeout=90, headers={"Authorization": "Bearer " + LLM_KEY})
        content = (d["choices"][0]["message"]["content"] or "").strip()
        return tidy(content)
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
    seen, candidates, cursor = set(), [], "0"
    for page in range(2):
        rows, cursor = feed_page(cursor)
        if not rows:
            break
        for x in rows:
            a = x.get("article_info") or {}
            aid = str(a.get("article_id") or "")
            if not aid or aid in seen:
                continue
            seen.add(aid)
            ok, why = wanted(a)
            if ok:
                a["_author"] = (x.get("author_user_info") or {}).get("user_name") or "掘金"
                candidates.append(a)
        time.sleep(1.0)
        if cursor in ("0", "", None):
            break

    log(f"扫描 {len(seen)} 条，可入选 {len(candidates)} 条")
    candidates.sort(key=lambda a: int(a.get("ctime") or 0), reverse=True)

    pushed = []
    for a in candidates[:MAX_ITEMS]:
        vp = viewpoint(a.get("title") or "", a.get("brief_content") or "")
        if not vp:
            log(f"  跳过（无看点）: {(a.get('title') or '')[:36]}")
            continue
        pub = datetime.fromtimestamp(int(a.get("ctime") or 0), tz=timezone.utc).isoformat()
        pushed.append({
            "title": a.get("title") or "",
            "url": f"https://juejin.cn/post/{a.get('article_id')}",
            "publishedAt": pub,
            "author": a.get("_author") or "掘金",
            "excerpt": vp,
            "raw": {"juejin": {"article_id": str(a.get("article_id")),
                               "digg": int(a.get("digg_count") or 0),
                               "view": int(a.get("view_count") or 0),
                               "read_minutes": read_minutes(a)}},
        })
        log(f"  ✓ {a.get('_author')} | {(a.get('title') or '')[:34]}\n      → {vp.replace(chr(10), ' ⏎ ')[:110]}")
        time.sleep(0.8)

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
