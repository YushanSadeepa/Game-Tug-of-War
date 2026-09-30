/**
 * ==========================================================================
 *  Splash / Loading Screen Controller
 * ==========================================================================
 *  Shows the logo.png with an entrance animation (handled purely in CSS)
 *  plus a JS-driven loading bar that fills smoothly over exactly 2.5s, then
 *  cross-fades the splash out while the main game (already rendering
 *  underneath) fades/scales into view — a seamless handoff rather than a
 *  jarring switch.
 *
 *  Loaded before game.js so it can start animating the instant the DOM is
 *  parsed, independently of Socket.io connection timing.
 *
 *  SPLASH <-> GAME SYNCHRONIZATION
 *  --------------------------------
 *  game.js deliberately does NOT open its Socket.io connection to the
 *  backend on page load. Connecting is what makes the server aware of this
 *  client and is what allows the server's "both players connected" check to
 *  fire the 3-2-1 countdown — so if that happened immediately, the
 *  countdown could run (or finish) while the splash screen still covers the
 *  canvas. To prevent that, this script signals game.js the moment the
 *  splash screen has ENTIRELY finished (loading bar at 100% AND the
 *  fade-out transition complete, element removed from the DOM), via:
 *
 *    1. `window.__splashComplete = true`   (a flag, in case game.js checks
 *                                            it after we've already fired)
 *    2. `window.dispatchEvent(new CustomEvent('splash:complete'))`
 *
 *  game.js listens for this and only calls its `connectToBackend()` once
 *  it has fired.
 * ==========================================================================
 */

(() => {
  'use strict';

  const SPLASH_DURATION_MS = 2500;
  const FADE_OUT_MS = 600; // must match the CSS .splash-screen transition time

  // Default to "not complete" immediately so game.js can safely read this
  // flag at any point, even before the rest of this script runs.
  window.__splashComplete = false;

  // Fires the synchronization signal exactly once. Safe to call multiple
  // times — subsequent calls are no-ops.
  function signalSplashComplete() {
    if (window.__splashComplete) return;
    window.__splashComplete = true;
    window.dispatchEvent(new CustomEvent('splash:complete'));
  }

  const splashScreen = document.getElementById('splashScreen');
  const loadingFill = document.getElementById('splashLoadingFill');
  const percentLabel = document.getElementById('splashPercent');
  const splashLogo = document.getElementById('splashLogo');

  // No splash element on the page at all (e.g. this HTML was stripped down)
  // — there is nothing to wait for, so signal completion immediately rather
  // than leaving game.js waiting forever for an event that will never come.
  if (!splashScreen) {
    signalSplashComplete();
    return;
  }

  // If the logo image fails to load (e.g. logo.png missing), don't let the
  // splash screen break — fall back gracefully and still show the game.
  if (splashLogo) {
    splashLogo.addEventListener('error', () => {
      splashLogo.style.display = 'none';
    });
  }

  let startTime = null;

  function tick(now) {
    if (startTime === null) startTime = now;
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / SPLASH_DURATION_MS);
    const pct = Math.round(progress * 100);

    if (loadingFill) loadingFill.style.width = `${pct}%`;
    if (percentLabel) percentLabel.textContent = `${pct}%`;

    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      finishSplash();
    }
  }

  function finishSplash() {
    splashScreen.classList.add('splash-hide');
    // Fully remove the splash from the DOM — and only THEN tell game.js it
    // may connect — once the fade-out transition completes, so it stops
    // intercepting clicks/taps on mobile and the handoff is truly seamless.
    setTimeout(() => {
      if (splashScreen.parentNode) {
        splashScreen.parentNode.removeChild(splashScreen);
      }
      signalSplashComplete();
    }, FADE_OUT_MS + 50);
  }

  requestAnimationFrame(tick);
})();
