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
  const layout = { rowsForHeight, pageOf };
  if (typeof module !== "undefined" && module.exports) module.exports = layout;
  else window.OpenFrontLobbyLayout = layout;
})();
