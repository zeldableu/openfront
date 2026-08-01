# Passerelle GAL → API OpenFront

Petit service Cloudflare Worker (gratuit) qui débloque deux choses que le
site statique ne peut pas faire seul :

- **le CORS** : `api.openfront.io` n'autorise que l'origine `openfront.io`,
  donc aucun navigateur ne peut l'appeler depuis notre site ;
- **les routes réservées aux membres** : `/clans/GAL/members` et
  `/clans/GAL/games` répondent 403 à un invité. Le Worker porte le
  `refreshToken` d'un compte membre du clan.

## Installation

```bash
cd worker
npm install -g wrangler
wrangler login
```

## Le jeton du compte de service

Sur `openfront.io`, connecté avec le compte dédié qui est dans GAL :

1. `F12` → **Application** (Chrome) ou **Stockage** (Firefox)
2. **Cookies** → `https://openfront.io`
3. copier la valeur de `refreshToken` (64 caractères hexadécimaux)

Puis, sans jamais l'écrire dans un fichier :

```bash
wrangler secret put OF_REFRESH_TOKEN
```

Wrangler demande la valeur et la stocke chiffrée côté Cloudflare. Elle
n'entre pas dans le dépôt git.

Vérifié : ce jeton **ne tourne pas** — deux appels successifs à
`/auth/refresh` renvoient le même cookie et le même `sub`. Une seule
saisie suffit donc, pour 30 jours glissants.

## Mise en ligne

```bash
wrangler deploy
```

Worker GAL déployé :
`https://gal-openfront.gal-openfront-worker.workers.dev`

Note l'URL renvoyée (`https://gal-openfront.<compte>.workers.dev`), puis :

- mets-la dans `ALLOWED_ORIGINS` (`wrangler.toml`) côté site ;
- renseigne l'URL du site dans `ALLOWED_ORIGINS` et redéploie.

Tant que `ALLOWED_ORIGINS` vaut `*`, n'importe quel site peut interroger
ta passerelle — donc utiliser ton compte de service. Mets l'URL réelle.

## Routes

| Route | Source | Auth |
|---|---|---|
| `GET /clan` | `/clans/GAL` | compte de service |
| `GET /members?page=1&pageSize=50` | `/clans/GAL/members` | compte de service |
| `GET /games?filter=&cursor=` | `/clans/GAL/games` | compte de service |
| `GET /sessions?start=&end=&page=&limit=` | `/public/clan/GAL/sessions` | aucune |
| `GET /player/{id}` | `/public/player/{id}` | aucune |
| `GET /player/{id}/games?filter=&type=&cursor=` | idem `/games` | aucune |
| `GET /leaderboard` | `/public/clans/leaderboard` | aucune |
| `POST /presence` | Durable Object (expiration après 65 s) | aucune |
| `WS /presence/ws` | Présence et sélection de lobby en temps réel | aucune |
| `GET /health` | — | — |

Réponses mises en cache en mémoire : 10 min pour la fiche de clan et le
classement, 5 min pour les membres, 1 min pour l'historique, 2 min pour
les joueurs. Ça évite de marteler leur API à chaque visiteur.

## Test local

```bash
npx wrangler dev --port 8787 --local
curl http://localhost:8787/health
curl "http://localhost:8787/members?pageSize=5"
```

## Si le jeton fuit

Déconnecte le compte de service depuis OpenFront (ça révoque la session),
récupère le nouveau `refreshToken` et refais `wrangler secret put`.
