/* OpenFront lobby WebSocket decoder.
 *
 * Since OpenFrontIO commit d70e4865ca (2026-08-21), lobby frames use the
 * project's positional Zbin format instead of JSON. This is a deliberately
 * small, dependency-free decoder for PublicLobbyMessageSchema only.
 */
(function (root) {
  "use strict";

  const MAX_ITEMS = 1 << 20;
  const MAX_SAFE = Number.MAX_SAFE_INTEGER;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  class WireError extends Error {
    constructor(message) {
      super(message);
      this.name = "OpenFrontLobbyWireError";
    }
  }

  class Reader {
    constructor(bytes) {
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pos = 0;
      this.items = 0;
    }

    need(length) {
      if (this.pos + length > this.bytes.length) {
        throw new WireError("Trame lobby tronquee");
      }
    }

    get remaining() {
      return this.bytes.length - this.pos;
    }

    u8() {
      this.need(1);
      return this.bytes[this.pos++];
    }

    readBytes(length) {
      this.need(length);
      const value = this.bytes.subarray(this.pos, this.pos + length);
      this.pos += length;
      return value;
    }

    uint() {
      let result = 0;
      let multiplier = 1;
      for (;;) {
        const byte = this.u8();
        result += (byte & 0x7f) * multiplier;
        if ((byte & 0x80) === 0) {
          if (byte === 0 && multiplier !== 1) {
            throw new WireError("Varint lobby non minimal");
          }
          break;
        }
        multiplier *= 0x80;
        if (multiplier > MAX_SAFE) throw new WireError("Varint lobby trop grand");
      }
      if (result > MAX_SAFE) throw new WireError("Varint lobby trop grand");
      return result;
    }

    float64() {
      this.need(8);
      const value = this.view.getFloat64(this.pos, true);
      this.pos += 8;
      return value;
    }

    string() {
      const length = this.uint();
      const bytes = this.readBytes(length);
      try {
        return decoder.decode(bytes);
      } catch {
        throw new WireError("Texte UTF-8 invalide dans la trame lobby");
      }
    }

    takeItems(count) {
      this.items += count;
      if (this.items > MAX_ITEMS) throw new WireError("Trame lobby trop volumineuse");
    }

    end() {
      if (this.remaining !== 0) {
        throw new WireError(`${this.remaining} octet(s) inattendu(s) en fin de trame`);
      }
    }
  }

  const body = (name, decode, options = {}) => ({ name, decode, ...options });
  const bool = (name, options = {}) => ({ name, kind: "bool", ...options });
  const literal = (name, value) => ({ name, kind: "literal", value });

  function object(fields) {
    let bit = 0;
    const plans = fields.map(field => ({
      ...field,
      presenceBit: field.optional ? bit++ : -1,
      nullBit: field.nullable ? bit++ : -1,
      valueBit: field.kind === "bool" ? bit++ : -1,
    }));
    const headerBytes = Math.ceil(bit / 8);

    return reader => {
      const header = reader.readBytes(headerBytes);
      const hasBit = index => index >= 0 &&
        (header[index >> 3] & (1 << (index & 7))) !== 0;
      const value = {};

      for (const field of plans) {
        if (field.optional && !hasBit(field.presenceBit)) continue;
        if (field.nullable && hasBit(field.nullBit)) {
          value[field.name] = null;
        } else if (field.kind === "bool") {
          value[field.name] = hasBit(field.valueBit);
        } else if (field.kind === "literal") {
          value[field.name] = field.value;
        } else {
          value[field.name] = field.decode(reader);
        }
      }
      return value;
    };
  }

  const uint = reader => reader.uint();
  const float64 = reader => reader.float64();
  const string = reader => reader.string();

  const enumeration = values => reader => {
    const ordinal = reader.uint();
    if (ordinal >= values.length) {
      throw new WireError(`Valeur d'enum lobby inconnue: ${ordinal}`);
    }
    return values[ordinal];
  };

  const array = decodeItem => reader => {
    const count = reader.uint();
    reader.takeItems(count);
    if (count > reader.remaining && reader.remaining !== 0) {
      throw new WireError("Tableau lobby incompatible avec la trame restante");
    }
    const values = [];
    for (let i = 0; i < count; i++) values.push(decodeItem(reader));
    return values;
  };

  const record = (decodeKey, decodeValue) => reader => {
    const count = reader.uint();
    reader.takeItems(count);
    const value = {};
    for (let i = 0; i < count; i++) {
      const key = decodeKey(reader);
      if (key === "__proto__" || Object.prototype.hasOwnProperty.call(value, key)) {
        throw new WireError(`Cle lobby invalide: ${key}`);
      }
      value[key] = decodeValue(reader);
    }
    return value;
  };

  const union = variants => reader => {
    const ordinal = reader.uint();
    if (ordinal >= variants.length) {
      throw new WireError(`Variante lobby inconnue: ${ordinal}`);
    }
    return variants[ordinal](reader);
  };

  const constant = value => () => value;

  // Enum order is part of Zbin's wire contract. Keep this list in the same
  // order as OpenFrontIO/src/core/game/Maps.gen.ts.
  const GAME_MAPS = [
    "Achiran", "Aegean", "Africa", "Alps", "Amazon River", "Antarctica",
    "ArchipelagoSea", "Arctic", "Asia", "Australia", "Baikal",
    "Baikal Nuke Wars", "Baja California", "Balkans", "Balkhash", "Baltics",
    "Bering Sea", "Bering Strait", "Between Two Seas", "Black Sea",
    "Bosphorus Straits", "Branching Paths", "Britannia", "Britannia Classic",
    "Caribbean", "Caspian Sea", "Caucasus", "China", "Chopping Block",
    "Clearwater Lakes", "Conakry", "Crimea", "Danish Straits",
    "Deglaciated Antarctica", "Didier", "Didier France", "Dyslexdria",
    "East Asia", "Europe", "Europe Classic", "Falkland Islands",
    "Faroe Islands", "Finger Lakes", "Four Islands", "France",
    "Gateway to the Atlantic", "Germany", "Giant World Map", "Great Lakes",
    "Gulf Of Guinea", "Gulf of St. Lawrence", "Halkidiki", "Hawaii",
    "Hecate Strait", "Hong Kong", "Iceland", "Indian Subcontinent",
    "Irish Sea", "Italia", "Japan", "Juan De Fuca Strait", "Korea",
    "Labyrinth", "Las Vegas Strip", "Lemnos", "Levant", "Lisbon",
    "Los Angeles", "Luna", "Manicouagan", "Mare Nostrum", "Mars", "Mena",
    "Middle East", "MilkyWay", "Mississippi River", "Montreal",
    "More Than Luck", "New York City", "Nile Delta", "North America",
    "Northwest Passage", "Oceania", "Onion", "Pangaea", "Passage", "Pluto",
    "Russia", "San Francisco", "Scandinavia", "Sierpinski", "Sol",
    "South America", "SoutheastAsia", "Strait of Gibraltar",
    "Strait of Hormuz", "Strait Of Malacca", "Surrounded", "Svalmel",
    "Taiwan Strait", "The Box", "Tierra Del Fuego", "Titan",
    "Tourney 2 Teams", "Tourney 3 Teams", "Tourney 4 Teams",
    "Tourney 8 Teams", "Traders Dream", "Two Lakes", "United States",
    "Venice", "Vietnam", "Warship Warship", "World", "World Inverted",
    "Yangtze River", "Yellow Sea", "Yenisei",
  ];

  const GAME_TYPES = ["Singleplayer", "Public", "Private"];
  const GAME_MODES = ["Free For All", "Team"];
  const RANKED_TYPES = ["1v1", "2v2"];
  const MAP_SIZES = ["Compact", "Normal"];
  const DIFFICULTIES = ["Easy", "Medium", "Hard", "Impossible"];
  const PUBLIC_TYPES = ["ffa", "team", "special", "hosted"];
  const LOBBY_ACCENTS = ["gold", "blue", "green", "red"];
  const UNIT_TYPES = [
    "Transport", "Warship", "Shell", "SAMMissile", "Port", "Atom Bomb",
    "Hydrogen Bomb", "Trade Ship", "Missile Silo", "Defense Post",
    "SAM Launcher", "City", "MIRV", "MIRV Warhead", "Train", "Factory",
  ];

  const doomsdayClock = object([
    bool("enabled", { optional: true }),
    body("speed", enumeration(["slow", "normal", "fast", "veryfast"]), { optional: true }),
  ]);

  const overtime = object([
    bool("enabled", { optional: true }),
    body("startMinutes", uint, { optional: true }),
  ]);

  const publicGameModifiers = object([
    bool("isCompact", { optional: true }),
    bool("isRandomSpawn", { optional: true }),
    bool("isCrowded", { optional: true }),
    bool("isHardNations", { optional: true }),
    body("startingGold", uint, { optional: true }),
    body("goldMultiplier", float64, { optional: true }),
    bool("isAlliancesDisabled", { optional: true }),
    bool("isPortsDisabled", { optional: true }),
    bool("isNukesDisabled", { optional: true }),
    bool("isSAMsDisabled", { optional: true }),
    bool("isPeaceTime", { optional: true }),
    bool("isWaterNukes", { optional: true }),
    bool("isDoomsdayClock", { optional: true }),
    bool("isOvertime", { optional: true }),
  ]);

  const nations = union([
    uint,
    enumeration(["default", "disabled"]),
  ]);

  const teamCount = union([
    uint,
    constant("Duos"),
    constant("Trios"),
    constant("Quads"),
    constant("Humans Vs Nations"),
  ]);

  const hostCheats = object([
    bool("infiniteGold", { optional: true }),
    bool("infiniteTroops", { optional: true }),
    body("goldMultiplier", float64, { optional: true, nullable: true }),
    body("startingGold", uint, { optional: true, nullable: true }),
  ]);

  const gameConfig = object([
    body("gameMap", enumeration(GAME_MAPS)),
    body("difficulty", enumeration(DIFFICULTIES)),
    bool("donateGold"),
    bool("donateTroops"),
    body("gameType", enumeration(GAME_TYPES)),
    body("gameMode", enumeration(GAME_MODES)),
    body("rankedType", enumeration(RANKED_TYPES), { optional: true }),
    body("gameMapSize", enumeration(MAP_SIZES)),
    body("doomsdayClock", doomsdayClock, { optional: true }),
    body("overtime", overtime, { optional: true }),
    body("publicGameModifiers", publicGameModifiers, { optional: true }),
    body("nations", nations),
    body("bots", uint),
    bool("infiniteGold"),
    bool("infiniteTroops"),
    bool("instantBuild"),
    bool("disableNavMesh", { optional: true }),
    bool("disableAlliances", { optional: true, nullable: true }),
    bool("disableClanTags", { optional: true }),
    bool("liveStatsEnabled", { optional: true }),
    bool("anonymizeNames", { optional: true }),
    body("nameReveals", array(string), { optional: true }),
    body("nameRevealPublicIds", array(string), { optional: true }),
    bool("waterNukes", { optional: true, nullable: true }),
    bool("randomSpawn"),
    body("maxPlayers", uint, { optional: true }),
    body("allowedPublicIds", array(string), { optional: true }),
    body("maxTimerValue", uint, { optional: true, nullable: true }),
    body("customAllianceDuration", uint, { optional: true, nullable: true }),
    body("startDelay", uint, { optional: true, nullable: true }),
    body("spawnImmunityDuration", uint, { optional: true, nullable: true }),
    body("disabledUnits", array(enumeration(UNIT_TYPES)), { optional: true }),
    body("playerTeams", teamCount, { optional: true }),
    body("goldMultiplier", float64, { optional: true, nullable: true }),
    body("startingGold", uint, { optional: true, nullable: true }),
    body("hostCheats", hostCheats, { optional: true }),
  ]);

  const publicGameInfo = object([
    body("gameID", string),
    body("numClients", uint),
    body("startsAt", uint, { optional: true }),
    body("gameConfig", gameConfig, { optional: true }),
    body("publicGameType", enumeration(PUBLIC_TYPES)),
    body("label", string, { optional: true }),
    body("accent", enumeration(LOBBY_ACCENTS), { optional: true }),
    bool("featured", { optional: true }),
  ]);

  const games = record(enumeration(PUBLIC_TYPES), array(publicGameInfo));
  const counts = record(string, uint);

  const fullMessage = object([
    literal("type", "full"),
    body("serverTime", uint),
    body("games", games),
  ]);

  const countsMessage = object([
    literal("type", "counts"),
    body("serverTime", uint),
    body("counts", counts),
  ]);

  const lobbyMessage = union([fullMessage, countsMessage]);

  function decodeLobbyMessage(input) {
    let bytes;
    if (input instanceof Uint8Array) {
      bytes = input;
    } else if (input instanceof ArrayBuffer) {
      bytes = new Uint8Array(input);
    } else if (ArrayBuffer.isView(input)) {
      bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else {
      throw new WireError("Type de trame lobby non pris en charge");
    }

    const reader = new Reader(bytes);
    const message = lobbyMessage(reader);
    reader.end();
    return message;
  }

  root.OpenFrontLobbyWire = Object.freeze({ decodeLobbyMessage, WireError });
})(globalThis);
