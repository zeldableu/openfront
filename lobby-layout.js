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
      // Score pondéré qui favorise les lobbies avec joueurs et les taux de remplissage
      // Donne plus de poids aux premiers joueurs qu'aux suivants
      const score = (game) => {
        const players = Number(game.players) || 0;
        const capacity = Number(game.capacity) || 1;
        const fill = players / capacity;
        
        // Bonus important pour le premier joueur, puis décroissant
        // Formule : joueurs + log(1 + joueurs) * 10 + fill * 5
        // Cela donne un bonus significatif même avec peu de joueurs
        const playerBonus = players > 0 ? Math.log1p(players) * 10 : 0;
        return players + playerBonus + fill * 5;
      };
      
      const scoreDiff = score(b) - score(a);
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
      
      // Conservation de l'ordre précédent pour éviter le clignotement
      const aKnown = previous.has(a.id), bKnown = previous.has(b.id);
      if (aKnown && bKnown) return previous.get(a.id) - previous.get(b.id);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      
      // En dernier recours, tri par nom de map
      return String(a.map || "").localeCompare(String(b.map || ""));
    });
  };
  const layout = { rowsForHeight, pageOf, prioritize };
  if (typeof module !== "undefined" && module.exports) module.exports = layout;
  else window.OpenFrontLobbyLayout = layout;
})();
