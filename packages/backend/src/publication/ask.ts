// A reader's question answered from what the site has already published, with the sources it used.
//
// The rule is the product: an answer may only restate the listed entries. When the site has nothing
// to say, it says so instead of improvising — a beginner cannot tell a confident wrong answer from a
// right one, so a fluent guess is worse than an honest gap.
import { z } from "zod";
import type { FeedItemSummary, TimelineFilters } from "@tongxing/contracts/site";
import { chatJson } from "../providers/llm.ts";
import { loadPool, SearchBusyError } from "./pool.ts";

export interface AskCitation {
  n: number;
  title: string;
  url: string;
  source: string;
  at: string | null;
}

export interface AskAnswer {
  answer: string;
  citations: AskCitation[];
  hits: number;
  model: string;
}

const AskSchema = z.object({
  /** The answer in plain Chinese; empty when the material does not cover the question. */
  answer: z.string(),
  /** Which numbered entries the answer actually rests on. */
  used: z.array(z.number()).default([]),
});

const SYSTEM = [
  "你在「同行」站里回答读者提问。读者多半没学过 AI，看不懂术语。",
  "只能依据下面给的资料回答，不许补充资料以外的知识、数字、时间或结论。",
  "回答要求：先用一句话直接回答；需要时说清关键细节；术语要用一句大白话解释。",
  "总长不超过 220 字，不分点、不用 Markdown、不写“根据资料”这类套话。",
  "引用资料时在句末标上编号，如 [1]、[1][3]。",
  "如果资料不足以回答这个问题，answer 就写成一句实话：站里目前还没有讲到这个，并说明资料里最接近的是什么；不要编。",
].join("\n");

/** Never let a question cost more than six items of context. */
const CONTEXT_ITEMS = 6;

// Chinese questions are not words separated by spaces, and the pool searches literal strings, so a
// whole sentence ("本地跑大模型需要什么显卡") matches nothing. Cut the question at its question-words
// and search the fragments instead; the longest fragment carries the subject.
const QUESTION_WORDS = /(什么|怎么|如何|为什么|哪些|哪个|可以|需要|请问|有没有|是不是|能不能|应该|推荐|我想|我要|想学|学习|入门|一下|吗|呢|吧|啊|的|了|和|与|在|是|有|我|你|他|它|这|那|个|用|要|能)/g;

function searchTerms(question: string): string[] {
  const clean = question.replace(/[，。？！、；：,.?!;:\s]+/g, " ").trim();
  const parts = clean
    .split(QUESTION_WORDS)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  parts.sort((a, b) => b.length - a.length);
  const terms = [clean.slice(0, 20), ...parts].filter((t) => t.length >= 2);
  return [...new Set(terms)].slice(0, 4);
}

export async function askSite(question: string, filters: TimelineFilters): Promise<AskAnswer> {
  const q = question.trim().slice(0, 200);
  if (!q) return { answer: "", citations: [], hits: 0, model: "" };

  // Search fragment by fragment, then rank: a term in the title is worth three in the summary, and a
  // fresh item beats an old one. Without this the pool's own ordering lets a passing mention outrank
  // the piece that is actually about the question.
  const terms = searchTerms(q);
  const found = new Map<string, FeedItemSummary>();
  const weight = new Map<string, number>();
  let hits = 0;
  for (const term of terms) {
    let pool;
    try {
      pool = await loadPool({ ...filters, q: term, tab: "relevance", page: 1 });
    } catch (e) {
      // Search capacity is bounded; one busy fragment should not lose the whole answer.
      if (e instanceof SearchBusyError) continue;
      throw e;
    }
    hits = Math.max(hits, pool.total);
    const needle = term.toLowerCase();
    for (const it of pool.items.slice(0, 20)) {
      const inTitle = (it.title ?? "").toLowerCase().includes(needle);
      const inSummary = (it.summary ?? "").toLowerCase().includes(needle);
      if (!inTitle && !inSummary) continue;
      const w = (inTitle ? 3 : 0) + (inSummary ? 1 : 0);
      found.set(it.id, it);
      weight.set(it.id, Math.max(weight.get(it.id) ?? 0, w));
    }
    if (found.size >= CONTEXT_ITEMS * 3) break;
  }
  const items = [...found.values()]
    .sort((a, b) => (weight.get(b.id)! - weight.get(a.id)!)
      || String(b.timelineAt ?? b.publishedAt ?? "").localeCompare(String(a.timelineAt ?? a.publishedAt ?? "")))
    .slice(0, CONTEXT_ITEMS);
  if (items.length === 0) return { answer: "", citations: [], hits: 0, model: "" };

  const lines = items.map((it, i) => {
    const src = (it.source as { name?: string } | null | undefined)?.name ?? "";
    const when = (it.timelineAt ?? it.publishedAt ?? "").slice(0, 10);
    return `[${i + 1}] ${it.title}${src ? `（${src}${when ? ` · ${when}` : ""}）` : ""}\n${(it.summary ?? "").slice(0, 220)}`;
  });

  const res = await chatJson({
    model: "default",
    purpose: "reader_question",
    subject: `ask:${q.slice(0, 40)}`,
    promptVersion: "ask-v1",
    system: SYSTEM,
    user: `读者的提问：${q}\n\n站内资料：\n${lines.join("\n\n")}`,
    schema: AskSchema,
    temperature: 0.2,
    maxTokens: 700,
    timeoutMs: 60_000,
    attemptTag: "ask",
  });

  const used = new Set(res.data.used.filter((n) => Number.isInteger(n) && n >= 1 && n <= items.length));
  // A model that forgets to tag its sources still answered from them. Show the three strongest then,
  // not all six: an unrelated entry under "资料来源" costs more trust than it adds context.
  const picked = used.size > 0 ? [...used].sort((a, b) => a - b) : items.slice(0, 3).map((_, i) => i + 1);

  return {
    // The prompt forbids Markdown, but models still slip in code backticks; they read as noise here.
    answer: res.data.answer.trim().replace(/`/g, ""),
    citations: picked.map((n) => {
      const it = items[n - 1]!;
      return {
        n,
        title: it.title,
        url: `/items/${it.id}`,
        source: (it.source as { name?: string } | null | undefined)?.name ?? "",
        at: (it.timelineAt ?? it.publishedAt ?? null) as string | null,
      };
    }),
    hits,
    model: res.model,
  };
}
