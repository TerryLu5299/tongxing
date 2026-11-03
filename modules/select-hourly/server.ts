// The hourly selection (the user's decision: the 精选 set rotates every hour). Once an hour, the
// top-N of listed, scored items by composite score (score + heat) fills the selected set through
// the engine's own chain — the admin's manual-correction use case, which writes the override,
// rebuilds the publication, settles seats and appends the ledger. Nothing here touches the ledger
// directly.
//
// Rules: manual overrides are pinned (never rewritten); automatic items compete on composite score.
// Guarantees: at most MAX_EVICT automatic items are dropped per run (old cards are never all
// pushed out at once), at least RECENT_MIN seats go to items from the last 24 hours (the page
// always has fresh content), and the selection stays at SEAT_CAP.
//
// The first recorded run also releases the connect-failed backlog the model's sleep left behind
// (local model, zero API fee): failed rows that carry a retry time are stuck — the sweep only
// wakes 'new' rows — so they wait for a release; rows without a retry time are the admin's own
// queue and stay untouched.
import { overrideFields } from "@tongxing/backend/admin/content";
import { queueProcessing } from "@tongxing/backend/jobs/content";
import { audit } from "@tongxing/backend/audit";
import { sql } from "@tongxing/backend/db";
import { listedCondition } from "@tongxing/backend/publication/scope";
import { defineServerModule } from "@tongxing/backend/modules";

const ACTOR = "selectHourly";
const REASON = "每小时自动选品：按评分+热度轮换";
/** The card cap the site has always shown on the home timeline. */
const SEAT_CAP = 16;
/** At most this many automatic items are dropped in one run. */
const MAX_EVICT = 4;
/** At least this many seats go to items from the last 24 hours. */
const RECENT_MIN = 2;
const RECENT_HOURS = 24;
/** Tiers that cannot enter the selection have no threshold (industry/selection.ts). */
const NO_THRESHOLD = ["EXCLUDE_MP"];
/** The backlog this module releases: transport failures while the model was asleep. */
const CONNECT_FAILED = "connect failed: %";

export interface CandidateRow {
  article_id: string;
  /** The projection's judgement (publications.selected), which already folds in any override. */
  model_selected: boolean;
  has_override: boolean;
  recent: boolean;
  score: number;
  heat: number;
  /** Hours since the item entered the list (sort_at). Drives the freshness rule below. */
  age_hours: number;
  /** Who published it. The seat plan spreads seats across outlets. */
  source_id: string;
  /** The event it belongs to; one event takes one seat so the page never repeats itself. */
  story_id: string | null;
}

const composite = (r: { score: number; heat: number }) => Number(r.score) + Number(r.heat);

/**
 * Community writing — 实测, a new repo, a plugin — scores low as "news" but is exactly what a reader
 * learning AI needs, and without a nudge it never wins a seat. A small bump lets its best pieces
 * compete; MAX_PER_SOURCE still caps how much of the page one outlet can take.
 */
const COMMUNITY_BOOST = new Map<string, number>([
  ["juejin-ai", 5], ["github-repos", 4], ["mcp-servers", 3], ["bilibili-reviews", 5], ["xhs-reviews", 5], ["zhihu-reviews", 5],
]);
const ranked = (r: CandidateRow) => composite(r) + (COMMUNITY_BOOST.get(r.source_id) ?? 0);
const byComposite = (a: CandidateRow, b: CandidateRow) => ranked(b) - ranked(a) || b.article_id.localeCompare(a.article_id);

/**
 * An automatic item older than this may not hold a seat while fresher candidates exist.
 * Without it the roster (top SEAT_CAP by composite) and the selected set become the same
 * set, so nothing is ever dropped and nothing new ever enters — the page freezes.
 */
const MAX_AGE_HOURS = 48;

/**
 * Seats one outlet may hold by preference. A pure score ranking lets a single prolific feed
 * (a wire service publishing dozens of items a day) take almost every seat, which reads as
 * "this site only republishes one outlet". The cap is relaxed only when the pool is too thin
 * to fill the page without it.
 */
const MAX_PER_SOURCE = 2;

/** A page never drops below this many cards; below it, stale material is pressed into service. */
const MIN_SEATS = 6;

/** Every listed, scored item of a tier that can enter the selection; the recent flag drives the quota. */
export async function candidates(now: Date): Promise<CandidateRow[]> {
  const heat = sql`coalesce((SELECT max(h.heat) FROM story_heat_hourly h
    JOIN facts f ON f.story_id = h.story_id JOIN fact_articles fa ON fa.fact_id = f.id
    WHERE fa.article_id = p.article_id AND h.complete), 0)`;
  const rows = await sql<CandidateRow[]>`
    SELECT p.article_id, p.source_id, p.story_id::text AS story_id, p.selected AS model_selected,
           EXISTS (SELECT 1 FROM editorial_overrides o
                    WHERE o.article_id = p.article_id AND coalesce(o.updated_by, '') <> ${ACTOR}) AS has_override,
           p.sort_at >= ${new Date(now.getTime() - RECENT_HOURS * 3600_000)} AS recent, p.score, ${heat} AS heat,
           greatest(0, extract(epoch from (${now}::timestamptz - p.sort_at)) / 3600)::float8 AS age_hours
    FROM publications p
    JOIN sources s ON s.id = p.source_id
    WHERE ${listedCondition(now)} AND NOT (s.tier = ANY(${NO_THRESHOLD}::text[])) AND p.score IS NOT NULL
    ORDER BY (p.score + ${heat}) DESC, p.sort_at DESC
    LIMIT 400`;
  for (const r of rows) {
    r.score = Number(r.score);
    r.heat = Number(r.heat);
    r.age_hours = Number(r.age_hours);
  }
  return rows;
}

/**
 * The roster plan: manual overrides are pinned; automatic seats go to fresh items first
 * (by composite score), and are only topped up from stale ones when there is not enough
 * fresh material. Pure — the caller decides what to act on.
 */
export function planRoster(pool: readonly CandidateRow[]): CandidateRow[] {
  const pinned = pool.filter((r) => r.has_override);
  const seats = Math.max(SEAT_CAP - pinned.length, 0);
  const automatic = pool.filter((r) => !r.has_override);
  const fresh = automatic.filter((r) => r.age_hours <= MAX_AGE_HOURS).sort(byComposite);
  const stale = automatic
    .filter((r) => r.age_hours > MAX_AGE_HOURS)
    .sort((a, b) => a.age_hours - b.age_hours || byComposite(a, b));

  // Spread the automatic seats across outlets: take the best of each feed first, and only let an
  // outlet past the cap when the remaining seats cannot be filled without it.
  const ordered = [...fresh, ...stale];
  const picks: CandidateRow[] = [];
  const perSource = new Map<string, number>();
  const takenStories = new Set<string>();
  for (const r of ordered) {
    if (picks.length >= seats) break;
    const used = perSource.get(r.source_id) ?? 0;
    if (used >= MAX_PER_SOURCE) continue;
    if (r.story_id && takenStories.has(r.story_id)) continue;
    picks.push(r);
    perSource.set(r.source_id, used + 1);
    if (r.story_id) takenStories.add(r.story_id);
  }
  // Second pass: seats still open — relax the per-outlet cap, but keep one seat per event.
  if (picks.length < seats) {
    const taken = new Set(picks.map((r) => r.article_id));
    for (const r of ordered) {
      if (picks.length >= seats) break;
      if (taken.has(r.article_id)) continue;
      if (r.story_id && takenStories.has(r.story_id)) continue;
      picks.push(r);
      if (r.story_id) takenStories.add(r.story_id);
    }
  }
  // Old material may fill the page only up to a floor. A short page of today's news reads better
  // than a full page where half the cards are days old; below the floor, stillness looks worse.
  if (picks.length < Math.min(MIN_SEATS, seats)) {
    const taken = new Set(picks.map((r) => r.article_id));
    const needed = Math.min(MIN_SEATS, seats) - picks.length;
    const fallback = stale.filter((r) => !taken.has(r.article_id)).slice(0, needed);
    picks.push(...fallback);
    for (const r of fallback) {
      const used = perSource.get(r.source_id) ?? 0;
      perSource.set(r.source_id, used + 1);
    }
  }

  // At least RECENT_MIN of the automatic seats go to the last 24 hours.
  const recentIn = picks.filter((r) => r.recent).length;
  if (recentIn < Math.min(RECENT_MIN, seats)) {
    const chosen = new Set(picks.map((r) => r.article_id));
    const swapIn = fresh.filter((r) => r.recent && !chosen.has(r.article_id)).slice(0, RECENT_MIN - recentIn);
    const swapOut = picks.filter((r) => !r.recent).sort((a, b) => composite(a) - composite(b)).slice(0, swapIn.length);
    for (const r of swapOut) picks.splice(picks.indexOf(r), 1);
    picks.push(...swapIn);
  }
  return [...pinned, ...picks];
}

/** What to act on: only automatic items whose state would actually change (overrides are never rewritten). */
export function changes(roster: readonly CandidateRow[], pool: readonly CandidateRow[]): { add: CandidateRow[]; drop: CandidateRow[] } {
  const inRoster = new Set(roster.map((r) => r.article_id));
  const automatic = pool.filter((r) => !r.has_override);
  const stale = automatic.filter((r) => r.model_selected && !inRoster.has(r.article_id));
  // A frozen page (selected items past MAX_AGE_HOURS) gets one full catch-up rotation;
  // afterwards the per-run cap keeps the page from turning over all at once.
  const frozen = automatic.some((r) => r.model_selected && r.age_hours > MAX_AGE_HOURS);
  const currentSelected = automatic.filter((r) => r.model_selected).length;
  // Publishing marks an article selected on its own editorial judgement, so the page can end up
  // holding far more than SEAT_CAP seats. The per-run cap exists to keep a healthy page from
  // churning; it must not also preserve that overflow, or the page grows without bound.
  const overflow = Math.max(currentSelected - SEAT_CAP, 0);
  const drop = stale.slice(0, frozen ? SEAT_CAP : Math.max(MAX_EVICT, overflow));
  const addCap = Math.max(SEAT_CAP - currentSelected + drop.length, 0);
  const add = automatic
    .filter((r) => !r.model_selected && inRoster.has(r.article_id))
    .sort(byComposite)
    .slice(0, addCap);
  return { add, drop };
}

export async function runSelection(now: Date): Promise<{ add: number; drop: number }> {
  const pool = await candidates(now);
  const roster = planRoster(pool);
  const plan = changes(roster, pool);
  // overrideFields is optimistic: it refuses when the stored version differs from the one passed.
  // This module rewrites its own rows every hour, so it has to send the version on file.
  const versionOf = async (articleId: string): Promise<number> => {
    const [row] = await sql<{ version: number }[]>`
      SELECT version FROM editorial_overrides WHERE article_id = ${articleId}`;
    return row?.version ?? 0;
  };
  for (const r of plan.add) {
    await overrideFields(r.article_id, { fields: { selected: true }, reason: REASON, version: await versionOf(r.article_id) }, ACTOR);
  }
  for (const r of plan.drop) {
    await overrideFields(r.article_id, { fields: { selected: false }, reason: REASON, version: await versionOf(r.article_id) }, ACTOR);
  }
  // Candidates only covers recent material, so an old seat that has fallen out of the pool is
  // invisible to the plan above and would keep its place on the front page forever. This sweep is
  // therefore limited to those invisible seats: in-pool items are the plan's business, and letting
  // the sweep touch them would bypass MAX_EVICT and turn the page over all at once.
  const inPool = new Set(pool.map((r) => r.article_id));
  const keep = new Set(roster.map((r) => r.article_id));
  const selectedRows = await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p
    WHERE p.selected
      AND NOT EXISTS (SELECT 1 FROM editorial_overrides o
                       WHERE o.article_id = p.article_id AND coalesce(o.updated_by, '') <> ${ACTOR})`;
  let swept = 0;
  for (const r of selectedRows) {
    if (keep.has(r.article_id) || inPool.has(r.article_id)) continue;
    await overrideFields(r.article_id, { fields: { selected: false }, reason: REASON, version: await versionOf(r.article_id) }, ACTOR);
    swept += 1;
  }
  return { add: plan.add.length, drop: plan.drop.length + swept };
}

/**
 * The connect-failed backlog, released once on the module's first run (the model being asleep made
 * these calls time out; they are local, so the retry costs no API fee). Articles without a retry
 * time are the admin's own queue and stay untouched — the engine's requeueFailed only takes those.
 */
export async function releaseConnectFailedBacklog(): Promise<{ released: number }> {
  const prior = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM job_runs WHERE job = 'site.selectHourly' AND status = 'ok'`;
  if ((prior[0]?.n ?? 0) > 0) return { released: 0 };
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM articles WHERE processing_state = 'failed' AND processing_retry_at IS NOT NULL
      AND processing_error LIKE ${CONNECT_FAILED}`;
  let released = 0;
  for (const r of rows) {
    await sql.begin(async (tx) => {
      const [a] = await tx`UPDATE articles SET processing_state = 'new', processing_error = NULL, processing_attempts = 0,
                      processing_retry_at = NULL, processing_queued_at = NULL
                    WHERE id = ${r.id} AND processing_state = 'failed' RETURNING id`;
      if (!a) return;
      const queued = await queueProcessing(r.id, { step: "analyze", db: tx });
      await audit(ACTOR, "content.requeue", `content:${a.id}`, "模型唤醒后释放 connect-failed 退避（本地模型，零 API 费）",
        { state: "failed" }, { state: "new", jobId: queued }, { db: tx });
    });
    released += 1;
  }
  return { released };
}

export default defineServerModule({
  name: "select-hourly",
  schedules: [
    {
      name: "site.selectHourly",
      cron: "2 * * * *",
      run: async () => {
        const backlog = await releaseConnectFailedBacklog();
        const selection = await runSelection(new Date());
        return { backlog, selection };
      },
    },
  ],
});
