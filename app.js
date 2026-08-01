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
const THUMB_URL = slug =>
  `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/${slug}/thumbnail.webp`;

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
  state.ws = ws;

  ws.onopen = () => {
    if (gen !== state.wsGen) return;
    state.retries = 0;
    setStatus("live");
  };
  ws.onmessage = ev => {
    if (gen !== state.wsGen) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
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

/* L'ordre n'est recalculé que lorsque la LISTE des lobbies change, pas à
   chaque mise à jour des compteurs — celles-ci arrivent deux fois par
   seconde et feraient danser les cartes en permanence. */
function orderedGames() {
  const conf = (window.TEAM && window.TEAM.defaultView) || {};
  const sig = [...state.games.keys()].sort().join(",");

  if (sig !== state.orderSig) {
    state.order = [...state.games.values()]
      .sort(SORTS[conf.sort] || SORTS.playersDesc)
      .map(g => g.id);
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

function render() {
  // Onglet caché : on saute la mise à jour du DOM, on la rejouera au retour.
  if (document.hidden) { state.domStale = true; return; }
  state.domStale = false;

  const list = orderedGames();
  const buckets = { ffa: [], team: [], special: [] };
  for (const g of list) (buckets[g.cat] || buckets.special).push(g);

  const live = new Set(list.map(g => g.id));
  if (state.rallyId && !live.has(state.rallyId)) {
    state.rallyId = "";
    const self = state.members.find(member => member.id === state.clientId);
    if (self) self.gameId = "";
    sendHeartbeat();
  }
  for (const [id, node] of state.cardEls) {
    if (!live.has(id)) {
      // La carte sortante devient un calque à sa position exacte : elle peut
      // s'animer sans occuper une rangée de grille ni pousser les survivantes.
      const left = node.offsetLeft;
      const top = node.offsetTop;
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      Object.assign(node.style, {
        left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
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
  img.onerror = () => { img.style.opacity = "0"; };
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

function showPseudoForm(show) {
  $("pseudoForm").hidden = !show;
  $("presenceBar").hidden = show;
  if (show) $("pseudoInput").focus();
}

function setPseudo(name) {
  const clean = name.trim().slice(0, 24);
  if (!clean) return;
  state.pseudo = clean;
  savePseudo(clean);
  showPseudoForm(false);
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

function presencePayload() {
  return {
    id: state.clientId,
    pseudo: state.pseudo,
    gameId: state.rallyId,
  };
}

function fallbackMember(name = state.pseudo) {
  return {
    id: name === state.pseudo ? state.clientId : `legacy_${hashText(name)}`,
    pseudo: name,
    gameId: name === state.pseudo ? state.rallyId : "",
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
    const url = `${base.replace(/^http/i, "ws")}/presence/ws`;
    socket = new WebSocket(url);
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
    const r = await fetch(`${base}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  const self = state.members.find(member => member.id === state.clientId);
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

function playerMarker(member, cancelable = false) {
  const own = member.id === state.clientId;
  const node = el(cancelable && own ? "button" : "span", `rallyPlayer${own ? " me" : ""}`);
  if (node.tagName === "BUTTON") node.type = "button";
  node.style.setProperty("--player-hue", String(hashText(member.id || member.pseudo) % 360));
  node.title = cancelable && own
    ? `${member.pseudo} · annuler ma sélection`
    : member.pseudo;
  node.setAttribute("aria-label", node.title);
  node.textContent = member.pseudo;
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
  const sig = members.map(member => `${member.id}:${member.pseudo}`).join("|");
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
  const sig = waiting.map(member => `${member.id}:${member.pseudo}`).join("|");
  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
    host.replaceChildren(...waiting.map(member => playerMarker(member)));
  }
  $("rallyWaitingCount").textContent = String(waiting.length);

  let hint = "Entre ton pseudo pour apparaître ici.";
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
  if (!state.pseudo) {
    showPseudoForm(true);
    renderRallyDock();
    return;
  }
  showPseudoForm(false);

  const host = $("presenceList");
  host.innerHTML = "";

  const base = presenceBase();
  const names = base && !state.presenceError
    ? visibleMembers().map(member => member.pseudo)
    : [state.pseudo];

  for (const name of names) {
    const chip = el("span", "member" + (name === state.pseudo ? " me" : ""));
    chip.append(el("i", "onlineDot"), document.createTextNode(name));
    host.append(chip);
  }

  if (!base) {
    host.append(el("span", "presenceNote", "liste partagée non configurée"));
  } else if (state.presenceError) {
    host.append(el("span", "presenceNote", "serveur de présence injoignable"));
  }
  renderRallyDock();
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

async function loadDailySessions(base, start, end) {
  const query = page => new URLSearchParams({
    start: start.toISOString(),
    end: end.toISOString(),
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
  const [leaderboard, sessions, games] = await Promise.all([
    fetchStatsJson(`${base}/leaderboard`),
    loadDailySessions(base, start, end),
    loadDailyClanGames(base, start),
  ]);

  const rows = leaderboardRows(leaderboard);
  const clanTag = clanName().toUpperCase();
  const clanIndex = rows.findIndex(row =>
    String(row.clanTag || row.tag || "").toUpperCase() === clanTag);
  const clan = clanIndex >= 0 ? rows[clanIndex] : {};
  const scoreByGame = new Map(sessions.map(session => [session.gameId, session]));
  const contributors = new Map();

  for (const game of games) {
    const session = scoreByGame.get(game.gameId);
    const players = Array.isArray(game.clanPlayers) ? game.clanPlayers : [];
    if (!session || !players.length) continue;
    const divisor = Math.max(1, Number(session.clanPlayerCount) || players.length);
    const share = (Number(session.score) || 0) / divisor;

    for (const player of players) {
      const name = String(player.username || "Joueur GAL");
      const key = String(player.publicId || name);
      const row = contributors.get(key) || { name, points: 0, games: 0, wins: 0 };
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
  const points = sessions.reduce((sum, session) => sum + (Number(session.score) || 0), 0);
  const wins = sessions.filter(session => session.hasWon).length;
  const teamPoints = (Number(clan.weightedWins) || 0) - (Number(clan.weightedLosses) || 0);

  return {
    rank: clanIndex >= 0 ? clanIndex + 1 : 0,
    ratio: Number(clan.weightedWLRatio),
    teamPoints,
    points,
    wins,
    losses: Math.max(0, sessions.length - wins),
    games: sessions.length,
    top,
    worst,
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

  const teamPoints = $("statsTeamPoints");
  teamPoints.textContent = signedScore(stats.teamPoints);
  teamPoints.className = stats.teamPoints > 0 ? "positive" : stats.teamPoints < 0 ? "negative" : "";

  const points = $("statsDailyPoints");
  points.textContent = signedScore(stats.points);
  points.className = stats.points > 0 ? "positive" : stats.points < 0 ? "negative" : "";
  $("statsWins").textContent = String(stats.wins);
  $("statsLosses").textContent = String(stats.losses);
  $("statsGames").textContent = `${stats.games} partie${stats.games === 1 ? "" : "s"}`;

  const top = $("statsTop");
  top.replaceChildren();
  if (!stats.top.length) {
    const item = el("li", "empty");
    item.append(el("span", "dailyTopName", "Aucune contribution aujourd'hui"));
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
    worst.textContent = "Personne pour l'instant 🎉";
  }

  $("statsUpdated").textContent = `🕒 ${new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit",
  }).format(stats.updatedAt)}`;
  $("statsMessage").hidden = true;
}

async function loadTeamStats() {
  $("statsUpdated").textContent = "chargement…";
  try {
    renderTeamStats(await calculateTeamStats());
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
  img.onerror = () => { img.style.display = "none"; };

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
  state.pseudo = loadPseudo();
  renderPresence();

  $("pseudoForm").addEventListener("submit", e => {
    e.preventDefault();
    setPseudo($("pseudoInput").value);
  });
  $("pseudoEdit").onclick = () => {
    $("pseudoInput").value = state.pseudo;
    showPseudoForm(true);
  };

  if (presenceBase()) {
    connectPresence();
    sendHeartbeat();
    setInterval(sendHeartbeat, HEARTBEAT_MS);
  }

  initWinsSlider();
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
