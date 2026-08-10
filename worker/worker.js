/* ==================================================================
   GAL — passerelle vers l'API OpenFront
   Cloudflare Worker. Deux rôles :

     1. Contourner le CORS : api.openfront.io n'autorise que l'origine
        openfront.io. Un navigateur ne peut donc pas l'appeler depuis
        notre site. Ce Worker relaie la réponse avec les bons en-têtes.

     2. Porter le compte de service : les routes /clans/{TAG}/members et
        /clans/{TAG}/games sont réservées aux membres du clan (403 pour
        un invité). Le Worker détient le refreshToken d'un compte membre
        et s'en sert pour obtenir un JWT.

     3. Porter la connexion Discord : le secret client OAuth2 ne peut pas
        vivre dans un site statique. Le Worker fait l'échange du code,
        lit l'identité Discord, et signe un jeton de session que le site
        renvoie ensuite à chaque battement de présence.

   Ni le refreshToken ni le secret Discord ne sont dans le code : ce sont
   des secrets Wrangler.
================================================================== */

const API = "https://api.openfront.io";
const DISCORD_API = "https://discord.com/api/v10";

/* Durée de la session Discord. Au-delà, le site repropose le bouton. */
const SESSION_TTL_S = 30 * 24 * 3600;

/* Fenêtre de validité du paramètre `state` de l'aller-retour OAuth. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/* Le JWT vit 900 s. On le garde en mémoire un peu moins pour ne pas
   rappeler /auth/refresh à chaque requête. La mémoire d'un Worker n'est
   pas partagée entre isolats : au pire on rafraîchit plusieurs fois,
   jamais un problème de correction. */
let cachedJwt = null;
let jwtExpiresAt = 0;

/* Cache des réponses. Les données de clan bougent lentement ; inutile de
   marteler leur API à chaque visiteur. */
const cache = new Map();

/* Une présence reste visible tant que le navigateur envoie son battement
   toutes les 20 s. Le Durable Object sérialise les mises à jour : deux
   visiteurs simultanés ne peuvent donc pas écraser la liste de l'autre. */
const PRESENCE_TTL_MS = 65000;

/* Une identité Discord vérifiée arrive au Durable Object par cet en-tête,
   posé par le Worker lui-même après contrôle de la signature. Le corps
   envoyé par le navigateur ne peut donc pas revendiquer `verified`. */
const IDENTITY_HEADER = "X-GAL-Identity";

/* Préfixe des identifiants issus de Discord. Un invité qui tenterait de
   se donner un id `d_…` serait refusé : sans cela, il suffirait de copier
   l'id d'un membre connecté pour usurper sa pastille. */
const DISCORD_ID_PREFIX = "d_";

function cleanMember(input, identity) {
  const id = identity ? identity.id : String(input.id || "").trim().slice(0, 80);
  const pseudo = identity
    ? identity.pseudo
    : String(input.pseudo || "").trim().slice(0, 24);
  const gameId = String(input.gameId || "").trim().slice(0, 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id) || !pseudo) return null;
  if (!identity && id.startsWith(DISCORD_ID_PREFIX)) return null;
  return {
    id,
    pseudo,
    gameId,
    avatar: identity ? identity.avatar || "" : "",
    verified: Boolean(identity),
    seenAt: Date.now(),
  };
}

function publicMembers(members) {
  return Object.values(members)
    .sort((a, b) => a.pseudo.localeCompare(b.pseudo, "fr"))
    .map(({ id, pseudo, gameId, avatar, verified }) =>
      ({ id, pseudo, gameId, avatar: avatar || "", verified: Boolean(verified) }));
}

/* ---------------- Jeton de session signé ---------------- */

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hmacKey(env) {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new HttpError(500, "SESSION_SECRET n'est pas configuré");
  return crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/* Signe `{payload}.{signature}`. Pas de JWT complet : on n'a besoin ni de
   l'en-tête d'algorithme ni de l'interopérabilité, et un format réduit
   laisse moins de place aux confusions d'algorithme. */
async function signPayload(env, payload) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/* Comparaison en temps constant : une comparaison `===` sur la signature
   fuit sa longueur commune, ce qui suffit à la reconstruire octet par
   octet quand on peut réessayer sans limite. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* Les mots de passe peuvent avoir des longueurs différentes. On compare
   donc leurs empreintes SHA-256, toujours de même taille, pour ne pas faire
   fuiter d'information par le temps de réponse. */
async function secretMatches(provided, expected) {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return timingSafeEqual(
    new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

async function verifyPayload(env, token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  let expected;
  try {
    expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body)));
  } catch { return null; }
  let given;
  try { given = b64urlDecode(sig); } catch { return null; }
  if (!timingSafeEqual(expected, given)) return null;
  try { return JSON.parse(new TextDecoder().decode(b64urlDecode(body))); }
  catch { return null; }
}

/* Identité vérifiée portée par un jeton de session, ou null. */
async function sessionIdentity(env, token) {
  const claims = await verifyPayload(env, token);
  if (!claims || !claims.sub) return null;
  if (Number(claims.exp || 0) * 1000 < Date.now()) return null;
  return {
    id: `${DISCORD_ID_PREFIX}${claims.sub}`,
    pseudo: String(claims.name || "").slice(0, 24),
    avatar: String(claims.avatar || "").slice(0, 200),
  };
}

export class PresenceRoom {
  constructor(state) {
    this.state = state;
  }

  /* L'identité vérifiée est fixée une fois pour toutes au moment de la
     poignée de main : la socket ne peut pas changer de propriétaire en
     cours de route. */
  readIdentity(request) {
    const raw = request.headers.get(IDENTITY_HEADER);
    if (!raw) return null;
    try { return JSON.parse(new TextDecoder().decode(b64urlDecode(raw))); }
    catch { return null; }
  }

  async fetch(request) {
    const identity = this.readIdentity(request);

    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      if (identity) server.serializeAttachment({ id: identity.id, identity });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Méthode interdite" }), { status: 405 });
    }

    let body;
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: "JSON invalide" }), { status: 400 }); }

    const member = cleanMember(body, identity);
    if (!member) {
      return new Response(JSON.stringify({ error: "Identité invalide" }), { status: 400 });
    }

    const members = await this.upsert(member);
    return new Response(JSON.stringify(this.payload(members)));
  }

  async activeMembers() {
    const now = Date.now();
    const members = await this.state.storage.get("members") || {};
    for (const [id, member] of Object.entries(members)) {
      if (!member || now - Number(member.seenAt || 0) > PRESENCE_TTL_MS) delete members[id];
    }
    return members;
  }

  async upsert(member) {
    const members = await this.activeMembers();
    members[member.id] = member;
    await this.state.storage.put("members", members);
    return members;
  }

  payload(members) {
    const list = publicMembers(members);
    return { members: list, online: list.map(member => member.pseudo) };
  }

  async broadcast() {
    const payload = JSON.stringify(this.payload(await this.activeMembers()));
    for (const socket of this.state.getWebSockets()) {
      try { socket.send(payload); } catch { /* connexion déjà fermée */ }
    }
  }

  async webSocketMessage(socket, message) {
    let body;
    try { body = JSON.parse(String(message)); }
    catch { return; }
    const attached = socket.deserializeAttachment();
    const identity = (attached && attached.identity) || null;
    const member = cleanMember(body, identity);
    if (!member) return;
    socket.serializeAttachment({ id: member.id, identity });
    await this.upsert(member);
    await this.broadcast();
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment();
    const id = attachment && attachment.id;
    if (id) {
      const stillConnected = this.state.getWebSockets().some(other => {
        if (other === socket) return false;
        const data = other.deserializeAttachment();
        return data && data.id === id;
      });
      if (!stillConnected) {
        const members = await this.activeMembers();
        delete members[id];
        await this.state.storage.put("members", members);
      }
    }
    await this.broadcast();
  }
}

async function getJwt(env) {
  if (cachedJwt && Date.now() < jwtExpiresAt) return cachedJwt;

  const token = env.OF_REFRESH_TOKEN;
  if (!token) throw new HttpError(500, "OF_REFRESH_TOKEN n'est pas configuré");

  const res = await fetch(`${API}/auth/refresh`, {
    method: "POST",
    headers: {
      // Le cookie que le navigateur enverrait normalement. Vérifié : le
      // serveur ne fait pas tourner ce jeton, la même valeur reste valable.
      Cookie: `refreshToken=${token}`,
      Origin: "https://openfront.io",
    },
  });
  if (!res.ok) throw new HttpError(502, `auth/refresh a répondu ${res.status}`);

  const { jwt, expiresIn } = await res.json();
  if (!jwt) throw new HttpError(502, "auth/refresh n'a pas renvoyé de JWT");

  cachedJwt = jwt;
  jwtExpiresAt = Date.now() + Math.max(60, (expiresIn || 900) - 60) * 1000;
  return jwt;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------------- Mise à jour admin du refreshToken ---------------- */

/* Un secret Worker ne peut pas être modifié depuis le runtime : on passe
   par l'API Cloudflare. Nécessite CF_API_TOKEN (avec le
   scope Account > Workers Scripts > Edit) et CF_ACCOUNT_ID (variable
   publique dans wrangler.toml). ADMIN_PASSWORD protège la route. */
async function updateRefreshToken(env, adminPassword, newToken) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) throw new HttpError(503, "La mise à jour admin n'est pas configurée");
  if (!(await secretMatches(adminPassword, expected))) {
    throw new HttpError(403, "Mot de passe admin incorrect");
  }
  if (!TOKEN_RE.test(newToken)) {
    throw new HttpError(400, "refreshToken invalide : 64 caractères hexadécimaux attendus");
  }

  /* Tester le token avant de toucher au secret partagé. Un mauvais copier-
     coller ne doit jamais casser les statistiques pour tous les visiteurs. */
  const validation = await fetch(`${API}/auth/refresh`, {
    method: "POST",
    headers: {
      Cookie: `refreshToken=${newToken}`,
      Origin: "https://openfront.io",
    },
  });
  if (!validation.ok) {
    throw new HttpError(400, "Ce refresh token est refusé par OpenFront");
  }
  const grant = await validation.json();
  if (!grant.jwt) {
    throw new HttpError(400, "OpenFront n'a pas renvoyé de JWT pour ce token");
  }

  const apiToken = env.CF_API_TOKEN;
  if (!apiToken) throw new HttpError(500, "CF_API_TOKEN n'est pas configuré");
  const accountId = env.CF_ACCOUNT_ID;
  if (!accountId) throw new HttpError(500, "CF_ACCOUNT_ID n'est pas configuré");
  const scriptName = env.CF_SCRIPT_NAME || "gal-openfront";

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  /* PUT ajoute ou remplace le secret en une seule opération. Ne jamais faire
     DELETE puis PUT : un échec intermédiaire couperait le site pour tous. */
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/secrets`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "OF_REFRESH_TOKEN",
        text: newToken,
        type: "secret_text",
      }),
    },
  );

  if (!res.ok) {
    console.error(JSON.stringify({
      message: "Échec de mise à jour du secret OF_REFRESH_TOKEN",
      status: res.status,
    }));
    throw new HttpError(502, "Cloudflare n'a pas pu enregistrer le nouveau token");
  }

  // Réutiliser le JWT obtenu pendant la validation dans l'isolat courant.
  cachedJwt = grant.jwt;
  jwtExpiresAt = Date.now() + Math.max(60, (grant.expiresIn || 900) - 60) * 1000;

  return { ok: true };
}

const TOKEN_RE = /^[a-f0-9]{64}$/;

async function callApi(path, { env, auth = false, ttl = 0 } = {}) {
  const key = (auth ? "a:" : "p:") + path;
  const hit = cache.get(key);
  if (ttl && hit && Date.now() < hit.until) return hit.body;

  const headers = { Accept: "application/json", Origin: "https://openfront.io" };
  if (auth) headers.Authorization = `Bearer ${await getJwt(env)}`;

  const res = await fetch(API + path, { headers });
  const body = await res.text();

  if (!res.ok) {
    // Un 401 vient presque toujours d'un JWT périmé : on le jette pour
    // que la requête suivante en redemande un.
    if (res.status === 401) { cachedJwt = null; jwtExpiresAt = 0; }
    throw new HttpError(res.status, body.slice(0, 300));
  }

  if (ttl) cache.set(key, { body, until: Date.now() + ttl * 1000 });
  return body;
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "*")
    .split(",").map(s => s.trim()).filter(Boolean);
}

function originAllowed(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins(env);
  return !origin || allowed.includes("*") || allowed.includes(origin);
}

function corsHeaders(env, request) {
  const allowed = allowedOrigins(env);
  const origin = request.headers.get("Origin") || "";
  const allow = allowed.includes("*") ? "*"
              : allowed.includes(origin) ? origin
              : allowed[0] || "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

/* ---------------- Connexion Discord ---------------- */

/* Ne renvoyer le visiteur que vers une origine de la liste blanche : sans
   ce contrôle, `?redirect=` transformerait le Worker en redirection
   ouverte, et le jeton de session partirait chez qui le demande. */
function safeRedirect(env, target, fallback) {
  const allowed = allowedOrigins(env);
  try {
    const url = new URL(target);
    // Le fragment est réécrit au retour : on repart d'une URL sans hash.
    url.hash = "";
    if (allowed.includes("*") || allowed.includes(url.origin)) return url.toString();
  } catch { /* URL absente ou invalide */ }
  return fallback;
}

function cookieValue(request, name) {
  const jar = request.headers.get("Cookie") || "";
  const hit = jar.split(";").map(part => part.trim())
    .find(part => part.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
}

const OAUTH_COOKIE = "gal_oauth_state";

function stateCookie(value, url, maxAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${OAUTH_COOKIE}=${encodeURIComponent(value)}; Path=/auth; Max-Age=${maxAge}` +
         `; HttpOnly; SameSite=Lax${secure}`;
}

function avatarUrl(user) {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  }
  // Avatar par défaut : Discord le dérive de l'identifiant lui-même.
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

async function discordLogin(env, request, url) {
  const clientId = env.DISCORD_CLIENT_ID;
  if (!clientId) throw new HttpError(500, "DISCORD_CLIENT_ID n'est pas configuré");

  const fallback = allowedOrigins(env).find(o => o !== "*") || "/";
  const back = safeRedirect(env, url.searchParams.get("redirect"), fallback);

  const nonce = crypto.randomUUID();
  const state = await signPayload(env, { n: nonce, r: back, t: Date.now() });

  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", `${url.origin}/auth/discord/callback`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("prompt", "none");
  authorize.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": stateCookie(nonce, url, 600),
    },
  });
}

async function discordCallback(env, request, url) {
  const denied = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const claims = await verifyPayload(env, url.searchParams.get("state"));
  const fallback = allowedOrigins(env).find(o => o !== "*") || "/";
  const back = claims ? safeRedirect(env, claims.r, fallback) : fallback;

  const bounce = hash => new Response(null, {
    status: 302,
    headers: { Location: back + hash, "Set-Cookie": stateCookie("", url, 0) },
  });

  // L'utilisateur a refusé sur l'écran Discord : ce n'est pas une panne.
  if (denied) return bounce("#discord=denied");

  if (!claims || !code) return bounce("#discord=error");
  if (Date.now() - Number(claims.t || 0) > OAUTH_STATE_TTL_MS) return bounce("#discord=expired");
  if (!claims.n || claims.n !== cookieValue(request, OAUTH_COOKIE)) {
    // Le `state` signé ne prouve rien seul : il faut qu'il vienne du même
    // navigateur que celui qui a lancé la connexion.
    return bounce("#discord=error");
  }

  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new HttpError(500, "Application Discord non configurée");

  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/auth/discord/callback`,
    }),
  });
  if (!tokenRes.ok) return bounce("#discord=error");
  const grant = await tokenRes.json();

  const userRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${grant.access_token}` },
  });
  if (!userRes.ok) return bounce("#discord=error");
  const user = await userRes.json();

  // Le jeton d'accès Discord ne sert qu'ici : on ne le garde pas. La
  // session du site est notre propre jeton signé, limité à ce dont le
  // site a besoin.
  const session = await signPayload(env, {
    sub: user.id,
    name: String(user.global_name || user.username || "").slice(0, 24),
    avatar: avatarUrl(user),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
  });

  return bounce(`#token=${encodeURIComponent(session)}`);
}

const json = (body, env, request, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env, request) },
  });

/* Recopie la requête vers le Durable Object en y ajoutant l'identité
   vérifiée. L'en-tête est systématiquement retiré d'abord : un visiteur
   pourrait sinon le poser lui-même et arriver « vérifié ». */
async function withIdentity(env, request, token) {
  const headers = new Headers(request.headers);
  headers.delete(IDENTITY_HEADER);
  const identity = token ? await sessionIdentity(env, token) : null;
  if (identity) {
    headers.set(IDENTITY_HEADER, b64urlEncode(enc.encode(JSON.stringify(identity))));
  }
  return new Request(request, { headers });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const tag = encodeURIComponent((env.CLAN_TAG || "GAL").toUpperCase());
    const qs = url.searchParams;

    try {
      // --- Fiche du clan (un jeton invité suffirait, mais autant réutiliser) ---
      if (path === "/clan") {
        return json(await callApi(`/clans/${tag}`, { env, auth: true, ttl: 600 }), env, request);
      }

      // --- Membres : réservé aux membres du clan, d'où le compte de service ---
      if (path === "/members") {
        const page = Number(qs.get("page") || 1);
        const size = Math.min(Number(qs.get("pageSize") || 50), 100);
        return json(
          await callApi(`/clans/${tag}/members?page=${page}&pageSize=${size}`,
                        { env, auth: true, ttl: 300 }),
          env, request);
      }

      // --- Historique officiel du clan ---
      if (path === "/games") {
        const params = new URLSearchParams();
        const filter = qs.get("filter");
        const cursor = qs.get("cursor");
        if (["ffa", "team", "hvn", "ranked"].includes(filter)) params.set("filter", filter);
        if (cursor) params.set("cursor", cursor);
        const suffix = params.toString() ? `?${params}` : "";
        return json(
          await callApi(`/clans/${tag}/games${suffix}`,
                        { env, auth: true, ttl: 60 }),
          env, request);
      }

      // --- Scores pondérés officiels, une ligne par partie du clan ---
      if (path === "/sessions") {
        const params = new URLSearchParams();
        const start = qs.get("start");
        const end = qs.get("end");
        const page = Math.max(1, Number(qs.get("page") || 1));
        const limit = Math.min(50, Math.max(1, Number(qs.get("limit") || 50)));
        if (start && !Number.isNaN(Date.parse(start))) params.set("start", start);
        if (end && !Number.isNaN(Date.parse(end))) params.set("end", end);
        params.set("page", String(page));
        params.set("limit", String(limit));
        return json(
          await callApi(`/public/clan/${tag}/sessions?${params}`, { env, ttl: 60 }),
          env, request);
      }

      // --- Historique public d'un joueur (aucune authentification requise) ---
      const player = path.match(/^\/player\/([A-Za-z0-9_-]{1,64})\/games$/);
      if (player) {
        const p = new URLSearchParams();
        for (const k of ["filter", "type", "cursor"]) {
          const v = qs.get(k);
          if (v) p.set(k, v);
        }
        const suffix = p.toString() ? `?${p}` : "";
        return json(
          await callApi(`/public/player/${encodeURIComponent(player[1])}/games${suffix}`,
                        { env, ttl: 120 }),
          env, request);
      }

      // --- Fiche publique d'un joueur ---
      const profile = path.match(/^\/player\/([A-Za-z0-9_-]{1,64})$/);
      if (profile) {
        return json(
          await callApi(`/public/player/${encodeURIComponent(profile[1])}`, { env, ttl: 300 }),
          env, request);
      }

      // --- Classement des clans (public) ---
      if (path === "/leaderboard") {
        return json(await callApi(`/public/clans/leaderboard`, { env, ttl: 600 }), env, request);
      }

      // --- Connexion Discord ---
      // `await` obligatoire : sans lui, la promesse est renvoyée telle
      // quelle et son rejet échappe au try/catch. Le Worker plante alors
      // en 1101 au lieu de rendre une erreur lisible.
      if (path === "/auth/discord/login") return await discordLogin(env, request, url);
      if (path === "/auth/discord/callback") return await discordCallback(env, request, url);

      // Permet au site de savoir si son jeton stocké vaut encore quelque
      // chose, sans attendre le premier battement de présence.
      if (path === "/auth/me") {
        const token = url.searchParams.get("token")
          || (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        const identity = await sessionIdentity(env, token);
        return json(JSON.stringify(identity
          ? { authenticated: true, ...identity }
          : { authenticated: false }), env, request, identity ? 200 : 401);
      }

      // --- Mise à jour du refreshToken OpenFront (admin) ---
      // Le secret OF_REFRESH_TOKEN est immuable depuis le runtime : on le
      // remplace atomiquement via l'API Cloudflare.
      // Protégé par ADMIN_PASSWORD (un secret) + vérification d'origine.
      if (path === "/admin/update-token" && request.method === "POST") {
        if (!originAllowed(env, request)) {
          return json(JSON.stringify({ error: "Origine interdite" }), env, request, 403);
        }
        let body;
        try { body = await request.json(); }
        catch { throw new HttpError(400, "JSON invalide"); }
        if (!body || typeof body !== "object") {
          throw new HttpError(400, "Corps de requête invalide");
        }
        const result = await updateRefreshToken(
          env, String(body.adminPassword || ""), String(body.refreshToken || ""));
        return json(JSON.stringify(result), env, request);
      }

      // --- Présence partagée entre tous les visiteurs du site ---
      if (path === "/presence/ws") {
        if (!originAllowed(env, request)) {
          return json(JSON.stringify({ error: "Origine interdite" }), env, request, 403);
        }
        const room = env.PRESENCE.get(env.PRESENCE.idFromName(env.CLAN_TAG || "GAL"));
        return await room.fetch(await withIdentity(env, request, url.searchParams.get("token")));
      }

      if (path === "/presence" && request.method === "POST") {
        const room = env.PRESENCE.get(env.PRESENCE.idFromName(env.CLAN_TAG || "GAL"));
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        const response = await room.fetch(await withIdentity(env, request, token));
        return json(await response.text(), env, request, response.status);
      }

      if (path === "/health") {
        return json(JSON.stringify({ ok: true, clan: env.CLAN_TAG || "GAL" }), env, request);
      }

      return json(JSON.stringify({ error: "Route inconnue", path }), env, request, 404);

    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return json(JSON.stringify({ error: err.message || "erreur" }), env, request, status);
    }
  },
};
