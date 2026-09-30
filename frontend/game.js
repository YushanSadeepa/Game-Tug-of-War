/**
 * ==========================================================================
 *  Online Tug-of-War — Client Game Engine
 * ==========================================================================
 *  - Explicitly connects to the backend Socket.io server (separate origin).
 *  - HTML5 Canvas rendering (sky, clouds, ground, rope, flag, characters)
 *  - Web Audio API synthesized sound effects (no external audio files)
 *  - Client-side interpolation (lerp) for smooth rope movement despite
 *    network latency
 * ==========================================================================
 */

(() => {
  'use strict';

  // ------------------------------------------------------------------
  // BACKEND CONNECTION CONFIG
  // ------------------------------------------------------------------
  // The frontend is now a fully separate app (its own folder / origin),
  // so the backend URL must be explicit rather than relying on a same-
  // origin default. Change this if the backend is deployed elsewhere.
  const BACKEND_URL = 'http://localhost:3000';

  // ------------------------------------------------------------------
  // DOM REFERENCES
  // ------------------------------------------------------------------
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const canvasWrapper = document.getElementById('canvasWrapper');

  const connectionStatusEl = document.getElementById('connectionStatus');
  const connectionStatusTextEl = document.getElementById('connectionStatusText');

  const roleBadgeEl = document.getElementById('roleBadge');
  const roleBadgeIconEl = document.getElementById('roleBadgeIcon');
  const roleBadgeTextEl = document.getElementById('roleBadgeText');

  const scoreRedEl = document.getElementById('scoreRed');
  const scoreBlueEl = document.getElementById('scoreBlue');
  const spectatorCountEl = document.getElementById('spectatorCount');

  const waitingOverlay = document.getElementById('waitingOverlay');
  const countdownOverlay = document.getElementById('countdownOverlay');
  const countdownNumberEl = document.getElementById('countdownNumber');
  const winOverlay = document.getElementById('winOverlay');
  const winMessageEl = document.getElementById('winMessage');
  const winSubMessageEl = document.getElementById('winSubMessage');
  const playAgainBtn = document.getElementById('playAgainBtn');

  // Personalized taunt lines shown to the PLAYER (not spectators) once a
  // round ends — one for whoever just won, one for whoever just lost.
  const WINNER_TAUNT_MESSAGE =
    'දින්නා මචන්.. දින්නා මචන්.. හෙමිහිට ස්පේස් බාර් එක හොඳ තත්වෙන් තියනවද බලපන්..';
  const LOSER_TAUNT_MESSAGE =
    'පරාදයි මචන්.. දන්නැද්ද ඔය පොඩ්ඩ පොඩ්ඩ ඩාම් වෙනවා ඩූම් වෙනවා';

  const pullBtn = document.getElementById('pullBtn');
  const tensionFillEl = document.getElementById('tensionFill');

  // ------------------------------------------------------------------
  // NETWORK STATE
  // ------------------------------------------------------------------
  // IMPORTANT: the socket is intentionally NOT created here. Connecting to
  // the backend is what makes this client eligible to be assigned Red/Blue
  // and is what lets the server's "both players connected" check trigger
  // the 3-2-1 countdown. If we connected immediately on page load, the
  // server could start (or even finish) that countdown while the splash
  // screen is still covering the canvas. Instead, `socket` stays null until
  // `connectToBackend()` is called, which only happens once the splash
  // screen has fully finished (see the "SPLASH SYNCHRONIZATION" section
  // near the bottom of this file).
  let socket = null;

  let myRole = 'spectator'; // 'red' | 'blue' | 'spectator'
  let gameState = 'waiting'; // 'waiting' | 'countdown' | 'playing' | 'finished'
  let serverPosition = 0; // authoritative value from server (-100..100)
  let displayPosition = 0; // client-interpolated value used for drawing
  let winner = null;
  let wins = { red: 0, blue: 0 };
  let pullingFlags = { red: false, blue: false };
  let lastCountdownValue = 3;

  // Local, purely-visual "pulling" pulses (so the player who clicked gets
  // instant feedback even before the server round-trip completes).
  let localPulse = { red: 0, blue: 0 };

  // ------------------------------------------------------------------
  // SOCKET CONNECTION + EVENT HANDLERS
  // ------------------------------------------------------------------
  // Wrapped in a function so it can be deferred until the splash screen
  // signals it is completely done (see bottom of file). Calling this
  // more than once is a no-op guard against double-connecting.
  function connectToBackend() {
    if (socket) return;

    // Explicitly point the Socket.io client at the backend's URL, with
    // reconnection enabled since the frontend and backend now run as
    // independent processes/origins.
    socket = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      connectionStatusEl.classList.add('online');
      connectionStatusEl.classList.remove('offline');
      connectionStatusTextEl.textContent = 'සම්බන්ධ විය ✔ (' + BACKEND_URL + ')';
    });

    socket.on('disconnect', () => {
      connectionStatusEl.classList.remove('online');
      connectionStatusEl.classList.add('offline');
      connectionStatusTextEl.textContent = 'සම්බන්ධතාවය කැඩී ඇත — නැවත සම්බන්ධ වෙමින්...';
      pullBtn.disabled = true;
    });

    socket.on('connect_error', () => {
      connectionStatusEl.classList.remove('online');
      connectionStatusEl.classList.add('offline');
      connectionStatusTextEl.textContent = 'Backend server (' + BACKEND_URL + ') වෙත සම්බන්ධ විය නොහැක';
      pullBtn.disabled = true;
    });

    socket.on('role', (data) => {
      myRole = data.role;
      updateRoleBadge();
      updatePullButtonEnabled();
    });

    socket.on('state', (data) => {
      gameState = data.state;
      serverPosition = data.position;
      winner = data.winner;
      wins = data.wins;
      pullingFlags = data.pulling;

      scoreRedEl.textContent = wins.red;
      scoreBlueEl.textContent = wins.blue;
      spectatorCountEl.textContent = data.spectatorCount;

      updateOverlays(data);
      updatePullButtonEnabled();

      if (data.state === 'countdown' && data.countdownValue !== lastCountdownValue) {
        lastCountdownValue = data.countdownValue;
        countdownNumberEl.textContent = data.countdownValue > 0 ? data.countdownValue : 'ආරම්භය!';
        playCountdownBeep(data.countdownValue > 0);
      }

      if (data.state === 'finished' && winner) {
        winMessageEl.textContent =
          winner === 'red'
            ? '🔴 රතු කණ්ඩායම ජයග්‍රහණය කළා!'
            : '🔵 නිල් කණ්ඩායම ජයග්‍රහණය කළා!';

        // Personalized taunt: only shown to the two actual players, based on
        // whether THEY personally won or lost this round. Spectators get no
        // taunt line, since neither message applies to them.
        winSubMessageEl.classList.remove('taunt-win', 'taunt-lose');
        if (myRole === winner) {
          winSubMessageEl.textContent = WINNER_TAUNT_MESSAGE;
          winSubMessageEl.classList.add('taunt-win');
        } else if (myRole === 'red' || myRole === 'blue') {
          winSubMessageEl.textContent = LOSER_TAUNT_MESSAGE;
          winSubMessageEl.classList.add('taunt-lose');
        } else {
          winSubMessageEl.textContent = '';
        }

        playCheerSound();
      } else if (data.state !== 'finished') {
        // Clear the taunt as soon as we leave the "finished" state so it
        // doesn't flash stale text before the next win overlay appears.
        winSubMessageEl.textContent = '';
        winSubMessageEl.classList.remove('taunt-win', 'taunt-lose');
      }
    });
  }

  function updateRoleBadge() {
    roleBadgeEl.classList.remove('role-red', 'role-blue', 'role-spectator');
    if (myRole === 'red') {
      roleBadgeEl.classList.add('role-red');
      roleBadgeIconEl.textContent = '🔴';
      roleBadgeTextEl.textContent = 'ඔබ: රතු කණ්ඩායම (වම් පැත්ත)';
    } else if (myRole === 'blue') {
      roleBadgeEl.classList.add('role-blue');
      roleBadgeIconEl.textContent = '🔵';
      roleBadgeTextEl.textContent = 'ඔබ: නිල් කණ්ඩායම (දකුණු පැත්ත)';
    } else {
      roleBadgeEl.classList.add('role-spectator');
      roleBadgeIconEl.textContent = '👀';
      roleBadgeTextEl.textContent = 'නැරඹුම්කරුවෙකි (තරගය පිරී ඇත)';
    }
  }

  function updateOverlays(data) {
    waitingOverlay.classList.toggle('hidden', data.state !== 'waiting');
    countdownOverlay.classList.toggle('hidden', data.state !== 'countdown');
    winOverlay.classList.toggle('hidden', data.state !== 'finished');
  }

  function updatePullButtonEnabled() {
    const isActivePlayer = myRole === 'red' || myRole === 'blue';
    pullBtn.disabled = !(isActivePlayer && gameState === 'playing');
  }

  // ------------------------------------------------------------------
  // PULL INPUT (button + spacebar) with local instant feedback
  // ------------------------------------------------------------------
  function attemptPull() {
    if (pullBtn.disabled || !socket) return;
    ensureAudioContext();
    socket.emit('pull', { role: myRole });
    localPulse[myRole] = 1;
    playPullSound();
  }

  pullBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    attemptPull();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      attemptPull();
    }
  });

  playAgainBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!socket) return;
    ensureAudioContext();
    socket.emit('restart');
  });

  // ==================================================================
  //  CANVAS RENDERING
  // ==================================================================
  let cw = 0;
  let ch = 0;
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  function resizeCanvas() {
    const rect = canvasWrapper.getBoundingClientRect();
    dpr = Math.max(1, window.devicePixelRatio || 1);
    cw = rect.width;
    ch = rect.height;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Cloud objects for gentle parallax drift
  const clouds = [
    { x: 0.1, y: 0.12, scale: 1.0, speed: 0.008 },
    { x: 0.45, y: 0.08, scale: 0.7, speed: 0.005 },
    { x: 0.75, y: 0.18, scale: 1.3, speed: 0.011 },
    { x: 0.25, y: 0.22, scale: 0.55, speed: 0.006 },
  ];

  function drawCloud(x, y, scale) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 32, 18, 0, 0, Math.PI * 2);
    ctx.ellipse(28, -8, 24, 16, 0, 0, Math.PI * 2);
    ctx.ellipse(-26, -6, 22, 15, 0, 0, Math.PI * 2);
    ctx.ellipse(8, -16, 20, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBackground(time) {
    // Sky gradient
    const skyGrad = ctx.createLinearGradient(0, 0, 0, ch);
    skyGrad.addColorStop(0, '#4facfe');
    skyGrad.addColorStop(0.55, '#a0d8ff');
    skyGrad.addColorStop(1, '#dff3ff');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, cw, ch);

    // Sun glow
    ctx.save();
    const sunX = cw * 0.87;
    const sunY = ch * 0.16;
    const glow = ctx.createRadialGradient(sunX, sunY, 4, sunX, sunY, 70);
    glow.addColorStop(0, 'rgba(255,247,200,0.95)');
    glow.addColorStop(1, 'rgba(255,247,200,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Clouds drift slowly & wrap around
    clouds.forEach((c) => {
      c.x += c.speed * 0.016;
      if (c.x > 1.25) c.x = -0.25;
      drawCloud(c.x * cw, c.y * ch, c.scale * (cw / 700));
    });

    // Ground
    const groundY = ch * 0.68;
    const groundGrad = ctx.createLinearGradient(0, groundY, 0, ch);
    groundGrad.addColorStop(0, '#7bc96f');
    groundGrad.addColorStop(1, '#4f9c47');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, groundY, cw, ch - groundY);

    // Ground texture stripes
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    for (let i = -1; i < 10; i++) {
      ctx.beginPath();
      ctx.moveTo(i * (cw / 8) + ((time * 0.01) % (cw / 8)), groundY);
      ctx.lineTo(i * (cw / 8) - 40 + ((time * 0.01) % (cw / 8)), ch);
      ctx.stroke();
    }

    // Dashed center boundary line
    ctx.save();
    ctx.setLineDash([10, 10]);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cw / 2, groundY);
    ctx.lineTo(cw / 2, ch);
    ctx.stroke();
    ctx.restore();

    return groundY;
  }

  // -------------------- Stick-figure character --------------------
  /**
   * Draws one animated cartoon/stick-figure team member.
   * @param {number} x - anchor x on canvas (feet position)
   * @param {number} y - anchor y on canvas (ground line)
   * @param {string} color - '#ff4d5e' or '#3fa9ff'
   * @param {number} leanDir - -1 (lean left) or +1 (lean right)
   * @param {number} pullPhase - 0..1 animation phase (arm pull cycle)
   * @param {string} mood - 'winning' | 'losing' | 'even'
   * @param {number} scale - size multiplier
   */
  function drawPlayer(x, y, color, leanDir, pullPhase, mood, scale) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    // Body lean angle: base lean away from center (bracing), extra lean
    // pulses with the pull animation
    const baseLean = leanDir * 0.18;
    const pulseLean = leanDir * 0.12 * Math.sin(pullPhase * Math.PI);
    const angle = baseLean + pulseLean;
    ctx.rotate(angle);

    const headR = 11;
    const bodyLen = 34;
    const hipY = -bodyLen;
    const headY = hipY - headR - 2;

    // ---- Legs (braced, wide stance) ----
    ctx.strokeStyle = '#2b2b2b';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(-14 * -leanDir * 0.6 - 6, 0);
    ctx.moveTo(0, hipY);
    ctx.lineTo(14 * -leanDir * 0.6 + 6, 0);
    ctx.stroke();

    // ---- Body (torso) ----
    ctx.strokeStyle = color;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, hipY);
    ctx.stroke();

    // ---- Arms reaching forward to grip the rope ----
    const armReach = 22;
    const armY = hipY + 10;
    const gripSwing = 4 * Math.sin(pullPhase * Math.PI * 2);
    ctx.strokeStyle = '#f2c29a';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, armY);
    ctx.lineTo(leanDir * armReach, armY - 6 + gripSwing);
    ctx.moveTo(0, armY + 6);
    ctx.lineTo(leanDir * armReach, armY - gripSwing);
    ctx.stroke();

    // ---- Head ----
    ctx.beginPath();
    ctx.fillStyle = '#f2c29a';
    ctx.arc(0, headY, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Hair
    ctx.fillStyle = '#3a2a1a';
    ctx.beginPath();
    ctx.arc(0, headY - 3, headR, Math.PI, Math.PI * 2);
    ctx.fill();

    // ---- Face (expression depends on mood) ----
    ctx.fillStyle = '#20140a';
    const eyeOffsetX = leanDir * 3;
    if (mood === 'losing') {
      // Struggling: angled eyebrows + tight grimace + sweat drop
      ctx.strokeStyle = '#20140a';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(eyeOffsetX - 5, headY - 5);
      ctx.lineTo(eyeOffsetX - 1, headY - 3);
      ctx.moveTo(eyeOffsetX + 5, headY - 5);
      ctx.lineTo(eyeOffsetX + 1, headY - 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(eyeOffsetX - 3, headY, 1.3, 0, Math.PI * 2);
      ctx.arc(eyeOffsetX + 3, headY, 1.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(eyeOffsetX - 4, headY + 6);
      ctx.lineTo(eyeOffsetX + 4, headY + 6);
      ctx.stroke();
      // sweat drop
      ctx.fillStyle = '#8fd3ff';
      ctx.beginPath();
      ctx.arc(headR - 2, headY - 2, 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (mood === 'winning') {
      // Confident smile
      ctx.beginPath();
      ctx.arc(eyeOffsetX - 3, headY, 1.4, 0, Math.PI * 2);
      ctx.arc(eyeOffsetX + 3, headY, 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(eyeOffsetX, headY + 4, 4, 0, Math.PI, false);
      ctx.strokeStyle = '#20140a';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    } else {
      // Neutral / focused
      ctx.beginPath();
      ctx.arc(eyeOffsetX - 3, headY, 1.4, 0, Math.PI * 2);
      ctx.arc(eyeOffsetX + 3, headY, 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(eyeOffsetX - 3, headY + 5);
      ctx.lineTo(eyeOffsetX + 3, headY + 5);
      ctx.strokeStyle = '#20140a';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    ctx.restore();
  }

  // -------------------- Rope + flag --------------------
  function drawRope(centerX, ropeY, offsetPx, tensionFactor) {
    const ropeHalfLen = cw * 0.62;
    const x1 = centerX - ropeHalfLen;
    const x2 = centerX + ropeHalfLen;

    // Slight sag animation for a "living" rope feel
    const sag = 4 + Math.sin(Date.now() * 0.004) * 1.5;

    ctx.save();
    ctx.translate(offsetPx, 0);

    // Rope shadow
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 15;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, ropeY + 4);
    ctx.quadraticCurveTo(centerX, ropeY + sag + 4, x2, ropeY + 4);
    ctx.stroke();

    // Rope body
    const ropeGrad = ctx.createLinearGradient(x1, 0, x2, 0);
    ropeGrad.addColorStop(0, '#c8955a');
    ropeGrad.addColorStop(0.5, '#e6b878');
    ropeGrad.addColorStop(1, '#c8955a');
    ctx.strokeStyle = ropeGrad;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(x1, ropeY);
    ctx.quadraticCurveTo(centerX, ropeY + sag, x2, ropeY);
    ctx.stroke();

    // Twisted-rope texture (diagonal hatch marks along the curve)
    ctx.strokeStyle = 'rgba(90,55,20,0.55)';
    ctx.lineWidth = 2;
    const segments = 46;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = x1 + (x2 - x1) * t;
      const y = ropeY + sag * 4 * t * (1 - t);
      const twist = ((i + Math.floor(Date.now() / 90)) % 2 === 0) ? 5 : -5;
      ctx.beginPath();
      ctx.moveTo(x - 5, y - twist);
      ctx.lineTo(x + 5, y + twist);
      ctx.stroke();
    }

    // Center ribbon / flag marker
    const flagY = ropeY + sag; // rope sags most at the very center
    ctx.save();
    ctx.translate(centerX, flagY);

    // Pole
    ctx.strokeStyle = '#4b3216';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -34);
    ctx.lineTo(0, 6);
    ctx.stroke();

    // Waving red ribbon/flag
    const wave = Math.sin(Date.now() * 0.006) * 4;
    ctx.fillStyle = '#ff2d4d';
    ctx.beginPath();
    ctx.moveTo(0, -34);
    ctx.lineTo(26, -30 + wave);
    ctx.lineTo(0, -18);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Ribbon knot / center marker ball — glows more with tension
    ctx.beginPath();
    ctx.fillStyle = '#ffd166';
    ctx.shadowColor = 'rgba(255,209,102,0.9)';
    ctx.shadowBlur = 6 + tensionFactor * 14;
    ctx.arc(0, 6, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    ctx.restore();
  }

  // -------------------- Goal lines --------------------
  function drawGoalLines(groundY) {
    const margin = cw * 0.06;
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 4;

    ctx.strokeStyle = 'rgba(255,77,94,0.85)';
    ctx.beginPath();
    ctx.moveTo(margin, groundY - 10);
    ctx.lineTo(margin, ch);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(63,169,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(cw - margin, groundY - 10);
    ctx.lineTo(cw - margin, ch);
    ctx.stroke();
    ctx.restore();
  }

  // ==================================================================
  //  MAIN ANIMATION LOOP
  // ==================================================================
  let animPhaseRed = 0;
  let animPhaseBlue = 0;

  function frame(time) {
    // Client-side interpolation ("lerp") toward the latest authoritative
    // server position — smooths out network jitter / lag.
    displayPosition += (serverPosition - displayPosition) * 0.14;

    // Decay local instant-feedback pulses
    localPulse.red = Math.max(0, localPulse.red - 0.06);
    localPulse.blue = Math.max(0, localPulse.blue - 0.06);

    // Advance pull-animation phase while the flag (server or local) is active
    const redActive = pullingFlags.red || localPulse.red > 0;
    const blueActive = pullingFlags.blue || localPulse.blue > 0;
    animPhaseRed = redActive ? (animPhaseRed + 0.14) % 1 : 0;
    animPhaseBlue = blueActive ? (animPhaseBlue + 0.14) % 1 : 0;

    const groundY = drawBackground(time);
    drawGoalLines(groundY);

    const centerX = cw / 2;
    const ropeY = groundY - ch * 0.14;
    const maxShift = cw * 0.30;
    const offsetPx = (displayPosition / 100) * maxShift;

    const tensionFactor = Math.min(1, Math.abs(displayPosition) / 100);

    // Determine moods
    let redMood = 'even';
    let blueMood = 'even';
    if (displayPosition < -6) {
      redMood = 'winning';
      blueMood = 'losing';
    } else if (displayPosition > 6) {
      redMood = 'losing';
      blueMood = 'winning';
    }

    drawRope(centerX, ropeY, offsetPx, tensionFactor);

    // ---- Red team (left side, 3 players) ----
    const redBaseX = centerX + offsetPx - cw * 0.18;
    const redSpacing = cw * 0.075;
    for (let i = 0; i < 3; i++) {
      const px = redBaseX - i * redSpacing;
      const scale = 1 - i * 0.08;
      drawPlayer(px, ropeY + 26, '#ff4d5e', 1, redActive ? animPhaseRed : 0, redMood, scale);
    }

    // ---- Blue team (right side, 3 players) ----
    const blueBaseX = centerX + offsetPx + cw * 0.18;
    const blueSpacing = cw * 0.075;
    for (let i = 0; i < 3; i++) {
      const px = blueBaseX + i * blueSpacing;
      const scale = 1 - i * 0.08;
      drawPlayer(px, ropeY + 26, '#3fa9ff', -1, blueActive ? animPhaseBlue : 0, blueMood, scale);
    }

    // Tension meter UI (below canvas)
    const pct = 50 + (displayPosition / 100) * 50;
    tensionFillEl.style.left = `${pct}%`;

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // ==================================================================
  //  WEB AUDIO API — SYNTHESIZED RETRO SFX (no external audio files)
  // ==================================================================
  let audioCtx = null;

  function ensureAudioContext() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  // Short filtered noise burst + pitch-dropping oscillator => "whoosh/tug"
  function playPullSound() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;

    // Noise burst
    const bufferSize = audioCtx.sampleRate * 0.12;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;

    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(500, now);
    noiseFilter.frequency.exponentialRampToValueAtTime(140, now + 0.12);
    noiseFilter.Q.value = 0.9;

    const noiseGain = audioCtx.createGain();
    noiseGain.gain.setValueAtTime(0.35, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

    noise.connect(noiseFilter).connect(noiseGain).connect(audioCtx.destination);
    noise.start(now);
    noise.stop(now + 0.14);

    // Pitch-drop "tug" tone
    const osc = audioCtx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.15);

    const oscGain = audioCtx.createGain();
    oscGain.gain.setValueAtTime(0.18, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc.connect(oscGain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  // Countdown beep: lower tone for 3-2-1, higher triumphant tone for GO
  function playCountdownBeep(isTickingDown) {
    ensureAudioContext();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;

    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = isTickingDown ? 440 : 880;

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (isTickingDown ? 0.16 : 0.32));

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + (isTickingDown ? 0.18 : 0.34));
  }

  // Victory cheer: quick ascending major arpeggio
  function playCheerSound() {
    ensureAudioContext();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6

    notes.forEach((freq, i) => {
      const startTime = now + i * 0.09;
      const osc = audioCtx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;

      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.25, startTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.4);

      osc.connect(gain).connect(audioCtx.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.42);
    });

    // Sprinkle of "sparkle" noise on top for a crowd-cheer texture
    const bufferSize = audioCtx.sampleRate * 0.6;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.15 * (1 - i / bufferSize);
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 2000;
    noise.connect(filter).connect(audioCtx.destination);
    noise.start(now);
  }

  // Unlock audio context on first user interaction anywhere on the page
  ['pointerdown', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, ensureAudioContext, { once: true });
  });

  // ==================================================================
  //  SPLASH SYNCHRONIZATION
  // ==================================================================
  // `splash.js` runs before this script and owns the splash screen's
  // timing. When it finishes (loading bar reaches 100% AND the fade-out
  // transition has completed, i.e. the splash element is fully gone), it:
  //   1. sets `window.__splashComplete = true`, and
  //   2. dispatches a `splash:complete` CustomEvent on `window`.
  //
  // We only call `connectToBackend()` once that has happened, so the
  // socket connection — and therefore the server's "both players
  // connected -> start 3-2-1 countdown" logic — cannot begin while the
  // splash screen is still visible or mid-transition.
  function beginGameSession() {
    connectToBackend();
  }

  if (window.__splashComplete) {
    // Edge case: splash.js already finished (e.g. no #splashScreen element
    // was found, so it completed synchronously) before this script ran.
    beginGameSession();
  } else {
    window.addEventListener('splash:complete', beginGameSession, { once: true });
  }

  // Safety net: if splash.js fails to load or throws before it can ever
  // dispatch 'splash:complete' (e.g. blocked script, typo'd <script> tag),
  // don't strand the player on a game that can never connect. This timeout
  // is well beyond the normal ~3.1s splash lifetime, so it never fires in
  // the normal flow.
  setTimeout(() => {
    if (!socket) {
      console.warn(
        '[game.js] "splash:complete" was not received in time — starting the backend connection anyway.'
      );
      beginGameSession();
    }
  }, 8000);
})();
