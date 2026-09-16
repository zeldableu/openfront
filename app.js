/* ==================================================================
   GAL — Lobbies OpenFront
   Site 100 % statique, sans aucun réglage : les lobbies viennent du
   WebSocket public d'OpenFront.io et s'affichent en trois colonnes.
   Le seul fichier à modifier est team.config.js.
================================================================== */
(() => {
"use strict";

/* ---------------- Constantes ---------------- */

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
  pendingRallyCall: null,
  rallyCall: null,
  lastRallyCallId: "",
  lastHornCallId: "",
  wasDispersed: false,
  renderQueued: false,
  domStale: false,
  cardEls: new Map(),
  mapPages: { ffa: 0, team: 0, special: 0 },
  view: "play",
  history: null,
  historySelectedDay: "",
  historyGeneration: 0,
  historyLoading: false,
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
const rallyTarget = () => Math.max(1, Math.min(20,
  Number(window.TEAM && window.TEAM.rallyTarget) || 5));

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
  renderHeader();
  if (kind === "off" && !state.wasOffline) {
    state.wasOffline = true;
    toast("Connexion perdue — reconnexion…", "bad");
  } else if (kind === "live" && state.wasOffline) {
    state.wasOffline = false;
    toast("Reconnecté", "ok");
  }
  scheduleRender();
}

// Connexion multi-workers : agrège les lobbies de tous les workers
const multiWorkerState = {
  connections: [],
  gen: 0,
};

async function connect() {
  closeSocket();
  const gen = ++state.wsGen;
  multiWorkerState.gen = gen;
  
  setStatus("connecting");
  console.log('[MULTI-WORKER] Découverte des serveurs OpenFront via API...');
  
  try {
    // Découvre les serveurs disponibles via l'API
    const clusterResponse = await fetch('https://api.openfront.io/cluster.json?site=openfront.io');
    if (!clusterResponse.ok) {
      throw new Error(`API cluster.json failed: ${clusterResponse.status}`);
    }
    
    const cluster = await clusterResponse.json();
    console.log('[MULTI-WORKER] Cluster découvert:', cluster);
    
    // Collecte les serveurs "open"
    const openServers = [];
    for (const [letter, serverInfo] of Object.entries(cluster.servers || {})) {
      if (serverInfo.state === "open") {
        openServers.push({
          letter: letter,
          host: serverInfo.host,
          numWorkers: serverInfo.numWorkers,
          version: serverInfo.version,
        });
      }
    }
    
    if (openServers.length === 0) {
      console.warn('[MULTI-WORKER] Aucun serveur "open" trouvé');
      // Fallback: essaie green et blue
      openServers.push(
        { letter: 'd', host: 'green.openfront.io', numWorkers: 20, version: '' },
        { letter: 'c', host: 'blue.openfront.io', numWorkers: 20, version: '' }
      );
    }
    
    console.log(`[MULTI-WORKER] ${openServers.length} serveur(s) trouvé(s):`, openServers.map(s => s.host).join(', '));
    
    // Se connecte à tous les workers de chaque serveur
    for (const server of openServers) {
      const numWorkers = Math.min(server.numWorkers, 5); // Limite à 5 workers par serveur
      for (let i = 0; i < numWorkers; i++) {
        connectToWorker(i, gen, server.host);
      }
    }
  } catch (error) {
    console.error('[MULTI-WORKER] Erreur découverte serveurs:', error);
    // Fallback vers les serveurs codés en dur
    console.log('[MULTI-WORKER] Fallback: connexion aux serveurs par défaut');
    const SERVERS = [
      { host: 'green.openfront.io', workers: 5 },
      { host: 'blue.openfront.io', workers: 5 },
    ];
    
    for (const server of SERVERS) {
      for (let i = 0; i < server.workers; i++) {
        connectToWorker(i, gen, server.host);
      }
    }
  }
}

function connectToWorker(workerId, gen, host = 'openfront.io') {
  const wsUrl = `wss://${host}/w${workerId}/lobbies`;
  console.log(`[WORKER-${workerId}@${host}] Connexion à ${wsUrl}`);
  
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (error) {
    console.error(`[WORKER-${workerId}@${host}] Erreur création WebSocket:`, error);
    return;
  }
  
  ws.binaryType = "arraybuffer";
  
  const connInfo = {
    ws,
    workerId,
    host,
    connected: false,
    url: wsUrl,
  };
  
  multiWorkerState.connections.push(connInfo);

  ws.onopen = () => {
    if (gen !== state.wsGen) return;
    connInfo.connected = true;
    console.log(`[WORKER-${workerId}@${host}] ✅ Connecté`);
    
    // Met à jour le statut global quand au moins un worker est connecté
    const anyConnected = multiWorkerState.connections.some(c => c.connected);
    if (anyConnected) {
      state.retries = 0;
      setStatus("live");
    }
  };
  
  ws.onmessage = ev => {
    if (gen !== state.wsGen) return;
    
    let msg;
    try {
      msg = typeof ev.data === "string"
        ? JSON.parse(ev.data)
        : window.OpenFrontLobbyWire.decodeLobbyMessage(ev.data);
      console.log(`[WORKER-${workerId}@${host}] Message decoded, keys:`, Object.keys(msg).slice(0, 5), "has 'games':", !!msg.games, "has 'counts':", !!msg.counts);
    } catch (error) {
      console.error(`[WORKER-${workerId}@${host}] Trame illisible:`, error);
      return;
    }
    
    applyMessage(msg, workerId, host);
  };
  
  ws.onclose = () => {
    if (gen !== state.wsGen) return;
    connInfo.connected = false;
    console.log(`[WORKER-${workerId}@${host}] 🔴 Déconnecté`);
    
    // Si TOUS les workers sont déconnectés, on tente une reconnexion
    const allDisconnected = multiWorkerState.connections.every(c => !c.connected);
    if (allDisconnected && gen === state.wsGen) {
      scheduleReconnect(gen);
    }
  };
  
  ws.onerror = (error) => {
    console.error(`[WORKER-${workerId}@${host}] Erreur WebSocket:`, error);
  };
}

function closeSocket() {
  // Fermer tous les workers
  for (const conn of multiWorkerState.connections) {
    if (conn.ws) {
      conn.ws.onopen = conn.ws.onmessage = conn.ws.onclose = conn.ws.onerror = null;
      try { conn.ws.close(); } catch { /* déjà fermé */ }
    }
  }
  multiWorkerState.connections = [];
  
  // Compatibilité avec l'ancien code
  if (state.ws) {
    const ws = state.ws;
    state.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* déjà fermé */ }
  }
}

function scheduleReconnect(gen) {
  if (gen !== state.wsGen) return;
  state.retries++;
  const delay = Math.min(1000 * 2 ** (state.retries - 1), 15000);
  setStatus("off");
  setTimeout(() => { if (gen === state.wsGen) connect(); }, delay);
}

function applyMessage(msg, workerId = null, host = null) {
  if (typeof msg.serverTime === "number") {
    state.clockOffset = msg.serverTime - Date.now();
  }

  const workerTag = workerId !== null ? `[WORKER-${workerId}@${host}]` : '[MSG]';
  let shouldRender = false;

  if (msg.type === "counts" && msg.counts) {
    // Update player counts only
    let totalPlayers = 0;
    for (const [id, n] of Object.entries(msg.counts)) {
      const playerCount = Number(n) || 0;
      totalPlayers += playerCount;
      const g = state.games.get(id);
      if (g) g.players = playerCount;
    }
    shouldRender = true;
  } else if (msg.type === "full" && msg.games) {
    // Full snapshot: REMPLACE toutes les lobbies (ne pas accumuler)
    // Sur OpenFront: chaque snapshot est la liste ACTUELLE, pas une fusion
    const oldSize = state.games.size;
    let totalGames = 0;
    
    // VIDER d'abord pour ne pas accumuler les lobbies mortes
    state.games.clear();
    
    for (const [category, list] of Object.entries(msg.games)) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        if (!raw || !raw.gameID) continue;
        const normalized = normalize(raw);
        state.games.set(raw.gameID, normalized);
        totalGames++;
      }
    }
    
    state.order = [];
    state.orderSig = "";
    
    console.log(`${workerTag} Snapshot: ${totalGames} lobbies (was: ${oldSize})`);
    const withPlayers = Array.from(state.games.values()).filter(g => g.players > 0).length;
    console.log(`Total: ${state.games.size} lobbies, ${withPlayers} with players`);
    shouldRender = true;
  }

  if (shouldRender) {
    scheduleRender();
  }
}

/* ---------------- Sélection & ordre ---------------- */

/* Les lobbies peuplés doivent rester sur la première page. Le tri ne change
   l'ordre que lorsqu'un compteur dépasse réellement un autre ; à égalité,
   prioritize() conserve l'ordre précédent et évite le clignotement. */
function orderedGames() {
  const conf = (window.TEAM && window.TEAM.defaultView) || {};
  const sig = [...state.games.keys()].sort().join(",");

  const games = [...state.games.values()];
  console.log("[DEBUG orderedGames] games.length:", games.length, "conf:", conf);
  
  const prioritized = conf.sort === "playersDesc"
    ? window.OpenFrontLobbyLayout.prioritize(games, state.order)
    : games.sort(SORTS[conf.sort] || SORTS.playersDesc);
  
  console.log("[DEBUG orderedGames] prioritized.length:", prioritized?.length);
  
  state.order = prioritized.map(game => game.id);
  state.orderSig = sig;

  let list = state.order.map(id => state.games.get(id)).filter(Boolean);
  console.log("[DEBUG orderedGames] final list.length:", list.length);

  // Filtrer les lobbies DÉJÀ COMMENCÉES ou PÉRIMÉES
  const beforeFilter = list.length;
  list = list.filter(g => {
    // 1. Si la partie a DÉJÀ COMMENCÉ (startsAt dans le passé) → cacher
    if (g.startsAt && g.startsAt <= now()) return false;
    
    // 2. Si lobby PLEINE avec countdown > 2 minutes → probablement périmée/lancée
    //    Le serveur garde des lobbies "fantômes" dans la liste publique
    if (g.startsAt && g.startsAt > now()) {
      const timeLeft = g.startsAt - now();
      const isFull = g.capacity > 0 && g.players >= g.capacity - 1; // 24/25, 97/100, etc.
      const oldCountdown = timeLeft > 2 * 60 * 1000; // Plus de 2 minutes
      
      // Si pleine + countdown trop long = lobby morte/lancée
      if (isFull && oldCountdown) {
        console.log(`[FILTER] Skipping stale lobby: ${g.map} ${g.players}/${g.capacity} countdown ${Math.round(timeLeft/1000)}s`);
        return false;
      }
    }
    
    return true;
  });
  console.log(`[DEBUG orderedGames] after filter: ${beforeFilter} → ${list.length}`);

  // IMPORTANT: Ne pas filtrer par startsAt - afficher TOUTES les lobbies (en attente ET en cours)
  // OpenFront affiche les lobbies qui attendent des joueurs et celles avec countdown

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
  setTimeout(() => { 
    try {
      render();
    } catch (err) {
      console.error("[ERROR render crashed]", err);
    }
    state.renderQueued = false;
  }, 120);
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
    if (!live.has(id) || !node.isConnected || node.hidden) continue;
    positions.set(id, node.getBoundingClientRect());
    stopCardMove(node);
  }
  return positions;
}

function animateCardReflow(positions) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  for (const [id, first] of positions) {
    const node = state.cardEls.get(id);
    if (!node || !node.isConnected || node.hidden) continue;

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
  console.log("[DEBUG render] called, view:", state.view, "hidden:", document.hidden);
  // Onglet caché : on saute la mise à jour du DOM, on la rejouera au retour.
  if (document.hidden) { state.domStale = true; return; }
  if (state.view !== "play") { state.domStale = true; return; }
  state.domStale = false;

  const list = orderedGames();
  const buckets = { ffa: [], team: [], special: [] };
  for (const g of list) {
    const category = g.cat || "special";
    (buckets[category] || buckets.special).push(g);
  }

  // Tri dans chaque catégorie : 
  // 1. Les lobbies avec countdown (startsAt défini et > 0) = countdown soonest first
  // 2. Les lobbies en attente (startsAt undefined ou <= 0) = order server sent
  for (const cat of ["ffa", "team", "special"]) {
    buckets[cat].sort((a, b) => {
      const aHasCountdown = a.startsAt && a.startsAt > now();
      const bHasCountdown = b.startsAt && b.startsAt > now();
      
      // Les deux ont un countdown : tri par soonest first
      if (aHasCountdown && bHasCountdown) {
        return a.startsAt - b.startsAt;
      }
      // Seulement a a un countdown : a avant b
      if (aHasCountdown) return -1;
      // Seulement b a un countdown : b avant a
      if (bHasCountdown) return 1;
      // Ni l'un ni l'autre : garder l'ordre du serveur (stable sort)
      return 0;
    });
  }

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
      if (!host || node.hidden) {
        stopCardMove(node);
        state.cardEls.delete(id);
        node.remove();
        continue;
      }
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

  // 3 colonnes par catégorie
  const COLUMNS = [
    { cat: "ffa",     cards: "colFfa",     count: "countFfa" },
    { cat: "team",    cards: "colTeam",    count: "countTeam" },
    { cat: "special", cards: "colSpecial", count: "countSpecial" },
  ];

  for (const col of COLUMNS) {
    const games = buckets[col.cat];
    $(col.count).textContent = games.length;
    const host = $(col.cards);
    
    const desiredNodes = [];
    for (const g of games) {
      let node = state.cardEls.get(g.id);
      if (!node) { node = buildCard(g); state.cardEls.set(g.id, node); }
      updateCard(node, g);
      node.hidden = false;
      desiredNodes.push(node);
    }

    // Mettre à jour l'ordre des cartes si nécessaire
    const currentNodes = [...host.children]
      .filter(node => !node.classList.contains("leaving") && !node.classList.contains("spawning"));
    const orderChanged = currentNodes.length !== desiredNodes.length ||
      desiredNodes.some((node, i) => currentNodes[i] !== node);
    if (orderChanged) {
      const fragment = document.createDocumentFragment();
      for (const node of desiredNodes) fragment.append(node);
      host.append(fragment);
    }
  }

  animateCardReflow(previousPositions);

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
  const halo = el("div", "rallyHalo");
  halo.setAttribute("aria-hidden", "true");
  const wave = el("div", "rallyWave");
  wave.setAttribute("aria-hidden", "true");

  const goal = el("div", "rallyGoal");
  const callButton = el("button", "rallyCallButton", "📣 Rallier");
  callButton.type = "button";
  callButton.title = "Déclencher un appel au ralliement visible par tous";
  callButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    callRally(g.id);
  });
  goal.append(callButton);

  const confetti = el("div", "rallyConfetti");
  confetti.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 12; i++) {
    const piece = el("i");
    piece.style.setProperty("--confetti-x", `${8 + (i * 83) % 88}%`);
    piece.style.setProperty("--confetti-delay", `${(i % 4) * 55}ms`);
    piece.style.setProperty("--confetti-hue", String((i * 47) % 360));
    confetti.append(piece);
  }

  image.append(img, halo, wave, confetti, rally, bar);

  const text = el("div", "cardText");
  const heading = el("div", "cardHeading");
  heading.append(el("div", "cardTitle"));
  const details = el("div", "cardDetails");
  details.append(el("div", "cardMode"), goal);
  text.append(heading, details);
  image.append(el("div", "badges"));

  image.append(el("span", "players"), el("span", "time"));

  card.append(image, text);
  setTimeout(() => card.classList.remove("entering"), 340);
  return card;
}

function updateCard(card, g) {
  const full = g.capacity > 0 && g.players >= g.capacity;
  const pct = g.capacity ? Math.min(100, (g.players / g.capacity) * 100) : 0;
  const remaining = g.startsAt - now();
  const soon = g.startsAt > 0 && remaining < 30000;
  const rallyMembers = membersForGame(g.id);
  const target = rallyTarget();
  const ready = rallyMembers.length;
  const complete = ready >= target;
  const imminent = ready > 0 && g.startsAt > 0 && remaining > 0 && remaining <= 10000;

  const time = card.querySelector(".time");
  time.className = "time" + (soon ? " soon" : "") + (g.startsAt ? "" : " idle");
  time.textContent = countdown(g);

  const players = card.querySelector(".players");
  players.className = "players" + (full ? " full" : "");
  players.textContent = g.capacity > 0 ? `${g.players} / ${g.capacity}` : `${g.players} joueurs`;

  const fill = card.querySelector(".cardBar > i");
  fill.className = full ? "full" : "";
  fill.style.setProperty("--progress", String(pct / 100));

  card.querySelector(".cardTitle").textContent = g.map;
  card.querySelector(".cardTitle").title = g.map;
  card.querySelector(".cardMode").textContent =
    `${modeLabel(g)} · ${g.difficulty} · ${g.bots} bots`;
  card.querySelector(".cardMode").title = card.querySelector(".cardMode").textContent;

  renderCardRally(card.querySelector(".cardRally"), g.id, rallyMembers);

  const goal = card.querySelector(".rallyGoal");
  goal.hidden = !state.pseudo;

  const activeCall = state.rallyCall &&
    Number(state.rallyCall.expiresAt || 0) > Date.now() &&
    state.rallyCall.gameId === g.id;
  const pendingCall = state.pendingRallyCall && state.pendingRallyCall.gameId === g.id;
  const callButton = card.querySelector(".rallyCallButton");
  callButton.hidden = !state.pseudo;
  callButton.disabled = Boolean(activeCall || pendingCall);
  callButton.textContent = activeCall || pendingCall ? "📣 Appel lancé" : "📣 Rallier";
  callButton.setAttribute("aria-label", `Rassemblement ici : ${g.map}`);

  card.classList.toggle("hasRally", ready > 0);
  card.classList.toggle("rallyComplete", complete);
  card.classList.toggle("rallyImminent", imminent);
  if (ready > 0) {
    card.style.setProperty("--rally-gradient", rallyGradient(rallyMembers));
  } else {
    card.style.removeProperty("--rally-gradient");
  }
  if (imminent) {
    const acceleration = 1 - Math.max(0, remaining) / 10000;
    card.style.setProperty("--rally-speed", `${(3.2 - acceleration * 1.8).toFixed(2)}s`);
  } else {
    card.style.removeProperty("--rally-speed");
  }

  const wasComplete = card.dataset.rallyComplete === "1";
  card.dataset.rallyComplete = complete ? "1" : "0";
  if (complete && !wasComplete) celebrateRally(card);

  const badges = card.querySelector(".badges");
  if (badges.dataset.sig !== g.badges.join("|")) {
    badges.dataset.sig = g.badges.join("|");
    badges.innerHTML = "";
    for (const b of g.badges.slice(0, 2)) badges.append(el("span", "badge", b));
    if (g.badges.length > 2) badges.append(el("span", "badge", `+${g.badges.length - 2}`));
    badges.title = g.badges.join(" · ");
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
  state.pendingRallyCall = null;
  state.rallyCall = null;
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
  const payload = {
    id: selfId(),
    pseudo: state.pseudo,
    gameId: state.rallyId,
  };
  if (state.pendingRallyCall) payload.rallyCall = state.pendingRallyCall;
  return payload;
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
  const call = data && data.rallyCall &&
    Number(data.rallyCall.expiresAt || 0) > Date.now()
      ? data.rallyCall
      : null;
  state.rallyCall = call;
  if (call && state.pendingRallyCall && (
    call.id === state.pendingRallyCall.id ||
    (call.callerId === selfId() && call.gameId === state.pendingRallyCall.gameId)
  )) {
    state.pendingRallyCall = null;
  }
  if (call && call.id !== state.lastRallyCallId) {
    state.lastRallyCallId = call.id;
    triggerRallyWave(call);
  }
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

function setLocalRally(gameId) {
  state.rallyId = String(gameId || "");
  const self = state.members.find(member => member.id === selfId());
  if (self) self.gameId = state.rallyId;
  else if (state.pseudo) state.members.push(fallbackMember());
  renderPresence();
  scheduleRender();
}

function selectRally(gameId) {
  setLocalRally(gameId);
  sendHeartbeat();
}

function callRally(gameId) {
  if (!state.pseudo) {
    toast("Entre ton pseudo avant de lancer le rassemblement.", "bad");
    return;
  }
  const currentCall = state.rallyCall;
  if ((state.pendingRallyCall && state.pendingRallyCall.gameId === gameId) ||
      (currentCall && currentCall.gameId === gameId &&
       Number(currentCall.expiresAt || 0) > Date.now())) return;
  setLocalRally(gameId);
  state.pendingRallyCall = {
    id: crypto.randomUUID(),
    gameId: state.rallyId,
  };
  primeRallyHorn();
  playRallyHorn(state.pendingRallyCall.id);
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

function membersForGame(gameId) {
  return visibleMembers().filter(member => member.gameId === gameId);
}

function rallyGradient(members) {
  const hues = members.map(member => hashText(member.id || member.pseudo) % 360);
  if (hues.length === 1) hues.push((hues[0] + 85) % 360, (hues[0] + 190) % 360);
  const colors = hues.map(hue => `hsl(${hue} 92% 63%)`);
  colors.push(colors[0]);
  return `conic-gradient(from var(--rally-angle), ${colors.join(", ")})`;
}

function triggerRallyWave(call) {
  setTimeout(() => {
    const card = state.cardEls.get(call.gameId);
    if (card && card.isConnected) {
      card.classList.remove("rallyWaveActive");
      // Relancer l'animation meme si deux appels distincts arrivent rapidement.
      void card.offsetWidth;
      card.classList.add("rallyWaveActive");
      setTimeout(() => card.classList.remove("rallyWaveActive"), 1500);
    }
    const game = state.games.get(call.gameId);
    toast(`📣 ${call.pseudo} appelle au ralliement${game ? ` sur ${game.map}` : ""} !`, "rally");
    playRallyHorn(call.id);
    showRallySpotlight(call);
  }, 180);
}

let hornContext = null;
function primeRallyHorn() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return null;
  if (!hornContext) hornContext = new Audio();
  if (hornContext.state === "suspended") hornContext.resume().catch(() => {});
  return hornContext;
}

/* A synthetic foghorn avoids a large audio download. Browser autoplay rules
   still apply until the visitor has interacted with the page once. */
function playRallyHorn(callId) {
  if (callId && state.lastHornCallId === callId) return;
  const ctx = hornContext;
  /* Ne pas creer un contexte audio depuis un message distant : un navigateur
     sans interaction utilisateur le reprendrait plus tard et jouerait la
     corne en retard. Une interaction locale l'arme pour les appels suivants. */
  if (!ctx || ctx.state !== "running") return;
  state.lastHornCallId = callId || state.lastHornCallId;
  const start = ctx.currentTime + .025;
  const master = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(520, start);
  master.gain.setValueAtTime(.0001, start);
  master.gain.exponentialRampToValueAtTime(.17, start + .12);
  master.gain.setValueAtTime(.17, start + 1.15);
  master.gain.exponentialRampToValueAtTime(.0001, start + 1.85);
  filter.connect(master).connect(ctx.destination);
  for (const [frequency, volume, detune] of [[73.4, .7, -4], [110, .34, 3], [146.8, .2, -7]]) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = frequency < 100 ? "sawtooth" : "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.detune.setValueAtTime(detune, start);
    oscillator.detune.linearRampToValueAtTime(detune + 9, start + 1.85);
    gain.gain.value = volume;
    oscillator.connect(gain).connect(filter);
    oscillator.start(start);
    oscillator.stop(start + 1.9);
  }
}

function showRallySpotlight(call) {
  const game = state.games.get(call.gameId);
  if (!game) return;
  const dialog = $("rallySpotlight");
  dialog.dataset.gameId = game.id;
  $("rallySpotlightCaller").textContent = `${call.pseudo} sonne le ralliement`;
  $("rallySpotlightMap").textContent = game.map;
  $("rallySpotlightMode").textContent = `${modeLabel(game)} · ${game.difficulty} · ${game.bots} bots`;
  $("rallySpotlightPlayers").textContent = game.capacity > 0 ? `${game.players} / ${game.capacity} joueurs` : `${game.players} joueurs`;
  const image = $("rallySpotlightImage");
  image.src = THUMB_URL(game.slug);
  image.alt = `Carte ${game.map}`;
  const waiting = membersForGame(game.id);
  $("rallySpotlightSquad").replaceChildren(...waiting.map(member => playerMarker(member)));
  if (!dialog.open) dialog.showModal();
}

function closeRallySpotlight(returnToMaps = true) {
  const dialog = $("rallySpotlight");
  const gameId = dialog.dataset.gameId || "";
  if (dialog.open) dialog.close();
  if (returnToMaps) focusGame(gameId);
}

function celebrateRally(card) {
  card.classList.remove("celebrating");
  void card.offsetWidth;
  card.classList.add("celebrating");
  setTimeout(() => card.classList.remove("celebrating"), 1900);
}

function renderCardRally(host, gameId, members = membersForGame(gameId)) {
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
  const groups = $("rallyGroups");
  const selected = members.filter(member => member.gameId);
  const groupSig = selected.map(member => `${member.id}:${member.pseudo}:${member.avatar || ""}:${member.gameId}:${state.games.get(member.gameId)?.map || ""}`).join("|");
  if (groups.dataset.sig !== groupSig) {
    groups.dataset.sig = groupSig;
    groups.replaceChildren();
    if (selected.length) groups.append(el("h3", null, "🗺️ Déjà sur une map"));
    for (const gameId of new Set(selected.map(member => member.gameId))) {
      const group = el("section", "rallyGroup");
      const button = el("button", "rallyGroupTitle", state.games.get(gameId)?.map || "Partie sélectionnée");
      button.type = "button";
      button.title = "Voir cette map dans le tableau";
      button.onclick = () => focusGame(gameId);
      const names = el("div", "rallyGroupPlayers");
      for (const member of selected.filter(member => member.gameId === gameId)) names.append(playerMarker(member));
      group.append(button, names);
      groups.append(group);
    }
  }
}

function renderPresence() {
  showLoginBox(!state.pseudo);
  renderProfile();
  renderRallyDock();
  renderDispersionAlert();
  renderHeader();
}

function renderDispersionAlert() {
  const mapIds = new Set(visibleMembers().map(member => member.gameId).filter(Boolean));
  const dispersed = mapIds.size >= 3;
  const alert = $("dispersionAlert");
  alert.hidden = !dispersed || state.view !== "play";
  if (dispersed && !state.wasDispersed) {
    toast("🔀 Les Gaulois sont dispersés !", "bad");
  }
  state.wasDispersed = dispersed;
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
  return window.OpenFrontTeamHistory.careerTotals(node, acc);
}

/* L'arbre est rangé en `visibilité > mode > difficulté`. Le deuxième
   niveau est le seul qui compte ici : un winrate global mélange les FFA
   à 45 joueurs, où gagner est rare par construction, et les parties en
   équipe. Comparés entre eux, ces chiffres ne veulent rien dire. */
function careerByMode(tree) {
  return window.OpenFrontTeamHistory.careerModeRows(tree);
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
  $("guestProfile").hidden = Boolean(state.pseudo);
  document.querySelector(".profileLayout").hidden = !state.pseudo;
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
  renderProfileTeamDetails();
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
  
  // Masquer les points de Coton (privacy)
  const hiddenPlayers = new Set(["coton", "Coton", "COTON"]);
  for (const player of ranking) {
    if (hiddenPlayers.has(player.name)) {
      player.points = null; // Masquer les points
      player.pointsHidden = true;
    }
  }
  
  const top = ranking.slice(0, 3);
  const worst = ranking.length ? ranking[ranking.length - 1] : null;
  const points = sessions
    ? sessions.reduce((sum, session) => sum + (Number(session.score) || 0), 0)
    : null;
  const wins = sessions ? sessions.filter(session => session.hasWon).length : null;
  // Points team = juste les victoires (weightedWins)
  const teamPoints = leaderboard && clanIndex >= 0 && clan.weightedWins
    ? Number(clan.weightedWins) || 0
    : null;

  return {
    rank: clanIndex >= 0 ? clanIndex + 1 : 0,
    clan: clanIndex >= 0 ? clan : null,
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
    ranking,
    leaderboard: leaderboard, // Ajouter le leaderboard complet
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

/* API JSON pour le bot */
window.getLobbiesAPI = function() {
  const games = [];
  const now_ms = now();
  const MAX_GAME_DURATION_MS = 45 * 60 * 1000; // 45 minutes max
  
  for (const [id, game] of state.games) {
    // Retourner TOUTES les parties (team ET ffa)
    // MAIS exclure les parties déjà lancées
    if (!game.startsAt || game.startsAt <= now_ms) continue;
    
    // Exclure aussi les parties trop anciennes (terminées ou stuck)
    if (game.startsAt + MAX_GAME_DURATION_MS < now_ms) continue;
    
    // Exclure les parties pleines
    if (game.capacity > 0 && game.players >= game.capacity) continue;
    
    // Exclure les parties à 90% de capacité ou plus
    if (game.capacity > 0 && game.players >= game.capacity * 0.9) continue;
    
    const remaining = game.startsAt - now_ms;
    
    games.push({
      gameId: game.id,
      map: game.map,
      players: game.players,
      capacity: game.capacity,
      teams: game.teams,
      perTeam: game.perTeam,
      difficulty: game.difficulty,
      category: game.cat,
      secondsRemaining: Math.round(remaining / 1000),
      startsAt: game.startsAt,
    });
  }
  
  // Trier par timer (15 secondes = idéal)
  games.sort((a, b) => {
    const distA = Math.abs(a.secondsRemaining - 15);
    const distB = Math.abs(b.secondsRemaining - 15);
    return distA - distB;
  });
  
  return {
    status: state.status,
    timestamp: Date.now(),
    gamesCount: state.games.size,
    allGames: games,
  };
};

// Exposer via fetch si besoin (pour les requêtes cross-origin)
if (typeof window !== 'undefined') {
  window.lobbyAPI = window.getLobbiesAPI;
}

function renderTeamStats(stats) {
  // Tableau GAL dans l'onglet Jouer
  $("statsRank").textContent = stats.rank ? `#${stats.rank}` : "—";
  $("statsRankLabel").textContent = stats.rank
    ? `🏆 GAL est ${stats.rank}${stats.rank === 1 ? "er" : "e"} mondial !`
    : "🏆 GAL au sommet";
  $("statsRatio").textContent = Number.isFinite(stats.ratio)
    ? stats.ratio.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";

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
      
      // Flouter les points si pointsHidden
      let scoreText = player.pointsHidden ? "?" : signedScore(player.points);
      const score = el("strong", `dailyTopPoints${player.pointsHidden ? "" : player.points < 0 ? " negative" : ""}`, scoreText);
      
      item.append(name, score);
      top.append(item);
    }
  }

  const worst = $("statsWorst");
  worst.replaceChildren();
  if (stats.worst) {
    const name = el("span", "dailyWorstName", stats.worst.name);
    name.title = `${stats.worst.name} · ${stats.worst.wins} victoire${stats.worst.wins === 1 ? "" : "s"} / ${stats.worst.games} parties`;
    
    // Flouter les points si pointsHidden
    let scoreText = stats.worst.pointsHidden ? "?" : signedScore(stats.worst.points);
    const score = el("strong", `dailyWorstPoints${stats.worst.pointsHidden ? "" : stats.worst.points < 0 ? " negative" : ""}`, scoreText);
    
    worst.append(name, score);
  } else {
    worst.textContent = stats.hasClanHistory
      ? "Personne pour l'instant 🎉"
      : "—";
  }

  $("statsUpdated").textContent = `🕒 ${new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit",
  }).format(stats.updatedAt)}`;

  // Podium top 5 dans l'onglet Classement
  renderWorldPodium(stats);
  
  // Stats du jour dans l'onglet Classement
  $("rankingSynced").textContent = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(stats.updatedAt);

  // Anciens éléments pour compatibilité
  const totals = $("officialTeamTotals");
  if (totals) {
    totals.replaceChildren();
    if (stats.clan) {
      for (const [key, label] of [["games", "🎮 Parties"], ["wins", "🏆 Victoires"], ["losses", "💀 Défaites"], ["playerSessions", "🛡️ Participations"], ["weightedWins", "⭐ Points gagnés"], ["weightedLosses", "🧊 Points perdus"]]) {
        const value = stats.clan[key] == null ? NaN : Number(stats.clan[key]);
        totals.append(statCell(label, Number.isFinite(value) ? value.toLocaleString("fr-FR", { maximumFractionDigits: 2 }) : "—"));
      }
    } else totals.append(el("p", "muted", "Totaux officiels indisponibles."));
  }

  const message = $("statsMessage");
  if (message) {
    if (stats.missing && stats.missing.length) {
      message.textContent = `Indisponible : ${stats.missing.join(", ")}.`;
      message.hidden = false;
    } else {
      message.hidden = true;
    }
  }
}

function renderWorldPodium(stats) {
  const host = $("podiumRanks");
  const progress = $("galProgress");
  
  if (!stats || !stats.clan) {
    host.innerHTML = '<p class="muted">Classement mondial indisponible</p>';
    progress.hidden = true;
    return;
  }

  // Récupérer le leaderboard complet
  const rows = leaderboardRows(stats.leaderboard || []);
  if (!rows.length) {
    host.innerHTML = '<p class="muted">Classement mondial indisponible</p>';
    progress.hidden = true;
    return;
  }

  // Calculer les points nets pour chaque team
  const teamsWithPoints = rows.map((clan, index) => ({
    rank: index + 1,
    tag: clan.clanTag || clan.tag || "???",
    points: (Number(clan.weightedWins) || 0) - (Number(clan.weightedLosses) || 0),
    isGal: (clan.clanTag || clan.tag || "").toUpperCase() === clanName().toUpperCase()
  }));

  // Top 5
  const top5 = teamsWithPoints.slice(0, 5);
  const galTeam = teamsWithPoints.find(t => t.isGal);
  
  // Afficher le podium
  host.replaceChildren();
  for (const team of top5) {
    const podiumItem = el("div", `podiumItem${team.isGal ? " isGal" : ""}`);
    const medal = team.rank === 1 ? "🥇" : team.rank === 2 ? "🥈" : team.rank === 3 ? "🥉" : `#${team.rank}`;
    podiumItem.innerHTML = `
      <span class="podiumRank">${medal}</span>
      <strong class="podiumTag">${team.tag}</strong>
      <span class="podiumPoints ${team.points < 0 ? "negative" : team.points > 0 ? "positive" : ""}">${signedScore(team.points)}</span>
    `;
    host.append(podiumItem);
  }

  // Afficher la progression GAL
  if (galTeam) {
    progress.hidden = false;
    $("galRankText").textContent = `GAL est #${galTeam.rank}`;
    
    // Calculer points manquants pour next rank
    if (galTeam.rank > 1) {
      const nextTeam = teamsWithPoints[galTeam.rank - 2]; // rank avant (index = rank - 1, donc -2 pour avant)
      const pointsNeeded = nextTeam.points - galTeam.points;
      $("pointsToNext").textContent = signedScore(pointsNeeded);
      $("nextRankNumber").textContent = `#${nextTeam.rank} (${nextTeam.tag})`;
    } else {
      $("nextRankInfo").textContent = "🏆 GAL est déjà #1 !";
    }
  } else {
    progress.hidden = true;
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
  const total = Math.floor(Math.max(0, Number(seconds) || 0));
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

function renderHeader() {
  $("headerSession").hidden = !state.pseudo;
  $("headerPseudo").textContent = state.pseudo || "Invité";
  $("headerIdentityType").textContent = state.identity ? "✔ Discord vérifié" : "pseudo libre";
  const status = state.status === "live" ? "🟢 Maps en direct" : state.status === "off" ? "🔴 Reconnexion…" : "🟡 Connexion…";
  $("headerLive").textContent = `${status} · ${state.presenceError ? "présence indisponible" : `${visibleMembers().length} en ligne`}`;
}

function showView(view) {
  state.view = view;
  for (const [name, id] of [["play", "Play"], ["profile", "Profile"], ["ranking", "Ranking"]]) {
    $(name + "View").hidden = name !== view;
    $("nav" + id).classList.toggle("active", name === view);
    $("nav" + id).setAttribute("aria-pressed", String(name === view));
  }
  $("wins").hidden = view !== "play";
  $("dispersionAlert").hidden = view !== "play" || !state.wasDispersed;
  if (view === "play") scheduleRender();
  else if ((view === "ranking" || state.pseudo) && !state.history && !state.historyLoading) loadHistory();
}

function focusGame(gameId) {
  const game = state.games.get(gameId);
  if (!game) { toast("Cette map n’est plus dans les lobbies."); return; }
  showView("play");
  render();
  // Scroll vers la carte dans la grille
  const card = state.cardEls.get(gameId);
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    card.focus({ preventScroll: true });
  }
}

const historyCache = new Map();
const playerCareerCache = new Map();
const prettyDay = day => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${day}T12:00:00Z`));
const shiftDay = (day, count) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};

function setHistoryPeriod(days) {
  const today = window.OpenFrontTeamHistory.dayKey(new Date());
  $("historyEnd").value = today;
  $("historyStart").value = shiftDay(today, 1 - days);
}

async function fetchHistorySessions(base, start, end, generation) {
  // The official API rejects intervals longer than 24 hours. Split in UTC
  // windows, including the 25-hour Paris day at the autumn DST transition.
  const windows = window.OpenFrontTeamHistory.scoreWindows(start, end);
  const sessions = [];
  let truncated = false;
  const partialDays = new Set();
  const fetchWindow = async interval => {
    const query = new URLSearchParams({ start: apiIsoSeconds(new Date(interval.start)), end: apiIsoSeconds(new Date(interval.end)) });
    const data = await fetchStatsJson(`${base}/history/scores?${query}`);
    if (!Array.isArray(data.results)) throw new Error("Réponse des scores invalide");
    return data;
  };
  for (let i = 0; i < windows.length; i += 3) {
    if (generation !== state.historyGeneration || !state.historyLoading) throw new Error("chargement remplacé");
    const batch = await Promise.all(windows.slice(i, i + 3).map(fetchWindow));
    for (let j = 0; j < batch.length; j++) {
      const data = batch[j];
      sessions.push(...data.results); truncated ||= data.truncated;
      if (data.truncated) {
        partialDays.add(window.OpenFrontTeamHistory.dayKey(windows[i + j].start));
        partialDays.add(window.OpenFrontTeamHistory.dayKey(windows[i + j].end - 1));
      }
    }
  }
  return { sessions, truncated, partialDays: [...partialDays] };
}

async function fetchHistoryGames(base, start, end, generation) {
  const query = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
  for (let batch = 0; batch < 80; batch++) {
    if (generation !== state.historyGeneration || !state.historyLoading) throw new Error("chargement remplacé");
    const data = await fetchStatsJson(`${base}/history/games?${query}`);
    if (!Array.isArray(data.games)) throw new Error("Historique invalide");
    if (data.complete) return { games: data.games, truncated: false, cached: data.cached };
    if (generation === state.historyGeneration) $("historyStatus").textContent = `Préparation initiale du cache partagé · ${data.pages} pages indexées${data.oldest ? ` · jusqu’au ${prettyDay(window.OpenFrontTeamHistory.dayKey(data.oldest))}` : ""}. Les prochaines consultations réutiliseront ces données.`;
  }
  throw new Error("L’index historique n’a pas encore couvert toute la période.");
}

async function loadHistory(force = false) {
  const startKey = $("historyStart").value;
  const endKey = $("historyEnd").value;
  const days = (Date.parse(endKey) - Date.parse(startKey)) / 86400000 + 1;
  const status = $("historyStatus");
  if (!Number.isFinite(days) || days < 1 || days > 31 || endKey > window.OpenFrontTeamHistory.dayKey(new Date())) {
    status.textContent = "Choisis une période passée ou actuelle de 1 à 31 jours.";
    return;
  }
  const generation = ++state.historyGeneration;
  const startedAt = performance.now();
  const key = `${startKey}/${endKey}`;
  state.historyLoading = true;
  state.historySelectedDay = endKey;
  state.rankingMatchLimit = 50;
  state.history = null;
  $("rankingView").setAttribute("aria-busy", "true");
  status.textContent = "⏳ Chargement des scores officiels et des joueurs de la période…";
  $("dailyHistory").replaceChildren(el("p", "muted", "L’historique se prépare…"));
  $("periodSummary").replaceChildren();
  renderContributors();
  try {
    const cached = historyCache.get(key);
    let result;
    if (!force && cached && Date.now() - cached.at < STATS_REFRESH_MS) result = cached.value;
    else {
      const base = apiBase();
      if (!base) throw new Error("Service de statistiques non configuré.");
      const start = parisDayStart(new Date(`${startKey}T12:00:00Z`));
      const end = parisDayStart(new Date(`${shiftDay(endKey, 1)}T12:00:00Z`));
      const archivePromise = fetchHistoryGames(base, start, end, generation)
        .then(value => ({ status: "fulfilled", value }), () => ({ status: "rejected" }));
      let scores;
      try { scores = { value: await fetchHistorySessions(base, start, end, generation) }; }
      catch { throw new Error("Les scores officiels sont indisponibles. Réessaie dans un instant."); }
      if (generation !== state.historyGeneration) return;
      const interim = window.OpenFrontTeamHistory.summarize(scores.value.sessions, [], startKey, endKey);
      state.history = { ...interim, start: startKey, end: endKey, archiveLoading: true, sessionsTruncated: scores.value.truncated };
      renderDailyHistory();
      renderContributors();
      status.textContent = `${interim.games} scores officiels disponibles. Identification des joueurs depuis le cache partagé…`;
      const archive = await archivePromise;
      if (generation !== state.historyGeneration) return;
      result = {
        ...window.OpenFrontTeamHistory.summarize(scores.value.sessions, archive.status === "fulfilled" ? archive.value.games : [], startKey, endKey),
        start: startKey, end: endKey,
        sessionsTruncated: scores.value.truncated,
        archiveMissing: archive.status !== "fulfilled",
        archiveTruncated: archive.status === "fulfilled" && archive.value.truncated,
      };
      for (const day of result.days) day.partial = scores.value.partialDays.includes(day.day);
      historyCache.set(key, { at: Date.now(), value: result });
      if (historyCache.size > 6) historyCache.delete(historyCache.keys().next().value);
    }
    if (generation !== state.historyGeneration) return;
    state.history = result;
    const warnings = [];
    if (result.sessionsTruncated) warnings.push("limite de pages atteinte : scores partiels");
    if (result.archiveMissing) warnings.push("historique joueurs indisponible");
    if (result.archiveTruncated) warnings.push("limite de pages atteinte : historique joueurs partiel");
    if (result.matched < result.games) warnings.push(`contributions reconstituées pour ${result.matched}/${result.games} parties`);
    status.textContent = `${warnings.length ? "⚠️ " : ""}${prettyDay(startKey)} → ${prettyDay(endKey)} · ${result.games} parties classées · ${result.players.length} joueurs identifiés · ${( (performance.now() - startedAt) / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s${warnings.length ? ` · ${warnings.join(" · ")}` : ""}.`;
    renderDailyHistory();
    renderContributors();
    renderProfileTeamDetails();
  } catch (error) {
    if (generation !== state.historyGeneration) return;
    status.textContent = `⚠️ ${error.message}`;
    $("dailyHistory").replaceChildren(el("p", "muted", "Historique indisponible. Le bilan global reste accessible."));
  } finally {
    if (generation === state.historyGeneration) {
      state.historyLoading = false;
      $("rankingView").setAttribute("aria-busy", "false");
    }
  }
}

function dataTable(headers, rows, caption) {
  const wrap = el("div", "tableScroll");
  const table = el("table", "dataTable");
  if (caption) table.append(el("caption", "srOnly", caption));
  const head = el("thead");
  const hr = el("tr");
  for (const text of headers) {
    const th = el("th", null, text);
    th.scope = "col";
    hr.append(th);
  }
  head.append(hr);
  const body = el("tbody");
  for (const cells of rows) {
    const tr = el("tr");
    for (const value of cells) {
      const td = el("td");
      if (value instanceof Node) td.append(value); else td.textContent = String(value);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

function pointLabel(value) { return el("strong", value < 0 ? "negative" : value > 0 ? "positive" : "", signedScore(value)); }

function renderDailyHistory() {
  const history = state.history;
  if (!history) return;
  const summary = $("periodSummary");
  const matches = selectedRankingMatches();
  const metrics = window.OpenFrontTeamHistory.analyze(matches);
  const selected = history.days.find(day => day.day === state.historySelectedDay);
  $("dailySelectedTitle").textContent = selected ? `Bilan du ${prettyDay(selected.day)}` : `Bilan cumulé · ${prettyDay(history.start)} → ${prettyDay(history.end)}`;
  summary.replaceChildren(statCell(`Points nets officiels GAL${selected?.partial || !selected && history.sessionsTruncated ? " (partiels)" : ""}`, signedScore(metrics.points)), statCell("Points gagnés", signedScore(metrics.gains)), statCell("Points perdus", signedScore(metrics.deductions)), statCell("Parties classées", metrics.games),
    statCell("Victoires / défaites", `${metrics.wins} / ${metrics.losses}`), statCell("Taux de victoire", metrics.games ? `${(metrics.wins / metrics.games * 100).toFixed(1)} %` : "—"),
    statCell("Joueurs identifiés", history.archiveLoading ? "…" : historyPlayers().length), statCell("Participations GAL", metrics.squadGames ? metrics.participations : "—"),
    statCell("Points nets / partie", metrics.games ? signedScore(metrics.points / metrics.games) : "—"), statCell("GAL moyens / partie", metrics.squadGames ? (metrics.participations / metrics.squadGames).toFixed(1) : "—"),
    statCell(`Durée moyenne (${metrics.timed}/${metrics.games} matchs)`, metrics.timed ? formatDuration(metrics.seconds / metrics.timed) : "—"), statCell("Plus longue série V / D", `${metrics.winStreak} / ${metrics.lossStreak}`));
  const scale = Math.max(1, ...history.days.map(day => Math.abs(day.points)));
  const rows = history.days.map(day => {
    const button = el("button", `dayButton${state.historySelectedDay === day.day ? " selected" : ""}`, prettyDay(day.day));
    button.type = "button";
    button.setAttribute("aria-pressed", String(state.historySelectedDay === day.day));
    button.onclick = () => { state.historySelectedDay = day.day; state.rankingMatchLimit = 50; renderDailyHistory(); renderContributors(); };
    const score = el("div", "historyScore");
    score.append(pointLabel(day.points));
    const bar = el("span", `historyMiniBar${day.points < 0 ? " loss" : ""}`);
    bar.style.setProperty("--day-progress", String(Math.abs(day.points) / scale));
    score.append(bar);
    if (day.partial || history.sessionsTruncated && history.archiveLoading) {
      if (!day.games) score.replaceChildren(el("strong", null, "—"));
      score.prepend(el("span", "muted", "⚠️ Partiel"));
    }
    return [button, score, day.partial && !day.games ? "—" : day.games, day.partial && !day.games ? "—" : `${day.wins} / ${day.losses}`, day.games ? `${Math.round(day.wins / day.games * 100)} %` : "—", history.archiveLoading ? "⏳" : `${day.players.length}${day.matched < day.games ? " ⚠️" : ""}`];
  });
  $("dailyHistory").replaceChildren(dataTable(["Jour", "Points GAL", "Parties", "V / D", "Winrate", "Joueurs"], rows, "Historique quotidien officiel de la team GAL"));
  renderRankingBreakdowns(metrics);
  renderRankingMatches();
}

function selectedRankingMatches() {
  const history = state.history;
  if (!history) return [];
  return (state.historySelectedDay ? history.days.filter(day => day.day === state.historySelectedDay) : history.days).flatMap(day => day.matches || []);
}

function renderRankingBreakdowns(metrics) {
  const highlights = $("dailyHighlights");
  highlights.replaceChildren();
  for (const [title, match] of [["Meilleure partie GAL", metrics.best], ["Partie la moins rentable", metrics.worst]]) {
    const card = el("section", "panel highlightCard");
    card.append(el("span", "eyebrow", title));
    if (match) card.append(el("h3", null, match.map), pointLabel(match.points), el("p", "muted", `${match.mode} · ${match.squad || "?"} GAL · ${match.population || "?"} joueurs`));
    else card.append(el("p", "muted", "Aucune partie classée"));
    highlights.append(card);
  }
  const players = historyPlayers();
  for (const [title, player] of [["Premier contributeur estimé", players[0]], ["Dernier contributeur estimé", players.at(-1)]]) {
    const card = el("section", "panel highlightCard");
    card.append(el("span", "eyebrow", title));
    if (player) {
      const link = el("button", "playerNameButton", player.name);
      link.type = "button"; link.onclick = () => openPlayerDetails(player.id);
      card.append(link, pointLabel(player.points), el("p", "muted", `${player.games} parties · ${player.wins} V / ${player.losses} D`));
    } else card.append(el("p", "muted", state.history.archiveLoading ? "Identification en cours…" : "Aucun joueur identifié"));
    highlights.append(card);
  }
  for (const [host, entries] of [["rankingMaps", metrics.maps], ["rankingModes", metrics.modes]]) {
    $(host).replaceChildren(entries.length ? dataTable(["Carte / mode", "Parties", "V / D", "Winrate", "Points GAL", "Pts / partie"], entries.map(row => [row.name, row.games, `${row.wins} / ${row.losses}`, `${Math.round(row.wins / row.games * 100)} %`, pointLabel(row.points), pointLabel(row.points / row.games)]), "Performance officielle GAL") : el("p", "muted", "Aucune partie sur ce créneau."));
  }
  const hours = $("rankingHours");
  hours.replaceChildren();
  const peak = Math.max(1, ...metrics.hours);
  metrics.hours.forEach((count, hour) => {
    const item = el("div", "hourColumn");
    item.title = `${hour} h : ${count} départ${count > 1 ? "s" : ""} de partie`;
    item.setAttribute("aria-label", item.title);
    const bar = el("span"); bar.style.height = `${count / peak * 100}%`;
    item.append(bar, el("small", null, hour % 3 ? "" : String(hour)));
    hours.append(item);
  });
}

function renderRankingMatches() {
  const filter = $("matchResultFilter").value;
  const matches = selectedRankingMatches().filter(m => filter === "all" || m.won === (filter === "win")).sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const limit = state.rankingMatchLimit || 50;
  const rows = matches.slice(0, limit).map(match => {
    const names = el("div", "matchNames");
    for (const player of match.players) {
      const button = el("button", "playerNameButton", player.name); button.type = "button"; button.onclick = () => openPlayerDetails(player.id); names.append(button);
    }
    if (!match.players.length) names.textContent = state.history?.archiveLoading ? "Identification…" : "Participants indisponibles";
    return [new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(match.start)), match.map, match.mode,
      el("span", match.won ? "positive" : "negative", match.won ? "Victoire" : "Défaite"), pointLabel(match.points), match.duration ? formatDuration(match.duration) : "—", `${match.squad || "—"} / ${match.population || "—"}`, names];
  });
  $("rankingMatchesTitle").textContent = `Journal des parties classées · ${matches.length} résultats`;
  $("rankingMatches").replaceChildren(rows.length ? dataTable(["Départ · Paris", "Carte", "Mode", "Résultat", "Points GAL", "Durée", "GAL / joueurs", "Participants GAL"], rows, "Détail des parties classées GAL") : el("p", "muted", "Aucune partie pour ce filtre."));
  $("moreRankingMatches").hidden = limit >= matches.length;
}

function historyPlayers() {
  return state.historySelectedDay ? state.history.days.find(day => day.day === state.historySelectedDay)?.players || [] : state.history.players;
}

function renderContributors() {
  const host = $("contributorTable");
  const history = state.history;
  if (!history) { host.replaceChildren(el("p", "muted", "Les contributions apparaîtront après le chargement de la période.")); return; }
  $("contributorsTitle").textContent = state.historySelectedDay ? `⚔️ Contributions du ${prettyDay(state.historySelectedDay)}` : `⚔️ Contributions cumulées · ${prettyDay(history.start)} → ${prettyDay(history.end)}`;
  if (history.archiveLoading) { host.replaceChildren(el("p", "muted", "⏳ Les scores sont disponibles. Les contributions arrivent après la lecture des participants…")); return; }
  const search = $("contributorSearch").value.trim().toLocaleLowerCase("fr");
  const players = sortedRankingPlayers();
  const day = history.days.find(day => day.day === state.historySelectedDay);
  const totalGames = day ? day.games : history.games;
  const rows = players.map((player, index) => ({ player, rank: index + 1 })).filter(({ player }) => player.name.toLocaleLowerCase("fr").includes(search)).map(({ player, rank }) => {
    const button = el("button", "playerNameButton", player.name);
    button.type = "button";
    button.onclick = () => openPlayerDetails(player.id);
    const stats = window.OpenFrontTeamHistory.analyze(player.matches || []);
    
    // Flouter les points de Coton
    const hiddenPlayers = new Set(["coton", "Coton", "COTON"]);
    const isHidden = hiddenPlayers.has(player.name);
    const pointsDisplay = isHidden ? "?" : pointLabel(player.points);
    const gainsDisplay = isHidden ? "?" : pointLabel(stats.gains);
    const lossesDisplay = isHidden ? "?" : pointLabel(stats.deductions);
    
    return [rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : rank, button, pointsDisplay, gainsDisplay, lossesDisplay, player.games, player.wins, player.losses,
      `${Math.round(player.wins / player.games * 100)} %`, signedScore(player.points / player.games), totalGames ? `${Math.round(player.games / totalGames * 100)} %` : "—", stats.timed ? formatDuration(stats.seconds) : "—", `${stats.winStreak} / ${stats.lossStreak}`];
  });
  host.replaceChildren(rows.length ? dataTable(["#", "Gaulois", "Net estimé", "Gains estimés", "Pertes estimées", "Parties", "V", "D", "Winrate", "Pts / partie", "Présence team", "Temps joué*", "Séries V / D"], rows, "Contributions estimées des joueurs GAL") : el("p", "muted", history.archiveMissing ? "La source qui identifie les joueurs est indisponible." : "Aucun joueur identifié pour ce filtre. Les contributions nécessitent un score officiel et les participants de la partie."));
  host.append(el("p", "muted", "* Temps joué : somme des durées des matchs identifiés, pas le temps connecté. Les séries concernent uniquement les parties classées de la période sélectionnée. Le tri winrate doit être lu avec le nombre de parties."));
}

function sortedRankingPlayers() {
  if (!state.history) return [];
  const key = $("contributorSort").value;
  const value = player => key === "winrate" ? player.wins / player.games : player[key];
  return [...historyPlayers()].sort((a, b) => value(b) - value(a) || b.points - a.points || b.games - a.games || a.name.localeCompare(b.name, "fr"));
}

function exportRanking() {
  if (!state.history || state.history.archiveLoading) return;
  const players = sortedRankingPlayers().map((player, index) => ({ player, rank: index + 1 })).filter(({ player }) => player.name.toLocaleLowerCase("fr").includes($("contributorSearch").value.trim().toLocaleLowerCase("fr")));
  // Spreadsheet formula injection protection, including usernames.
  const escape = value => `"${(typeof value === "string" ? value.replace(/^[\s]*[=+@-]/, "'$&") : String(value)).replace(/"/g, '""')}"`;
  const rows = [["Jour / période", "Rang", "Joueur", "Net estimé", "Gains estimés", "Pertes estimées", "Parties", "Victoires", "Défaites", "Winrate %", "Pts / partie estimés", "Présence team %", "Temps de matchs (secondes)", "Série victoires", "Série défaites"]];
  const games = state.historySelectedDay ? state.history.days.find(day => day.day === state.historySelectedDay)?.games : state.history.games;
  players.forEach(({ player: p, rank }) => {
    const stats = window.OpenFrontTeamHistory.analyze(p.matches || []);
    
    // Flouter les points de Coton dans l'export
    const hiddenPlayers = new Set(["coton", "Coton", "COTON"]);
    const isHidden = hiddenPlayers.has(p.name);
    
    rows.push([state.historySelectedDay || `${state.history.start}/${state.history.end}`, rank, p.name, 
      isHidden ? "?" : p.points, 
      isHidden ? "?" : stats.gains, 
      isHidden ? "?" : stats.deductions, 
      p.games, p.wins, p.losses, p.wins / p.games * 100, 
      isHidden ? "?" : p.points / p.games, 
      games ? p.games / games * 100 : 0, stats.seconds, stats.winStreak, stats.lossStreak]);
  });
  const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map(row => row.map(escape).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = el("a"); link.href = url; link.download = `GAL-${state.historySelectedDay || state.history.start + "-" + state.history.end}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function playerTeamContent(periodPlayer) {
  const selected = state.historySelectedDay ? historyPlayers().find(p => p.id === periodPlayer.id) : null;
  const player = selected || periodPlayer;
  const population = selected ? historyPlayers() : state.history.players;
  const teamGames = selected ? state.history.days.find(day => day.day === state.historySelectedDay).games : state.history.games;
  const content = el("div");
  const metrics = el("div", "statsGrid");
  
  // Flouter les points de Coton
  const hiddenPlayers = new Set(["coton", "Coton", "COTON"]);
  const isHidden = hiddenPlayers.has(player.name);
  const pointsDisplay = isHidden ? "?" : signedScore(player.points);
  const pointsPerGameDisplay = isHidden ? "?" : signedScore(player.points / player.games);
  
  metrics.append(statCell("⭐ Contribution estimée", pointsDisplay), statCell("🎯 Parties avec GAL", player.games), statCell("🏆 Victoires", player.wins), statCell("💀 Défaites", player.losses), statCell("⚖️ Winrate avec GAL", `${Math.round(player.wins / player.games * 100)} %`), statCell("🚀 Points / partie", pointsPerGameDisplay));
  const rank = population.findIndex(row => row.id === player.id) + 1;
  metrics.append(statCell(selected ? "🏅 Rang estimé du jour" : "🏅 Rang estimé sur la période", `${rank} / ${population.length}`), statCell("🛡️ Présence dans les parties GAL", teamGames ? `${Math.round(player.games / teamGames * 100)} %` : "—"));
  if (periodPlayer.daily?.length) {
    const byScore = [...periodPlayer.daily].sort((a, b) => b.points - a.points);
    const bestPoints = isHidden ? "?" : signedScore(byScore[0].points);
    const worstPoints = isHidden ? "?" : signedScore(byScore.at(-1).points);
    metrics.append(statCell("🔥 Meilleur jour joué", `${prettyDay(byScore[0].day)} · ${bestPoints}`, "wide"), statCell("🧊 Pire jour joué", `${prettyDay(byScore.at(-1).day)} · ${worstPoints}`, "wide"));
  }
  content.append(el("p", "muted", `${selected ? `Journée : ${prettyDay(state.historySelectedDay)}` : `Période : ${prettyDay(state.history.start)} → ${prettyDay(state.history.end)}`}. Statistiques sur les parties classées identifiées, pas sur toute la carrière.`), metrics);
  const days = [...(periodPlayer.daily || [])].reverse();
  if (selected) content.append(el("p", "muted", `Cumul sur la période : ${isHidden ? "?" : signedScore(periodPlayer.points)} points estimés · ${periodPlayer.games} parties · ${periodPlayer.wins} V / ${periodPlayer.losses} D.`));
  if (days.length) content.append(el("h3", null, "📅 Contribution jour par jour"), dataTable(["Jour", "Points estimés", "Parties", "V / D"], days.map(day => [prettyDay(day.day), isHidden ? "?" : pointLabel(day.points), day.games, `${day.wins} / ${day.losses}`]), "Contributions quotidiennes du joueur"));
  content.append(el("p", "muted", "Les points individuels sont une répartition estimée du score GAL. Les parties sans participants identifiables ne sont pas attribuées."));
  const focus = selected || player;
  const stats = window.OpenFrontTeamHistory.analyze(focus.matches || []);
  content.append(el("h3", null, state.historySelectedDay && selected ? `Détail du ${prettyDay(state.historySelectedDay)}` : "Détail de la période"));
  const detail = el("div", "statsGrid");
  detail.append(statCell("Points nets estimés", isHidden ? "?" : signedScore(focus.points)), statCell("Gains / pertes estimés", isHidden ? "?" : `${signedScore(stats.gains)} / ${signedScore(stats.deductions)}`),
    statCell("Temps de match cumulé", stats.timed ? formatDuration(stats.seconds) : "—"), statCell("Séries maximales V / D", `${stats.winStreak} / ${stats.lossStreak}`));
  content.append(detail, dataTable(["Carte", "Parties", "V / D", "Points estimés"], stats.maps.map(row => [row.name, row.games, `${row.wins} / ${row.losses}`, isHidden ? "?" : pointLabel(row.points)]), "Statistiques GAL du joueur par carte"));
  return content;
}

async function openPlayerDetails(id) {
  const player = state.history?.players.find(row => row.id === id);
  if (!player) return;
  const dialog = $("playerDialog");
  dialog.dataset.player = id;
  $("playerDetailName").textContent = `⚔️ ${player.name}`;
  const career = el("section", "careerDetails");
  career.append(el("h3", null, "🎖️ Carrière OpenFront"), el("p", "muted", "Chargement des statistiques publiques…"));
  $("playerDetailContent").replaceChildren(playerTeamContent(player), career);
  if (!dialog.open) dialog.showModal();
  try {
    const cached = playerCareerCache.get(id);
    const profile = cached && Date.now() - cached.at < STATS_REFRESH_MS ? cached.value : await fetchStatsJson(`${apiBase()}/player/${encodeURIComponent(id)}`);
    playerCareerCache.set(id, { at: Date.now(), value: profile });
    if (!dialog.open || dialog.dataset.player !== id) return;
    if (!profile || !profile.stats) throw new Error("Statistiques absentes");
    const stats = sumWinsLosses(profile.stats);
    const grid = el("div", "statsGrid");
    grid.append(statCell("🏆 Victoires carrière", stats.wins), statCell("💀 Défaites carrière", stats.losses), statCell("🎮 Parties carrière", stats.wins + stats.losses), statCell("⚖️ Winrate carrière", stats.wins + stats.losses ? `${Math.round(stats.wins / (stats.wins + stats.losses) * 100)} %` : "—"));
    career.replaceChildren(el("h3", null, "🎖️ Carrière OpenFront · tous modes"), grid);
    const modes = [...careerByMode(profile.stats).values()].filter(row => row.wins + row.losses > 0);
    if (modes.length) career.append(dataTable(["Mode", "V", "D", "Winrate"], modes.map(row => [row.mode, row.wins, row.losses, `${Math.round(row.wins / (row.wins + row.losses) * 100)} %`]), "Carrière publique par mode de jeu"));
  } catch {
    if (dialog.open && dialog.dataset.player === id) career.replaceChildren(el("p", "muted", "Carrière OpenFront indisponible. Les contributions GAL restent visibles."));
  }
}

function renderProfileTeamDetails() {
  const host = $("profileTeamDetails");
  if (!state.pseudo) { host.replaceChildren(el("p", "muted", "Connecte-toi avec ton pseudo pour retrouver tes contributions.")); return; }
  if (!state.ofAccount) { host.replaceChildren(el("p", "muted", "Choisis ton compte OpenFront dans le profil pour retrouver tes contributions dans la team.")); return; }
  const history = state.history;
  if (!history) { host.replaceChildren(el("p", "muted", "Charge une période dans Classement pour consulter tes contributions.")); return; }
  if (history.archiveLoading) { host.replaceChildren(el("p", "muted", "⏳ Recherche des contributions dans l’historique GAL…")); return; }
  const player = history.players.find(row => row.id === state.ofAccount.publicId);
  host.replaceChildren(player ? playerTeamContent(player) : el("p", "muted", `Aucune contribution identifiée du ${prettyDay(history.start)} au ${prettyDay(history.end)}${history.matched < history.games ? " : l’historique joueurs est partiel" : ""}.`));
}

function initSiteShell() {
  $("headerConnection").append($("loginBox"));
  $("headerSession").append($("logoutBtn"));
  $("profileSlot").append($("profileCard"));
  // Garder teamStats dans playView (à gauche des maps)
  $("leftRail").remove();
  $("navPlay").onclick = () => showView("play");
  $("navProfile").onclick = $("headerIdentity").onclick = () => showView("profile");
  $("navRanking").onclick = () => showView("ranking");
  document.querySelector(".headerBrand").onclick = event => { event.preventDefault(); showView("play"); };
  const today = window.OpenFrontTeamHistory.dayKey(new Date());
  $("historyStart").max = $("historyEnd").max = today;
  setHistoryPeriod(1);
  $("historyFilters").onsubmit = event => { event.preventDefault(); loadHistory(); };
  $("refreshHistory").onclick = () => { loadTeamStats(); loadHistory(true); };
  $("historyWeek").onclick = () => { setHistoryPeriod(7); loadHistory(); };
  $("historyMonth").onclick = () => { setHistoryPeriod(30); loadHistory(); };
  $("historyToday").onclick = () => { setHistoryPeriod(1); loadHistory(); };
  $("historyAllDays").onclick = () => { state.historySelectedDay = ""; renderDailyHistory(); renderContributors(); };
  $("contributorSearch").oninput = renderContributors;
  $("contributorSort").onchange = renderContributors;
  $("exportRanking").onclick = exportRanking;
  $("matchResultFilter").onchange = () => { state.rankingMatchLimit = 50; renderRankingMatches(); };
  $("moreRankingMatches").onclick = () => { state.rankingMatchLimit = (state.rankingMatchLimit || 50) + 50; renderRankingMatches(); };
  $("closePlayerDialog").onclick = () => $("playerDialog").close();
  $("playerDialog").onclick = event => {
    const dialog = $("playerDialog");
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  };
  $("closeRallySpotlight").onclick = () => closeRallySpotlight(true);
  $("rallySpotlight").onclick = event => {
    if (event.target === $("rallySpotlight")) closeRallySpotlight(true);
  };
  $("rallySpotlight").addEventListener("cancel", event => {
    event.preventDefault();
    closeRallySpotlight(true);
  });
  $("rallySpotlightJoin").onclick = event => {
    event.stopPropagation();
    const gameId = $("rallySpotlight").dataset.gameId;
    if (!state.games.has(gameId)) return closeRallySpotlight(true);
    selectRally(gameId);
    window.open(JOIN_URL(gameId), "_blank", "noopener,noreferrer");
    $("rallySpotlight").close();
    window.focus();
  };
}

function init() {
  window.TEAM = window.TEAM || {};
  initSiteShell();
  document.addEventListener("pointerdown", primeRallyHorn, { once: true, capture: true });
  document.addEventListener("keydown", primeRallyHorn, { once: true, capture: true });
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
  // Pagination buttons removed - using 3-column layout without pagination
  if (typeof ResizeObserver !== "undefined") {
    const layoutObserver = new ResizeObserver(scheduleRender);
    layoutObserver.observe($("board"));
  }
  window.addEventListener("resize", scheduleRender);
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
