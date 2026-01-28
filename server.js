const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const INDEX_PATH = path.join(__dirname, "index.html");

// ---- Card setup ----
const SUITS = [
  { s: "♠", color: "#1a1a1a" },
  { s: "♥", color: "#d1223b" },
  { s: "♦", color: "#d1223b" },
  { s: "♣", color: "#1a1a1a" }
];
const RANKS = [
  { r: "A", v: 1 }, { r: "2", v: 2 }, { r: "3", v: 3 }, { r: "4", v: 4 },
  { r: "5", v: 5 }, { r: "6", v: 6 }, { r: "7", v: 7 }, { r: "8", v: 8 },
  { r: "9", v: 9 }, { r: "10", v: 10 }, { r: "J", v: 11 }, { r: "Q", v: 12 }, { r: "K", v: 13 }
];

function makeDeck() {
  const d = [];
  for (const suit of SUITS) for (const rank of RANKS) {
    d.push({ rank: rank.r, value: rank.v, suit: suit.s, color: suit.color });
  }
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Game state (single shared lobby) ----
const STARTING_CHIPS = 1000;
const ROUND_TIME_MS = 15000;
const PAIR_MULT = 11;

const state = {
  hostId: null,
  phase: "idle", // idle | betting | revealed
  deck: shuffle(makeDeck()),
  card1: null,
  card2: null,
  card3: null,
  betDeadline: null,
  players: new Map(),
  lastRound: null,
  config: { pairRule: true }
};

let revealTimer = null;

function ensureDeck(n = 3) {
  if (state.deck.length < n) state.deck = shuffle(makeDeck());
}
function drawCard() {
  ensureDeck(1);
  return state.deck.pop();
}
function publicState() {
  return {
    hostId: state.hostId,
    phase: state.phase,
    deckCount: state.deck.length,
    card1: state.card1,
    card2: state.card2,
    card3: state.card3,
    betDeadline: state.betDeadline,
    config: state.config,
    players: Array.from(state.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      connected: p.connected,
      lastDelta: p.lastDelta ?? 0
    })),
    lastRound: state.lastRound
  };
}
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast() {
  for (const [id, p] of state.players.entries()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      send(p.ws, { type: "state", you: id, state: publicState() });
    }
  }
}
function setHostIfNeeded() {
  if (state.hostId && state.players.has(state.hostId) && state.players.get(state.hostId).connected) return;
  for (const p of state.players.values()) {
    if (p.connected) { state.hostId = p.id; return; }
  }
  state.hostId = null;
}
function isHost(id) {
  return state.hostId && id === state.hostId;
}

function newHand() {
  ensureDeck(3);
  state.card1 = drawCard();
  state.card2 = drawCard();
  state.card3 = null;
  state.phase = "betting";
  state.betDeadline = Date.now() + ROUND_TIME_MS;
  state.lastRound = null;

  for (const p of state.players.values()) {
    p.bet = 0;
    p.lastDelta = 0;
  }

  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    if (state.phase === "betting") reveal();
  }, ROUND_TIME_MS + 50);
}

function reveal() {
  if (state.phase !== "betting") return;

  state.card3 = drawCard();
  state.phase = "revealed";
  state.betDeadline = null;

  const outcomes = {};
  const v1 = state.card1.value;
  const v2 = state.card2.value;
  const v3 = state.card3.value;

  const isPair = (v1 === v2);
  const lo = Math.min(v1, v2);
  const hi = Math.max(v1, v2);

  for (const p of state.players.values()) {
    let bet = Math.floor(Number(p.bet || 0));
    if (!Number.isFinite(bet) || bet < 0) bet = 0;
    if (bet > p.chips) bet = p.chips;

    let delta = 0;
    let win = false;

    if (bet === 0) {
      delta = 0;
    } else if (isPair) {
      if (!state.config.pairRule) {
        delta = -bet;
      } else {
        win = (v3 === v1);
        delta = win ? bet * PAIR_MULT : -bet;
      }
    } else {
      win = (v3 > lo && v3 < hi);
      delta = win ? bet : -bet;
    }

    p.chips = Math.max(0, p.chips + delta);
    p.lastDelta = delta;
    outcomes[p.id] = { bet, delta, win };
  }

  state.lastRound = { outcomes };
}

// ---- HTTP server: SERVE THE UI ----
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.url === "/" || req.url.startsWith("/?")) {
    fs.readFile(INDEX_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("index.html not found in repo root.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// ---- WebSocket server ----
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();

  const player = {
    id,
    name: "Player " + id.slice(0, 4),
    chips: STARTING_CHIPS,
    bet: 0,
    connected: true,
    lastDelta: 0,
    ws
  };
  state.players.set(id, player);

  if (!state.hostId) state.hostId = id;
  setHostIfNeeded();

  send(ws, { type: "welcome", you: id });
  broadcast();

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

    const p = state.players.get(id);
    if (!p) return;

    if (msg.type === "set_name") {
      const nm = String(msg.name || "").trim().slice(0, 18);
      if (nm) p.name = nm;
      broadcast();
      return;
    }

    if (msg.type === "place_bet") {
      if (state.phase !== "betting") return;
      const bet = Math.floor(Number(msg.bet));
      if (!Number.isFinite(bet)) return;
      p.bet = Math.max(0, Math.min(p.chips, bet));
      broadcast();
      return;
    }

    if (msg.type === "sit_out") {
      if (state.phase !== "betting") return;
      p.bet = 0;
      broadcast();
      return;
    }

    if (msg.type === "host_new_hand") {
      if (!isHost(id)) return;
      if (state.phase === "betting") return;
      newHand();
      broadcast();
      return;
    }

    if (msg.type === "host_reveal_now") {
      if (!isHost(id)) return;
      if (state.phase !== "betting") return;
      reveal();
      broadcast();
      return;
    }

    if (msg.type === "reset_me") {
      p.chips = STARTING_CHIPS;
      p.bet = 0;
      p.lastDelta = 0;
      broadcast();
      return;
    }
  });

  ws.on("close", () => {
    const p = state.players.get(id);
    if (p) { p.connected = false; p.ws = null; }
    setHostIfNeeded();
    broadcast();
  });
});

server.listen(PORT, () => console.log("Server listening on", PORT));
