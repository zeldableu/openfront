const assert = require("node:assert/strict");
const { dayKey, summarize, scoreWindows, careerTotals, careerModeRows } = require("../team-history.js");
const careerTree = {
  Public: { Team: { Easy: { wins: "7", losses: "4" } }, "Free For All": { Medium: { wins: "2", losses: "9" } } },
  Ranked: { "1v1": { wins: "3", losses: "1" } },
  recent: { all: { games: 100, wins: 40 }, Public: { all: { games: 80, wins: 35 }, Team: { all: { games: 40, wins: 25 } } } },
};
assert.deepEqual(careerTotals(careerTree), { wins: 12, losses: 14 });
assert.deepEqual([...careerModeRows(careerTree).keys()], ["Team", "Free For All", "1v1"]);
const windows = scoreWindows("2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z");
assert.equal(windows.length, 2);
assert.equal(windows[0].end, windows[1].start);
assert.equal(windows[1].end - windows[1].start, 3600000);
assert.ok(windows.every(w => w.end - w.start <= 86400000));
assert.equal(dayKey("2026-09-13T22:15:00Z"), "2026-09-14");
assert.equal(dayKey("2026-01-01T23:15:00Z"), "2026-01-02");
assert.equal(dayKey("bad date"), "");
const games = [
  { gameId: "a", clanPlayers: [{ publicId: "1", username: "Alice", won: true }, { publicId: "2", username: "Bob", won: true }] },
  { gameId: "b", clanPlayers: [{ publicId: "1", username: "Alice", won: false }] },
  { gameId: "c", clanPlayers: [{ publicId: "2", username: "Bob", won: true }] },
];
const sessions = [
  { gameId: "a", gameStart: "2026-09-13T22:15:00Z", clanPlayerCount: 2, score: 2, hasWon: true },
  { gameId: "b", gameStart: "2026-09-14T12:00:00Z", clanPlayerCount: 1, score: -0.5, hasWon: false },
  { gameId: "c", gameStart: "2026-09-15T12:00:00Z", clanPlayerCount: 1, score: 0.2, hasWon: true },
  { gameId: "unmatched", gameStart: "2026-09-15T16:00:00Z", score: -1, hasWon: false },
];
const result = summarize([...sessions, sessions[0]], games, "2026-09-14", "2026-09-16");
assert.equal(result.games, 4);
assert.equal(result.matched, 3);
assert.equal(result.days.length, 3);
assert.equal(result.days[0].games, 0);
assert.equal(result.days[2].points, 1.5);
assert.equal(result.players[0].name, "Bob");
assert.equal(result.players[0].points, 1.2);
assert.equal(result.players[0].daily.length, 2);
assert.equal(result.players[1].points, 0.5);
assert.equal(result.players[1].wins, 1);
assert.equal(result.players[1].losses, 1);
assert.equal(summarize([], [], "2026-09-14", "2026-09-14").days[0].points, 0);
assert.equal(summarize([{ gameId: "bad", gameStart: "bad", score: 5 }], [], "2026-09-14", "2026-09-14").games, 0);
console.log("Team history: Paris dates, official totals, estimated shares, missing participants and deduplication OK");
