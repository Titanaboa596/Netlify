/* ──────────────────────────────────────────────────────────────────────────
   11. NETWORKING — FastAPI WebSocket (Technical Component G)

   Deployment model:
   • Frontend (HTML/CSS/JS) → Netlify (static hosting)
   • Backend (server.py)    → Railway (persistent server)

   CONFIGURATION — edit WS_SERVER_URL below to point at your Railway URL.
   Leave it as an empty string to auto-detect (works for local development).

   WS_SERVER_URL examples:
     ''                                        → auto-detect from page origin
     'wss://tank-trouble.up.railway.app'       → your Railway deployment
─────────────────────────────────────────────────────────────────────────── */

/**
 * Set this to your Railway WebSocket server URL when deploying to Netlify.
 * Format: 'wss://your-app-name.up.railway.app'
 * Leave as '' to auto-detect from the page origin (local dev mode).
 * @type {string}
 */
const WS_SERVER_URL = '';

let wsConnection = null;  // active WebSocket instance
let myRole       = null;  // 'p1' (host) or 'p2' (joiner), assigned by server
let pingInterval = null;  // setInterval ID for latency pings

/* ── Diagnostic panel helpers ─────────────────────────────────────────── */

/**
 * Update one row in the connection diagnostic panel.
 * @param {string} id   - 'ws' | 'role' | 'lobby' | 'game'
 * @param {string} icon - emoji
 * @param {string} text - status text
 * @param {string} cls  - 'ds-ok' | 'ds-fail' | 'ds-spin'
 */
function diagSetStep(id, icon, text, cls) {
  const row = document.getElementById('d-' + id);
  const st  = document.getElementById('ds-' + id);
  if (!row || !st) return;
  row.querySelector('.diag-icon').textContent = icon;
  st.textContent = text;
  st.className   = 'diag-status ' + (cls || '');
}

/** Set the small status message below the diagnostic box. */
function diagSetMessage(msg, color) {
  const el = document.getElementById('waitMsg');
  if (el) { el.textContent = msg; el.style.color = color || '#f5c518'; }
}

/** Reset all diagnostic rows to their initial pending state. */
function diagReset() {
  ['ws', 'role', 'lobby', 'game'].forEach(id =>
    diagSetStep(id, '⏳', 'waiting…', 'ds-spin')
  );
  diagSetMessage('');
  document.getElementById('waitTitle').textContent = 'Connecting…';
}

/* ── WebSocket URL resolution ─────────────────────────────────────────── */

/**
 * Return the WebSocket server URL.
 *
 * Priority:
 *   1. WS_SERVER_URL constant (set this for Netlify deployments)
 *   2. Auto-detect from page origin:
 *      - localhost / 127.0.0.1 → ws://localhost:8081/ws  (local dev)
 *      - any other host        → wss://<same-host>/ws    (ngrok etc.)
 */
function getWebSocketUrl() {
  if (WS_SERVER_URL) return WS_SERVER_URL + '/ws';

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const host  = (location.hostname === '127.0.0.1' ||
                 location.hostname === 'localhost'  ||
                 location.hostname === '')
                ? 'localhost:8081'
                : location.host;
  return proto + '://' + host + '/ws';
}

/* ── WebSocket connection ─────────────────────────────────────────────── */

/**
 * Open the WebSocket connection.
 * Returns a Promise that resolves on open, rejects after 10 s timeout.
 */
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const url = getWebSocketUrl();
    diagSetStep('ws', '🔄', 'connecting…', 'ds-spin');

    try {
      wsConnection = new WebSocket(url);
    } catch (err) {
      diagSetStep('ws', '❌', 'could not open', 'ds-fail');
      reject(err); return;
    }

    const timeout = setTimeout(() => {
      diagSetStep('ws', '❌', 'timed out', 'ds-fail');
      reject(new Error('WebSocket timed out'));
    }, 10000);

    wsConnection.onopen = () => {
      clearTimeout(timeout);
      diagSetStep('ws', '✅', 'connected', 'ds-ok');
      resolve(wsConnection);
    };
    wsConnection.onerror = () => {
      clearTimeout(timeout);
      diagSetStep('ws', '❌', 'connection error', 'ds-fail');
      reject(new Error('WebSocket error'));
    };
    wsConnection.onclose = () => {
      document.getElementById('pingEl').textContent = '⚠ disconnected';
    };
  });
}

/** JSON-encode and send a message (no-op if socket is not open). */
function sendWsMessage(obj) {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify(obj));
  }
}

/* ── In-game message senders ──────────────────────────────────────────── */

/** Host → joiner: full authoritative game state at ~20 Hz. */
function netSendState() {
  if (myRole !== 'p1') return;
  sendWsMessage({
    t:          'state',
    tanks:      tanks.map(tk => tk.toJSON()),
    pus:        powerupItems.map(p => p.toJSON()),
    scores,
    roundover:  gamePhase === 'roundover',
    playing:    gamePhase === 'playing',
    roundWinner,
  });
}

/** Joiner → host: local keyboard input snapshot at ~20 Hz. */
function netSendInput() {
  if (myRole !== 'p2') return;
  sendWsMessage({ t: 'inp', inp: getInputSnapshot(KEYS_P2) });
}

/* ── Incoming message handler ─────────────────────────────────────────── */

/**
 * Route an incoming WebSocket message to the correct handler.
 * Server-control messages (assigned/ready/full/peer_left) are handled here.
 * Game-play messages are handled based on myRole.
 * @param {MessageEvent} evt
 */
function onWebSocketMessage(evt) {
  let data;
  try { data = JSON.parse(evt.data); } catch { return; }
  if (!data || !data.t) return;

  // ── Server control messages ─────────────────────────────────────────────

  if (data.t === 'assigned') {
    // Server tells us our role authoritatively — no client-side guessing
    myRole      = data.role;
    isHost      = (data.role === 'p1');
    isLocalGame = false;

    if (data.role === 'p1') {
      diagSetStep('role',  '✅', 'you are Player 1 (host)', 'ds-ok');
      diagSetStep('lobby', '🔄', 'waiting for Player 2…',   'ds-spin');
      diagSetStep('game',  '🔄', 'waiting for opponent…',   'ds-spin');
      diagSetMessage('Waiting for your opponent to open the link…');
      document.getElementById('waitTitle').textContent = 'Waiting for opponent…';
      setOnlineLabels(true);
    } else {
      diagSetStep('role',  '✅', 'you are Player 2',    'ds-ok');
      diagSetStep('lobby', '✅', 'joined host',         'ds-ok');
      diagSetStep('game',  '🔄', 'waiting for start…',  'ds-spin');
      diagSetMessage('Found a host! Waiting for game to start…');
      setOnlineLabels(false);
    }
    return;
  }

  if (data.t === 'ready') {
    // Server tells P1 that P2 has joined — kick off the game
    diagSetStep('lobby', '✅', 'opponent joined', 'ds-ok');
    diagSetStep('game',  '✅', 'starting!',        'ds-ok');
    diagSetMessage('Opponent connected! Starting…', '#4caf50');
    const seed = Math.floor(Math.random() * 0xFFFFFF);
    initRound(seed);
    sendWsMessage({ t: 'start', seed, scores: [0, 0] });
    startGame();
    startPingLoop();
    return;
  }

  if (data.t === 'full') {
    diagSetStep('lobby', '❌', 'room full', 'ds-fail');
    diagSetMessage('A game is already in progress. Try again soon.', '#ff3d71');
    return;
  }

  if (data.t === 'peer_left') {
    document.getElementById('pingEl').textContent = '⚠ opponent left';
    showLobby();
    return;
  }

  // ── Game-play messages ──────────────────────────────────────────────────

  if (myRole === 'p1') {
    if (data.t === 'inp')  remoteInput = data.inp || {};
    if (data.t === 'pong') {
      document.getElementById('pingEl').textContent = (Date.now() - data.ts) + 'ms';
    }
  }

  if (myRole === 'p2') {
    if (data.t === 'start') {
      scores = data.scores || [0, 0];
      initRound(data.seed);
      diagSetStep('game', '✅', 'game started', 'ds-ok');
      startGame();
      startPingLoop();
    }

    if (data.t === 'state') {
      if (data.tanks && tanks.length === 2) {
        data.tanks.forEach((d, i) => { if (tanks[i]) tanks[i].applyJSON(d); });
      }
      if (data.pus) {
        powerupItems = (data.pus || [])
          .map(p => {
            const type = POWERUP_TYPES.find(pt => pt.id === p.typeId) || POWERUP_TYPES[0];
            const item = new PowerUpItem(p.x, p.y, type, p.pulse);
            item.alive = p.alive;
            return item;
          })
          .filter(p => p.alive);
      }
      if (data.scores) { scores = data.scores; updateScoreHUD(); }
      updatePowerupHUD();
      if (data.roundover && gamePhase !== 'roundover') {
        roundWinner = data.roundWinner;
        showRoundOver();
      }
      if (data.playing && gamePhase === 'roundover') hideRoundOver();
    }

    if (data.t === 'newround') {
      hideRoundOver();
      initRound(data.seed);
      scores = data.scores || scores;
      updateScoreHUD();
    }

    if (data.t === 'ping') sendWsMessage({ t: 'pong', ts: data.ts });
  }
}

/* ── Ping loop ────────────────────────────────────────────────────────── */

/** Send pings every 2.5 s (host only) to measure round-trip latency. */
function startPingLoop() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (myRole === 'p1') sendWsMessage({ t: 'ping', ts: Date.now() });
  }, 2500);
}

/* ── Teardown ─────────────────────────────────────────────────────────── */

/** Close the WebSocket and stop the ping loop. */
function stopNetwork() {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (wsConnection) { try { wsConnection.close(); } catch {} wsConnection = null; }
  myRole = null;
}

/* ── Matchmaking entry point ──────────────────────────────────────────── */

/**
 * Connect to the server and request a role.
 * The server assigns roles authoritatively — no timing race possible.
 */
async function startMatchmaking() {
  diagReset();
  diagSetMessage('Connecting to server…');

  try {
    await connectWebSocket();
  } catch {
    diagSetMessage(
      'Cannot reach game server. Is it running?',
      '#ff3d71'
    );
    return;
  }

  wsConnection.onmessage = onWebSocketMessage;

  // Ask the server for a role slot
  diagSetStep('role', '🔄', 'requesting role…', 'ds-spin');
  sendWsMessage({ t: 'join' });
}

/* ── HUD label helpers ────────────────────────────────────────────────── */

/** Update player labels and mode badge for online play. */
function setOnlineLabels(amHost) {
  if (amHost) {
    document.getElementById('p1lbl').textContent = 'ESDF · Q (YOU)';
    document.getElementById('p2lbl').textContent = 'REMOTE';
    document.getElementById('c1h').textContent   = 'YOU: ESDF · Q fire';
    document.getElementById('c2h').textContent   = 'Opponent: remote';
  } else {
    document.getElementById('p1lbl').textContent = 'REMOTE';
    document.getElementById('p2lbl').textContent = 'ARROWS · M (YOU)';
    document.getElementById('c1h').textContent   = 'Opponent: remote';
    document.getElementById('c2h').textContent   = 'YOU: Arrows · M fire';
  }
  document.getElementById('modeLbl').textContent = 'ONLINE';
}

/** Return to the lobby and clean up all network state. */
function showLobby() {
  stopNetwork();
  gamePhase = 'lobby';
  gameLoop.stop();
  document.getElementById('waiting').classList.remove('on');
  document.getElementById('hud').classList.remove('on');
  document.getElementById('roundOverlay').classList.remove('on');
  document.getElementById('lobby').style.display = 'flex';
}
