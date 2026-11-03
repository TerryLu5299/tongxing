// 小红书搜索采集（由 fetch.py 调用）
// 依赖：ego(lite) 已安装并在运行，且已在小红书登录过。脚本读同目录 keywords.json。
// 输出：一行 JSON 数组到 stdout（ego-browser 也可能把它写到 stderr，调用方两边都收）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, "keywords.json"), "utf8"));

const task = await taskSpace(cfg.space || "xhs collect");
const page = task.page("p1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];

for (const kw of cfg.keywords) {
  const url = "https://www.xiaohongshu.com/search_result?keyword=" + encodeURIComponent(kw);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(cfg.waitMs || 4500);
    const items = await page.evaluate(`(() => {
      const out = [];
      document.querySelectorAll('section.note-item').forEach(sec => {
        const a = sec.querySelector('a[href*="/search_result/"], a[href*="/explore/"]');
        const lines = (sec.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
        if (!a || lines.length === 0) return;
        out.push({
          title: lines[0],
          author: lines[1] || '',
          timeText: lines[2] || '',
          href: a.getAttribute('href') || '',
        });
      });
      return out;
    })()`);
    for (const it of items) out.push({ ...it, keyword: kw });
  } catch (e) {
    out.push({ keyword: kw, error: String(e).slice(0, 160) });
  }
}

console.log(JSON.stringify(out));
