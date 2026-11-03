#!/usr/bin/env node
// 同行站流水线看门狗：健康时什么都不输出（cron 空输出即静默），出问题时打印一行一条。
// 判据全部来自数据库实测值，不做推断。
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = "E:/projects/tongxing";
const envFile = path.join(ROOT, ".env");
const env = Object.fromEntries(
  fs.readFileSync(envFile, "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

const one = async (sql) => (await client.query(sql)).rows[0];
const beijing = (d) => new Date(d.getTime() + 8 * 3600_000);
const H = 3600_000;
const now = Date.now();
const out = [];

// 1) 精选冻结：最新入选条目超过 36 小时
const sel = await one(`SELECT count(*)::int n, max(sort_at) newest FROM publications WHERE selected AND visibility='public'`);
if (sel?.n > 0 && sel.newest) {
  const age = (now - new Date(sel.newest).getTime()) / H;
  if (age > 36) out.push(`精选已冻结 ${Math.round(age)} 小时（最新一条 ${beijing(new Date(sel.newest)).toISOString().slice(0, 16).replace("T", " ")}）——选品轮换卡住`);
}

// 2) 分析停摆：3 小时零成功且积压超过 20
const an = await one(`
  SELECT count(*) FILTER (WHERE processing_state='analyzed' AND updated_at > now() - interval '3 hours')::int ok,
         count(*) FILTER (WHERE processing_state='new')::int queued
  FROM articles WHERE discovered_at > now() - interval '7 days'`);
if (an && an.ok === 0 && an.queued > 20) out.push(`分析停摆：3 小时零成功，队列积压 ${an.queued} 篇`);

// 3) 模型额度：近 3 小时余额类失败
const q402 = await one(`SELECT count(*)::int n FROM articles WHERE processing_state='failed' AND processing_error LIKE '%402%' AND updated_at > now() - interval '3 hours'`);
if (q402?.n > 5) out.push(`模型额度不足：近 3 小时 ${q402.n} 篇因余额失败`);

// 4) 日报：北京 10 点后今天还没有——只在“今天这个窗口本来有内容”时才算故障，
//    否则是空窗口（历史上断档那天），报了也没人能修。
const bj = beijing(new Date(now));
const todayKey = bj.toISOString().slice(0, 10);
const hourBJ = bj.getUTCHours();
// The daily edition lands at 08:00 Beijing time; an hour of grace covers a slow run.
if (hourBJ >= 9) {
  const start = new Date(Date.parse(todayKey + "T00:00:00Z"));
  const end = new Date(start.getTime()); // 北京 08:00 当天的日报窗口终点 = 当日 00:00Z
  const startIso = new Date(start.getTime() - 86400_000).toISOString();
  const endIso = end.toISOString();
  const win = await one(`
    SELECT count(*)::int n FROM publications p
    WHERE p.visibility='public' AND p.selected AND NOT p.backfill
      AND ((p.visible_after <= p.timeline_at AND p.timeline_at >= '${startIso}' AND p.timeline_at < '${endIso}')
        OR (p.visible_after > p.timeline_at AND p.visible_after >= '${startIso}' AND p.visible_after < '${endIso}'))`);
  if (win && win.n > 0) {
    const d = await one(`SELECT 1 AS x FROM reports WHERE kind='daily' AND key='${todayKey}'`);
    if (!d) out.push(`今天（${todayKey}）的日报还没出刊，窗口里有 ${win.n} 条内容没成稿`);

    // 5) 报告任务连续失败（同样只在有内容可成稿时才报警）
    const rep = await one(`SELECT count(*)::int n FROM job_runs WHERE job='reports.compose' AND status<>'ok' AND started_at > now() - interval '6 hours'`);
    if (rep?.n >= 3) out.push(`日报任务近 6 小时失败 ${rep.n} 次`);
  }
}

await client.end();

if (out.length) {
  console.log("同行站异常：");
  for (const line of out) console.log("- " + line);
}
