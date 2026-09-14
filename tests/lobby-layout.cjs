const assert = require("node:assert/strict");
const { rowsForHeight, pageOf, prioritize } = require("../lobby-layout.js");
assert.equal(rowsForHeight(0), 1);
assert.equal(rowsForHeight(380), 1);
assert.equal(rowsForHeight(390), 2);
assert.equal(rowsForHeight(590), 3);
assert.equal(rowsForHeight(1200), 3);
assert.deepEqual(pageOf(7, 3, 0), { page: 0, pages: 3, start: 0, end: 3 });
assert.deepEqual(pageOf(7, 3, 2), { page: 2, pages: 3, start: 6, end: 7 });
assert.deepEqual(pageOf(6, 2, 20), { page: 2, pages: 3, start: 4, end: 6 });
assert.deepEqual(pageOf(0, 3, 2), { page: 0, pages: 1, start: 0, end: 0 });
for (const count of [1, 6, 7, 18, 50]) {
  for (const rows of [1, 2, 3]) {
    const seen = [];
    for (let page = 0; page < Math.ceil(count / rows); page++) {
      const slice = pageOf(count, rows, page);
      for (let i = slice.start; i < slice.end; i++) seen.push(i);
    }
    assert.deepEqual(seen, Array.from({ length: count }, (_, i) => i));
  }
}
const crowded = { id: "crowded", map: "Crowded", players: 34, capacity: 92 };
const almostFull = { id: "almost", map: "Almost", players: 20, capacity: 21 };
const active = { id: "active", map: "Active", players: 2, capacity: 40 };
const emptyA = { id: "empty-a", map: "A", players: 0, capacity: 10 };
const emptyB = { id: "empty-b", map: "B", players: 0, capacity: 100 };
assert.deepEqual(prioritize([emptyA, active, crowded, emptyB, almostFull]).map(g => g.id), ["crowded", "almost", "active", "empty-a", "empty-b"]);
assert.deepEqual(prioritize([emptyB, emptyA], ["empty-b", "empty-a"]).map(g => g.id), ["empty-b", "empty-a"]);
assert.deepEqual(prioritize([{ ...active, players: 5 }, { ...almostFull, players: 5 }], ["active", "almost"]).map(g => g.id), ["almost", "active"]);
console.log("Lobby layout: adaptive rows, last-page clamping and all maps reachable OK");
