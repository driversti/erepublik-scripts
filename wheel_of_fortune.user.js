// ==UserScript==
// @name         Wheel of Fortune Automator
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Automate spinning the Wheel of Fortune on Erepublik
// @author       driversti and AI
// @match        https://www.erepublik.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        apiBuild: "https://www.erepublik.com/en/main/wheeloffortune-build",
        apiSpin: "https://www.erepublik.com/en/main/wheeloffortune-spin",
        delay: 3000
    };

    let state = {
        isRunning: false,
        spinsCount: 0,
        totalCost: 0,
        prizes: [],
        settings: {
            spinType: 1, // 1 or 5
            maxCostPerSpin: 0,
            maxTotalSpend: 0,
            stopOnJackpot: false
        }
    };

    function init() {
        console.log("Wheel of Fortune Automator initialized");
        createUI();
    }

    function createUI() {
        addStyles();
        createFloatingButton();
        createModal();
    }

    function addStyles() {
        GM_addStyle(`
            #wof-btn {
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 9999;
                padding: 10px 20px;
                background: #e74c3c;
                color: white;
                border: none;
                border-radius: 5px;
                cursor: pointer;
                font-weight: bold;
                box-shadow: 0 2px 5px rgba(0,0,0,0.3);
            }
            #wof-modal {
                display: none;
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 0 10px rgba(0,0,0,0.5);
                z-index: 10000;
                width: 400px;
                max-height: 80vh;
                overflow-y: auto;
                font-family: Arial, sans-serif;
                color: #333;
            }
            #wof-overlay {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.5);
                z-index: 9999;
            }
            .wof-group { margin-bottom: 15px; }
            .wof-group label { display: block; margin-bottom: 5px; font-weight: bold; }
            .wof-group input, .wof-group select { width: 100%; padding: 8px; box-sizing: border-box; }
            .wof-row { display: flex; justify-content: space-between; align-items: center; }
            .wof-btn-primary { background: #2ecc71; color: white; border: none; padding: 10px; width: 100%; cursor: pointer; border-radius: 4px; }
            .wof-btn-secondary { background: #95a5a6; color: white; border: none; padding: 5px 10px; cursor: pointer; border-radius: 4px; margin-top: 10px; }
            .wof-results { margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px; }
            .wof-log { height: 150px; overflow-y: auto; background: #f9f9f9; border: 1px solid #ddd; padding: 5px; font-size: 12px; margin-top: 10px; }
            .wof-stat { display: flex; justify-content: space-between; margin-bottom: 5px; }
        `);
    }

    function createFloatingButton() {
        const btn = document.createElement('button');
        btn.id = 'wof-btn';
        btn.innerText = "Wheel Automator";
        btn.onclick = toggleSettingsModal;
        document.body.appendChild(btn);
    }

    function createModal() {
        const overlay = document.createElement('div');
        overlay.id = 'wof-overlay';
        overlay.onclick = toggleSettingsModal;
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = 'wof-modal';
        modal.innerHTML = `
            <h2 style="margin-top:0">Wheel of Fortune Settings</h2>
            
            <div class="wof-group">
                <label>Spin Type</label>
                <select id="wof-spin-type">
                    <option value="1">Single Spin</option>
                    <option value="5">5 Spins (Multispin)</option>
                </select>
            </div>

            <div class="wof-group">
                <label>Max Cost per Spin (Currency)</label>
                <input type="number" id="wof-max-cost" placeholder="Empty = Unlimited">
            </div>

            <div class="wof-group">
                <label>Max Total Spend (Currency)</label>
                <input type="number" id="wof-total-spend" placeholder="Empty = Unlimited">
            </div>

            <div class="wof-group wof-row">
                <label style="margin:0">Stop on 3 Jackpots</label>
                <input type="checkbox" id="wof-stop-jackpot" style="width:auto">
            </div>

            <button id="wof-start-btn" class="wof-btn-primary">Start Auto-Spin</button>

            <div class="wof-results">
                <h3>Results</h3>
                <div class="wof-stat"><span>Spins:</span> <span id="wof-stat-spins">0</span></div>
                <div class="wof-stat"><span>Spent:</span> <span id="wof-stat-spent">0</span></div>
                <div class="wof-stat"><span>Jackpots:</span> <span id="wof-stat-jackpots">0</span></div>
                
                <div class="wof-log" id="wof-log"></div>
                
                <button class="wof-btn-secondary" id="wof-export-csv">Export CSV</button>
                <button class="wof-btn-secondary" id="wof-export-clip">Copy to Clipboard</button>
            </div>
        `;
        document.body.appendChild(modal);

        // Event Listeners
        document.getElementById('wof-start-btn').onclick = toggleSpinning;
        document.getElementById('wof-export-csv').onclick = exportCSV;
        document.getElementById('wof-export-clip').onclick = exportClipboard;
    }

    function toggleSettingsModal() {
        const modal = document.getElementById('wof-modal');
        const overlay = document.getElementById('wof-overlay');
        const isVisible = modal.style.display === 'block';

        modal.style.display = isVisible ? 'none' : 'block';
        overlay.style.display = isVisible ? 'none' : 'block';
    }

    function toggleSpinning() {
        if (state.isRunning) {
            stopSpinning();
        } else {
            startSpinning();
        }
    }

    function getCSRFToken() {
        return window.csrfToken || "";
    }

    async function fetchData() {
        log("Fetching wheel data...");
        try {
            const response = await fetch(CONFIG.apiBuild, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "X-Requested-With": "XMLHttpRequest"
                },
                body: `_token=${getCSRFToken()}`
            });

            if (!response.ok) throw new Error("Network response was not ok");

            const data = await response.json();
            updateStateFromBuild(data);
            log(`Data fetched. Next spin cost: ${state.nextSpinCost}`);
            return true;
        } catch (e) {
            log(`Error fetching data: ${e.message}`);
            stopSpinning();
            return false;
        }
    }

    function updateStateFromBuild(data) {
        state.nextSpinCost = data.cost;
        state.jackpotsWon = data.progress.jackpot;
        state.multispinCosts = data.multispin; // Store multispin costs
        // Update UI with current stats if needed
        document.getElementById('wof-stat-jackpots').innerText = state.jackpotsWon;
    }

    function startSpinning() {
        // Update state from UI
        state.settings.spinType = parseInt(document.getElementById('wof-spin-type').value);

        const maxCostInput = document.getElementById('wof-max-cost').value;
        state.settings.maxCostPerSpin = maxCostInput === "" ? -1 : parseInt(maxCostInput);

        const totalSpendInput = document.getElementById('wof-total-spend').value;
        state.settings.maxTotalSpend = totalSpendInput === "" ? -1 : parseInt(totalSpendInput);

        state.settings.stopOnJackpot = document.getElementById('wof-stop-jackpot').checked;

        state.isRunning = true;
        state.totalCost = 0; // Reset session cost
        state.spinsCount = 0; // Reset session spins

        document.getElementById('wof-start-btn').innerText = "Stop Auto-Spin";
        document.getElementById('wof-start-btn').style.background = "#e74c3c";

        log("Starting auto-spin...");
        runSpinLoop();
    }

    async function runSpinLoop() {
        if (!state.isRunning) return;

        // 1. Fetch current data to get cost
        const successFetch = await fetchData();
        if (!successFetch || !state.isRunning) return;

        // 2. Check limits
        const spinType = state.settings.spinType;
        // data.multispin is an object like { "1": { cost: 3400, ... }, "5": { cost: 18000, ... } }
        // We stored it in state.multispinCosts
        let currentSpinCost = 0;
        if (state.multispinCosts && state.multispinCosts[spinType]) {
            currentSpinCost = state.multispinCosts[spinType].cost;
        } else {
            // Fallback if multispin data missing (shouldn't happen if fetchData works)
            currentSpinCost = state.nextSpinCost * spinType;
        }

        if (state.settings.maxCostPerSpin !== -1 && currentSpinCost > state.settings.maxCostPerSpin) {
            log(`Spin cost (${currentSpinCost}) exceeds max cost per spin (${state.settings.maxCostPerSpin}). Stopping.`);
            stopSpinning();
            return;
        }

        if (state.settings.maxTotalSpend !== -1 && (state.totalCost + currentSpinCost) > state.settings.maxTotalSpend) {
            log(`Next spin cost (${currentSpinCost}) would exceed max total spend (${state.settings.maxTotalSpend}). Stopping.`);
            stopSpinning();
            return;
        }

        // 3. Spin
        const successSpin = await spin(currentSpinCost, spinType);
        if (!successSpin || !state.isRunning) return;

        // 4. Loop
        log(`Waiting ${CONFIG.delay}ms...`);
        setTimeout(runSpinLoop, CONFIG.delay);
    }

    async function spin(cost, spins) {
        log(`Spinning... (Cost: ${cost}, Spins: ${spins})`);
        try {
            const response = await fetch(CONFIG.apiSpin, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "X-Requested-With": "XMLHttpRequest"
                },
                body: `_token=${getCSRFToken()}&_currentCost=${cost}&spins=${spins}`
            });

            if (!response.ok) throw new Error("Network response was not ok");

            const data = await response.json();

            // Update state
            state.totalCost += cost;
            state.spinsCount += spins;
            state.jackpotsWon = data.jackpot;

            // Log prizes and save to history
            if (data.prizes) {
                data.prizes.forEach(p => {
                    const prizeName = p.tooltip || p.prize;
                    log(`Won: ${prizeName}`);
                    const record = {
                        date: new Date().toISOString(),
                        prize: prizeName,
                        cost: cost / spins, // approx cost per prize if multispin
                        spinType: spins
                    };
                    state.prizes.push(record);
                    saveToHistory(record);
                });
            }

            // Update UI
            document.getElementById('wof-stat-spins').innerText = state.spinsCount;
            document.getElementById('wof-stat-spent').innerText = state.totalCost;
            document.getElementById('wof-stat-jackpots').innerText = state.jackpotsWon;

            // Check Stop on Jackpot
            if (state.settings.stopOnJackpot) {
                const wonJackpot = data.prizes.some(p => p.prize === 'jackpot' || (p.tooltip && p.tooltip.toLowerCase().includes('jackpot')));
                if (wonJackpot) {
                    // Check if we reached 3 jackpots total (as per API data)
                    if (state.jackpotsWon >= 3) {
                        log("Target of 3 Jackpots reached! Stopping.");
                        stopSpinning();
                        return false;
                    }
                }
            }

            return true;
        } catch (e) {
            log(`Error spinning: ${e.message}`);
            stopSpinning();
            return false;
        }
    }

    function saveToHistory(record) {
        let history = JSON.parse(localStorage.getItem('wof_history') || '[]');
        history.push(record);
        localStorage.setItem('wof_history', JSON.stringify(history));
    }

    function stopSpinning() {
        state.isRunning = false;
        document.getElementById('wof-start-btn').innerText = "Start Auto-Spin";
        document.getElementById('wof-start-btn').style.background = "#2ecc71";
        log("Auto-spin stopped.");
    }

    function log(msg) {
        const logDiv = document.getElementById('wof-log');
        const line = document.createElement('div');
        line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logDiv.prepend(line);
    }

    function exportCSV() {
        const history = JSON.parse(localStorage.getItem('wof_history') || '[]');
        if (history.length === 0) {
            alert("No history to export.");
            return;
        }

        let csv = "Date,Prize,Cost,SpinType\n";
        history.forEach(row => {
            csv += `"${row.date}","${row.prize}",${row.cost},${row.spinType}\n`;
        });

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);
        a.setAttribute('download', 'wof_history.csv');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        log("CSV Exported.");
    }

    function exportClipboard() {
        const history = JSON.parse(localStorage.getItem('wof_history') || '[]');
        if (history.length === 0) {
            alert("No history to export.");
            return;
        }

        let text = "Date\tPrize\tCost\tSpinType\n";
        history.forEach(row => {
            text += `${row.date}\t${row.prize}\t${row.cost}\t${row.spinType}\n`;
        });

        navigator.clipboard.writeText(text).then(() => {
            log("History copied to clipboard.");
        }).catch(err => {
            log("Failed to copy: " + err);
        });
    }

    window.addEventListener('load', init);

})();
