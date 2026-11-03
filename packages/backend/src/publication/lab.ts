// 实测库（/lab）：只收真正跑过一遍的评测与教程，不跟新闻抢 48 小时的座位。
//
// 为什么单独一层：新闻按小时淘汰，实测是常青内容——三个月后照样有人要读。
// 放进同一个池子，它永远排在后面；按日期排又会被旧文压到底。
// 这里的排序只认两件事：内容分（模型读完正文给的）和来源是否实测类。
import type { FeedItemSummary } from "@tongxing/contracts/site";
import { sql } from "../db.ts";
import { ITEM_COLUMNS, ITEM_FROM, toFeedItemSummary, type ItemRow } from "./items.ts";
import { listedCondition } from "./scope.ts";

/** 实测类来源：带 review 标签的，或下面这些明确的社区信源。 */
const REVIEW_SOURCES = [
  "zhihu-reviews", "xhs-reviews", "juejin-ai", "github-repos", "mcp-servers", "bilibili-reviews",
] as const;

export interface LabEntry {
  item: FeedItemSummary;
  /** 来源名，页面按它分组显示「来自知乎实测 / 来自掘金」。 */
  sourceName: string;
  sourceId: string;
}

export interface LabResponse {
  entries: LabEntry[];
  /** 各来源各有多少条，给页面顶部做筛选。 */
  sources: { id: string; name: string; count: number }[];
}

/** 实测类的标题特征：讲怎么跑、跑出什么、哪里踩坑，而不是「某公司发布某模型」。 */
const REVIEW_TITLE = [
  "%实测%", "%评测%", "%测评%", "%部署%", "%踩坑%", "%教程%", "%对比%",
  "%跑分%", "%上手%", "%安装%", "%配置%", "%调优%", "%显存%", "%选型%",
];

const LIMIT = 60;

export async function loadLab(now: Date, sourceId?: string | null): Promise<LabResponse> {
  const filter = sourceId ? sql`AND p.source_id = ${sourceId}` : sql``;
  const rows = await sql<(ItemRow & { source_id: string })[]>`
    SELECT ${ITEM_COLUMNS}, p.source_id
    ${ITEM_FROM}
    WHERE ${listedCondition(now)}
      AND (p.source_id = ANY(${REVIEW_SOURCES as unknown as string[]}) OR s.tags @> ARRAY['review'])
      AND p.title ILIKE ANY(${REVIEW_TITLE})
      ${filter}
    ORDER BY p.score DESC NULLS LAST, p.sort_at DESC
    LIMIT ${LIMIT}`;

  const counts = await sql<{ id: string; name: string; n: number }[]>`
    SELECT s.id, s.name, count(*)::int AS n
    FROM publications p
    JOIN sources s ON s.id = p.source_id
    WHERE ${listedCondition(now)}
      AND (p.source_id = ANY(${REVIEW_SOURCES as unknown as string[]}) OR s.tags @> ARRAY['review'])
      AND p.title ILIKE ANY(${REVIEW_TITLE})
    GROUP BY 1, 2 ORDER BY 3 DESC`;

  return {
    entries: rows.map((r) => ({
      item: toFeedItemSummary(r),
      sourceId: r.source_id,
      sourceName: r.source_name,
    })),
    sources: counts.map((c) => ({ id: c.id, name: c.name, count: c.n })),
  };
}
