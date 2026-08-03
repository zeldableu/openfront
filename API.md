# Ce que l'API OpenFront donne (et ne donne pas)

Relevé fait le 1er août 2026 en interrogeant `https://api.openfront.io`
et en lisant `src/client/Api.ts`, `src/client/ClanApi.ts` et
`src/core/ApiSchemas.ts` du dépôt `openfrontio/OpenFrontIO`.

## Accessible sans compte ✅

| Endpoint | Contenu | Vérifié |
|---|---|---|
| `/public/clans/leaderboard` | Tous les clans : `clanTag, games, wins, losses, playerSessions, weightedWins, weightedLosses, weightedWLRatio` | GAL = 4ᵉ sur 61 |
| `/public/clan/{TAG}/exists` | `{"exists":true}` | GAL existe |
| `/public/player/{publicId}` | Fiche joueur (arbre de stats) | — |
| `/public/player/{publicId}/games` | Historique de parties, paginé par curseur | réponse réelle obtenue |
| `/leaderboard/ranked` | Top ladder : `rank, elo, peakElo, wins, losses, public_id, accountUsername` | 50 en 1v1, 9 en 2v2 |

Schéma d'une partie renvoyée par `/public/player/{id}/games` :

```
gameId, start, durationSeconds, map, mode, type, playerTeams,
rankedType, result: "victory" | "defeat" | "incomplete",
totalPlayers, username, clanTag
```

`nextCursor` est un jeton opaque : le renvoyer tel quel en paramètre
`cursor`, jamais le fabriquer.

## Accessible avec un jeton invité ✅

`POST /auth/refresh` délivre un JWT à **n'importe qui**, sans compte ni
identification (c'est le « guest flow » de leur client). Durée : 900 s.

```bash
curl -s -X POST https://api.openfront.io/auth/refresh -H "Origin: https://openfront.io"
```

| Endpoint | Contenu |
|---|---|
| `/clans?page=&pageSize=` | Annuaire de tous les clans : `name, tag, description, isOpen, createdAt, memberCount` |
| `/clans/{TAG}` | Fiche du clan. GAL = « Les Gaulois », 211 membres |

## Bloqué même avec un jeton invité ❌

| Endpoint | Code | Pourquoi |
|---|---|---|
| `/clans/{TAG}/members` | **403** | réservé aux membres du clan |
| `/clans/{TAG}/games` | **403** | réservé aux membres du clan |

## Archives de parties — PUBLIQUES ✅

`GET https://api.openfront.io/game/{gameID}` renvoie **HTTP 200** et
l'enregistrement complet d'une partie terminée, sans aucune
authentification. Environ 50 Ko pour un 1v1, 260 Ko pour une partie à 8.

> Correction : une note précédente indiquait cette route en 403. C'était une
> erreur d'hôte — j'avais interrogé `openfront.io/wN/api/game/{id}` (le
> worker de jeu) au lieu de `api.openfront.io/game/{id}`.

```
{ version, gitCommit, domain, subdomain,
  info: { gameID, config, players[], lobbyCreatedAt, visibleAt,
          start, end, duration, num_turns, winner, lobbyFillTime },
  turns: [ { intents: [ { type, clientID, ... } ] } ] }
```

Chaque joueur porte `clientID`, `username`, `clanTag` et un bloc `stats`
détaillé (attaques, trahisons, tuiles finales, conquêtes, bateaux, bombes,
or, unités). `info.winner` étiquette le vainqueur.

Les intentions sont attribuées par `clientID`, donc on sait exactement qui a
fait quoi. Exemple de répartition sur une partie à 8 joueurs :

```
attack 1093 · boat 260 · build_unit 200 · spawn 85 · allianceRequest 81
emoji 50 · donate_troops 42 · cancel_attack 11 · upgrade_structure 7 …
```

`npm run replay:game -- <gameID>` rejoue l'archive en headless et vérifie
les hashs. Attention : le champ `gitCommit` compte — rejouer une archive
ancienne avec du code récent peut désynchroniser.

Le 403 (et non 401) est net : le jeton invité est bien accepté, c'est
l'autorisation qui manque. La page « Membres » du site officiel ne
fonctionne que pour un membre connecté du clan.

## Trois conséquences importantes

**On ne peut pas récupérer les membres d'un clan par l'API.** Il faut
copier les `publicId` à la main depuis la page du clan (visible quand on
en est membre) vers un fichier du site. Un roster ne bouge presque pas.

> Ne pas utiliser le jeton personnel d'un membre pour contourner ça : le
> cookie `refreshToken` est valable 30 jours et donne un accès complet au
> compte. Copier la liste prend deux minutes.

**Les scores pondérés par partie existent dans l'endpoint de sessions du
clan** : `/public/clan/{TAG}/sessions?start=&end=&page=&limit=`. Chaque ligne
contient notamment `gameId`, `clanPlayerCount`, `hasWon`, `numTeams`,
`totalPlayerCount` et le `score` signé déjà calculé par OpenFront.

Formule officielle : taille moyenne d'une équipe = joueurs / équipes ; part
du clan = joueurs du clan / taille moyenne ; difficulté =
`max(1, sqrt(numTeams - 1))`. Une victoire multiplie la part du clan par la
difficulté, une défaite la divise. Le leaderboard ajoute en plus une
décroissance temporelle avec une demi-vie de 30 jours.

Les sessions et scores de clan ne concernent que les parties publiques en
équipe. Une partie FFA de l'historique n'a donc aucun score de clan officiel.

## CORS

`api.openfront.io` n'autorise que l'origine `openfront.io`. Depuis un
autre site, `fetch` échoue en `TypeError: Failed to fetch`.

Ce n'est ni un 403 ni un souci réseau : une requête en `mode: "no-cors"`
renvoie `type: "opaque"`, `status: 0` — elle part et reçoit une réponse,
c'est le navigateur qui refuse de nous la laisser lire.

**Un proxy qui réémet la réponse avec les en-têtes CORS suffit donc à
tout débloquer.**

## Impossible d'embarquer le jeu dans une iframe

Réponse de `api.openfront.io` :

```
Content-Security-Policy: frame-ancestors 'self' https://*.crazygames.com
  https://crazygames.com https://*.itch.io https://itch.io https://itch.zone ...
```

Liste blanche explicite. Testé : une iframe vers `openfront.io` se charge
sans erreur visible mais reste entièrement noire. Il faut donc lancer une
partie par navigation, pas par embarquement.

## Fraîcheur

Le classement des clans est un cliché recalculé côté serveur sur une
fenêtre glissante de 90 jours. Deux appels à des URL différentes ont
renvoyé le même `end`, avec ~20 min de retard sur l'heure réelle : il est
mis en cache, pas calculé à la demande.
