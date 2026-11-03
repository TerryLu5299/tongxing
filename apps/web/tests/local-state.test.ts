import assert from "node:assert/strict";
import { after, test } from "node:test";
import { beijingDate, beijingTime } from "@tongxing/contracts/time";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

let instance = 0;
async function reader(starred: unknown[] = []) {
  const values = new Map([["tongxing-starred-items", JSON.stringify(starred)]]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } },
  });
  // Reopening the page starts with an empty snapshot cache.
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?test=${instance++}`);
  return { state, values };
}

const displayDate = (value: string) => `${beijingDate(value)} ${beijingTime(value)}`;

test("import keeps bookmarks with invalid dates and persists displayable replacements", async () => {
  const invalid = ["broken", "", "999999-01-01", "+275760-09-13T00:00:00.000Z", null, 42, {}];
  const { state, values } = await reader();
  const before = Date.now();
  const report = state.importBundle(JSON.stringify({ version: 1, starred: invalid.map((date, i) => ({
    id: `import-${i}`, title: `Bookmark ${i}`, savedAt: date, publishedAt: date,
  })) }));
  assert.equal(report.starredAdded, invalid.length);
  const saved = JSON.parse(values.get(state.KEYS.starred)!);
  assert.equal(saved.length, invalid.length);
  for (const item of saved) {
    assert.equal(item.publishedAt, null);
    assert.ok(Date.parse(item.savedAt) >= before && Date.parse(item.savedAt) <= Date.now());
    assert.doesNotThrow(() => displayDate(item.savedAt));
  }
});

test("stored bookmarks with damaged dates remain readable, exportable and removable", async () => {
  const { state } = await reader([{ id: "stored", title: "Keep me", savedAt: "broken", publishedAt: "broken" }]);
  const starred = state.getStarred();
  assert.equal(starred.length, 1);
  assert.equal(starred[0]!.title, "Keep me");
  assert.equal(starred[0]!.publishedAt, null);
  assert.doesNotThrow(() => displayDate(starred[0]!.savedAt));
  assert.strictEqual(state.getStarred(), starred, "React snapshots must stay stable between changes");
  assert.deepEqual(state.exportBundle().starred, starred);
  state.removeStar("stored");
  assert.deepEqual(state.getStarred(), []);
});

test("valid dates are preserved and an import cannot replace an existing bookmark", async () => {
  const existing = { id: "valid", title: "Original", savedAt: "2026-09-29T08:30:00+08:00", publishedAt: "2026-09-28T23:00:00Z" };
  const { state } = await reader([existing]);
  const report = state.importBundle(JSON.stringify({ version: 1, starred: [{ ...existing, title: "Replacement", savedAt: "broken" }] }));
  assert.equal(report.starredAdded, 0);
  const [saved] = state.getStarred();
  assert.equal(saved!.title, existing.title);
  assert.equal(saved!.savedAt, existing.savedAt);
  assert.equal(saved!.publishedAt, existing.publishedAt);
});

// Failure cases before changing storage: another tab's writes must survive a cached-tab edit;
// unreadable bookmarks must not be overwritten and failed writes must not report success.
test("a cached tab merges newer saved bookmarks and read marks before writing", async () => {
  const { state, values } = await reader([{ id: "old", title: "Old" }]);
  state.getStarred();
  state.getReadIds();
  values.set(state.KEYS.starred, JSON.stringify([{ id: "other-tab", title: "Other tab" }, { id: "old", title: "Old" }]));
  values.set(state.KEYS.read, JSON.stringify(["other-tab"]));
  state.toggleStar({ id: "new", title: "New", summary: null, sourceName: "", publishedAt: null, score: null, aiSelected: false });
  state.markRead("new");
  assert.deepEqual(state.getStarred().map((s) => s.id), ["new", "other-tab", "old"]);
  assert.deepEqual(state.getReadIds(), ["new", "other-tab"]);
});

test("failed bookmark writes and damaged existing data do not report a successful toggle", async () => {
  const { state, values } = await reader();
  const item = { id: "new", title: "New", summary: null, sourceName: "", publishedAt: null, score: null, aiSelected: false };
  values.set(state.KEYS.starred, "damaged original data");
  assert.equal(state.toggleStar(item), false);
  assert.equal(values.get(state.KEYS.starred), "damaged original data");
  window.localStorage.setItem = () => { throw new Error("quota"); };
  assert.equal(state.toggleStar(item), false);
});

test("read history lists the 50 most recent visits newest first and clearing empties it", async () => {
  const { state, values } = await reader();
  // Distinct timestamps: marks inside one millisecond would tie in the sort, so give Date a clock.
  const RealDate = Date;
  const realNow = RealDate.now();
  let tick = realNow;
  globalThis.Date = class extends RealDate {
    constructor(...args: [number]) { super(args.length ? args[0]! : ++tick); }
    static now = () => tick;
  } as unknown as typeof Date;
  try {
    for (let i = 0; i < 60; i++) state.markRead(`visit-${i}`, `Visit ${i}`);
    const history = state.getReadHistory();
    assert.equal(history.length, state.READ_HISTORY_LIMIT);
    assert.equal(history[0]!.id, "visit-59");
    assert.equal(history[1]!.id, "visit-58");
    for (let i = 1; i < history.length; i++) assert.ok(Date.parse(history[i - 1]!.at) > Date.parse(history[i]!.at));
    // A re-visit moves to the front with a fresh time.
    state.markRead("visit-10", "Visit 10");
    assert.equal(state.getReadHistory()[0]!.id, "visit-10");
    assert.equal(state.getReadHistory().length, state.READ_HISTORY_LIMIT);
    state.clearReadHistory();
    assert.deepEqual(state.getReadHistory(), []);
    assert.deepEqual(state.getReadIds(), []);
    assert.ok(!values.has(state.KEYS.readAt));
  } finally {
    globalThis.Date = RealDate;
  }
});

test("damaged visit records are dropped on read, not written over", async () => {
  const { state, values } = await reader();
  values.set(state.KEYS.readAt, JSON.stringify({ "good-1": { t: new Date().toISOString(), title: "Good" }, "bad-1": { t: "999999-01-01", title: "Bad" }, junk: "x" }));
  assert.deepEqual(state.getReadHistory().map((h) => h.id), ["good-1"]);
});
