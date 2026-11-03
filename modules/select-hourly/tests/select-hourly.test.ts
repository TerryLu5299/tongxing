// The hourly rotation's decision rules (pinned overrides, the recent quota, the bounded eviction)
// on fixed pools; the backlog release is the engine's own requeue shape (state flip + queue +
// audit, one transaction).
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@tongxing/backend/db";
import { changes, planRoster, type CandidateRow } from "@tongxing/select-hourly/server";

after(() => closeDb());

const row = (id: string, o: Partial<CandidateRow> = {}): CandidateRow =>
  ({ article_id: id, model_selected: false, has_override: false, recent: true, score: 70, heat: 0, ...o });

test("manual overrides are pinned and fill the cap", () => {
  const pool = [row("pin", { has_override: true, model_selected: true }), row("a", { score: 90 }), row("b", { score: 80 })];
  assert.deepEqual(planRoster(pool).map((r) => r.article_id), ["pin", "a", "b"]);
});

test("the recent quota holds when the top-N is all old", () => {
  const pool = [
    ...Array.from({ length: 12 }, (_, i) => row(`o${i}`, { recent: false, score: 90 - i })),
    row("r1", { score: 60 }), row("r2", { score: 59 }),
  ];
  const roster = planRoster(pool);
  assert.equal(roster.length, 12);
  assert.ok(roster.filter((r) => r.recent).length >= 2);
  assert.ok(roster.some((r) => r.article_id === "r1") && roster.some((r) => r.article_id === "r2"));
});

test("nothing is acted on when the plan matches the current state", () => {
  const pool = [row("keep", { model_selected: true }), row("out"), row("pin", { has_override: true, model_selected: true })];
  const plan = changes(planRoster(pool), pool);
  assert.deepEqual(plan.add.map((r) => r.article_id), ["out"]);
  assert.deepEqual(plan.drop, []);
});

test("evictions are bounded per run", () => {
  const pool = [
    ...Array.from({ length: 12 }, (_, i) => row(`o${i}`, { recent: false, score: 95 - i, model_selected: i < 12 })),
    row("n1", { score: 99 }), row("n2", { score: 98 }), row("n3", { score: 97 }), row("n4", { score: 96 }), row("n5", { score: 95.5 }),
  ];
  const plan = changes(planRoster(pool), pool);
  assert.ok(plan.drop.length <= 4);
  assert.ok(plan.add.length >= 1);
});

test("a pool smaller than the cap keeps every recent item", () => {
  const pool = [row("x", { score: 90 }), row("y", { score: 50 })];
  assert.deepEqual(planRoster(pool).map((r) => r.article_id), ["x", "y"]);
});

test("the pool query runs on the test database", async () => {
  const { candidates } = await import("@tongxing/select-hourly/server");
  const rows = await candidates(new Date());
  assert.ok(Array.isArray(rows), `tag ${tag()}`);
});
