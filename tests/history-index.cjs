const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
(async () => {
  const { HistoryIndex } = await import('../worker/history-index.js');
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...args) {
    if (!args.length && query.includes(';')) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    const rows = statement.all(...args);
    return { toArray: () => rows };
  }};
  let now = Date.parse('2026-09-14T18:00:00Z'), calls = 0, scoreCalls = 0;
  const games = Array.from({ length: 250 }, (_, i) => ({ gameId: 'g' + i, start: new Date(now - i * 3600000).toISOString(), clanPlayers: [] }));
  const api = async (type, p) => {
    if (type === 'sessions') { scoreCalls++; return { results: [{ gameId: 'g1', score: 2 }], total: 1 }; }
    calls++;
    const offset = Number(p.cursor || 0);
    await new Promise(resolve => setImmediate(resolve));
    return { results: games.slice(offset, offset + 10), nextCursor: offset + 10 < games.length ? String(offset + 10) : null };
  };
  let index = new HistoryIndex(sql, api, () => now);
  const start = now - 200 * 3600000;
  let page = await index.games(start, now + 1000);
  assert.equal(page.complete, false);
  const firstCalls = calls;
  page = await index.games(start, now + 1000);
  assert.equal(page.complete, true);
  assert.equal(page.games.length, 201);
  assert.equal(calls - firstCalls, 8);
  const warmedCalls = calls;
  index = new HistoryIndex(sql, api, () => now); // eviction/restart
  const fast = await index.games(start, now + 1000);
  assert.equal(fast.cached, true);
  assert.equal(calls, warmedCalls);
  const oldStart = now - 15 * 86400000, oldEnd = oldStart + 86400000;
  await Promise.all([index.scores(oldStart, oldEnd), index.scores(oldStart, oldEnd)]);
  assert.equal(scoreCalls, 1);
  await index.scores(oldStart, oldEnd);
  assert.equal(scoreCalls, 1);
  now += 7 * 3600000;
  await index.scores(oldStart, oldEnd);
  assert.equal(scoreCalls, 2);
  const prior = calls;
  await index.games(start, now + 1000);
  assert.equal(calls - prior, 3); // head refresh retains a late-game overlap
  console.log('History index: checkpoints, restart persistence, bounded scan, shared in-flight fetch, score TTL and warm-cache zero upstream calls OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
