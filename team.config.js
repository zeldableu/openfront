/* ------------------------------------------------------------------
   CONFIG TEAM — c'est le SEUL fichier à modifier.
   Tout le reste (app.js) est générique.
------------------------------------------------------------------ */

window.TEAM = {
  /* Nom de la team. Sert uniquement au titre de l'onglet. */
  name: "GAL",

  /* Fond d'écran du site. */
  background: "8c0f3c44-a4c4-4e02-a4a8-756d27631b9a.png",

  /* Intensité du fond d'écran, de 0 (invisible) à 1 (brut). */
  backgroundOpacity: 1,

  /* Couleur d'accent : boutons, bordures au survol, pastilles. */
  accent: "#3aa0ff",

  /* URL du petit service qui partage la liste des membres en ligne.
     Deux navigateurs ne peuvent rien se dire directement : sans ce point
     de rendez-vous, chacun ne voit que lui-même et le site le signale.
     Exemple : "https://gal-presence.toncompte.workers.dev"            */
  presenceApi: "https://gal-openfront.gal-openfront-worker.workers.dev",

  /* En local, les avatars et les choix de maps passent par Wrangler afin
     de pouvoir tester sans modifier le Worker déjà en production. */
  localPresenceApi: "http://127.0.0.1:8787",

  /* La page n'a ni header ni réglages : tout le monde voit la même chose.
     Voici cette chose. Laisse tel quel pour afficher tous les lobbies,
     du plus rempli au plus vide.

       type      : "all" | "ffa" | "team" | "special" | "hvn"
       hideEmpty : true pour cacher les lobbies à 0 joueur
       sort      : "playersDesc" | "playersAsc" | "capacityDesc"
                 | "capacityAsc" | "starts" | "map"
  */
  defaultView: {
    type: "all",
    hideEmpty: false,
    sort: "playersDesc",
  },
};
