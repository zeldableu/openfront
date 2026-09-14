const assert = require("node:assert/strict");
require("../lobby-wire.js");

const uint = n => {
  const bytes = [];
  do { const b = n % 128; n = Math.floor(n / 128); bytes.push(b | (n ? 128 : 0)); } while (n);
  return bytes;
};
const str = s => [...uint(Buffer.byteLength(s)), ...Buffer.from(s)];
const decode = bytes => OpenFrontLobbyWire.decodeLobbyMessage(Uint8Array.from(bytes));
const serverTime = 1789409258000;

// v0.34 full snapshots have a presence header even when both new fields
// are absent. Omitting this byte is what broke the old decoder.
assert.deepEqual(decode([0, 0, ...uint(serverTime), 0]), {
  type: "full", serverTime, games: {},
});
assert.deepEqual(decode([0, 7, ...uint(serverTime), 0, ...str("build-test")]), {
  type: "full", serverTime, games: {}, gitCommit: "build-test", active: true,
});
assert.deepEqual(decode([0, 3, ...uint(serverTime), 0, ...str("draining")]), {
  type: "full", serverTime, games: {}, gitCommit: "draining", active: false,
});
assert.deepEqual(decode([1, ...uint(serverTime), 1, ...str("game123"), 42]), {
  type: "counts", serverTime, counts: { game123: 42 },
});

// One lobby without optional config: confirms record/union/header alignment.
const frame = [0, 7, ...uint(serverTime), 1, 0, 1,
  1, ...str("game123"), 42, ...uint(serverTime + 10000), 0, ...str("build-test")];
assert.equal(decode(frame).games.ffa[0].gameID, "game123");
assert.equal(decode(frame).games.ffa[0].numClients, 42);
assert.throws(() => decode([0, 7]), /tronquee/);
console.log("Lobby v0.34 regression tests passed");
