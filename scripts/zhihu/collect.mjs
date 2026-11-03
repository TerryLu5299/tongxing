// 知乎搜索采集（由 fetch.py 调用）
// 搜索结果卡片只有标题 + 摘要，没有发布时间，所以逐条打开详情页读时间和正文开头。
// 依赖 ego(lite) 已登录知乎。输出一行 JSON 到 stdout（ego 也可能写到 stderr）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, "keywords.json"), "utf8"));
const NL = String.fromCharCode(10);

// 手工跑时 fetch.py 会在同目录放一个 .takeover 标记（ego 的 node 运行时不继承调用方的环境变量，
// 所以用文件传递）。cron 不放标记，也就不会跟正在用浏览器的人抢控制权。
const flag = path.join(here, ".takeover");
const task = fs.existsSync(flag)
  ? await takeOverTaskSpace(cfg.space || "zhihu collect")
  : await taskSpace(cfg.space || "zhihu collect");
const page = task.page("p1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 内联脚本按行拼：模板字符串里的反斜杠在两层转义下太容易出错。
const LIST_JS = [
  "(() => {",
  "  const NL = String.fromCharCode(10);",
  "  const flat = s => (s || '').split(NL).join(' ').split('  ').join(' ').trim();",
  "  const out = [];",
  "  document.querySelectorAll('.SearchResult-Card').forEach(card => {",
  "    const h = card.querySelector('h2');",
  "    const a = h ? h.querySelector('a') : card.querySelector('a');",
  "    const rich = card.querySelector('.RichText');",
  "    if (!h || !a) return;",
  "    out.push({",
  "      title: flat(h.innerText).slice(0, 90),",
  "      href: a.getAttribute('href') || '',",
  "      excerpt: rich ? flat(rich.innerText).slice(0, 160) : '',",
  "    });",
  "  });",
  "  return out;",
  "})()",
].join(NL);

const DETAIL_JS = [
  "(() => {",
  "  const NL = String.fromCharCode(10);",
  "  const flat = s => (s || '').split(NL).join(' ').split('  ').join(' ').trim();",
  "  const body = document.querySelector('.RichText, .Post-RichText, article, .AnswerItem');",
  "  const who = document.querySelector('.AuthorInfo-name, .AuthorInfo, .UserLink-link');",
  // 专栏文章和回答的头部结构不一样，时间的位置也换，所以先找时间元素，再退回到扫正文行。
  "  const tEl = document.querySelector('.ContentItem-time, .Post-Time, [itemprop=datePublished]');",
  "  const lines = (document.body.innerText || '').split(NL).slice(0, 400);",
  "  const timeLine = lines.filter(l => l.indexOf('发布于') >= 0 || l.indexOf('编辑于') >= 0)[0] || '';",
  "  const timeText = tEl ? flat(tEl.innerText) : flat(timeLine);",
  "  return {",
  "    timeText: timeText.slice(0, 40),",
  "    author: who ? flat(who.innerText).split(' ')[0].slice(0, 24) : '',",
  "    body: body ? flat(body.innerText).slice(0, 700) : '',",
  "    url: location.href,",
  "  };",
  "})()",
].join(NL);

const abs = (href) => {
  if (!href) return "";
  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("/")) return "https://www.zhihu.com" + href;
  return href;
};

const out = [];
const seen = new Set();

for (const kw of cfg.keywords) {
  const url = "https://www.zhihu.com/search?type=content&q=" + encodeURIComponent(kw);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(cfg.waitMs || 4500);
    const cards = await page.evaluate(LIST_JS);
    for (const c of cards.slice(0, cfg.perKeyword || 8)) {
      const link = abs(c.href);
      if (!link || seen.has(link)) continue;
      seen.add(link);
      let detail = { timeText: "", author: "", body: "", url: link };
      try {
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 25000 });
        await sleep(cfg.detailWaitMs || 2500);
        detail = await page.evaluate(DETAIL_JS);
        // 知乎的时间在客户端渲染，偶尔比正文晚半拍：等一次再读，避免把有日期的稿子当无日期丢掉。
        if (!detail.timeText) {
          await sleep(2500);
          const again = await page.evaluate(DETAIL_JS);
          if (again.timeText) detail = again;
        }
      } catch (e) {
        detail.body = "";
      }
      out.push({ ...c, ...detail, href: link, keyword: kw });
    }
  } catch (e) {
    out.push({ keyword: kw, error: String(e).slice(0, 160) });
  }
}

console.log(JSON.stringify(out));
