# Passerelle GAL → API OpenFront

Petit service Cloudflare Worker (gratuit) qui débloque deux choses que le
site statique ne peut pas faire seul :

- **le CORS** : `api.openfront.io` n'autorise que l'origine `openfront.io`,
  donc aucun navigateur ne peut l'appeler depuis notre site ;
- **les routes réservées aux membres** : `/clans/GAL/members` et
  `/clans/GAL/games` répondent 403 à un invité. Le Worker porte le
  `refreshToken` d'un compte membre du clan ;
- **la connexion Discord** : le secret client OAuth2 ne peut pas vivre
  dans un site statique, sinon n'importe qui le lirait dans le source.

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

Quand ce jeton expire, il peut être remplacé depuis le bouton
**Renouveler le token** du profil. La valeur est enregistrée dans le secret
partagé du Worker : la correction s'applique donc à tous les visiteurs.

### Autoriser le renouvellement depuis le site

La route d'administration nécessite deux secrets supplémentaires :

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put CF_API_TOKEN
```

- `ADMIN_PASSWORD` est le mot de passe demandé dans la fenêtre du site ;
- `CF_API_TOKEN` est un jeton API Cloudflare limité au compte concerné,
  avec la permission **Workers Scripts: Edit**.

Le nouveau refresh token est testé auprès d'OpenFront avant tout changement,
puis `OF_REFRESH_TOKEN` est remplacé atomiquement. Ni le mot de passe, ni les
deux tokens ne doivent être ajoutés à Git.

## L'application Discord

Sur [discord.com/developers/applications](https://discord.com/developers/applications) :

1. **New Application**, nomme-la (« GAL Lobbies »).
2. Onglet **OAuth2** → copie le **Client ID**, mets-le dans
   `DISCORD_CLIENT_ID` (`wrangler.toml`). Ce n'est pas un secret : il
   apparaît dans l'URL de connexion.
3. Toujours dans **OAuth2** → **Redirects**, ajoute exactement :

   ```
   https://gal-openfront.gal-openfront-worker.workers.dev/auth/discord/callback
   ```

   Et pour tester en local, ajoute aussi
   `http://127.0.0.1:8787/auth/discord/callback`. Discord refuse toute
   URL de retour absente de cette liste, au caractère près.
4. **Reset Secret** → copie le *Client Secret*, puis pose-le ainsi que la
   clé de signature des sessions :

   ```bash
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET
   ```

   `SESSION_SECRET` est une valeur au hasard, connue de toi seul — elle
   signe les sessions du site. Par exemple :
   `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`.
   La changer déconnecte tout le monde ; c'est justement le bouton
   d'urgence si un jeton fuite.

Le scope demandé est `identify` seul : le site voit l'identifiant, le
pseudo et l'avatar, rien d'autre. Ni les serveurs, ni le courriel, ni les
messages. Aucun jeton d'accès Discord n'est conservé — il sert une fois,
au moment de l'échange, puis est jeté.

## Le déroulé de la connexion

1. Le site envoie le visiteur sur `/auth/discord/login?redirect=<le site>`.
2. Le Worker pose un cookie anti-CSRF et redirige vers Discord.
3. Discord renvoie sur `/auth/discord/callback` avec un `code`.
4. Le Worker vérifie le `state` **et** le cookie, échange le code, lit
   `/users/@me`, puis signe une session de 30 jours (HMAC-SHA256).
5. Retour sur le site avec `#token=…`. Le fragment n'est pas transmis au
   serveur qui héberge la page : le jeton n'apparaît donc ni dans les
   journaux de GitHub Pages ni dans un en-tête `Referer`. Le site le
   range dans `localStorage` et nettoie l'URL.
6. À chaque battement de présence, le jeton repart au Worker qui
   revérifie sa signature. Le navigateur ne peut pas se déclarer vérifié
   tout seul : l'identité est réécrite côté serveur.

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
| `GET /auth/discord/login?redirect=` | Redirige vers Discord | aucune |
| `GET /auth/discord/callback` | Retour Discord, délivre la session | aucune |
| `GET /auth/me` | Valide un jeton de session (401 sinon) | session |
| `POST /presence` | Durable Object (expiration après 65 s) | session facultative |
| `WS /presence/ws?token=` | Présence et sélection de lobby en temps réel | session facultative |
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

## Si le secret Discord fuit

Sur le portail développeur, **Reset Secret**, puis
`npx wrangler secret put DISCORD_CLIENT_SECRET`. Renouvelle aussi
`SESSION_SECRET` pour invalider les sessions déjà distribuées.

## Si le jeton OpenFront fuit

Déconnecte le compte de service depuis OpenFront (ça révoque la session),
récupère le nouveau `refreshToken` et refais `wrangler secret put`.
