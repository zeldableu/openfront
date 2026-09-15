const WebSocket = require("./worker/node_modules/ws");
require("./lobby-wire.js");

const sockets = [];
const reports = new Map();
for (let index = 0; index < 5; index++) {
  const worker = `w${index}`;
  const report = { worker, full: 0, deltas: 0, games: new Map(), errors: [] };
  reports.set(worker, report);
  const socket = new WebSocket(`wss://openfront.io/${worker}/lobbies`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  socket.binaryType = "arraybuffer";
  socket.on("message", data => {
    try {
      const message = OpenFrontLobbyWire.decodeLobbyMessage(data);
      if (message.type === "full") {
        report.full++;
        report.games.clear();
        for (const list of Object.values(message.games || {})) {
          for (const game of list) report.games.set(game.gameID, Number(game.numClients) || 0);
        }
      } else if (message.type === "counts") {
        report.deltas++;
        for (const [id, count] of Object.entries(message.counts || {})) report.games.set(id, Number(count) || 0);
      }
    } catch (error) {
      report.errors.push(error.message);
    }
  });
  socket.on("error", error => report.errors.push(error.message));
  sockets.push(socket);
}

setTimeout(() => {
  for (const socket of sockets) socket.close();
  for (const report of reports.values()) {
    const counts = [...report.games.values()];
    const populated = counts.filter(count => count > 0).sort((a, b) => b - a);
    console.log(JSON.stringify({
      worker: report.worker,
      full: report.full,
      deltas: report.deltas,
      games: counts.length,
      populated: populated.length,
      topCounts: populated.slice(0, 8),
      errors: report.errors.slice(0, 3),
    }));
  }
}, 6500);
