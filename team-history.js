/* Only official clan session scores are used. Individual shares are estimates. */
(() => {
  "use strict";
  const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
  const hourFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" });
  const dayKey = value => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const parts = dayFormatter.formatToParts(date);
    const get = key => parts.find(p => p.type === key).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  function summarize(sessions, games, start, end) {
    const days = new Map();
    for (let date = new Date(`${start}T12:00:00Z`); date <= new Date(`${end}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
      const key = date.toISOString().slice(0, 10);
      days.set(key, { day: key, points: 0, games: 0, wins: 0, losses: 0, matched: 0, players: new Map(), matches: [] });
    }
    const byGame = new Map(games.map(game => [game.gameId, game]));
    const seen = new Set();
    for (const session of sessions) {
      if (!session.gameId || seen.has(session.gameId)) continue;
      seen.add(session.gameId);
      const game = byGame.get(session.gameId);
      const day = days.get(dayKey(session.gameStart || (game && game.start)));
      if (!day) continue;
      if (session.score == null || session.score === "") continue;
      const score = Number(session.score);
      if (!Number.isFinite(score)) continue;
      day.points += score;
      day.games++;
      if (session.hasWon) day.wins++; else day.losses++;
      const players = Array.isArray(game && game.clanPlayers) ? game.clanPlayers : [];
      const duration = game?.durationSeconds == null ? null : Number(game.durationSeconds);
      day.matches.push({ id: session.gameId, start: session.gameStart || game?.start, points: score, won: !!session.hasWon,
        map: game?.map || "Carte non identifiée", mode: game?.mode || "Mode non identifié",
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        population: Number(session.totalPlayerCount) || Number(game?.totalPlayers) || null,
        squad: Number(session.clanPlayerCount) || players.length || null,
        players: players.map(p => ({ id: String(p.publicId || p.username || ""), name: String(p.username || "GAL"), won: !!p.won })) });
      if (!players.length) continue;
      day.matched++;
      const share = score / Math.max(1, Number(session.clanPlayerCount) || players.length);
      const participants = new Set();
      for (const player of players) {
        const id = String(player.publicId || player.username || "");
        if (!id || participants.has(id)) continue;
        participants.add(id);
        const row = day.players.get(id) || { id, name: String(player.username || "Joueur GAL"), points: 0, games: 0, wins: 0, losses: 0, daily: [], matches: [] };
        row.points += share;
        row.games++;
        if (player.won) row.wins++; else row.losses++;
        row.matches.push({ ...day.matches.at(-1), points: share, won: !!player.won });
        day.players.set(id, row);
      }
    }
    const totals = new Map();
    for (const day of days.values()) {
      for (const player of day.players.values()) {
        const row = totals.get(player.id) || { id: player.id, name: player.name, points: 0, games: 0, wins: 0, losses: 0, daily: [], matches: [] };
        for (const key of ["points", "games", "wins", "losses"]) row[key] += player[key];
        row.daily.push({ day: day.day, points: player.points, games: player.games, wins: player.wins, losses: player.losses });
        row.matches.push(...player.matches);
        totals.set(player.id, row);
      }
    }
    const sort = rows => [...rows].sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name, "fr"));
    return {
      days: [...days.values()].reverse().map(day => ({ ...day, players: sort(day.players.values()) })),
      players: sort(totals.values()),
      matched: [...days.values()].reduce((sum, day) => sum + day.matched, 0),
      games: [...days.values()].reduce((sum, day) => sum + day.games, 0),
    };
  }
  function analyze(matches) {
    const ordered = [...matches].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const result = { games: matches.length, wins: 0, losses: 0, points: 0, gains: 0, deductions: 0,
      seconds: 0, timed: 0, participations: 0, squadGames: 0, population: 0, populated: 0,
      best: null, worst: null, winStreak: 0, lossStreak: 0, maps: [], modes: [], hours: Array(24).fill(0) };
    const maps = new Map(), modes = new Map();
    let streak = 0, last;
    for (const match of ordered) {
      result.points += match.points;
      result[match.won ? "wins" : "losses"]++;
      if (match.points > 0) result.gains += match.points; else result.deductions += match.points;
      if (match.duration > 0) { result.seconds += match.duration; result.timed++; }
      if (match.squad > 0) { result.participations += match.squad; result.squadGames++; }
      if (match.population > 0) { result.population += match.population; result.populated++; }
      if (!result.best || match.points > result.best.points) result.best = match;
      if (!result.worst || match.points < result.worst.points) result.worst = match;
      streak = last === match.won ? streak + 1 : 1;
      last = match.won;
      const key = match.won ? "winStreak" : "lossStreak";
      result[key] = Math.max(result[key], streak);
      const hour = Number(hourFormatter.format(new Date(match.start)));
      if (Number.isFinite(hour)) result.hours[hour]++;
      for (const [index, name] of [[maps, match.map], [modes, match.mode]]) {
        const row = index.get(name) || { name, games: 0, wins: 0, losses: 0, points: 0 };
        row.games++; row[match.won ? "wins" : "losses"]++; row.points += match.points;
        index.set(name, row);
      }
    }
    result.maps = [...maps.values()].sort((a, b) => b.games - a.games || b.points - a.points);
    result.modes = [...modes.values()].sort((a, b) => b.games - a.games);
    return result;
  }
  function scoreWindows(start, end) {
    const windows = [];
    for (let cursor = new Date(start).getTime(); cursor < new Date(end).getTime();) {
      const next = Math.min(new Date(end).getTime(), cursor + 86400000);
      windows.push({ start: cursor, end: next });
      cursor = next;
    }
    return windows;
  }
  function careerTotals(node, acc = { wins: 0, losses: 0 }) {
    if (!node || typeof node !== "object") return acc;
    if ("wins" in node || "losses" in node) {
      acc.wins += Number(node.wins) || 0;
      acc.losses += Number(node.losses) || 0;
      return acc;
    }
    for (const [key, child] of Object.entries(node)) {
      // `recent` contains overlapping rolling-window summaries, not career
      // leaves. Counting it fabricates wins and modes such as "all".
      if (key !== "recent") careerTotals(child, acc);
    }
    return acc;
  }
  function careerModeRows(tree) {
    const modes = new Map();
    for (const [visibility, branch] of Object.entries(tree || {})) {
      if (visibility === "recent" || !branch || typeof branch !== "object") continue;
      for (const [mode, node] of Object.entries(branch)) {
        const sum = careerTotals(node);
        const row = modes.get(mode) || { mode, wins: 0, losses: 0 };
        row.wins += sum.wins;
        row.losses += sum.losses;
        modes.set(mode, row);
      }
    }
    return modes;
  }
  const api = { dayKey, summarize, analyze, scoreWindows, careerTotals, careerModeRows };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.OpenFrontTeamHistory = api;
})();
