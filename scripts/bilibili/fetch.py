#!/usr/bin/env python3
"""B站评测白名单抓取 → 字幕看点摘要 → 推送同行站 ingest。

用法: python scripts/bilibili/fetch.py [--dry-run]
配置: 同目录 whitelist.json；token 与 LLM 配置从仓库根 .env 读。
设计: 48h 窗口内白名单 UP 主新投稿；字幕优先，无字幕用视频简介兜底；
      摘要走 DeepSeek 官方 API（2026-10-14 由本地 8082 切换）。单条失败不中断，限速防风控。
"""
import http.cookiejar
import json, os, re, sys, time, hashlib, urllib.request, urllib.parse, urllib.error
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
COOKIE = os.path.expanduser("~/.bilibili_cookies.txt")


def _load_env():
    """读仓库根 .env（与 AIHOT 站点共用同一份 LLM 配置）"""
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


_ENV = _load_env()
LLM_URL = ((_ENV.get("LLM_BASE_URL") or "https://api.deepseek.com/v1").rstrip("/")
           + "/chat/completions")
LLM_KEY = _ENV.get("LLM_API_KEY", "")
LLM_MODEL = _ENV.get("LLM_MODEL", "deepseek-chat")
INGEST = "http://127.0.0.1:3001/api/ingest/items"
SOURCE_ID = "bilibili-reviews"
SOURCE_NAME = "B站评测精选"
WINDOW_H = 48          # 只收 48h 内的新投稿（站的旧文不刷屏规则）
MAX_VIDEOS = 15        # 单轮最多处理（LLM 慢，防卡死）
DRY = "--dry-run" in sys.argv

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Referer": "https://www.bilibili.com"}
MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,
         12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,
         57,62,11,36,20,34,44,52]


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def cookie_header():
    out = []
    try:
        for line in open(COOKIE, encoding="utf-8").read().splitlines():
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) > 6:
                out.append(f"{parts[5]}={parts[6]}")
    except OSError as e:
        log(f"cookie 读取失败: {e}")
    return "; ".join(out)


COOKIE_HDR = cookie_header()
_wbi_cache = {"keys": None, "ts": 0}
# cookiejar：自动携带并持久化风控 cookie（b_lsid/ts 等由页面下发）
_jar = http.cookiejar.MozillaCookieJar(COOKIE)
try:
    _jar.load(ignore_discard=True, ignore_expires=True)
except OSError:
    pass
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))


def _save_jar():
    try:
        _jar.save(ignore_discard=True, ignore_expires=True)
    except OSError:
        pass


def http_get(url, headers=None, timeout=15):
    h = dict(UA)
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with _opener.open(req, timeout=timeout) as r:
        data = r.read()
    _save_jar()
    return data


def warmup():
    """热身：访问首页与 space 页，收下风控 cookie。"""
    for u in ("https://www.bilibili.com/", "https://space.bilibili.com/"):
        try:
            http_get(u, timeout=12)
        except Exception as e:
            log(f"热身 {u}: {e}")


def wbi_sign(params):
    now = time.time()
    if not _wbi_cache["keys"] or now - _wbi_cache["ts"] > 300:
        d = json.loads(http_get("https://api.bilibili.com/x/web-interface/nav"))
        img = d["data"]["wbi_img"]["img_url"].rsplit("/", 1)[-1].split(".")[0]
        sub = d["data"]["wbi_img"]["sub_url"].rsplit("/", 1)[-1].split(".")[0]
        _wbi_cache["keys"] = (img, sub)
        _wbi_cache["ts"] = now
    img, sub = _wbi_cache["keys"]
    mixin = "".join((img + sub)[i] for i in MIXIN)[:32]
    params = {k: str(v) for k, v in params.items()}
    params["wts"] = str(int(now))
    query = urllib.parse.urlencode(dict(sorted(params.items())))
    params["w_rid"] = hashlib.md5((query + mixin).encode()).hexdigest()
    return params


def space_videos(mid, name, pages=1):
    """UP 主最新投稿：走 wbi search/type（按时间排序，mid 精确匹配防同名）。
    注：space 的 arc/search 接口风控 -352 无解，search/type 实测可通过。"""
    out = []
    for pn in range(1, pages + 1):
        p = wbi_sign({"search_type": "video", "keyword": name, "page": pn, "page_size": 30,
                      "order": "pubdate"})
        url = "https://api.bilibili.com/x/web-interface/wbi/search/type?" + urllib.parse.urlencode(p)
        d = None
        for attempt in range(3):
            try:
                d = json.loads(http_get(url))
            except urllib.error.HTTPError as e:
                if e.code in (412, 429) and attempt < 2:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise
            if (d.get("code") not in (0, None)) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            break
        if not d or d.get("code") != 0 or "result" not in (d.get("data") or {}):
            log(f"  search {name} code={(d or {}).get('code')} → arc/dynamic")
            return _arc_videos(mid)
        if not any(str(v.get("mid", "")) == str(mid) for v in (d["data"].get("result") or [])):
            log(f"  search {name} 无本人结果 → arc/dynamic")
            return _arc_videos(mid)
        for v in d["data"]["result"] or []:
            if str(v.get("mid", "")) != str(mid):
                continue  # 只收本人投稿（防同名号）
            out.append({
                "bvid": v.get("bvid", ""),
                "title": re.sub(r"<[^>]+>", "", v.get("title", "")),
                "pubdate": int(v.get("pubdate", 0)),
                "duration": v.get("length", "") or v.get("duration", ""),
                "description": re.sub(r"<[^>]+>", "", v.get("description", "") or ""),
            })
        time.sleep(1.5)
    return out


def _arc_videos(mid):
    """回退：space arc/search（间歇可用时能过）。"""
    out = []
    try:
        p = wbi_sign({"mid": mid, "ps": 20, "pn": 1, "order": "pubdate", "platform": "web"})
        url = "https://api.bilibili.com/x/space/wbi/arc/search?" + urllib.parse.urlencode(p)
        d = json.loads(http_get(url, headers={"Referer": f"https://space.bilibili.com/{mid}/video"}))
        if d.get("code") == 0:
            for v in (d.get("data", {}).get("list", {}) or {}).get("vlist") or []:
                out.append({"bvid": v.get("bvid", ""),
                            "title": re.sub(r"<[^>]+>", "", v.get("title", "")),
                            "pubdate": int(v.get("created", 0)),
                            "duration": v.get("length", ""),
                            "description": (v.get("description") or "").strip()})
        else:
            log(f"  arc回退 mid={mid} code={d.get('code')}")
    except Exception as e:
        log(f"  arc回退 mid={mid} {e}")
    time.sleep(1.0)
    if out:
        return out
    return _dynamic_videos(mid)


def _dynamic_videos(mid):
    """第三层兜底：动态流接口（feed/space，风控最松，含视频投稿）。"""
    out = []
    try:
        p = wbi_sign({"host_mid": mid, "offset": "", "features": "item.opus.styles"})
        url = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?" + urllib.parse.urlencode(p)
        d = json.loads(http_get(url))
        if d.get("code") == 0:
            for it in (d.get("data", {}) or {}).get("items") or []:
                major = ((it.get("modules", {}) or {}).get("module_dynamic", {}) or {}).get("major") or {}
                arc = major.get("archive") or {}
                if not arc.get("bvid"):
                    continue
                pub = ((it.get("modules", {}) or {}).get("module_author", {}) or {}).get("pub_ts", 0)
                out.append({"bvid": arc.get("bvid", ""),
                            "title": re.sub(r"<[^>]+>", "", arc.get("title", "")),
                            "pubdate": int(pub or 0),
                            "duration": arc.get("duration_text", ""),
                            "description": ""})
        else:
            log(f"  dynamic mid={mid} code={d.get('code')}")
    except Exception as e:
        log(f"  dynamic mid={mid} {e}")
    time.sleep(1.0)
    return out


def video_detail(bvid):
    """view API: cid + 作者 + 播放。"""
    d = json.loads(http_get(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"))
    if d.get("code") != 0:
        return None
    data = d["data"]
    return {"cid": data.get("cid"), "author": data.get("owner", {}).get("name", ""),
            "view": data.get("stat", {}).get("view", 0), "desc": (data.get("desc") or "").strip()}


def subtitle_text(bvid, cid):
    """player/wbi/v2 取 AI 字幕；无字幕返回 None。"""
    try:
        p = wbi_sign({"bvid": bvid, "cid": cid})
        url = "https://api.bilibili.com/x/player/wbi/v2?" + urllib.parse.urlencode(p)
        d = json.loads(http_get(url))
        subs = d.get("data", {}).get("subtitle", {}).get("subtitles") or []
        if not subs:
            return None
        sub_url = subs[0].get("subtitle_url", "")
        if sub_url.startswith("//"):
            sub_url = "https:" + sub_url
        raw = json.loads(http_get(sub_url))
        parts = [b.get("content", "") for b in raw.get("body", []) if b.get("content")]
        text = "".join(parts)
        return text or None
    except Exception as e:
        log(f"  字幕失败 {bvid}: {e}")
        return None


def llm_viewpoint(title, text, fallback_desc=""):
    """DeepSeek 官方 API：一句话看点 + 3 要点。失败回退到简介。"""
    has_sub = bool(text and text.strip())
    source = (text or fallback_desc or "")[:8000]
    if not source.strip():
        return None
    if has_sub:
        material_label, material = "字幕", source
    else:
        material_label, material = "视频简介（无字幕，仅据简介与标题概括，不要编造细节）", source
    payload = {
        "model": LLM_MODEL,
        "max_tokens": 600,
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content":
             "你是视频看点提炼员。根据视频标题和" + material_label + "，输出两部分："
             "第一行『看点：』+一句话核心结论（不超过45字，说清评测结果或主要发现）；"
             "随后最多3行『- 』开头的要点（每行不超过35字，只留可核实的事实与数字）。"
             "不写客套话，不复述标题，信息不足时基于已有信息概括。"},
            {"role": "user", "content": f"标题：{title}\n\n{material_label}：\n{source}"},
        ],
    }
    try:
        req = urllib.request.Request(
            LLM_URL, data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + LLM_KEY}, method="POST")
        with urllib.request.urlopen(req, timeout=90) as r:
            d = json.loads(r.read())
        content = d["choices"][0]["message"]["content"].strip()
        return content[:600] if content else None
    except Exception as e:
        log(f"  LLM失败: {e}")
        return None


def ingest(items):
    env = open(os.path.join(ROOT, ".env"), encoding="utf-8").read()
    m = re.search(r"INGEST_TOKEN=(\S+)", env)
    if not m:
        log("(.env 缺 INGEST_TOKEN)")
        return False
    body = json.dumps({"sourceId": SOURCE_ID, "sourceName": SOURCE_NAME, "items": items}).encode()
    req = urllib.request.Request(INGEST, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + m.group(1)})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            log(f"ingest: {r.read().decode()}")
            return True
    except urllib.error.HTTPError as e:
        log(f"ingest HTTP {e.code}: {e.read().decode()[:200]}")
        return False


def main():
    warmup()
    time.sleep(1)
    wl = json.load(open(os.path.join(HERE, "whitelist.json"), encoding="utf-8"))["whitelist"]
    cutoff = time.time() - WINDOW_H * 3600
    candidates = []
    for u in wl:
        try:
            vids = space_videos(u["mid"], u["name"])
        except Exception as e:
            log(f"{u['name']} space失败: {e}")
            continue
        fresh = [v for v in vids if v["pubdate"] >= cutoff]
        if fresh:
            log(f"{u['name']}: {len(fresh)}/{len(vids)} 条在 {WINDOW_H}h 内")
        for v in fresh:
            v.update(uploader=u["name"], mid=u["mid"], category=u["category"])
            candidates.append(v)
        time.sleep(0.6)
    candidates.sort(key=lambda v: v["pubdate"], reverse=True)
    candidates = candidates[:MAX_VIDEOS]
    log(f"候选合计 {len(candidates)} 条")

    pushed = []
    for v in candidates:
        det = None
        try:
            det = video_detail(v["bvid"])
        except Exception as e:
            log(f"  view失败 {v['bvid']}: {e}")
        if not det:
            continue
        sub = None
        try:
            sub = subtitle_text(v["bvid"], det["cid"])
        except Exception as e:
            log(f"  字幕异常 {v['bvid']}: {e}")
        viewpoint = llm_viewpoint(v["title"], sub, (det.get("desc") or v["description"]))
        if not viewpoint:
            log(f"  跳过（无看点）: {v['title'][:40]}")
            continue
        pub = datetime.fromtimestamp(v["pubdate"], tz=timezone.utc).isoformat()
        item = {
            "title": v["title"],
            "url": f"https://www.bilibili.com/video/{v['bvid']}/",
            "publishedAt": pub,
            "author": v["uploader"],
            "excerpt": viewpoint,
            "raw": {"bili": {"bvid": v["bvid"], "cid": det["cid"], "view": det["view"],
                             "duration": v["duration"], "category": v["category"],
                             "has_subtitle": bool(sub)}},
        }
        pushed.append(item)
        vp_head = viewpoint.replace(chr(10), " ⏎ ")[:110]
        log(f"  ✓ {v['uploader']} | {v['title'][:34]}\n      → {vp_head}")
        time.sleep(1.0)

    if not pushed:
        log("本轮无新内容")
        return
    if DRY:
        log(f"[dry-run] 跳过推送 {len(pushed)} 条")
        return
    # ingest 每次最多 50 条
    for i in range(0, len(pushed), 40):
        ingest(pushed[i:i + 40])


if __name__ == "__main__":
    main()
