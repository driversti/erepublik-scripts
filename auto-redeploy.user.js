// ==UserScript==
// @name         Auto Redeploy
// @namespace    erepublik-auto-redeploy
// @version      1.0.0
// @description  Automatically redeploys after each deployment finishes until PP expires or round ends
// @author       driver sti
// @match        https://www.erepublik.com/*/military/battlefield/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  // 1. CONSTANTS & CONFIG
  // ═══════════════════════════════════════════════════════════════════

  const PREFIX = 'ard';
  const LOG_PREFIX = '[AutoRedeploy]';
  const RETRY_DELAY_MS = 2000;
  const ALREADY_DEPLOYING_DELAY_MS = 5000;
  const STORAGE_KEY_POSITION = 'ard-panel-position';
  const WS_FALLBACK_POLL_MS = 2000;
  const ROUND_CHECK_INTERVAL_MS = 10000;

  const State = Object.freeze({
    IDLE: 'IDLE',
    ACTIVATING_BOOSTERS: 'ACTIVATING_BOOSTERS',
    FETCHING_INVENTORY: 'FETCHING_INVENTORY',
    DEPLOYING: 'DEPLOYING',
    WAITING_FOR_COMPLETION: 'WAITING_FOR_COMPLETION',
    CHECK_BOOSTERS: 'CHECK_BOOSTERS',
    RETRYING: 'RETRYING',
    STOPPED: 'STOPPED',
  });

  const SKIN_MAP = { 1: 14, 2: 15, 3: 16, 4: 17, 11: 18 };

  // ═══════════════════════════════════════════════════════════════════
  // 2. LOGGER
  // ═══════════════════════════════════════════════════════════════════

  const logLines = [];
  let logElement = null;

  function log(msg, level = 'info') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = `[${time}] ${msg}`;
    logLines.push(entry);
    if (logLines.length > 200) logLines.shift();

    if (logElement) {
      logElement.textContent = logLines.join('\n');
      logElement.scrollTop = logElement.scrollHeight;
    }

    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`${LOG_PREFIX} ${msg}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. PAGE CONTEXT READER
  // ═══════════════════════════════════════════════════════════════════

  function getToken() {
    if (typeof csrfToken !== 'undefined' && csrfToken) return csrfToken;
    const sd = getServerData();
    return sd?.csrfToken || null;
  }

  function getServerData() {
    return typeof SERVER_DATA !== 'undefined' ? SERVER_DATA : null;
  }

  function getPageContext() {
    const sd = getServerData();
    if (!sd) return null;
    return {
      battleId: sd.battleId,
      battleZoneId: sd.battleZoneId,
      mySideCountryId: sd.mySideCountryId,
      currentDivision: sd.currentDivision || sd.division,
      health: sd.health,
      deployment: sd.deployment,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4. API CLIENT
  // ═══════════════════════════════════════════════════════════════════

  async function postRequest(url, data) {
    const token = getToken();
    const body = new URLSearchParams();
    if (token) body.append('_token', token);
    for (const [key, value] of Object.entries(data)) {
      body.append(key, String(value));
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
      credentials: 'include',
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function getJSON(url) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function waitForCondition(fn, timeoutMs = 10000, pollMs = 200, abortFn) {
    return new Promise(resolve => {
      if (fn()) { resolve(true); return; }
      if (abortFn && abortFn()) { resolve(false); return; }
      const check = () => {
        if (fn()) { clearInterval(interval); clearTimeout(timeout); resolve(true); }
        else if (abortFn && abortFn()) { clearInterval(interval); clearTimeout(timeout); resolve(false); }
      };
      const interval = setInterval(check, pollMs);
      const timeout = setTimeout(() => {
        clearInterval(interval); resolve(false);
      }, timeoutMs);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5. NOTIFICATION MANAGER
  // ═══════════════════════════════════════════════════════════════════

  function requestNotificationPermission() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function notify(title, body) {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(title, { body, icon: '//www.erepublik.net/favicon.ico' });
      } catch (_) { /* ignore */ }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6. POMELO EVENT BRIDGE
  // ═══════════════════════════════════════════════════════════════════

  let pomeloConnected = false;
  let pomeloListeners = [];

  function setupPomeloListeners() {
    const pomelo = window.pomelo;
    if (!pomelo || typeof pomelo.on !== 'function') {
      log('⚡ Pomelo object not available — using HTTP polling');
      return false;
    }

    const onFinished = (data) => {
      log(`⚡ Deploy finished via WS (dmg: ${data.damage}, kills: ${data.kills}, energy: ${data.energySpent})`);
      window.dispatchEvent(new CustomEvent('ard:deployFinished', { detail: data }));
    };

    const onProgress = (data) => {
      if (data.progress === 0) log('⚡ Deployment started (WS)');
      // progress: 100 fires after onDeployFinished, so we ignore it
    };

    const onDisconnect = () => {
      log('⚡ Pomelo disconnected', 'warn');
      pomeloConnected = false;
      updateWsIndicator('disconnected');
      window.dispatchEvent(new CustomEvent('ard:wsDisconnected'));
    };

    pomelo.on('onDeployFinished', onFinished);
    pomelo.on('onDeployProgress', onProgress);
    pomelo.on('disconnect', onDisconnect);
    pomelo.on('heartbeat timeout', onDisconnect);

    pomeloListeners = [
      ['onDeployFinished', onFinished],
      ['onDeployProgress', onProgress],
      ['disconnect', onDisconnect],
      ['heartbeat timeout', onDisconnect],
    ];

    pomeloConnected = true;
    log('⚡ Pomelo event bridge connected');
    return true;
  }

  function teardownPomeloListeners() {
    const pomelo = window.pomelo;
    if (!pomelo) return;
    for (const [event, fn] of pomeloListeners) {
      pomelo.removeListener(event, fn);
    }
    pomeloListeners = [];
    pomeloConnected = false;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 7. COMPLETION DETECTOR (WS primary + HTTP fallback)
  // ═══════════════════════════════════════════════════════════════════

  let roundCheckIntervalId = null;
  let httpPollIntervalId = null;
  let wsDisconnectHandler = null;

  function startCompletionDetector(battleId, battleZoneId) {
    stopCompletionDetector();

    if (pomeloConnected) {
      // WS primary: pomelo events handle deploy completion instantly
      log('Monitoring via Pomelo (instant WS detection)');
      updateWsIndicator('connected');

      // Slow HTTP poll for round-end only (no WS event for this yet)
      roundCheckIntervalId = setInterval(async () => {
        try {
          const campaigns = await getJSON(
            'https://www.erepublik.com/en/military/campaignsJson/list'
          );
          const battle = campaigns.battles?.[String(battleId)];
          if (!battle) {
            window.dispatchEvent(new CustomEvent('ard:roundChanged'));
            return;
          }
          const div = Object.values(battle.div).find(d => d.id === battleZoneId);
          if (div && div.division_end) {
            window.dispatchEvent(new CustomEvent('ard:roundChanged'));
          }
        } catch (e) {
          log(`Round check error: ${e.message}`, 'warn');
        }
      }, ROUND_CHECK_INTERVAL_MS);

      // If WS disconnects mid-deploy, switch to HTTP fallback
      wsDisconnectHandler = () => {
        log('WS disconnected — switching to HTTP polling fallback');
        clearInterval(roundCheckIntervalId);
        roundCheckIntervalId = null;
        startHttpFallbackPoll(battleId, battleZoneId);
      };
      window.addEventListener('ard:wsDisconnected', wsDisconnectHandler, { once: true });

    } else {
      // No pomelo: full HTTP fallback
      startHttpFallbackPoll(battleId, battleZoneId);
    }
  }

  function startHttpFallbackPoll(battleId, battleZoneId) {
    log('Polling for deploy completion (HTTP fallback)...');
    updateWsIndicator('fallback');
    let eventFired = false;

    httpPollIntervalId = setInterval(async () => {
      if (eventFired) return;
      try {
        const citizenData = await getJSON(
          'https://www.erepublik.com/en/military/campaignsJson/citizen'
        );

        // deployment is non-null when still active
        if (citizenData.deployment !== null && citizenData.deployment !== undefined) return;

        log('Deploy finished (HTTP poll)');
        eventFired = true;
        stopCompletionDetector();

        // Check if the round ended
        try {
          const campaigns = await getJSON(
            'https://www.erepublik.com/en/military/campaignsJson/list'
          );
          const battle = campaigns.battles?.[String(battleId)];

          if (!battle) {
            window.dispatchEvent(new CustomEvent('ard:roundChanged'));
            return;
          }

          const div = Object.values(battle.div).find(d => d.id === battleZoneId);
          if (div && div.division_end) {
            window.dispatchEvent(new CustomEvent('ard:roundChanged'));
            return;
          }
        } catch (e) {
          log(`Campaign check error: ${e.message}`, 'warn');
        }

        window.dispatchEvent(new CustomEvent('ard:deployFinished'));
      } catch (err) {
        log(`Poll error: ${err.message}`, 'warn');
      }
    }, WS_FALLBACK_POLL_MS);
  }

  function stopCompletionDetector() {
    if (roundCheckIntervalId) {
      clearInterval(roundCheckIntervalId);
      roundCheckIntervalId = null;
    }
    if (httpPollIntervalId) {
      clearInterval(httpPollIntervalId);
      httpPollIntervalId = null;
    }
    if (wsDisconnectHandler) {
      window.removeEventListener('ard:wsDisconnected', wsDisconnectHandler);
      wsDisconnectHandler = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 8. BOOSTER MANAGER
  // ═══════════════════════════════════════════════════════════════════

  function getAvailableBoosters() {
    const sd = getServerData();
    if (!sd?.boosters?.inactive) return [];

    const boosters = [];
    const inactive = sd.boosters.inactive;

    for (const category of Object.keys(inactive)) {
      const items = inactive[category];
      // Handle both array and object-of-items
      const list = Array.isArray(items) ? items : Object.values(items);
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        if (item.amount > 0) {
          boosters.push({
            id: item.id,
            name: item.name || category,
            type: item.type || category,
            amount: item.amount,
            duration: item.duration || item.activationData?.params?.duration || 0,
            quality: item.quality,
            icon: item.icon,
            params: item.activationData?.params || { type: category, quality: item.quality, duration: item.duration },
            canActivate: !!item.canActivateBooster,
          });
        }
      }
    }

    return boosters;
  }

  async function activateBooster(booster, ctx) {
    const params = {
      type: booster.params.type,
      quality: booster.params.quality,
      duration: booster.params.duration,
      battleId: ctx.battleId,
      battleZoneId: ctx.battleZoneId,
      sideId: ctx.mySideCountryId,
    };

    log(`Activating: ${booster.name}`);
    const result = await postRequest(
      'https://www.erepublik.com/en/military/fight-activateBooster',
      params
    );

    // Note: API returns "succes" (typo) on success
    if (result.status === 'succes' || result.status === 'success') {
      log(`Booster activated: ${booster.name}`);
      return true;
    }

    log(`Booster failed: ${result.message || JSON.stringify(result)}`, 'warn');
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 9. DEPLOY CACHE
  // ═══════════════════════════════════════════════════════════════════

  const deployCache = {
    weapons: [],
    vehicles: [],
    maxEnergy: 0,
    selectedWeaponQuality: -1,
    selectedSkinId: null,
    inventoryLoaded: false,
  };

  async function fetchInventory(ctx) {
    log('Fetching inventory...');
    const result = await postRequest(
      'https://www.erepublik.com/en/military/fightDeploy-getInventory',
      {
        battleId: ctx.battleId,
        battleZoneId: ctx.battleZoneId,
        sideCountryId: ctx.mySideCountryId,
      }
    );

    deployCache.weapons = result.weapons || [];
    deployCache.vehicles = result.vehicles || [];
    deployCache.maxEnergy = result.maxEnergy || 0;

    // Default to active vehicle
    const activeVehicle = deployCache.vehicles.find(v => v.isActive);
    if (activeVehicle && deployCache.selectedSkinId === null) {
      deployCache.selectedSkinId = activeVehicle.id;
    }

    // Default to best weapon
    const bestWeapon = deployCache.weapons.find(w => w.isBest);
    if (bestWeapon && deployCache.selectedWeaponQuality === -1) {
      deployCache.selectedWeaponQuality = bestWeapon.quality;
    }

    deployCache.inventoryLoaded = true;
    log(`Inventory: ${deployCache.weapons.length} weapons, ${deployCache.vehicles.length} vehicles, ${deployCache.maxEnergy.toLocaleString()} max energy`);
    return deployCache;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 9a. DEPLOY VIA GAME UI (Angular scope)
  // ═══════════════════════════════════════════════════════════════════

  function getDeployScope() {
    const el = document.getElementById('battleFooterDeploy');
    if (!el || typeof angular === 'undefined') return null;
    return angular.element(el).scope();
  }

  async function deployViaGameUI() {
    const abort = () => stopRequested;

    const scope = getDeployScope();
    if (!scope) throw new Error('Cannot access Angular deploy scope');

    // 1. Open popup — triggers getInventory() internally
    log('Opening game deploy popup...');
    scope.openPopup();
    scope.$apply();

    // 2. Wait for inventory to load
    const loaded = await waitForCondition(() => !scope.settings.loading, 15000, 200, abort);
    if (stopRequested) throw new Error('Stopped by user');
    if (!loaded) throw new Error('Game inventory loading timed out');

    const maxEnergy = scope.data.inventory.maxEnergy;
    log(`Game inventory loaded, maxEnergy: ${maxEnergy}`);
    if (maxEnergy <= 0) throw new Error('No energy available (game reports 0)');

    // 3. Set energy to max and recalculate allocation
    scope.deployConfig.energyUsed = maxEnergy;
    scope.sliderChange(true);

    // 4. Set weapon quality from our dropdown
    readDropdownSelections();
    scope.deployConfig.weaponQuality = deployCache.selectedWeaponQuality;

    // 5. Set vehicle from our dropdown
    const skinId = deployCache.selectedSkinId;
    if (skinId) {
      const vehicle = (scope.data.inventory.vehicles || []).find(v => v.id === skinId);
      if (vehicle) {
        scope.settings.activeVehicle = vehicle;
      }
    }

    if (stopRequested) throw new Error('Stopped by user');

    // 6. Trigger the deploy
    log('Triggering game startDeploy...');
    scope.$apply();
    scope.startDeploy();
    scope.$apply();

    // 7. Wait for the API call to complete
    const finished = await waitForCondition(() => !scope.settings.deployStarted, 30000, 300, abort);
    if (stopRequested) throw new Error('Stopped by user');
    if (!finished) throw new Error('Deploy API call timed out (deployStarted stuck)');

    // 8. Check result
    if (!scope.settings.activeState) {
      throw new Error('Deploy failed (game returned error)');
    }

    return {
      deploymentId: scope.data?.deployment?.id || 'unknown',
      energy: maxEnergy,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 10. STATE MACHINE
  // ═══════════════════════════════════════════════════════════════════

  let currentState = State.IDLE;
  let ppBoosterTracker = null; // { activatedAt: number, durationMs: number }
  let ppTimerIntervalId = null;
  let deployCount = 0;
  let selectedBoosterIds = new Set();
  let retryCount = 0;
  let stopRequested = false;

  function setState(newState) {
    currentState = newState;
    updateStatusDisplay();
    updateStartStopButtons();
  }

  function updateStatusDisplay() {
    const el = document.getElementById(`${PREFIX}-status`);
    if (!el) return;
    el.textContent = `Status: ${currentState}`;
    el.classList.remove(`${PREFIX}-status-stopping`);
  }

  function updateStatsDisplay() {
    const el = document.getElementById(`${PREFIX}-stats`);
    if (el) el.textContent = `Deploys: ${deployCount}`;
  }

  function updateWsIndicator(state) {
    const el = document.getElementById(`${PREFIX}-ws-status`);
    if (!el) return;
    const config = {
      connected:    { text: 'WS: ON',   cls: `${PREFIX}-ws-on` },
      disconnected: { text: 'WS: OFF',  cls: `${PREFIX}-ws-off` },
      fallback:     { text: 'WS: POLL', cls: `${PREFIX}-ws-poll` },
      idle:         { text: 'WS: --',   cls: `${PREFIX}-ws-idle` },
    };
    const c = config[state] || config.idle;
    el.textContent = c.text;
    el.className = c.cls;
  }

  // — PP Timer —

  function startPPTimer(durationSec) {
    ppBoosterTracker = { activatedAt: Date.now(), durationMs: durationSec * 1000 };
    stopPPTimer();
    ppTimerIntervalId = setInterval(updatePPTimerDisplay, 1000);
    updatePPTimerDisplay();
  }

  function stopPPTimer() {
    if (ppTimerIntervalId) {
      clearInterval(ppTimerIntervalId);
      ppTimerIntervalId = null;
    }
  }

  function updatePPTimerDisplay() {
    const el = document.getElementById(`${PREFIX}-pp-timer`);
    if (!el) return;

    if (!ppBoosterTracker) {
      el.textContent = 'PP Timer: --:--';
      return;
    }

    const remaining = (ppBoosterTracker.activatedAt + ppBoosterTracker.durationMs) - Date.now();
    if (remaining <= 0) {
      el.textContent = 'PP Timer: 00:00';
      return;
    }

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    el.textContent = `PP Timer: ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function isPPExpired() {
    if (!ppBoosterTracker) return false;
    return Date.now() >= ppBoosterTracker.activatedAt + ppBoosterTracker.durationMs;
  }

  // — Event Handlers —

  function onDeployFinished() {
    if (currentState !== State.WAITING_FOR_COMPLETION) return;

    stopCompletionDetector();

    deployCount++;
    updateStatsDisplay();
    log(`Deploy #${deployCount} complete`);

    if (stopRequested) {
      transitionToStopped('Stopped by user');
      return;
    }

    setState(State.CHECK_BOOSTERS);
    checkBoostersAndContinue();
  }

  function onRoundChanged() {
    log('Round ended or battle finished');
    stopCompletionDetector();
    if (currentState === State.WAITING_FOR_COMPLETION) {
      deployCount++;
      updateStatsDisplay();
    }
    transitionToStopped('Round ended');
    notify('Round Changed', 'The battle round ended. Redeployment stopped.');
  }

  function checkBoostersAndContinue() {
    if (isPPExpired()) {
      transitionToStopped('PP booster expired');
      notify('Boosters Expired', `PP booster timer finished. Deployed ${deployCount} times.`);
      return;
    }

    // Small delay before next deploy to avoid hammering
    setTimeout(() => executeDeploy(), 1000);
  }

  function transitionToStopped(reason) {
    stopCompletionDetector();
    stopPPTimer();
    updateWsIndicator(pomeloConnected ? 'idle' : 'disconnected');
    setState(State.STOPPED);
    log(`Stopped: ${reason}`);
    stopRequested = false;
    updateStartStopButtons();
  }

  // — Main Flow —

  async function startAutoDeploy() {
    if (currentState !== State.IDLE && currentState !== State.STOPPED) {
      log('Cannot start: not in IDLE/STOPPED state', 'warn');
      return;
    }

    stopRequested = false;
    deployCount = 0;
    retryCount = 0;
    ppBoosterTracker = null;
    updateStatsDisplay();
    updateStartStopButtons();

    // Re-check pomelo connection (may have reconnected since last run)
    if (!pomeloConnected) {
      teardownPomeloListeners();
      const wsOk = setupPomeloListeners();
      updateWsIndicator(wsOk ? 'idle' : 'disconnected');
    }

    const ctx = getPageContext();
    if (!ctx) {
      log('Cannot read page context (SERVER_DATA missing)', 'error');
      return;
    }

    // If SERVER_DATA says deploying, verify via API (SERVER_DATA can be stale)
    if (ctx.deployment) {
      log('SERVER_DATA shows active deployment - verifying...');
      try {
        const citizenData = await getJSON(
          'https://www.erepublik.com/en/military/campaignsJson/citizen'
        );
        if (citizenData.deployment !== null && citizenData.deployment !== undefined) {
          log('Confirmed: deployment is active - waiting for it to finish');
          setState(State.WAITING_FOR_COMPLETION);
          startCompletionDetector(ctx.battleId, ctx.battleZoneId);
          return;
        }
        log('SERVER_DATA was stale - no active deployment, proceeding normally');
      } catch (err) {
        log(`Could not verify deployment: ${err.message} - proceeding anyway`, 'warn');
      }
    }

    // Activate selected boosters
    setState(State.ACTIVATING_BOOSTERS);
    await activateSelectedBoosters(ctx);

    if (stopRequested) { transitionToStopped('Stopped by user'); return; }

    // Fetch inventory if not loaded
    if (!deployCache.inventoryLoaded) {
      setState(State.FETCHING_INVENTORY);
      try {
        await fetchInventory(ctx);
        populateWeaponDropdown();
        populateVehicleDropdown();
      } catch (err) {
        log(`Inventory fetch failed: ${err.message}`, 'error');
        transitionToStopped('Inventory fetch failed');
        return;
      }
    }

    // Start deploying
    await executeDeploy();
  }

  async function activateSelectedBoosters(ctx) {
    if (selectedBoosterIds.size === 0) {
      log('No boosters selected');
      return;
    }

    const boosters = getAvailableBoosters();

    for (const boosterId of selectedBoosterIds) {
      if (stopRequested) return;

      const booster = boosters.find(b => b.id === boosterId);
      if (!booster) {
        log(`Booster "${boosterId}" not found or unavailable`, 'warn');
        continue;
      }

      try {
        const success = await activateBooster(booster, ctx);
        if (success && booster.type === 'prestige_points') {
          startPPTimer(booster.duration);
          log(`PP timer started: ${booster.duration}s`);
        }
        await delay(400);
      } catch (err) {
        log(`Booster error: ${err.message}`, 'error');
      }
    }
  }

  async function executeDeploy() {
    if (stopRequested || currentState === State.STOPPED || currentState === State.IDLE) {
      if (currentState !== State.STOPPED && currentState !== State.IDLE) {
        transitionToStopped('Stopped by user');
      }
      return;
    }

    const ctx = getPageContext();
    if (!ctx) { transitionToStopped('Page context lost'); return; }

    setState(State.DEPLOYING);

    try {
      log(`Deploying #${deployCount + 1} via game UI...`);
      const result = await deployViaGameUI();

      if (stopRequested) { transitionToStopped('Stopped by user'); return; }

      log(`Deploy started! ID: ${result.deploymentId}, energy: ${result.energy}`);
      retryCount = 0;

      setState(State.WAITING_FOR_COMPLETION);
      startCompletionDetector(ctx.battleId, ctx.battleZoneId);
    } catch (err) {
      const msg = err.message.toLowerCase();

      if (msg.includes('stopped by user') || stopRequested) {
        transitionToStopped('Stopped by user');
        return;
      }

      log(`Deploy failed: ${err.message}`, 'error');

      if (msg.includes('already') || msg.includes('deploying')) {
        log('Already deploying - waiting for it to finish');
        setState(State.WAITING_FOR_COMPLETION);
        await delay(ALREADY_DEPLOYING_DELAY_MS);
        startCompletionDetector(ctx.battleId, ctx.battleZoneId);
        return;
      }

      if (msg.includes('no energy')) {
        transitionToStopped('No energy available');
        notify('No Energy', 'All energy consumed. Stopping.');
        return;
      }

      if (retryCount < 1) {
        retryCount++;
        setState(State.RETRYING);
        log(`Retrying in ${RETRY_DELAY_MS}ms... (attempt ${retryCount})`);
        await delay(RETRY_DELAY_MS);
        await executeDeploy();
      } else {
        transitionToStopped(`Deploy failed: ${err.message}`);
        notify('Deploy Error', `Failed after retry: ${err.message}`);
      }
    }
  }

  function stopAutoDeploy() {
    stopRequested = true;
    if (currentState === State.WAITING_FOR_COMPLETION) {
      log('Stop requested - will stop after current deploy finishes');
      const el = document.getElementById(`${PREFIX}-status`);
      if (el) {
        el.textContent = 'Status: STOPPING...';
        el.classList.add(`${PREFIX}-status-stopping`);
      }
    } else if (currentState !== State.IDLE && currentState !== State.STOPPED) {
      transitionToStopped('Stopped by user');
    }
    updateStartStopButtons();
  }

  // Register custom events
  window.addEventListener('ard:deployFinished', onDeployFinished);
  window.addEventListener('ard:roundChanged', onRoundChanged);

  function cleanup() {
    stopCompletionDetector();
    teardownPomeloListeners();
    stopPPTimer();
    window.removeEventListener('ard:deployFinished', onDeployFinished);
    window.removeEventListener('ard:roundChanged', onRoundChanged);
  }

  window.addEventListener('beforeunload', cleanup);

  // ═══════════════════════════════════════════════════════════════════
  // 11. UI PANEL (HTML + CSS + Event Handlers)
  // ═══════════════════════════════════════════════════════════════════

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .${PREFIX}-panel {
        position: fixed;
        top: 80px;
        right: 20px;
        width: 380px;
        background: #1a1a2e;
        border: 1px solid #333;
        border-radius: 8px;
        color: #e0e0e0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        z-index: 99999;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        user-select: none;
      }
      .${PREFIX}-panel.minimized .${PREFIX}-body { display: none; }

      .${PREFIX}-titlebar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background: #0f3460;
        border-radius: 7px 7px 0 0;
        cursor: move;
      }
      .${PREFIX}-titlebar-left {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 13px;
      }
      .${PREFIX}-titlebar-btn {
        background: none;
        border: none;
        color: #aaa;
        cursor: pointer;
        font-size: 14px;
        padding: 2px 6px;
        border-radius: 3px;
      }
      .${PREFIX}-titlebar-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }

      .${PREFIX}-body { padding: 0; }

      .${PREFIX}-status-bar {
        display: flex;
        justify-content: space-between;
        padding: 8px 12px;
        background: #16213e;
        border-bottom: 1px solid #333;
        font-size: 11px;
      }
      .${PREFIX}-status-bar span { color: #aaa; }
      .${PREFIX}-ws-on { color: #4caf50 !important; }
      .${PREFIX}-ws-off { color: #f44336 !important; }
      .${PREFIX}-ws-poll { color: #ff9800 !important; }
      .${PREFIX}-ws-idle { color: #888 !important; }
      .${PREFIX}-status-stopping { color: #ff9800 !important; font-weight: 600; }

      .${PREFIX}-section {
        padding: 8px 12px;
        border-bottom: 1px solid #2a2a3e;
      }
      .${PREFIX}-section-title {
        font-size: 10px;
        text-transform: uppercase;
        color: #666;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
      }

      .${PREFIX}-booster-list {
        max-height: 160px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: #333 transparent;
      }
      .${PREFIX}-booster-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 0;
        font-size: 11px;
      }
      .${PREFIX}-booster-item input[type="checkbox"] {
        accent-color: #e94560;
        margin: 0;
      }
      .${PREFIX}-booster-item .amount {
        color: #888;
        margin-left: auto;
        font-size: 10px;
      }

      .${PREFIX}-dropdowns {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .${PREFIX}-dropdown-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .${PREFIX}-dropdown-row label {
        width: 55px;
        font-size: 11px;
        color: #aaa;
      }
      .${PREFIX}-dropdown-row select {
        flex: 1;
        background: #16213e;
        color: #e0e0e0;
        border: 1px solid #333;
        border-radius: 4px;
        padding: 4px 6px;
        font-size: 11px;
        cursor: pointer;
      }
      .${PREFIX}-dropdown-row select:focus { outline: 1px solid #0f3460; }

      .${PREFIX}-stats {
        padding: 8px 12px;
        border-bottom: 1px solid #2a2a3e;
        font-size: 11px;
        color: #aaa;
      }

      .${PREFIX}-buttons {
        display: flex;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid #2a2a3e;
      }
      .${PREFIX}-btn-start {
        flex: 1;
        padding: 8px;
        border: none;
        border-radius: 4px;
        background: #2d6a4f;
        color: #fff;
        font-weight: 600;
        font-size: 12px;
        cursor: pointer;
        letter-spacing: 1px;
      }
      .${PREFIX}-btn-start:hover { background: #40916c; }
      .${PREFIX}-btn-start:disabled { background: #333; color: #666; cursor: not-allowed; }

      .${PREFIX}-btn-stop {
        flex: 0.6;
        padding: 8px;
        border: none;
        border-radius: 4px;
        background: #6b2020;
        color: #fff;
        font-weight: 600;
        font-size: 12px;
        cursor: pointer;
      }
      .${PREFIX}-btn-stop:hover { background: #922b2b; }
      .${PREFIX}-btn-stop:disabled { background: #333; color: #666; cursor: not-allowed; }

      .${PREFIX}-log-container {
        padding: 6px 12px 8px;
      }
      .${PREFIX}-log-label {
        font-size: 10px;
        text-transform: uppercase;
        color: #666;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }
      .${PREFIX}-log {
        height: 100px;
        overflow-y: auto;
        background: #0d0d1a;
        border: 1px solid #222;
        border-radius: 4px;
        padding: 6px;
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 10px;
        color: #7a7;
        white-space: pre-wrap;
        word-break: break-all;
        scrollbar-width: thin;
        scrollbar-color: #333 transparent;
      }
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    injectStyles();

    const panel = document.createElement('div');
    panel.className = `${PREFIX}-panel`;
    panel.id = `${PREFIX}-panel`;

    panel.innerHTML = `
      <div class="${PREFIX}-titlebar" id="${PREFIX}-titlebar">
        <div class="${PREFIX}-titlebar-left">
          <span>Auto Redeploy</span>
        </div>
        <div>
          <button class="${PREFIX}-titlebar-btn" id="${PREFIX}-btn-minimize" title="Minimize">&minus;</button>
          <button class="${PREFIX}-titlebar-btn" id="${PREFIX}-btn-close" title="Close">&times;</button>
        </div>
      </div>
      <div class="${PREFIX}-body">
        <div class="${PREFIX}-status-bar">
          <span id="${PREFIX}-status">Status: IDLE</span>
          <span id="${PREFIX}-ws-status" class="${PREFIX}-ws-idle" title="Pomelo WebSocket">WS: --</span>
          <span id="${PREFIX}-pp-timer">PP Timer: --:--</span>
        </div>

        <div class="${PREFIX}-section">
          <div class="${PREFIX}-section-title">Boosters (select to activate on start)</div>
          <div class="${PREFIX}-booster-list" id="${PREFIX}-booster-list">
            <div style="color:#666; font-size:11px;">Loading boosters...</div>
          </div>
        </div>

        <div class="${PREFIX}-section">
          <div class="${PREFIX}-dropdowns">
            <div class="${PREFIX}-dropdown-row">
              <label>Weapon:</label>
              <select id="${PREFIX}-weapon-select">
                <option value="-1">No Weapon</option>
              </select>
            </div>
            <div class="${PREFIX}-dropdown-row">
              <label>Vehicle:</label>
              <select id="${PREFIX}-vehicle-select">
                <option value="">Loading...</option>
              </select>
            </div>
          </div>
        </div>

        <div class="${PREFIX}-stats" id="${PREFIX}-stats">Deploys: 0</div>

        <div class="${PREFIX}-buttons">
          <button class="${PREFIX}-btn-start" id="${PREFIX}-btn-start">&gt;&gt;&gt; START &gt;&gt;&gt;</button>
          <button class="${PREFIX}-btn-stop" id="${PREFIX}-btn-stop" disabled>STOP</button>
        </div>

        <div class="${PREFIX}-log-container">
          <div class="${PREFIX}-log-label">Log</div>
          <div class="${PREFIX}-log" id="${PREFIX}-log"></div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // Log element reference
    logElement = document.getElementById(`${PREFIX}-log`);
    // Replay any logs captured before UI was created
    if (logLines.length > 0) {
      logElement.textContent = logLines.join('\n');
      logElement.scrollTop = logElement.scrollHeight;
    }

    // Minimize
    document.getElementById(`${PREFIX}-btn-minimize`).addEventListener('click', () => {
      panel.classList.toggle('minimized');
    });

    // Close (cleanup intervals and remove panel)
    document.getElementById(`${PREFIX}-btn-close`).addEventListener('click', () => {
      cleanup();
      panel.remove();
    });

    // Start (disable immediately to prevent double-clicks)
    document.getElementById(`${PREFIX}-btn-start`).addEventListener('click', (e) => {
      if (e.target.disabled) return;
      e.target.disabled = true;
      startAutoDeploy();
    });

    // Stop
    document.getElementById(`${PREFIX}-btn-stop`).addEventListener('click', () => {
      stopAutoDeploy();
    });

    // Draggable
    makeDraggable(panel, document.getElementById(`${PREFIX}-titlebar`));

    // Restore position
    restorePosition(panel);
  }

  function populateBoosterList() {
    const container = document.getElementById(`${PREFIX}-booster-list`);
    if (!container) return;

    const boosters = getAvailableBoosters();
    if (boosters.length === 0) {
      container.innerHTML = '<div style="color:#666; font-size:11px;">No boosters available</div>';
      return;
    }

    container.innerHTML = '';
    for (const booster of boosters) {
      const item = document.createElement('label');
      item.className = `${PREFIX}-booster-item`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.boosterId = booster.id;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedBoosterIds.add(booster.id);
        } else {
          selectedBoosterIds.delete(booster.id);
        }
      });

      const nameSpan = document.createElement('span');
      const durationLabel = booster.duration >= 3600
        ? `${Math.round(booster.duration / 3600)}h`
        : booster.duration >= 60
          ? `${Math.round(booster.duration / 60)}m`
          : `${booster.duration}s`;
      nameSpan.textContent = `${booster.name} (${durationLabel})`;

      const amountSpan = document.createElement('span');
      amountSpan.className = 'amount';
      amountSpan.textContent = `x${booster.amount}`;

      item.appendChild(checkbox);
      item.appendChild(nameSpan);
      item.appendChild(amountSpan);
      container.appendChild(item);
    }
  }

  function populateWeaponDropdown() {
    const select = document.getElementById(`${PREFIX}-weapon-select`);
    if (!select) return;

    select.innerHTML = '';
    for (const weapon of deployCache.weapons) {
      const opt = document.createElement('option');
      opt.value = weapon.quality;
      let label = weapon.name;
      if (weapon.amount !== null && weapon.amount !== undefined) {
        label += ` (x${weapon.amount})`;
      }
      if (weapon.damageperHit) {
        label += ` - ${weapon.damageperHit} dmg/hit`;
      }
      if (weapon.isBest) label += ' *';
      opt.textContent = label;
      if (weapon.quality === deployCache.selectedWeaponQuality) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      deployCache.selectedWeaponQuality = parseInt(select.value, 10);
    });
  }

  function populateVehicleDropdown() {
    const select = document.getElementById(`${PREFIX}-vehicle-select`);
    if (!select) return;

    select.innerHTML = '';
    for (const vehicle of deployCache.vehicles) {
      const opt = document.createElement('option');
      opt.value = vehicle.id;
      opt.textContent = vehicle.name || `Vehicle ${vehicle.id}`;
      if (vehicle.isActive) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      deployCache.selectedSkinId = parseInt(select.value, 10);
    });
  }

  function readDropdownSelections() {
    const weaponSelect = document.getElementById(`${PREFIX}-weapon-select`);
    if (weaponSelect) {
      deployCache.selectedWeaponQuality = parseInt(weaponSelect.value, 10);
    }
    const vehicleSelect = document.getElementById(`${PREFIX}-vehicle-select`);
    if (vehicleSelect && vehicleSelect.value) {
      deployCache.selectedSkinId = parseInt(vehicleSelect.value, 10);
    }
  }

  function updateStartStopButtons() {
    const startBtn = document.getElementById(`${PREFIX}-btn-start`);
    const stopBtn = document.getElementById(`${PREFIX}-btn-stop`);
    if (!startBtn || !stopBtn) return;

    const isRunning = currentState !== State.IDLE && currentState !== State.STOPPED;
    startBtn.disabled = isRunning;
    stopBtn.disabled = !isRunning;
  }

  // — Draggable —

  function makeDraggable(panel, handle) {
    let isDragging = false;
    let startX, startY, origLeft, origTop;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = (origLeft + dx) + 'px';
      panel.style.top = (origTop + dy) + 'px';
      panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      savePosition(panel);
    });
  }

  function savePosition(panel) {
    try {
      const rect = panel.getBoundingClientRect();
      localStorage.setItem(STORAGE_KEY_POSITION, JSON.stringify({
        left: rect.left,
        top: rect.top,
      }));
    } catch (_) { /* ignore */ }
  }

  function restorePosition(panel) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_POSITION));
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        // Clamp to viewport
        const maxX = window.innerWidth - 100;
        const maxY = window.innerHeight - 50;
        panel.style.left = Math.min(Math.max(0, saved.left), maxX) + 'px';
        panel.style.top = Math.min(Math.max(0, saved.top), maxY) + 'px';
        panel.style.right = 'auto';
      }
    } catch (_) { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 12. MAIN (Entry Point)
  // ═══════════════════════════════════════════════════════════════════

  async function init() {
    log('Initializing...');
    requestNotificationPermission();

    const sd = getServerData();
    if (!sd) {
      log('SERVER_DATA not found - not on an active battlefield?', 'error');
      return;
    }

    if (sd.battleFinished) {
      log('Battle is finished - nothing to do');
      return;
    }

    log(`Battle #${sd.battleId}, Zone ${sd.battleZoneId}, Side ${sd.mySideCountryId}`);

    createPanel();
    populateBoosterList();

    // Connect to Pomelo WebSocket events
    const wsOk = setupPomeloListeners();
    updateWsIndicator(wsOk ? 'idle' : 'disconnected');

    // Pre-fetch inventory for dropdowns
    const ctx = getPageContext();
    if (ctx) {
      try {
        await fetchInventory(ctx);
        populateWeaponDropdown();
        populateVehicleDropdown();
      } catch (err) {
        log(`Initial inventory fetch failed: ${err.message}`, 'warn');
        log('Weapon/vehicle dropdowns will populate on START');
      }
    }

    log('Ready. Select boosters, weapon, vehicle, then click START.');
  }

  // Wait for page to fully load (SERVER_DATA needs to be populated)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1500));
  } else {
    setTimeout(init, 1500);
  }

})();
