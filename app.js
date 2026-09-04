/* ==================================================================
   GAL — Lobbies OpenFront
   Site 100 % statique, sans aucun réglage : les lobbies viennent du
   WebSocket public d'OpenFront.io et s'affichent en trois colonnes.
   Le seul fichier à modifier est team.config.js.
================================================================== */
(() => {
"use strict";

/* ---------------- Constantes ---------------- */

const WORKERS   = ["w0", "w1", "w2", "w3", "w4"];
const WS_URL    = w => `wss://openfront.io/${w}/lobbies`;
const JOIN_URL  = id => `https://openfront.io/game/${encodeURIComponent(id)}`;
const THUMB_URL = slug => `assets/maps/${encodeURIComponent(slug)}.webp`;

const COLUMNS = [
  { cat: "ffa",     cards: "colFfa",     count: "countFfa" },
  { cat: "team",    cards: "colTeam",    count: "countTeam" },
  { cat: "special", cards: "colSpecial", count: "countSpecial" },
];

/* Libellés des modificateurs connus. Ceux que le serveur ajoutera plus tard
   sont libellés automatiquement à partir de leur nom. */
const MOD_LABEL = new Map(Object.entries({
  compact:        "Compact",
  hardNations:    "Nations difficiles",
  waterNukes:     "Nukes marines",
  noNations:      "Sans nations",
  infiniteGold:   "Or infini",
  infiniteTroops: "Troupes infinies",
  instantBuild:   "Build instantané",
  randomSpawn:    "Spawn aléatoire",
  donateGold:     "Don d'or",
  donateTroops:   "Don de troupes",
  noClanTags:     "Sans tags de clan",
  disabledUnits:  "Unités désactivées",
}));

/* Modificateurs présents sur presque toutes les parties : les afficher
   revient à couvrir chaque carte de bulles sans rien apprendre à personne.
   Tout le reste — y compris les modificateurs inédits — est affiché. */
const DULL_MODS = new Set(["donateGold", "donateTroops", "noClanTags", "noNations"]);

/* Clés de publicGameModifiers déjà couvertes par modsOf(). */
const KNOWN_PM = new Set(["isCompact", "isHardNations", "isWaterNukes"]);

const SORTS = {
  playersDesc:  (a, b) => b.players - a.players || a.map.localeCompare(b.map),
  playersAsc:   (a, b) => a.players - b.players || a.map.localeCompare(b.map),
  capacityDesc: (a, b) => b.capacity - a.capacity || b.players - a.players,
  capacityAsc:  (a, b) => a.capacity - b.capacity || b.players - a.players,
  starts:       (a, b) => (a.startsAt || Infinity) - (b.startsAt || Infinity),
  map:          (a, b) => a.map.localeCompare(b.map) || b.players - a.players,
};

/* ---------------- État ---------------- */

const state = {
  ws: null,
  wsGen: 0,
  retries: 0,
  status: "connecting",
  wasOffline: false,
  clockOffset: 0,        // serverTime - Date.now()
  games: new Map(),
  order: [],             // ids, ordre figé (voir orderedGames)
  orderSig: "",
  clientId: "",
  pseudo: "",
  token: "",              // jeton de session Discord signé par le Worker
  identity: null,         // { id, pseudo, avatar } quand la connexion est vérifiée
  teamStats: null,        // dernier calcul de calculateTeamStats()
  roster: new Map(),      // pseudo OpenFront (minuscules) -> { publicId, username }
  rosterState: "idle",    // idle | loading | ready | error
  ofAccount: null,        // { publicId, username } compte OpenFront lié
  ofStats: null,          // stats personnelles calculées
  ofStatsFor: "",         // publicId auquel ofStats correspond
  online: [],
  members: [],
  presenceError: false,
  presenceWs: null,
  presenceReconnect: 0,
  rallyId: "",
  renderQueued: false,
  domStale: false,
  cardEls: new Map(),
};

const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const now = () => Date.now() + state.clockOffset;
const clanName = () => String((window.TEAM && window.TEAM.name) || "la team");

/* ---------------- Normalisation ---------------- */

function mapSlug(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* `playerTeams` change de nature selon le lobby :
     - nombre  -> c'est le NOMBRE d'équipes
     - "Duos" / "Trios" / "Quads" -> c'est la TAILLE d'une équipe
     - "Humans Vs Nations" -> mode à part, sans équipes
   Confondre les deux affiche n'importe quoi, d'où cette normalisation. */
const TEAM_WORDS = { duos: 2, trios: 3, quads: 4, quints: 5, sextets: 6 };
const SIZE_WORDS = { 2: "Duos", 3: "Trios", 4: "Quads" };

function teamShape(playerTeams, capacity) {
  if (typeof playerTeams === "number" && playerTeams > 0) {
    return {
      teams: playerTeams,
      perTeam: capacity ? Math.floor(capacity / playerTeams) : 0,
      hvn: false,
    };
  }
  if (typeof playerTeams === "string") {
    const key = playerTeams.trim().toLowerCase();
    if (key === "humans vs nations") return { teams: 0, perTeam: 0, hvn: true };
    const size = TEAM_WORDS[key];
    if (size) {
      return { teams: capacity ? Math.floor(capacity / size) : 0, perTeam: size, hvn: false };
    }
  }
  return { teams: 0, perTeam: 0, hvn: false };
}

function pmKey(k) {
  const bare = k.replace(/^is(?=[A-Z])/, "");
  return bare.charAt(0).toLowerCase() + bare.slice(1);
}

function humanize(k) {
  return k.replace(/^is(?=[A-Z])/, "")
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/^./, c => c.toUpperCase());
}

function modsOf(cfg) {
  const set = new Set();
  const pm = cfg.publicGameModifiers || {};

  if (pm.isCompact || cfg.gameMapSize === "Compact") set.add("compact");
  if (pm.isHardNations) set.add("hardNations");
  if (pm.isWaterNukes || cfg.waterNukes) set.add("waterNukes");
  if (cfg.nations === "disabled") set.add("noNations");
  if (cfg.infiniteGold) set.add("infiniteGold");
  if (cfg.infiniteTroops) set.add("infiniteTroops");
  if (cfg.instantBuild) set.add("instantBuild");
  if (cfg.randomSpawn) set.add("randomSpawn");
  if (cfg.donateGold) set.add("donateGold");
  if (cfg.donateTroops) set.add("donateTroops");
  if (cfg.disableClanTags) set.add("noClanTags");
  if (Array.isArray(cfg.disabledUnits) && cfg.disabledUnits.length) set.add("disabledUnits");

  // `isRandomSpawn` doit retomber sur la même clé que `cfg.randomSpawn`,
  // sinon le même modificateur apparaît deux fois.
  for (const [k, v] of Object.entries(pm)) {
    if (v !== true || KNOWN_PM.has(k)) continue;
    const key = pmKey(k);
    set.add(key);
    if (!MOD_LABEL.has(key)) MOD_LABEL.set(key, humanize(k));
  }
  return set;
}

/* Modificateurs à valeur numérique (goldMultiplier, startingGold…). */
function extrasOf(cfg) {
  const pm = cfg.publicGameModifiers || {};
  const out = [];
  for (const [k, v] of Object.entries(pm)) {
    if (typeof v !== "number") continue;
    if (k === "goldMultiplier") out.push(`Or ×${v}`);
    else if (k === "startingGold") out.push(`${compactNumber(v)} d'or au départ`);
    else out.push(`${humanize(k)} ${v.toLocaleString("fr-FR")}`);
  }
  return out;
}

function compactNumber(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(0)} k`;
  return String(n);
}

function normalize(raw) {
  const cfg = raw.gameConfig || {};
  const capacity = Number(cfg.maxPlayers) || 0;
  const shape = teamShape(cfg.playerTeams, capacity);
  const mods = modsOf(cfg);
  return {
    id: raw.gameID,
    cat: raw.publicGameType || "ffa",
    players: Number(raw.numClients) || 0,
    capacity,
    map: cfg.gameMap || "?",
    slug: mapSlug(cfg.gameMap),
    difficulty: cfg.difficulty || "",
    bots: Number(cfg.bots) || 0,
    teams: shape.teams,
    perTeam: shape.perTeam,
    hvn: shape.hvn,
    // Absent tant que le lobby est vide : le serveur ne lance le décompte
    // qu'à partir du premier joueur connecté.
    startsAt: Number(raw.startsAt) || 0,
    badges: [
      ...[...mods].filter(k => !DULL_MODS.has(k)).map(k => MOD_LABEL.get(k) || k),
      ...extrasOf(cfg),
    ],
  };
}

/* ---------------- WebSocket ---------------- */

/* Sans header, l'état de la connexion n'est plus affiché en permanence.
   On signale donc les transitions par un toast, pour qu'une liste figée
   ne puisse pas passer pour à jour. */
function setStatus(kind) {
  state.status = kind;
  if (kind === "off" && !state.wasOffline) {
    state.wasOffline = true;
    toast("Connexion perdue — reconnexion…", "bad");
  } else if (kind === "live" && state.wasOffline) {
    state.wasOffline = false;
    toast("Reconnecté", "ok");
  }
  scheduleRender();
}

function connect() {
  closeSocket();
  const gen = ++state.wsGen;
  const worker = WORKERS[Math.floor(Math.random() * WORKERS.length)];
  setStatus("connecting");

  let ws;
  try {
    ws = new WebSocket(WS_URL(worker));
  } catch {
    scheduleReconnect(gen);
    return;
  }
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  ws.onopen = () => {
    if (gen !== state.wsGen) return;
    state.retries = 0;
    setStatus("live");
  };
  ws.onmessage = ev => {
    if (gen !== state.wsGen) return;
    let msg;
    try {
      msg = typeof ev.data === "string"
        ? JSON.parse(ev.data)
        : window.OpenFrontLobbyWire.decodeLobbyMessage(ev.data);
    } catch (error) {
      console.error("Trame de lobbies OpenFront illisible", error);
      try { ws.close(); } catch { /* deja ferme */ }
      return;
    }
    applyMessage(msg);
  };
  ws.onclose = () => { if (gen === state.wsGen) scheduleReconnect(gen); };
  ws.onerror = () => { try { ws.close(); } catch { /* déjà fermé */ } };
}

function closeSocket() {
  if (!state.ws) return;
  const ws = state.ws;
  state.ws = null;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  try { ws.close(); } catch { /* déjà fermé */ }
}

function scheduleReconnect(gen) {
  if (gen !== state.wsGen) return;
  state.retries++;
  const delay = Math.min(1000 * 2 ** (state.retries - 1), 15000);
  setStatus("off");
  setTimeout(() => { if (gen === state.wsGen) connect(); }, delay);
}

function applyMessage(msg) {
  if (typeof msg.serverTime === "number") {
    state.clockOffset = msg.serverTime - Date.now();
  }

  if (msg.type === "counts" && msg.counts) {
    for (const [id, n] of Object.entries(msg.counts)) {
      const g = state.games.get(id);
      if (g) g.players = Number(n) || 0;
    }
  } else if (msg.games) {
    // Snapshot complet : il fait autorité, les lobbies absents ont disparu.
    const next = new Map();
    for (const list of Object.values(msg.games)) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        if (!raw || !raw.gameID) continue;
        next.set(raw.gameID, normalize(raw));
      }
    }
    state.games = next;
  } else {
    return;
  }

  scheduleRender();
}

/* ---------------- Sélection & ordre ---------------- */

/* L'ordre initial suit le tri configuré. Ensuite, les cartes déjà visibles
   gardent leur ordre relatif et les nouveaux lobbies sont ajoutés à la fin :
   une disparition ne doit jamais provoquer un second tri haut-bas. */
function orderedGames() {
  const conf = (window.TEAM && window.TEAM.defaultView) || {};
  const sig = [...state.games.keys()].sort().join(",");

  if (sig !== state.orderSig) {
    const liveIds = new Set(state.games.keys());
    const survivors = state.order.filter(id => liveIds.has(id));
    const known = new Set(survivors);
    const newcomers = [...state.games.values()]
      .filter(game => !known.has(game.id))
      .sort(SORTS[conf.sort] || SORTS.playersDesc)
      .map(g => g.id);
    state.order = [...survivors, ...newcomers];
    state.orderSig = sig;
  }

  let list = state.order.map(id => state.games.get(id)).filter(Boolean);

  if (conf.hideEmpty) list = list.filter(g => g.players > 0);
  if (conf.type && conf.type !== "all") {
    list = list.filter(g => conf.type === "hvn" ? g.hvn : g.cat === conf.type);
  }
  return list;
}

/* ---------------- Rendu ---------------- */

function countdown(g) {
  if (!g.startsAt) return "en attente";   // lobby vide : pas encore d'heure de départ
  const ms = g.startsAt - now();
  if (ms <= 0) return "en cours";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")}` : `${s} s`;
}

function modeLabel(g) {
  if (g.hvn) return "Humains vs Nations";
  if (g.teams > 0) {
    const word = SIZE_WORDS[g.perTeam];
    return word ? `${word} · ${g.teams} équipes` : `${g.teams} équipes de ${g.perTeam}`;
  }
  return "Free For All";
}

/* Volontairement en setTimeout et pas en requestAnimationFrame : rAF est gelé
   dans un onglet en arrière-plan, où l'on veut continuer à suivre les lobbies. */
function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  setTimeout(() => { state.renderQueued = false; render(); }, 120);
}

function stopCardMove(node) {
  const animation = node._moveAnimation;
  if (!animation) return;
  node._moveAnimation = null;
  animation.cancel();
  node.classList.remove("moving");
}

/* FLIP : mémorise la position réellement visible avant le nouveau tri, puis
   ramène chaque survivante vers sa nouvelle cellule par un seul glissement. */
function snapshotCardPositions(live) {
  const positions = new Map();
  for (const [id, node] of state.cardEls) {
    if (!live.has(id) || !node.isConnected) continue;
    positions.set(id, node.getBoundingClientRect());
    stopCardMove(node);
  }
  return positions;
}

function animateCardReflow(positions) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  for (const [id, first] of positions) {
    const node = state.cardEls.get(id);
    if (!node || !node.isConnected) continue;

    const last = node.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

    node.classList.add("moving");
    const animation = node.animate([
      { transform: `translate3d(${dx}px, ${dy}px, 0)` },
      { transform: "translate3d(0, 0, 0)" },
    ], {
      duration: 420,
      easing: "cubic-bezier(.22, 1, .36, 1)",
    });
    node._moveAnimation = animation;

    const cleanup = () => {
      if (node._moveAnimation !== animation) return;
      node._moveAnimation = null;
      node.classList.remove("moving");
    };
    animation.onfinish = cleanup;
    animation.oncancel = cleanup;
  }
}

function render() {
  // Onglet caché : on saute la mise à jour du DOM, on la rejouera au retour.
  if (document.hidden) { state.domStale = true; return; }
  state.domStale = false;

  const list = orderedGames();
  const buckets = { ffa: [], team: [], special: [] };
  for (const g of list) (buckets[g.cat] || buckets.special).push(g);

  const live = new Set(list.map(g => g.id));
  const previousPositions = snapshotCardPositions(live);
  if (state.rallyId && !live.has(state.rallyId)) {
    state.rallyId = "";
    const self = state.members.find(member => member.id === selfId());
    if (self) self.gameId = "";
    sendHeartbeat();
  }
  for (const [id, node] of state.cardEls) {
    if (!live.has(id)) {
      // La carte sortante devient un calque à sa position exacte : elle peut
      // s'animer sans occuper une rangée de grille ni pousser les survivantes.
      const host = node.parentElement;
      const hostRect = host.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      stopCardMove(node);
      Object.assign(node.style, {
        left: `${rect.left - hostRect.left}px`,
        top: `${rect.top - hostRect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      state.cardEls.delete(id);
      node.classList.add("leaving");
      setTimeout(() => node.remove(), 300);
    }
  }

  for (const col of COLUMNS) {
    const games = buckets[col.cat];
    $(col.count).textContent = games.length;
    const host = $(col.cards);
    const desiredNodes = [];
    for (const g of games) {
      let node = state.cardEls.get(g.id);
      if (!node) { node = buildCard(g); state.cardEls.set(g.id, node); }
      updateCard(node, g);
      desiredNodes.push(node);
    }

    // Les trames `counts` arrivent ~2 fois/s : ne jamais déplacer les cartes
    // si leur ordre n'a pas changé, sinon le navigateur perd l'état :hover et
    // la cellule clignote sous la souris.
    const currentNodes = [...host.children]
      .filter(node => !node.classList.contains("leaving"));
    const orderChanged = currentNodes.length !== desiredNodes.length ||
      desiredNodes.some((node, i) => currentNodes[i] !== node);
    if (orderChanged) {
      const fragment = document.createDocumentFragment();
      for (const node of desiredNodes) fragment.append(node);
      host.append(fragment);
    }
  }

  animateCardReflow(previousPositions);

  const offline = state.status === "off";
  $("emptyTitle").textContent = offline
    ? "OpenFront demande une vérification."
    : "Aucun lobby ouvert pour le moment.";
  $("emptyText").textContent = offline
    ? "Ouvre OpenFront une fois, laisse la page se charger, puis reviens ici."
    : "La liste se met à jour toute seule.";
  $("unlockLobbies").hidden = !offline;
  $("emptyState").hidden = list.length > 0 || state.status === "connecting";
  $("board").hidden = list.length === 0 && state.status !== "connecting";
}

function buildCard(g) {
  const card = el("article", "card entering");
  card.dataset.id = g.id;
  card.tabIndex = 0;
  card.setAttribute("role", "link");

  // OpenFront refuse l'iframe : on ouvre donc la partie dans un nouvel onglet.
  // Le focus final reste une décision du navigateur, mais on redemande aussitôt
  // le focus pour garder le tableau de lobbies actif quand il l'autorise.
  const open = () => {
    selectRally(g.id);
    window.open(JOIN_URL(g.id), "_blank", "noopener,noreferrer");
    window.focus();
  };
  card.addEventListener("click", open);
  card.addEventListener("keydown", e => {
    if (e.target !== card) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });

  const image = el("div", "cardImage");
  const img = el("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = "";
  img.src = THUMB_URL(g.slug);
  img.onerror = () => {
    image.classList.add("mapImageMissing");
    img.remove();
  };
  const bar = el("div", "cardBar");
  bar.append(el("i"));
  const rally = el("div", "cardRally");
  image.append(img, rally, bar);

  const text = el("div", "cardText");
  text.append(el("div", "cardTitle"), el("div", "cardMode"), el("div", "badges"));

  const side = el("div", "cardSide");
  side.append(el("span", "players"), el("span", "time"));

  card.append(image, text, side);
  setTimeout(() => card.classList.remove("entering"), 340);
  return card;
}

function updateCard(card, g) {
  const full = g.players >= g.capacity;
  const pct = g.capacity ? Math.min(100, (g.players / g.capacity) * 100) : 0;
  const soon = g.startsAt > 0 && g.startsAt - now() < 30000;

  const time = card.querySelector(".time");
  time.className = "time" + (soon ? " soon" : "") + (g.startsAt ? "" : " idle");
  time.textContent = countdown(g);

  const players = card.querySelector(".players");
  players.className = "players" + (full ? " full" : "");
  players.textContent = `${g.players} / ${g.capacity}`;

  const fill = card.querySelector(".cardBar > i");
  fill.className = full ? "full" : "";
  fill.style.setProperty("--progress", String(pct / 100));

  card.querySelector(".cardTitle").textContent = g.map;
  card.querySelector(".cardMode").textContent =
    `${modeLabel(g)} · ${g.difficulty} · ${g.bots} bots`;

  renderCardRally(card.querySelector(".cardRally"), g.id);

  const badges = card.querySelector(".badges");
  if (badges.dataset.sig !== g.badges.join("|")) {
    badges.dataset.sig = g.badges.join("|");
    badges.innerHTML = "";
    for (const b of g.badges) badges.append(el("span", "badge", b));
  }

  card.classList.toggle("rallied", g.id === state.rallyId);
}

/* ---------------- Présence ---------------- */

/* Le pseudo est retenu dans ce navigateur : au retour, l'utilisateur est
   reconnu sans rien resaisir.

   La LISTE des membres en ligne, elle, ne peut pas venir du navigateur :
   deux onglets sur deux machines ne partagent rien. Il faut un point de
   rendez-vous commun, d'où `TEAM.presenceApi`. Tant qu'il n'est pas
   renseigné, on n'affiche que soi et on le dit clairement plutôt que de
   faire croire à une liste vide. */

const PRESENCE_KEY = "of.pseudo";
const CLIENT_ID_KEY = "of.client-id";
const SESSION_KEY = "of.session";
const HEARTBEAT_MS = 20000;
const STATS_REFRESH_MS = 5 * 60 * 1000;
const FEED_TARGET = 25;
const FEED_MAX_PAGES = 5;

function loadPseudo() {
  try { return localStorage.getItem(PRESENCE_KEY) || ""; } catch { return ""; }
}
function savePseudo(name) {
  try { localStorage.setItem(PRESENCE_KEY, name); } catch { /* quota */ }
}

function loadClientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY) || "";
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
      id = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `gal_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return `gal_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

/* ---------------- Connexion Discord ----------------

   Le secret OAuth ne peut pas vivre dans un site statique : c'est le
   Worker qui fait l'échange, puis nous renvoie ici avec un jeton signé
   dans le fragment (`#token=…`). Le fragment n'est jamais envoyé au
   serveur qui héberge la page, contrairement à la query string : il ne
   se retrouve donc ni dans les journaux de GitHub Pages ni dans un
   en-tête `Referer`.

   Ce jeton n'est pas relu pour décider de quoi que ce soit de sensible :
   le Worker revérifie sa signature à chaque battement. Ici, on ne le
   décode que pour afficher le bon pseudo et la bonne image. */

function decodeSession(token) {
  const body = String(token || "").split(".")[0];
  if (!body) return null;
  try {
    const padded = body.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(body.length / 4) * 4, "=");
    const json = decodeURIComponent(
      atob(padded).split("").map(c => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
    const claims = JSON.parse(json);
    if (!claims || !claims.sub) return null;
    if (Number(claims.exp || 0) * 1000 < Date.now()) return null;
    return {
      id: `d_${claims.sub}`,
      pseudo: String(claims.name || "").slice(0, 24),
      avatar: String(claims.avatar || ""),
    };
  } catch { return null; }
}

function loadSession() {
  try { return localStorage.getItem(SESSION_KEY) || ""; } catch { return ""; }
}
function saveSession(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* quota ou stockage refusé */ }
}

const LOGIN_ERRORS = {
  denied: "Connexion Discord annulée.",
  expired: "La demande a expiré, réessaie.",
  error: "Discord n'a pas répondu correctement, réessaie.",
};

/* Lit le retour du Worker, puis nettoie l'URL : sans ça un rechargement
   ou un lien copié ferait circuler le jeton. */
function consumeAuthHash() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return "";
  const params = new URLSearchParams(hash);
  const token = params.get("token") || "";
  const problem = params.get("discord") || "";
  if (!token && !problem) return "";

  history.replaceState(null, "", location.pathname + location.search);
  if (token) saveSession(token);
  return problem;
}

function applySession(token) {
  const identity = decodeSession(token);
  if (!identity) {
    if (token) saveSession("");        // jeton périmé ou illisible
    state.token = "";
    state.identity = null;
    return false;
  }
  state.token = token;
  state.identity = identity;
  state.pseudo = identity.pseudo;
  return true;
}

/* Le jeton peut être refusé par le Worker alors qu'il paraît valide ici
   (secret de signature changé, session révoquée). Sans ce contrôle, le
   site afficherait « connecté » pendant que la présence, elle, rejette
   silencieusement chaque battement. Seul un 401 franc déconnecte : une
   coupure réseau ne doit pas jeter la session. */
async function verifySession() {
  const base = presenceBase();
  if (!base || !state.token) return;
  let response;
  try {
    response = await fetch(`${base}/auth/me`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
  } catch { return; }
  if (response.status !== 401) return;
  logout();
  showLoginNote("Ta session Discord a expiré, reconnecte-toi.");
}

function loginWithDiscord() {
  const base = presenceBase();
  if (!base) {
    showLoginNote("Le service de connexion n'est pas configuré.");
    return;
  }
  const back = location.origin + location.pathname + location.search;
  location.href = `${base}/auth/discord/login?redirect=${encodeURIComponent(back)}`;
}

function logout() {
  saveSession("");
  savePseudo("");        // sinon un ancien pseudo libre reprend la main au rechargement
  saveOfAccount(null);   // le compte OpenFront suit la personne, pas le navigateur
  state.token = "";
  state.identity = null;
  state.pseudo = "";
  state.ofAccount = null;
  state.ofStats = null;
  state.rallyId = "";
  state.members = [];
  const socket = state.presenceWs;
  state.presenceWs = null;
  if (socket) { try { socket.close(1000, "déconnexion"); } catch { /* déjà fermée */ } }
  renderPresence();
  scheduleRender();
}

function showLoginNote(message) {
  const note = $("loginNote");
  note.textContent = message || "";
  note.hidden = !message;
}

function showLoginBox(show) {
  $("loginBox").hidden = !show;
}

/* Identité utilisée pour la présence : celle de Discord si elle existe,
   sinon l'identifiant tiré au sort dans ce navigateur. */
function selfId() {
  return state.identity ? state.identity.id : state.clientId;
}

function setPseudo(name) {
  const clean = name.trim().slice(0, 24);
  if (!clean) return;
  state.pseudo = clean;
  savePseudo(clean);
  showLoginBox(false);
  if (!state.ofAccount) autoLinkAccount();
  renderPresence();
  connectPresence();
  sendHeartbeat();
}

function apiBase() {
  const team = window.TEAM || {};
  return String(team.presenceApi || "").replace(/\/+$/, "");
}

function presenceBase() {
  const team = window.TEAM || {};
  const local = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  const url = (local && team.localPresenceApi) || team.presenceApi || "";
  return url.replace(/\/+$/, "");
}

/* Quand la session Discord est là, le Worker ignore `id` et `pseudo` et
   impose ceux du jeton : on les envoie quand même pour le repli pseudo. */
function presencePayload() {
  return {
    id: selfId(),
    pseudo: state.pseudo,
    gameId: state.rallyId,
  };
}

function fallbackMember(name = state.pseudo) {
  const own = name === state.pseudo;
  return {
    id: own ? selfId() : `legacy_${hashText(name)}`,
    pseudo: name,
    gameId: own ? state.rallyId : "",
    avatar: own && state.identity ? state.identity.avatar : "",
    verified: own && Boolean(state.identity),
  };
}

function applyPresence(data) {
  if (Array.isArray(data.members)) {
    state.members = data.members.filter(member => member && member.id && member.pseudo);
  } else if (Array.isArray(data.online)) {
    state.members = data.online.filter(Boolean).map(fallbackMember);
  }
  state.online = state.members.map(member => member.pseudo);
  state.presenceError = false;
  renderPresence();
  scheduleRender();
}

function connectPresence() {
  const base = presenceBase();
  if (!base || !state.pseudo) return;
  const current = state.presenceWs;
  if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return;

  clearTimeout(state.presenceReconnect);
  let socket;
  try {
    // Une WebSocket ne permet pas d'en-tête Authorization : le jeton
    // passe donc en query. Il ne quitte pas le Worker, qui est la seule
    // origine appelée ici.
    const url = new URL(`${base.replace(/^http/i, "ws")}/presence/ws`);
    if (state.token) url.searchParams.set("token", state.token);
    socket = new WebSocket(url.toString());
  } catch {
    state.presenceError = true;
    renderPresence();
    return;
  }
  state.presenceWs = socket;

  socket.onopen = () => {
    if (state.presenceWs !== socket) return;
    state.presenceError = false;
    socket.send(JSON.stringify(presencePayload()));
  };
  socket.onmessage = event => {
    if (state.presenceWs !== socket) return;
    try { applyPresence(JSON.parse(event.data)); } catch { /* trame invalide */ }
  };
  socket.onerror = () => { try { socket.close(); } catch { /* déjà fermé */ } };
  socket.onclose = () => {
    if (state.presenceWs !== socket) return;
    state.presenceWs = null;
    state.presenceError = true;
    renderPresence();
    state.presenceReconnect = setTimeout(connectPresence, 2200);
  };
}

async function sendHeartbeat() {
  const base = presenceBase();
  if (!base || !state.pseudo) return;

  const socket = state.presenceWs;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(presencePayload()));
    return;
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const r = await fetch(`${base}/presence`, {
      method: "POST",
      headers,
      body: JSON.stringify(presencePayload()),
    });
    if (!r.ok) throw new Error(String(r.status));
    applyPresence(await r.json());
  } catch {
    state.presenceError = true;
    renderPresence();
  }
}

function selectRally(gameId) {
  state.rallyId = String(gameId || "");
  const self = state.members.find(member => member.id === selfId());
  if (self) self.gameId = state.rallyId;
  else if (state.pseudo) state.members.push(fallbackMember());
  renderPresence();
  scheduleRender();
  sendHeartbeat();
}

function hashText(value) {
  let hash = 0;
  for (const char of String(value || "")) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

/* L'avatar Discord vient du CDN et peut manquer (compte supprimé, réseau
   coupé) : on le retire alors plutôt que d'afficher une image cassée. */
function avatarImage(member) {
  if (!member.avatar) return null;
  const img = el("img", "playerAvatar");
  img.src = member.avatar;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.draggable = false;
  img.addEventListener("error", () => img.remove());
  return img;
}

function playerMarker(member, cancelable = false) {
  const own = member.id === selfId();
  const node = el(cancelable && own ? "button" : "span", `rallyPlayer${own ? " me" : ""}`);
  if (node.tagName === "BUTTON") node.type = "button";
  node.style.setProperty("--player-hue", String(hashText(member.id || member.pseudo) % 360));
  node.title = cancelable && own
    ? `${member.pseudo} · annuler ma sélection`
    : member.pseudo;
  node.setAttribute("aria-label", node.title);
  const avatar = avatarImage(member);
  if (avatar) node.append(avatar);
  node.append(document.createTextNode(member.pseudo));
  if (cancelable && own) {
    node.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      selectRally("");
    });
  }
  return node;
}

function visibleMembers() {
  if (state.members.length) return state.members;
  return state.pseudo ? [fallbackMember()] : [];
}

function renderCardRally(host, gameId) {
  const members = visibleMembers().filter(member => member.gameId === gameId);
  const sig = members.map(member => `${member.id}:${member.pseudo}:${member.avatar || ""}`).join("|");
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.replaceChildren();
  for (const member of members.slice(0, 4)) host.append(playerMarker(member, true));
  if (members.length > 4) host.append(el("span", "cardRallyMore", `+${members.length - 4}`));
}

function renderRallyDock() {
  const host = $("rallyWaiting");
  const members = visibleMembers();
  const waiting = members.filter(member => !member.gameId);
  const sig = waiting.map(member => `${member.id}:${member.pseudo}:${member.avatar || ""}`).join("|");
  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
    host.replaceChildren(...waiting.map(member => playerMarker(member)));
  }
  $("rallyWaitingCount").textContent = String(waiting.length);

  let hint = "Connecte-toi pour apparaître ici.";
  if (state.pseudo && state.rallyId) {
    const game = state.games.get(state.rallyId);
    hint = `Tu rejoins ${game ? game.map : "une map"} · clique ton pseudo pour annuler.`;
  } else if (state.pseudo && waiting.length) {
    hint = "Clique une map : ton pseudo apparaîtra dessus.";
  } else if (state.pseudo) {
    hint = "Tout le monde a choisi une map.";
  }
  $("rallyHint").textContent = hint;
}

function renderPresence() {
  showLoginBox(!state.pseudo);
  renderProfile();
  renderRallyDock();
}

/* ---------------- Profil ----------------

   Le compte Discord dit qui est la personne ; il ne dit rien de ses
   parties. Le pont, c'est `clanPlayers` dans l'historique du clan, seul
   endroit de l'API qui associe un pseudo OpenFront à son `publicId`
   (`/members` renvoie les publicId mais jamais les pseudos, et plafonne
   à 10 par page — inutilisable pour retrouver quelqu'un). */

const OF_ACCOUNT_KEY = "of.account";
const ROSTER_PAGES = 6;          // ~60 parties de clan : couvre les actifs

function loadOfAccount() {
  try {
    const raw = JSON.parse(localStorage.getItem(OF_ACCOUNT_KEY) || "null");
    if (raw && raw.publicId && raw.username) return raw;
  } catch { /* entrée illisible */ }
  return null;
}

function saveOfAccount(account) {
  try {
    if (account) localStorage.setItem(OF_ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(OF_ACCOUNT_KEY);
  } catch { /* quota */ }
}

/* Recense les joueurs GAL vus dans l'historique récent du clan.

   `/games` est la seule route qui donne pseudo et publicId ensemble, et
   c'est aussi une des rares qui exige le compte de service. Quand ce
   dernier tombe, l'annuaire est vide : il faut le dire, pas laisser
   « recherche en cours » tourner indéfiniment. */
async function loadRoster() {
  const base = apiBase();
  if (!base || state.rosterState === "loading" || state.roster.size) return;
  state.rosterState = "loading";
  renderProfile();

  let cursor = "";
  let failed = false;
  for (let page = 0; page < ROSTER_PAGES; page++) {
    let data;
    try {
      data = await fetchStatsJson(`${base}/games${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    } catch {
      // Une coupure au milieu de la pagination laisse un annuaire partiel,
      // exploitable ; c'est l'échec dès la première page qui est bloquant.
      failed = !state.roster.size;
      break;
    }
    for (const game of data.results || []) {
      for (const player of game.clanPlayers || []) {
        if (!player.publicId || !player.username) continue;
        state.roster.set(player.username.toLowerCase(),
                         { publicId: player.publicId, username: player.username });
      }
    }
    cursor = typeof data.nextCursor === "string" ? data.nextCursor : "";
    if (!cursor) break;
  }

  state.rosterState = failed ? "error" : "ready";
  if (!state.ofAccount) autoLinkAccount();
  renderProfile();
}

/* Rapprochement automatique, mais seulement sur une égalité stricte : un
   à-peu-près afficherait à quelqu'un les statistiques d'un autre. */
function autoLinkAccount() {
  if (!state.pseudo) return;
  const hit = state.roster.get(state.pseudo.trim().toLowerCase());
  if (hit) setOfAccount(hit, false);
}

function setOfAccount(account, persist = true) {
  state.ofAccount = account;
  if (persist) saveOfAccount(account);
  state.ofStats = null;
  renderProfile();
  if (account) loadOfStats();
}

/* Les feuilles de l'arbre `stats` portent des tableaux dont le sens n'est
   documenté nulle part (`hbomb: ["17","24","0"]`). On ne garde donc que
   `wins` et `losses`, dont la signification ne prête pas à confusion. */
function sumWinsLosses(node, acc = { wins: 0, losses: 0 }) {
  if (!node || typeof node !== "object") return acc;
  if ("wins" in node || "losses" in node) {
    acc.wins += Number(node.wins) || 0;
    acc.losses += Number(node.losses) || 0;
    return acc;
  }
  for (const child of Object.values(node)) sumWinsLosses(child, acc);
  return acc;
}

/* L'arbre est rangé en `visibilité > mode > difficulté`. Le deuxième
   niveau est le seul qui compte ici : un winrate global mélange les FFA
   à 45 joueurs, où gagner est rare par construction, et les parties en
   équipe. Comparés entre eux, ces chiffres ne veulent rien dire. */
function careerByMode(tree) {
  const modes = new Map();
  if (!tree || typeof tree !== "object") return modes;
  for (const visibility of Object.values(tree)) {
    if (!visibility || typeof visibility !== "object") continue;
    for (const [mode, node] of Object.entries(visibility)) {
      const sum = sumWinsLosses(node);
      const row = modes.get(mode) || { mode, wins: 0, losses: 0 };
      row.wins += sum.wins;
      row.losses += sum.losses;
      modes.set(mode, row);
    }
  }
  return modes;
}

/* Le « meilleur mode » n'a de sens qu'avec assez de parties : sur trois
   matchs, un 100 % ne dit rien. */
function bestMode(modes, minimum = 20) {
  let best = null;
  for (const row of modes.values()) {
    const played = row.wins + row.losses;
    if (played < minimum) continue;
    const rate = row.wins / played;
    if (!best || rate > best.rate) best = { ...row, played, rate };
  }
  return best;
}

function currentStreak(games) {
  if (!games.length) return { kind: "", count: 0 };
  const first = games[0].result;
  if (first !== "victory" && first !== "defeat") return { kind: "", count: 0 };
  let count = 0;
  for (const game of games) {
    if (game.result !== first) break;
    count++;
  }
  return { kind: first, count };
}

function favouriteMap(games) {
  const tally = new Map();
  for (const game of games) {
    if (!game.map) continue;
    tally.set(game.map, (tally.get(game.map) || 0) + 1);
  }
  let best = null;
  for (const [map, count] of tally) {
    if (!best || count > best.count) best = { map, count };
  }
  return best;
}

async function loadOfStats() {
  const base = apiBase();
  const account = state.ofAccount;
  if (!base || !account) return;
  const id = encodeURIComponent(account.publicId);
  state.ofStatsFor = account.publicId;

  try {
    const [profile, history] = await Promise.all([
      fetchStatsJson(`${base}/player/${id}`),
      fetchStatsJson(`${base}/player/${id}/games`),
    ]);
    // Une réponse plus lente que le changement de compte ne doit pas
    // écraser les stats du compte désormais affiché.
    if (state.ofStatsFor !== account.publicId) return;

    const games = Array.isArray(history.results) ? history.results : [];
    const tree = profile && profile.stats;
    const career = sumWinsLosses(tree);
    state.ofStats = {
      career,
      best: bestMode(careerByMode(tree)),
      streak: currentStreak(games),
      favourite: favouriteMap(games),
      recent: games.length,
      createdAt: profile && profile.createdAt,
    };
  } catch {
    state.ofStats = { error: true };
  }
  renderProfile();
}

/* Les mêmes classes que le Tableau GAL : le profil doit se lire comme le
   reste du site, pas comme un panneau rapporté. */
function statCell(label, value, extra = "") {
  const cell = el("div", `statCell${extra ? ` ${extra}` : ""}`);
  cell.append(el("span", null, label), el("strong", null, value));
  return cell;
}

function renderProfileLink() {
  const host = $("profileLink");
  host.replaceChildren();

  // Le compte lié est déjà affiché sous le pseudo : ici, seul le moyen
  // d'en changer reste utile.
  if (state.ofAccount) {
    const change = el("button", "linkChange", "changer de compte OpenFront");
    change.type = "button";
    change.addEventListener("click", () => setOfAccount(null));
    host.append(change);
    return;
  }

  if (!state.roster.size) {
    if (state.rosterState === "error") {
      const note = el("p", "profileHint profileWarn",
        "Liste des joueurs indisponible : l'historique du clan ne répond pas.");
      const retry = el("button", "linkChange", "réessayer");
      retry.type = "button";
      retry.addEventListener("click", () => {
        state.rosterState = "idle";
        loadRoster();
      });
      host.append(note, retry);
    } else {
      host.append(el("p", "profileHint", "Recherche des joueurs GAL récents…"));
    }
    return;
  }

  const names = [...state.roster.values()]
    .sort((a, b) => a.username.localeCompare(b.username, "fr"));
  const label = el("label", "linkLabel", "Ton pseudo OpenFront");
  label.htmlFor = "linkSelect";
  const select = el("select", "linkSelect");
  select.id = "linkSelect";
  select.append(el("option", null, "— choisir —"));
  for (const entry of names) {
    const option = el("option", null, entry.username);
    option.value = entry.publicId;
    select.append(option);
  }
  select.addEventListener("change", () => {
    const hit = names.find(entry => entry.publicId === select.value);
    if (hit) setOfAccount(hit);
  });
  host.append(label, select);
}

function renderProfileStats() {
  const host = $("profileStats");
  host.replaceChildren();
  const hint = $("profileHint");

  if (!state.ofAccount) {
    // Inutile d'inviter à lier un compte quand la liste n'a pas pu être
    // chargée : le bloc au-dessus explique déjà pourquoi c'est impossible.
    const blocked = state.rosterState === "error" && !state.roster.size;
    hint.textContent = blocked ? "" : "Lie ton compte pour voir tes statistiques.";
    hint.hidden = blocked;
    return;
  }

  const teamStats = state.teamStats;
  const daily = teamStats && Array.isArray(teamStats.ranking)
    ? teamStats.ranking.findIndex(row => row.id === state.ofAccount.publicId)
    : -1;
  const mine = daily >= 0 ? teamStats.ranking[daily] : null;
  const dailyAvailable = teamStats
    && !teamStats.missing.includes("scores du jour")
    && !teamStats.missing.includes("historique du clan");

  host.append(statCell("🚀 Points du jour", mine
    ? signedScore(mine.points)
    : dailyAvailable ? signedScore(0) : "—"));
  host.append(statCell("🏅 Rang du jour",
    mine ? `${daily + 1}ᵉ / ${teamStats.ranking.length}`
         : dailyAvailable ? "Non classé" : "—"));
  host.append(statCell("🎯 Parties du jour",
    mine ? `${mine.games} · ${mine.wins} V` : "0"));

  const stats = state.ofStats;
  if (!stats) {
    hint.textContent = "Chargement de tes statistiques…";
    hint.hidden = false;
    return;
  }
  if (stats.error) {
    hint.textContent = "Statistiques OpenFront indisponibles.";
    hint.hidden = false;
    return;
  }

  const { wins, losses } = stats.career;
  const played = wins + losses;
  host.append(statCell("🏆 Victoires", String(wins)));
  host.append(statCell("💀 Défaites", String(losses)));
  host.append(statCell("⚖️ Winrate",
    played ? `${Math.round((wins / played) * 100)} %` : "—"));

  if (stats.best) {
    host.append(statCell("🎖️ Meilleur mode",
      `${stats.best.mode} · ${Math.round(stats.best.rate * 100)} % sur ${stats.best.played}`,
      "wide"));
  }
  if (stats.streak.count > 1) {
    const won = stats.streak.kind === "victory";
    host.append(statCell(won ? "🔥 Série en cours" : "🧊 Série noire",
      `${stats.streak.count} ${won ? "victoires" : "défaites"}`, "wide"));
  }
  if (stats.favourite && stats.favourite.count > 1) {
    host.append(statCell("🗺️ Map fétiche",
      `${stats.favourite.map} · ${stats.favourite.count}×`, "wide"));
  }

  hint.hidden = true;
}

function renderProfile() {
  const card = $("profileCard");
  card.hidden = !state.pseudo;
  if (!state.pseudo) return;

  const avatar = $("profileAvatar");
  const url = state.identity && state.identity.avatar;
  if (url) {
    if (avatar.src !== url) avatar.src = url;
    avatar.hidden = false;
    avatar.onerror = () => { avatar.hidden = true; };
  } else {
    avatar.hidden = true;
  }

  $("profileName").textContent = state.pseudo;
  const tag = $("profileTag");
  tag.textContent = state.identity ? "✔ Discord vérifié" : "pseudo libre";
  tag.classList.toggle("verified", Boolean(state.identity));
  $("profileAccount").textContent = state.ofAccount
    ? `⚔️ ${state.ofAccount.username}`
    : "compte OpenFront non lié";

  renderProfileLink();
  renderProfileStats();
}

/* ---------------- Admin : renouvellement du refresh token ----------------

   Le refreshToken OpenFront expire. Plutôt que de passer par une IA ou la
   console Cloudflare, un bouton dans le profil permet de le renouveler en
   direct : le Worker l'enregistre dans le stockage durable partagé.
   Le mot de passe admin est demandé à chaque fois (ou
   mémorisé sur cet appareil si l'option est cochée). */

const ADMIN_PASSWORD_KEY = "of.admin-password";

let adminOverlay = null;

function showUpdateTokenModal() {
  if (adminOverlay) return;

  const saved = (() => {
    try { return localStorage.getItem(ADMIN_PASSWORD_KEY) || ""; } catch { return ""; }
  })();

  const passwordInput = el("input");
  passwordInput.type = "password";
  passwordInput.placeholder = "Mot de passe admin";
  passwordInput.autocomplete = "current-password";
  passwordInput.value = saved;

  const tokenInput = el("textarea");
  tokenInput.placeholder = "Nouveau refresh token (64 hexadécimaux)";
  tokenInput.spellcheck = false;
  tokenInput.autocapitalize = "none";
  tokenInput.autocomplete = "off";

  const rememberCb = el("input");
  rememberCb.type = "checkbox";
  rememberCb.id = "adminRemember";
  if (saved) rememberCb.checked = true;
  const rememberLabel = el("label", "linkLabel", null);
  rememberLabel.htmlFor = "adminRemember";
  rememberLabel.append(rememberCb, " Mémoriser le mot de passe sur cet appareil");

  const errorMsg = el("p", "errorMsg", "");
  errorMsg.hidden = true;
  errorMsg.setAttribute("role", "alert");
  errorMsg.setAttribute("aria-live", "polite");

  const cancelBtn = el("button", "btn ghost", "Annuler");
  cancelBtn.type = "button";
  const saveBtn = el("button", "btn primary", "Enregistrer");
  saveBtn.type = "button";
  const actions = el("div", "actions");
  actions.append(cancelBtn, saveBtn);

  const title = el("h3", null, "Renouveler le refresh token OpenFront");
  title.id = "adminModalTitle";

  const card = el("div", "adminModalCard");
  card.append(
    title,
    el("p", "hint", "Cookie refreshToken côté openfront.io → F12 → Application → Cookies."),
    el("label", "linkLabel", "Mot de passe admin"),
    passwordInput,
    el("label", "linkLabel", "Nouveau refresh token"),
    tokenInput,
    rememberLabel,
    errorMsg,
    actions,
  );

  adminOverlay = el("div", "adminModal");
  adminOverlay.setAttribute("role", "dialog");
  adminOverlay.setAttribute("aria-modal", "true");
  adminOverlay.setAttribute("aria-labelledby", title.id);
  adminOverlay.append(card);

  cancelBtn.onclick = hideUpdateTokenModal;
  adminOverlay.onclick = e => {
    if (e.target === adminOverlay) hideUpdateTokenModal();
  };
  adminOverlay.onkeydown = e => {
    if (e.key === "Escape") hideUpdateTokenModal();
  };

  saveBtn.onclick = async () => {
    const password = passwordInput.value;
    const token = tokenInput.value.trim();
    errorMsg.hidden = true;
    errorMsg.textContent = "";

    if (!password) { errorMsg.textContent = "Mot de passe admin requis."; errorMsg.hidden = false; return; }
    if (!/^[a-f0-9]{64}$/.test(token)) {
      errorMsg.textContent = "Refresh token invalide : 64 hexadécimaux attendus.";
      errorMsg.hidden = false;
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Envoi…";

    try {
      const base = presenceBase();
      if (!base) throw new Error("Le service n'est pas configuré.");
      const res = await fetch(`${base}/admin/update-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminPassword: password, refreshToken: token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);

      if (rememberCb.checked) {
        try { localStorage.setItem(ADMIN_PASSWORD_KEY, password); } catch { /* quota */ }
      } else {
        try { localStorage.removeItem(ADMIN_PASSWORD_KEY); } catch { /* stockage indisponible */ }
      }

      hideUpdateTokenModal();
      toast("Refresh token mis à jour sur le Worker.", "ok");
    } catch (e) {
      errorMsg.textContent = e.message;
      errorMsg.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Enregistrer";
    }
  };

  document.body.append(adminOverlay);
  requestAnimationFrame(() => (saved ? tokenInput : passwordInput).focus());
}

function hideUpdateTokenModal() {
  if (!adminOverlay) return;
  adminOverlay.remove();
  adminOverlay = null;
}

/* ---------------- Statistiques GAL ---------------- */

function parisDayStart(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const values = value => Object.fromEntries(
    formatter.formatToParts(value)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)]),
  );
  const today = values(date);
  const target = Date.UTC(today.year, today.month - 1, today.day);
  const atGuess = values(new Date(target));
  const represented = Date.UTC(
    atGuess.year, atGuess.month - 1, atGuess.day,
    atGuess.hour, atGuess.minute, atGuess.second,
  );
  return new Date(target - (represented - target));
}

async function fetchStatsJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

/* L'API des sessions exige une date ISO à la seconde. `toISOString()` ajoute
   des millisecondes (`.123Z`), désormais rejetées par sa validation. */
function apiIsoSeconds(date) {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

async function loadDailySessions(base, start, end) {
  const query = page => new URLSearchParams({
    start: apiIsoSeconds(start),
    end: apiIsoSeconds(end),
    page: String(page),
    limit: "50",
  });
  const first = await fetchStatsJson(`${base}/sessions?${query(1)}`);
  const sessions = Array.isArray(first.results) ? [...first.results] : [];
  const pages = Math.ceil((Number(first.total) || sessions.length) / 50);
  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) =>
        fetchStatsJson(`${base}/sessions?${query(i + 2)}`)),
    );
    for (const page of rest) {
      if (Array.isArray(page.results)) sessions.push(...page.results);
    }
  }
  return sessions;
}

async function loadDailyClanGames(base, start) {
  const games = [];
  let cursor = "";
  let page = 0;
  const startMs = start.getTime();

  while (page < 30) {
    const url = `${base}/games${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = await fetchStatsJson(url);
    const batch = Array.isArray(data.results) ? data.results : [];
    if (!batch.length) break;

    let reachedYesterday = false;
    for (const game of batch) {
      const time = new Date(game.start).getTime();
      if (Number.isFinite(time) && time >= startMs) games.push(game);
      else if (Number.isFinite(time)) reachedYesterday = true;
    }

    cursor = typeof data.nextCursor === "string" ? data.nextCursor : "";
    page++;
    if (!cursor || reachedYesterday) break;
  }
  return games;
}

function leaderboardRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.clans)) return data.clans;
  return [];
}

async function calculateTeamStats() {
  const base = apiBase();
  if (!base) throw new Error("API absente");

  const end = new Date();
  const start = parisDayStart(end);

  /* Trois sources indépendantes, dont une seule (l'historique du clan)
     dépend du compte de service. Un `Promise.all` faisait disparaître le
     classement mondial et les points du jour parce qu'une troisième
     requête sans rapport échouait. Chacune tombe désormais seule. */
  const [lbResult, sessionsResult, gamesResult] = await Promise.allSettled([
    fetchStatsJson(`${base}/leaderboard`),
    loadDailySessions(base, start, end),
    loadDailyClanGames(base, start),
  ]);
  const leaderboard = lbResult.status === "fulfilled" ? lbResult.value : null;
  const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : null;
  const games = gamesResult.status === "fulfilled" ? gamesResult.value : null;

  if (!leaderboard && !sessions && !games) throw new Error("aucune source disponible");

  const missing = [];
  if (!leaderboard) missing.push("classement mondial");
  if (!sessions) missing.push("scores du jour");
  if (!games) missing.push("historique du clan");

  const rows = leaderboardRows(leaderboard || {});
  const clanTag = clanName().toUpperCase();
  const clanIndex = rows.findIndex(row =>
    String(row.clanTag || row.tag || "").toUpperCase() === clanTag);
  const clan = clanIndex >= 0 ? rows[clanIndex] : {};
  const scoreByGame = new Map((sessions || []).map(session => [session.gameId, session]));
  const contributors = new Map();

  // La répartition par joueur croise les deux sources : sans l'une, elle
  // n'existe pas, mais le reste du tableau reste calculable.
  for (const game of games || []) {
    const session = scoreByGame.get(game.gameId);
    const players = Array.isArray(game.clanPlayers) ? game.clanPlayers : [];
    if (!session || !players.length) continue;
    const divisor = Math.max(1, Number(session.clanPlayerCount) || players.length);
    const share = (Number(session.score) || 0) / divisor;

    for (const player of players) {
      const name = String(player.username || "Joueur GAL");
      const key = String(player.publicId || name);
      const row = contributors.get(key) || { id: key, name, points: 0, games: 0, wins: 0 };
      row.points += share;
      row.games++;
      if (player.won) row.wins++;
      contributors.set(key, row);
    }
  }

  const ranking = [...contributors.values()]
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name, "fr"));
  const top = ranking.slice(0, 3);
  const worst = ranking.length ? ranking[ranking.length - 1] : null;
  const points = sessions
    ? sessions.reduce((sum, session) => sum + (Number(session.score) || 0), 0)
    : null;
  const wins = sessions ? sessions.filter(session => session.hasWon).length : null;
  const teamPoints = leaderboard
    ? (Number(clan.weightedWins) || 0) - (Number(clan.weightedLosses) || 0)
    : null;

  return {
    rank: clanIndex >= 0 ? clanIndex + 1 : 0,
    ratio: leaderboard ? Number(clan.weightedWLRatio) : NaN,
    teamPoints,
    points,
    wins,
    losses: sessions ? Math.max(0, sessions.length - wins) : null,
    games: sessions ? sessions.length : null,
    top,
    worst,
    hasClanHistory: Boolean(games),
    missing,
    // Le classement complet sert au profil : sans lui, impossible de dire
    // à quelqu'un où il se situe s'il n'est ni sur le podium ni dernier.
    ranking,
    updatedAt: end,
  };
}

function signedScore(value) {
  const amount = Number(value) || 0;
  const number = Math.abs(amount).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${number}`;
}

function renderTeamStats(stats) {
  $("statsRank").textContent = stats.rank ? `#${stats.rank}` : "—";
  $("statsRankLabel").textContent = stats.rank
    ? `🏆 GAL est ${stats.rank}${stats.rank === 1 ? "er" : "e"} mondial !`
    : "🏆 GAL au sommet";
  $("statsRatio").textContent = Number.isFinite(stats.ratio)
    ? stats.ratio.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";

  // `null` distingue « pas encore chargé » de « zéro », que `signedScore`
  // afficherait tous les deux en +0,00 — un mensonge tranquille.
  const scoreOrDash = (node, value) => {
    node.textContent = value === null ? "—" : signedScore(value);
    node.className = value === null ? "" : value > 0 ? "positive" : value < 0 ? "negative" : "";
  };
  scoreOrDash($("statsTeamPoints"), stats.teamPoints);
  scoreOrDash($("statsDailyPoints"), stats.points);

  $("statsWins").textContent = stats.wins === null ? "—" : String(stats.wins);
  $("statsLosses").textContent = stats.losses === null ? "—" : String(stats.losses);
  $("statsGames").textContent = stats.games === null
    ? "— parties"
    : `${stats.games} partie${stats.games === 1 ? "" : "s"}`;

  const top = $("statsTop");
  top.replaceChildren();
  if (!stats.top.length) {
    const item = el("li", "empty");
    item.append(el("span", "dailyTopName", stats.hasClanHistory
      ? "Aucune contribution aujourd'hui"
      : "Historique du clan indisponible"));
    top.append(item);
  } else {
    for (const player of stats.top) {
      const item = el("li");
      const name = el("span", "dailyTopName", player.name);
      name.title = `${player.name} · ${player.wins} victoire${player.wins === 1 ? "" : "s"} / ${player.games} parties`;
      const score = el("strong", `dailyTopPoints${player.points < 0 ? " negative" : ""}`, signedScore(player.points));
      item.append(name, score);
      top.append(item);
    }
  }

  const worst = $("statsWorst");
  worst.replaceChildren();
  if (stats.worst) {
    const name = el("span", "dailyWorstName", stats.worst.name);
    name.title = `${stats.worst.name} · ${stats.worst.wins} victoire${stats.worst.wins === 1 ? "" : "s"} / ${stats.worst.games} parties`;
    const score = el("strong", `dailyWorstPoints${stats.worst.points < 0 ? " negative" : ""}`, signedScore(stats.worst.points));
    worst.append(name, score);
  } else {
    worst.textContent = stats.hasClanHistory
      ? "Personne pour l'instant 🎉"
      : "—";
  }

  $("statsUpdated").textContent = `🕒 ${new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit",
  }).format(stats.updatedAt)}`;

  // Dire ce qui manque, sinon un « — » isolé passe pour une valeur nulle.
  const message = $("statsMessage");
  if (stats.missing && stats.missing.length) {
    message.textContent = `Indisponible : ${stats.missing.join(", ")}.`;
    message.hidden = false;
  } else {
    message.hidden = true;
  }
}

async function loadTeamStats() {
  $("statsUpdated").textContent = "chargement…";
  try {
    const stats = await calculateTeamStats();
    state.teamStats = stats;
    renderTeamStats(stats);
    renderProfile();          // le rang et les points du jour en dépendent
    // L'annuaire dépend de la même API : si elle est revenue, on retente.
    if (state.rosterState === "error") {
      state.rosterState = "idle";
      loadRoster();
    }
  } catch {
    $("statsUpdated").textContent = "indisponible";
    $("statsMessage").textContent = "Impossible de charger les statistiques.";
    $("statsMessage").hidden = false;
  }
}

/* ---------------- Feed des parties du clan ---------------- */

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes} min ${String(rest).padStart(2, "0")} s`;
}

function formatGameDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date inconnue";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function clanPlayerNames(game) {
  const players = Array.isArray(game.clanPlayers)
    ? game.clanPlayers.filter(Boolean).map(p => p.username).filter(Boolean)
    : [];
  if (!players.length) return clanName();
  const shown = players.slice(0, 3);
  return shown.join(", ") + (players.length > shown.length ? ` +${players.length - shown.length}` : "");
}

function gameOutcome(result) {
  if (result === "victory") return { label: "Victoire", cls: "victory" };
  if (result === "defeat") return { label: "Défaite", cls: "defeat" };
  return { label: "Incomplète", cls: "incomplete" };
}

function formatClanScore(game) {
  const score = Number(game.clanScore);
  if (!Number.isFinite(score)) return "— pt";
  const sign = score > 0 ? "+" : score < 0 ? "−" : "";
  const amount = Math.abs(score).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${amount} pts`;
}

function buildWinCard(game) {
  const outcome = gameOutcome(game.result);
  const card = el("article", `winCard ${outcome.cls}`);

  const img = el("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = "";
  img.src = THUMB_URL(mapSlug(game.map));
  img.onerror = () => {
    card.classList.add("mapImageMissing");
    img.remove();
  };

  const hasScore = Number.isFinite(Number(game.clanScore));
  const points = el("span", "winPoints" + (hasScore ? "" : " unranked"),
                    hasScore ? formatClanScore(game) : "Non classé");
  points.title = hasScore
    ? "Score pondéré officiel OpenFront"
    : "Les parties FFA ne comptent pas dans le score du clan";

  const body = el("div", "winCardBody");
  body.append(
    el("span", "winBadge", outcome.label),
    el("div", "winMap", game.map || "Map inconnue"),
    el("div", "winMeta", `${formatGameDate(game.start)} · ${formatDuration(game.durationSeconds)}`),
    el("div", "winPlayers", clanPlayerNames(game)),
  );
  card.append(img, points, body);
  return card;
}

async function loadClanScores(base, games) {
  const times = games.map(g => new Date(g.start).getTime()).filter(Number.isFinite);
  if (!times.length) return new Map();
  const start = new Date(Math.min(...times) - 1000).toISOString();
  const end = new Date(Math.max(...times) + 1000).toISOString();
  const params = new URLSearchParams({ start, end, limit: "50" });
  const response = await fetch(`${base}/sessions?${params}`);
  if (!response.ok) throw new Error(String(response.status));
  const data = await response.json();
  const sessions = Array.isArray(data.results) ? data.results : [];
  return new Map(sessions.map(session => [session.gameId, Number(session.score)]));
}

async function loadClanWins() {
  const section = $("wins");
  const track = $("winTrack");
  const status = $("winsStatus");
  const base = apiBase();
  if (!base) { section.hidden = true; return; }

  const seen = new Set();
  let cursor = "";
  let page = 0;
  let count = 0;
  const feed = [];

  try {
    do {
      const url = `${base}/games${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      const games = Array.isArray(data.results) ? data.results : [];

      for (const game of games) {
        if (count >= FEED_TARGET) break;
        if (!game || !game.gameId || seen.has(game.gameId)) continue;
        seen.add(game.gameId);
        feed.push(game);
        count++;
      }

      cursor = typeof data.nextCursor === "string" ? data.nextCursor : "";
      page++;
      status.textContent = count ? `Chargement de ${count} parties…` : "Recherche des dernières parties…";
    } while (cursor && count < FEED_TARGET && page < FEED_MAX_PAGES);

    if (!count) {
      track.append(el("div", "winsMessage", "Aucune partie récente trouvée."));
      return;
    }

    let scores = new Map();
    let scoresAvailable = true;
    try { scores = await loadClanScores(base, feed); }
    catch { scoresAvailable = false; }

    for (const game of feed) {
      game.clanScore = scores.get(game.gameId);
      track.append(buildWinCard(game));
    }
    status.textContent = `${count} parties récentes · ${scoresAvailable ? "scores officiels OpenFront" : "scores indisponibles"}`;
  } catch {
    status.textContent = "Historique momentanément indisponible";
    if (!count) track.append(el("div", "winsMessage", "Impossible de charger les parties de la team."));
  }
}

function initWinsSlider() {
  const track = $("winTrack");
  const slide = direction => track.scrollBy({
    left: direction * Math.max(260, track.clientWidth * .8),
    behavior: "smooth",
  });
  $("winsPrev").onclick = () => slide(-1);
  $("winsNext").onclick = () => slide(1);
  loadClanWins();
}

/* ---------------- Machine à sous cochon-chèvre ---------------- */

const SLOT_SYMBOLS = {
  pig: { src: "flying-pig.png?v=20260817-1", label: "Cochon" },
  goat: { src: "slot-goat.webp?v=20260817-1", label: "Chèvre" },
};
const SLOT_LOSSES = [
  ["pig", "pig", "goat"],
  ["pig", "goat", "pig"],
  ["goat", "pig", "pig"],
  ["pig", "goat", "goat"],
  ["goat", "pig", "goat"],
  ["goat", "goat", "pig"],
];

let slotSpinning = false;
let slotSpinId = 0;
let slotIntervals = [];
let slotReturnFocus = null;

function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError("max invalide");
  if (!window.crypto?.getRandomValues) return Math.floor(Math.random() * max);

  const range = 0x100000000;
  const limit = range - (range % max);
  const draw = new Uint32Array(1);
  do { window.crypto.getRandomValues(draw); } while (draw[0] >= limit);
  return draw[0] % max;
}

function setSlotSymbol(image, symbolName) {
  const symbol = SLOT_SYMBOLS[symbolName];
  image.src = symbol.src;
  image.alt = symbol.label;
  image.dataset.symbol = symbolName;
}

function clearSlotIntervals() {
  for (const interval of slotIntervals) clearInterval(interval);
  slotIntervals = [];
}

function stopSlotMusic() {
  const audio = $("slotWinAudio");
  if (!audio) return;
  audio.pause();
  try { audio.currentTime = 0; } catch { /* métadonnées pas encore chargées */ }
}

function showSlotMachine() {
  const modal = $("slotModal");
  slotReturnFocus = document.activeElement;
  modal.hidden = false;
  document.body.classList.add("slotOpen");
  $("slotMachine").classList.remove("win");
  requestAnimationFrame(() => $("slotClose").focus());
}

function hideSlotMachine() {
  slotSpinId += 1;
  slotSpinning = false;
  clearSlotIntervals();
  stopSlotMusic();
  document.querySelectorAll(".slotReel.spinning").forEach(reel => reel.classList.remove("spinning"));
  $("slotLever").disabled = false;
  $("slotLever").classList.remove("pulled");
  $("slotModal").hidden = true;
  document.body.classList.remove("slotOpen");
  if (slotReturnFocus?.focus) slotReturnFocus.focus();
}

function slotDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function spinSlotMachine() {
  if (slotSpinning) return;
  const spinId = ++slotSpinId;
  const machine = $("slotMachine");
  const lever = $("slotLever");
  const result = $("slotResult");
  const reels = [...document.querySelectorAll("[data-slot-reel]")];

  slotSpinning = true;
  stopSlotMusic();
  machine.classList.remove("win");
  lever.disabled = true;
  lever.classList.remove("pulled");
  void lever.offsetWidth;
  lever.classList.add("pulled");
  result.textContent = "Les rouleaux tournent…";

  const winner = randomInt(10) === 0;
  const finalSymbols = winner
    ? ["pig", "pig", "pig"]
    : SLOT_LOSSES[randomInt(SLOT_LOSSES.length)];

  clearSlotIntervals();
  reels.forEach((image, index) => {
    image.parentElement.classList.add("spinning");
    slotIntervals[index] = setInterval(() => {
      setSlotSymbol(image, randomInt(2) ? "pig" : "goat");
    }, 82 + index * 11);
  });

  await slotDelay(760);
  for (let index = 0; index < reels.length; index += 1) {
    if (spinId !== slotSpinId) return;
    clearInterval(slotIntervals[index]);
    setSlotSymbol(reels[index], finalSymbols[index]);
    reels[index].parentElement.classList.remove("spinning");
    await slotDelay(230);
  }
  clearSlotIntervals();
  if (spinId !== slotSpinId) return;

  slotSpinning = false;
  lever.disabled = false;
  lever.classList.remove("pulled");

  if (winner) {
    machine.classList.add("win");
    result.textContent = "JACKPOT GAL ! Tu as gagné !";
    const audio = $("slotWinAudio");
    try { audio.currentTime = 0; } catch { /* premier chargement */ }
    const playback = audio.play();
    if (playback) playback.catch(() => toast("La musique de victoire est bloquée par le navigateur.", "bad"));
  } else {
    result.textContent = "Perdu… Retente ta chance !";
  }
}

function initSlotMachine() {
  const launcher = $("pigLauncher");
  const modal = $("slotModal");
  if (!launcher || !modal) return;

  launcher.onclick = () => {
    launcher.classList.remove("opening");
    void launcher.offsetWidth;
    launcher.classList.add("opening");
    showSlotMachine();
  };
  launcher.addEventListener("animationend", () => launcher.classList.remove("opening"));
  $("slotLever").onclick = spinSlotMachine;
  $("slotClose").onclick = hideSlotMachine;
  modal.onclick = event => {
    if (event.target === modal) hideSlotMachine();
  };
  modal.onkeydown = event => {
    if (event.key === "Escape") hideSlotMachine();
  };
}

/* ---------------- Toasts ---------------- */

function toast(msg, kind = "") {
  const node = el("div", "toast " + kind, msg);
  $("toasts").append(node);
  setTimeout(() => node.remove(), 4200);
}

/* ---------------- Identité de la team ---------------- */

function applyBranding() {
  const t = window.TEAM || {};
  const root = document.documentElement.style;

  root.setProperty("--accent", t.accent || "#3aa0ff");
  root.setProperty("--wallpaper", t.background ? `url("${t.background}")` : "none");
  root.setProperty("--wallpaper-opacity", String(t.backgroundOpacity ?? 0.85));

  document.title = `Lobbies OpenFront · ${t.name || ""}`.trim();
  $("winsTitle").textContent = `25 dernières parties ${clanName()}`;
  $("winTrack").setAttribute("aria-label", `Dernières parties de ${clanName()}`);
}

/* ---------------- Démarrage ---------------- */

function init() {
  window.TEAM = window.TEAM || {};
  applyBranding();

  state.clientId = loadClientId();

  // L'ordre compte : le retour de Discord (`#token=…`) doit être consommé
  // avant de décider quelle identité afficher.
  const problem = consumeAuthHash();
  if (!applySession(loadSession())) state.pseudo = loadPseudo();
  showLoginNote(LOGIN_ERRORS[problem] || "");
  renderPresence();

  $("discordLogin").onclick = loginWithDiscord;
  $("logoutBtn").onclick = logout;
  $("adminTokenBtn").onclick = showUpdateTokenModal;
  $("pseudoForm").addEventListener("submit", e => {
    e.preventDefault();
    setPseudo($("pseudoInput").value);
  });
  $("unlockLobbies").onclick = () => {
    window.open("https://openfront.io/", "_blank", "noopener,noreferrer");
    toast("Laisse OpenFront se charger, puis reviens sur cette page.", "ok");
  };

  state.ofAccount = loadOfAccount();
  loadRoster();
  if (state.ofAccount) loadOfStats();

  if (presenceBase()) {
    verifySession();
    connectPresence();
    sendHeartbeat();
    setInterval(sendHeartbeat, HEARTBEAT_MS);
  }

  initWinsSlider();
  initSlotMachine();
  loadTeamStats();
  setInterval(loadTeamStats, STATS_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // Le navigateur peut avoir coupé la socket en arrière-plan.
    if (state.status === "off") connect();
    if (!state.presenceWs) connectPresence();
    if (state.domStale) render();
  });

  window.addEventListener("pagehide", () => {
    clearTimeout(state.presenceReconnect);
    if (state.presenceWs) state.presenceWs.close(1000, "page fermée");
  });

  connect();
  setInterval(scheduleRender, 1000);   // rafraîchit les comptes à rebours
}

document.addEventListener("DOMContentLoaded", init);
})();
