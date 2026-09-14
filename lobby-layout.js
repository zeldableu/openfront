/* Fixed-size lobby pages: incoming games never squeeze the visible cards. */
(() => {
  "use strict";
  const rowsForHeight = height => Math.max(1, Math.min(3,
    Math.floor((Math.max(0, Number(height) || 0) + 8) / 198)));
  const pageOf = (count, rows, requested = 0) => {
    rows = Math.max(1, Math.floor(Number(rows) || 1));
    count = Math.max(0, Math.floor(Number(count) || 0));
    const pages = Math.max(1, Math.ceil(count / rows));
    const page = Math.max(0, Math.min(pages - 1, Math.floor(Number(requested) || 0)));
    const start = page * rows;
    return { page, pages, start, end: Math.min(count, start + rows) };
  };
  /* Keep populated lobbies ahead of empty ones. Ties retain their previous
     relative order so identical count frames never make cards flicker. */
  const prioritize = (games, previousIds = []) => {
    const previous = new Map(previousIds.map((id, index) => [id, index]));
    return [...games].sort((a, b) => {
      const players = (Number(b.players) || 0) - (Number(a.players) || 0);
      if (players) return players;
      const fillA = Number(a.capacity) > 0 ? (Number(a.players) || 0) / Number(a.capacity) : 0;
      const fillB = Number(b.capacity) > 0 ? (Number(b.players) || 0) / Number(b.capacity) : 0;
      if (fillB !== fillA) return fillB - fillA;
      const aKnown = previous.has(a.id), bKnown = previous.has(b.id);
      if (aKnown && bKnown) return previous.get(a.id) - previous.get(b.id);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return String(a.map || "").localeCompare(String(b.map || ""));
    });
  };
  const layout = { rowsForHeight, pageOf, prioritize };
  if (typeof module !== "undefined" && module.exports) module.exports = layout;
  else window.OpenFrontLobbyLayout = layout;
})();
