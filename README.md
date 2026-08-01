# GAL — Lobbies OpenFront

Les lobbies [OpenFront.io](https://openfront.io) en direct, aux couleurs de la team.

En bas de la page, un carrousel affiche les 25 dernières parties de la team,
victoires comme défaites, avec leur score pondéré officiel OpenFront, leur
map, leur date, leur durée et les joueurs GAL. Ce feed forme un bandeau pleine
largeur sous la grille de grandes cartes panoramiques des lobbies.

La mise en page est verrouillée sur la hauteur de l'écran : la page ne défile
pas verticalement. La grille centrale absorbe l'espace disponible et le feed
reste compact en bas ; leurs pistes horizontales restent navigables.

Les lobbies apparaissent et disparaissent avec une transition. Un clic ouvre la
partie OpenFront dans un nouvel onglet afin de conserver le tableau disponible.
La grille centrale conserve toujours six cellules fixes, deux par catégorie :
la disparition d'un lobby laisse une cellule vide sans agrandir les autres maps.
Ni header, ni menu, ni réglage : on ouvre, on voit les parties sur le fond GAL,
on rejoint.

La connexion au serveur ne s'affiche donc plus en permanence. En cas de coupure,
un bandeau discret apparaît en bas à droite (« Connexion perdue », puis
« Reconnecté ») : une liste figée ne peut pas passer pour à jour.

Site **100 % statique** : pas de serveur, pas de base de données, pas de compte.
Les lobbies viennent du WebSocket public d'OpenFront.

## Fichiers

| Fichier | Rôle |
|---|---|
| `team.config.js` | **Le seul fichier à modifier** : couleur d'accent, fond d'écran, contenu affiché |
| `index.html` | Structure de la page |
| `styles.css` | Thème |
| `app.js` | Logique, générique et indépendante de la team |
| `assets/wallpaper.png` | Le fond d'écran GAL |

## Mise en page

Trois colonnes, comme dans le jeu : **Free For All**, **Équipes**, **Spécial**,
chacune avec son compteur de lobbies.

Une carte, c'est la miniature de la map avec trois pastilles posées dessus
(joueurs, temps avant départ, modificateurs notables), une jauge de remplissage,
puis une ligne d'infos : nom de la map, et en dessous `mode · difficulté · bots`.
Toute la carte est cliquable et ouvre le lobby sur OpenFront.

Le bouton **Rally** apparaît au survol : il copie un lien `?rally=<id>` — qui
l'ouvre voit ce lobby épinglé en haut de sa colonne avec un bandeau *Rejoindre*.
C'est le « on rejoint tous celui-là », à coller dans le Discord.

Deux choix pour que ça reste lisible plutôt qu'un mur de bulles :

- Les modificateurs présents sur presque toutes les parties (dons d'or et de
  troupes, tags de clan, sans nations) ne sont pas affichés. Tout le reste l'est,
  y compris les modificateurs que le jeu ajoutera plus tard.
- **L'ordre des cartes est figé** tant que la liste des lobbies ne change pas.
  Les compteurs de joueurs, eux, continuent de se mettre à jour en direct. Sans
  ça les cartes se réordonnent deux fois par seconde et deviennent illisibles.

## Régler ce qui s'affiche

Tout se passe dans `defaultView`, dans `team.config.js`. Tout le monde voit la
même chose, il n'y a pas de préférence par personne.

```js
defaultView: {
  type: "all",          // "all" | "ffa" | "team" | "special" | "hvn"
  hideEmpty: false,     // true pour cacher les lobbies à 0 joueur
  sort: "playersDesc",  // "playersDesc" | "playersAsc" | "capacityDesc"
                        // "capacityAsc" | "starts" | "map"
}
```

Pour changer le fond d'écran, modifie `background` dans `team.config.js`.
`backgroundOpacity` va de 0 (invisible) à 1 (image brute). La mise en page
réserve le coin supérieur gauche au logo intégré dans le fond GAL.

## Mettre en ligne (GitHub Pages, gratuit)

1. Crée un dépôt public nommé `<ton-pseudo>.github.io`.
2. Pousse ces fichiers à la racine du dépôt.
3. Settings → Pages → Source : `Deploy from a branch`, branche `main`, dossier `/`.
4. Le site est en ligne sur `https://<ton-pseudo>.github.io/` après ~1 minute.

Les chemins sont relatifs, donc un dépôt au nom différent
(`https://<pseudo>.github.io/lobbies/`) fonctionne pareil.

## Développement local

Deux terminaux sont nécessaires pour tester le rassemblement partagé :

```bash
# Terminal 1, à la racine
python -m http.server 5173

# Terminal 2
cd worker
npx wrangler dev --port 8787 --local
```

Puis `http://localhost:5173`. Recharge en vidant le cache (`Ctrl+Shift+R`) après
avoir modifié le CSS. Les visiteurs sans map apparaissent dans le panneau centré
à droite. Cliquer une carte déplace leur pseudo complet sur cette map chez tous
les navigateurs connectés ; cliquer son propre pseudo annule le choix.

Sous ce panneau, les statistiques GAL affichent le rang mondial, le ratio, les
points nets de la team (`weightedWins - weightedLosses`), le total des scores
officiels depuis minuit à Paris et le bilan du jour. Le top 3 et le pire
contributeur sont eux aussi strictement journaliers. La contribution
individuelle partage le score de chaque partie entre les joueurs GAL qui y ont
participé.

## Ce que le flux public ne permet pas

Le WebSocket d'OpenFront ne publie **que** le nombre de joueurs connectés par lobby
(`numClients`), jamais leurs pseudos. Détecter automatiquement qu'un membre de GAL
est dans une partie est donc impossible sans serveur intermédiaire — d'où le rally
manuel, qui couvre le même besoin.

## Crédit

Concept inspiré de [minhkarl.github.io](https://minhkarl.github.io/), réécrit de zéro.
