// One persistent index per clan. Cursor checkpoints survive Worker eviction.
// No tokens or account credentials are stored in this index.
export class HistoryIndex {
  constructor(sql, api, now = Date.now) {
    this.sql = sql;
    this.api = api;
    this.now = now;
    this.flight = null;
    this.scoreFlights = new Map();
    sql.exec(`CREATE TABLE IF NOT EXISTS history_games (id TEXT PRIMARY KEY, start INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_start ON history_games(start);
      CREATE TABLE IF NOT EXISTS history_meta (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_scores (id TEXT PRIMARY KEY, updated INTEGER NOT NULL, data TEXT NOT NULL);`);
  }
  meta() {
    const row = this.sql.exec("SELECT data FROM history_meta WHERE id = 'scan'").toArray()[0];
    return row ? JSON.parse(row.data) : { cursor: "", oldest: null, exhausted: false, refreshed: 0, pages: 0 };
  }
  save(meta) { this.sql.exec("INSERT OR REPLACE INTO history_meta VALUES ('scan', ?)", JSON.stringify(meta)); }
  put(games) {
    for (const game of games) {
      const start = Date.parse(game.start);
      if (!game.gameId || !Number.isFinite(start)) continue;
      // Keep only fields used by the ranking; upstream archives can be much larger.
      const data = { gameId: game.gameId, start: game.start, durationSeconds: game.durationSeconds,
        map: game.map, mode: game.mode, result: game.result, totalPlayers: game.totalPlayers,
        clanPlayers: (game.clanPlayers || []).map(p => ({ publicId: p.publicId, username: p.username, won: p.won })) };
      this.sql.exec("INSERT OR REPLACE INTO history_games VALUES (?, ?, ?)", game.gameId, start, JSON.stringify(data));
    }
  }
  async scan(start) {
    let meta = this.meta();
    // Refresh the head once a minute, stopping at the first known page.
    if (meta.refreshed < this.now() - 60000) {
      let cursor = "";
      let reached = false;
      for (let i = 0; i < 8; i++) {
        const page = await this.api("games", { cursor });
        if (!Array.isArray(page.results)) throw new Error("Historique OpenFront invalide");
        reached ||= page.results.some(g => this.sql.exec("SELECT id FROM history_games WHERE id = ?", g.gameId).toArray().length);
        this.put(page.results);
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : "";
        if (!meta.oldest) {
          meta.oldest = Math.min(...page.results.map(g => Date.parse(g.start)).filter(Number.isFinite));
          meta.cursor = cursor;
          meta.exhausted = !cursor;
          meta.pages++;
          this.save(meta);
          break;
        }
        // Revisit a small overlap for games which finished late and updates to
        // recent participants, rather than stopping at the first known game.
        if (reached && i >= 2 || !cursor || !page.results.length) break;
      }
      // If traffic resumed after a long gap, persist the refresh cursor and
      // finish bridging the gap next time instead of marking a gap as complete.
      if (!reached && cursor && meta.refreshed) {
        meta.headCursor = cursor;
      } else meta.headCursor = "";
      meta.refreshed = this.now();
      this.save(meta);
    }
    if (meta.headCursor) {
      for (let i = 0; i < 8 && meta.headCursor; i++) {
        const page = await this.api("games", { cursor: meta.headCursor });
        if (!Array.isArray(page.results)) throw new Error("Historique OpenFront invalide");
        const known = page.results.some(g => this.sql.exec("SELECT id FROM history_games WHERE id = ?", g.gameId).toArray().length);
        this.put(page.results);
        meta.headCursor = known ? "" : (page.nextCursor || "");
        this.save(meta);
      }
    }
    // Bounded work per request. Each caller shares the same in-flight scan.
    for (let i = 0; i < 12 && !meta.exhausted && (meta.oldest == null || meta.oldest > start); i++) {
      const page = await this.api("games", { cursor: meta.cursor });
      if (!Array.isArray(page.results)) throw new Error("Historique OpenFront invalide");
      this.put(page.results);
      const times = page.results.map(g => Date.parse(g.start)).filter(Number.isFinite);
      if (times.length) meta.oldest = Math.min(meta.oldest ?? Infinity, ...times);
      const next = typeof page.nextCursor === "string" ? page.nextCursor : "";
      if (next && next === meta.cursor) throw new Error("Curseur OpenFront bloqué");
      meta.cursor = next;
      meta.exhausted = !next || !page.results.length;
      meta.pages++;
      this.save(meta);
    }
  }
  async games(start, end) {
    const before = this.meta();
    const cached = before.refreshed >= this.now() - 60000 && !before.headCursor && (before.exhausted || before.oldest != null && before.oldest <= start);
    if (!cached) {
      if (!this.flight) this.flight = this.scan(start).finally(() => { this.flight = null; });
      await this.flight;
    }
    const meta = this.meta();
    const games = this.sql.exec("SELECT data FROM history_games WHERE start >= ? AND start < ? ORDER BY start DESC", start, end).toArray().map(row => JSON.parse(row.data));
    return { games, complete: !meta.headCursor && (meta.exhausted || meta.oldest != null && meta.oldest <= start), cached,
      oldest: Number.isFinite(meta.oldest) ? new Date(meta.oldest).toISOString() : null, pages: meta.pages, updated: meta.refreshed };
  }
  async scores(start, end) {
    const id = `${start}/${end}`;
    const row = this.sql.exec("SELECT updated, data FROM history_scores WHERE id = ?", id).toArray()[0];
    // Recent days can still receive late-finished games. Past days are checked
    // every six hours, not treated as immutable forever.
    const ttl = end > this.now() - 86400000 ? 60000 : 21600000;
    if (row && row.updated > this.now() - ttl) return { ...JSON.parse(row.data), cached: true };
    if (this.scoreFlights.has(id)) return this.scoreFlights.get(id);
    const pending = (async () => {
      const first = await this.api("sessions", { start: new Date(start).toISOString().replace(/\.\d{3}Z$/, "Z"), end: new Date(end).toISOString().replace(/\.\d{3}Z$/, "Z"), page: 1, limit: 50 });
      if (!Array.isArray(first.results)) throw new Error("Scores OpenFront invalides");
      const results = [...first.results];
      const required = Math.max(1, Math.ceil((Number(first.total) || results.length) / 50));
      const pages = Math.min(required, 20);
      for (let p = 2; p <= pages; p++) {
        const page = await this.api("sessions", { start: new Date(start).toISOString().replace(/\.\d{3}Z$/, "Z"), end: new Date(end).toISOString().replace(/\.\d{3}Z$/, "Z"), page: p, limit: 50 });
        if (!Array.isArray(page.results)) throw new Error("Scores OpenFront invalides");
        results.push(...page.results);
      }
      const data = { results, truncated: required > pages };
      this.sql.exec("INSERT OR REPLACE INTO history_scores VALUES (?, ?, ?)", id, this.now(), JSON.stringify(data));
      // Bounded retention. Cursor history remains reusable for older requests.
      this.sql.exec("DELETE FROM history_scores WHERE updated < ?", this.now() - 45 * 86400000);
      return { ...data, cached: false };
    })().finally(() => this.scoreFlights.delete(id));
    this.scoreFlights.set(id, pending);
    return pending;
  }
}
