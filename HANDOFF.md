# Prompt de reprise

Copie tout ce qui suit dans une nouvelle conversation.

---

Je développe un site web statique pour ma team OpenFront.io, le clan **GAL**
(« Les Gaulois », clan francophone, 211 membres). Reprends le projet là où
il en est. Réponds en français.

## Le projet

Dossier : `C:\Users\lokev\Desktop\openfront`
Cible : hébergement GitHub Pages (statique pur).
Stack : HTML + CSS + JavaScript **vanilla**. Aucun framework, aucun build,
aucune dépendance. Ne propose pas React/Vite/Tailwind, ce serait un recul.

```
index.html          structure (aucun header, aucun réglage)
styles.css          thème bleu nuit sur fond d'écran GAL
app.js              toute la logique
team.config.js      le SEUL fichier à modifier pour rebrander
8c0f3c44-a4c4-4e02-a4a8-756d27631b9a.png  fond GAL avec logo en haut à gauche
API.md              relevé complet de l'API OpenFront (à lire en premier)
README.md           doc du site
worker/             passerelle Cloudflare Worker (pas encore déployée)
```

## Ce que le site fait aujourd'hui

Il affiche les lobbies OpenFront en direct, en **trois colonnes** :
Free For All / Équipes / Spécial, chacune avec son compteur.

Source des données : WebSocket public `wss://openfront.io/{w0..w4}/lobbies`
(worker tiré au hasard). Deux types de trames :
- `{type:"full", serverTime, games:{ffa:[],team:[],special:[]}}` — snapshot
  qui fait autorité
- `{type:"counts", counts:{gameID:nbJoueurs}}` — patch des compteurs, ~2/s

Cartes compactes (~68 px) : vignette de map, nom, ligne
`mode · difficulté · bots`, joueurs et compte à rebours à droite, badges de
modificateurs notables. Toute la carte est cliquable et navigue vers
`https://openfront.io/game/{gameID}` dans un nouvel onglet, avec tentative de
conserver le focus sur le tableau de lobbies.

Une barre de présence en haut propose au premier passage **Se connecter avec
Discord** (OAuth2, scope `identify`, échange fait par le Worker qui signe une
session HMAC de 30 jours rangée en `localStorage` sous `of.session`) ou, en
repli, un simple pseudo retenu sous `of.pseudo`. Les membres connectés par
Discord portent leur avatar ; les pseudos libres sont marqués comme tels, car
un pseudo saisi à la main ne prouve rien. Le Worker réécrit lui-même
l'identité des sessions vérifiées : le navigateur ne peut pas se déclarer
vérifié, ni réutiliser un identifiant `d_…`.
Dans la marge droite, un panneau centré verticalement montre le pseudo complet
des membres qui n'ont pas encore choisi de lobby. Un clic sur une carte ouvre
la partie et associe le joueur à ce lobby ; son pseudo apparaît alors sur la
carte chez tous les navigateurs.
Le transport local utilise `/presence/ws`, avec `POST /presence` en repli.
Un second panneau placé juste dessous affiche le rang mondial GAL, le ratio,
les points nets de la team (`weightedWins - weightedLosses`) et les
points/victoires/défaites depuis minuit en Europe/Paris. Le top 3 et le pire
contributeur sont journaliers. Ils répartissent `session.score` à parts égales
entre les entrées `clanPlayers` de la partie, afin que la somme individuelle
reste égale au total du clan.

## Pièges déjà rencontrés — ne pas les réintroduire

1. **`playerTeams` est polymorphe.** Nombre = nombre d'équipes. Chaîne
   `"Duos"`/`"Trios"`/`"Quads"` = **taille** d'une équipe (donc un Duos sur
   60 places = 30 équipes de 2). `"Humans Vs Nations"` = mode à part.
   Voir `teamShape()` dans `app.js`.
2. **Ne jamais retrier à chaque trame `counts`.** Les cartes se réordonnaient
   deux fois par seconde et c'était illisible. L'ordre n'est recalculé que
   quand la *liste* des lobbies change (`orderedGames()` compare une signature
   d'ids).
3. **Pas de `requestAnimationFrame` pour planifier le rendu.** rAF est gelé
   dans un onglet en arrière-plan. Tout passe par `setTimeout`.
4. **`[hidden]` doit être forcé en CSS** (`[hidden]{display:none!important}`),
   sinon les règles `display:flex/grid` l'emportent et les blocs masqués
   restent visibles.
5. **Le fond d'écran est sur `body::before` en `z-index:-2`.** `body` doit
   rester `background: transparent` et seul `html` porte la couleur de repli ;
   sinon le fond du body se peint par-dessus l'image.
6. **OpenFront refuse d'être embarqué en iframe** :
   `Content-Security-Policy: frame-ancestors 'self' https://*.crazygames.com
   https://*.itch.io …`. L'iframe se charge mais reste noire. Navigation
   uniquement.
7. Les modificateurs présents sur presque toutes les parties (`donateGold`,
   `donateTroops`, `noClanTags`, `noNations`) ne sont pas affichés, sinon
   chaque carte devient un mur de bulles.

## L'API OpenFront — lis `API.md`, tout y est vérifié

Base : `https://api.openfront.io`

**Sans aucune authentification :**
- `/public/clans/leaderboard` — tous les clans : `clanTag, games, wins,
  losses, playerSessions, weightedWins, weightedLosses, weightedWLRatio`.
  GAL est 4ᵉ sur 61.
- `/public/player/{publicId}` — fiche joueur, arbre de stats détaillé
- `/public/player/{publicId}/games` — historique de parties, paginé par
  `cursor` opaque. Champs : `gameId, start, durationSeconds, map, mode, type,
  playerTeams, rankedType, result ("victory"|"defeat"|"incomplete"),
  totalPlayers, username, clanTag`
- `/leaderboard/ranked` — top ladder avec `public_id`

**Avec un jeton invité** (`POST /auth/refresh` en délivre un à n'importe qui,
sans compte) :
- `/clans` — annuaire de tous les clans
- `/clans/{TAG}` — fiche du clan

**Interdit même avec un jeton invité (403), réservé aux membres du clan :**
- `/clans/{TAG}/members` — la liste des membres
- `/clans/{TAG}/games` — l'historique officiel du clan

**CORS :** l'API n'autorise que l'origine `openfront.io`. Depuis notre site,
`fetch` échoue en `TypeError: Failed to fetch`. Ce n'est pas un blocage
serveur : en `mode:"no-cors"` la réponse revient en `type:"opaque"`. Un proxy
qui réémet la réponse avec les en-têtes CORS suffit à tout débloquer.

**Scores par partie :** `/public/clan/{TAG}/sessions` renvoie un `score` signé
officiel par partie, avec `clanPlayerCount`, `numTeams` et `totalPlayerCount`.
Le feed fusionne ces sessions avec `/games` par `gameId`. Le score pondère la
part de l'équipe occupée par le clan et la difficulté liée au nombre d'équipes.

## Où j'en suis exactement

Le dossier `worker/` contient une passerelle Cloudflare Worker déployée sur
`https://gal-openfront.gal-openfront-worker.workers.dev`. Les routes publiques,
la route protégée `/members`, la présence et le préflight CORS ont été
testés avec succès en production.

Elle expose : `/clan`, `/members`, `/games`, `/sessions`, `/player/{id}`,
`/player/{id}/games`, `/leaderboard`, `/presence`, `/presence/ws`, `/health`.
La présence partagée utilise un Durable Object et expire après 65 secondes.

La page affiche aussi en bas un feed horizontal des 25 dernières parties du
clan. Le client suit le `nextCursor` opaque de `/games`, fusionne le `score`
officiel de `/sessions` par `gameId`, puis montre l'issue, les points, la map,
la date, la durée et les joueurs GAL. Le feed est un bandeau pleine largeur en
bas de page ; les lobbies utilisent de grandes cartes verticales avec map plein cadre.
`html` et `body` sont en hauteur fixe avec `overflow:hidden` : aucun scroll de
page. La grille prend l'espace flexible restant et les sliders défilent seulement
horizontalement.
Les cartes ont une animation d'entrée/sortie, une barre de remplissage pilotée
par `transform: scaleX()` et ouvrent les parties dans un nouvel onglet.
Chaque `.colCards` possède exactement deux rangées `1fr` : ne pas revenir à
des rangées implicites, sinon une carte seule s'étire sur toute la hauteur.
Le rendu compare l'ordre réel des nœuds avant de les rattacher : ne pas faire
`appendChild` à chaque trame `counts`, cela fait clignoter l'état `:hover`.

Elle porte le `refreshToken` d'un compte de service membre de GAL pour
accéder aux routes en 403. Ce jeton est un **secret Wrangler**
(`wrangler secret put OF_REFRESH_TOKEN`), jamais dans le dépôt : le site est
public. Détail vérifié : ce jeton **ne tourne pas**, une seule saisie tient
30 jours glissants.

## Ce qu'il reste à faire

1. Construire la page **historique de parties** : récupérer `/members`, puis
   fusionner les `/public/player/{id}/games` de chaque membre par `gameId`
   pour reconstituer les parties du clan avec qui y était, le résultat, la
   map et la durée. Plus un classement interne.

Commence par lire `API.md`, `team.config.js` et `app.js` avant de proposer
quoi que ce soit.
