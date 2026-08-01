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

   Le refreshToken n'est JAMAIS dans le code : c'est un secret Wrangler.
================================================================== */

const API = "https://api.openfront.io";

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

function cleanMember(input) {
  const id = String(input.id || "").trim().slice(0, 80);
  const pseudo = String(input.pseudo || "").trim().slice(0, 24);
  const gameId = String(input.gameId || "").trim().slice(0, 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id) || !pseudo) return null;
  return { id, pseudo, gameId, seenAt: Date.now() };
}

function publicMembers(members) {
  return Object.values(members)
    .sort((a, b) => a.pseudo.localeCompare(b.pseudo, "fr"))
    .map(({ id, pseudo, gameId }) => ({ id, pseudo, gameId }));
}

export class PresenceRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Méthode interdite" }), { status: 405 });
    }

    let body;
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: "JSON invalide" }), { status: 400 }); }

    const member = cleanMember(body);
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
    const member = cleanMember(body);
    if (!member) return;
    socket.serializeAttachment({ id: member.id });
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
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

const json = (body, env, request, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env, request) },
  });

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

      // --- Présence partagée entre tous les visiteurs du site ---
      if (path === "/presence/ws") {
        if (!originAllowed(env, request)) {
          return json(JSON.stringify({ error: "Origine interdite" }), env, request, 403);
        }
        const room = env.PRESENCE.get(env.PRESENCE.idFromName(env.CLAN_TAG || "GAL"));
        return room.fetch(request);
      }

      if (path === "/presence" && request.method === "POST") {
        const room = env.PRESENCE.get(env.PRESENCE.idFromName(env.CLAN_TAG || "GAL"));
        const response = await room.fetch(request);
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
