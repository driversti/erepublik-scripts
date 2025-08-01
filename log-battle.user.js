// ==UserScript==
// @name         eRepublik Battle Logger
// @namespace    https://github.com/driversti/erepublik-scripts
// @version      1.2
// @description  Adds a draggable button to log battle data. Its position is saved automatically.
// @author       driversti https://www.erepublik.com/en/citizen/profile/4690052
// @updateURL    https://driversti.github.io/erepublik-scripts/log-battle.user.js
// @downloadURL  https://driversti.github.io/erepublik-scripts/log-battle.user.js
// @match        https://www.erepublik.com/*/military/battlefield/*
// @connect      n8n.yurii.live
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    const BUTTON_ID = 'ex-log-battle-button-draggable';
    const STORAGE_KEY = 'erepublik-battle-logger-position';

    // === Styling ===
    GM_addStyle(`
        #${BUTTON_ID} {
            position: absolute;
            z-index: 2003;
            height: 35px;
            width: 70px;
            background: #28a745;
            color: white;
            border: 1px solid #1e7e34;
            border-radius: 6px;
            cursor: grab;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            font-weight: bold;
            user-select: none;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        }
        #${BUTTON_ID}:hover {
            background-color: #218838;
        }
        #${BUTTON_ID}:active {
            cursor: grabbing; /* Indicates active drag */
            background-color: #1e7e34;
        }
        .ex-log-battle-toast {
            position: fixed; bottom: 20px; right: 20px; padding: 10px 20px;
            border-radius: 4px; color: white; opacity: 0;
            transition: opacity 0.3s ease-in-out; z-index: 10001;
        }
        .ex-log-battle-toast.ex-success { background-color: #4CAF50; }
        .ex-log-battle-toast.ex-error { background-color: #f44336; }
        .ex-log-battle-toast.ex-show { opacity: 1; }
    `);

    function init() {
        const recordButton = document.createElement('div');
        recordButton.id = BUTTON_ID;
        recordButton.textContent = 'Record';
        document.body.appendChild(recordButton);

        const savedPos = localStorage.getItem(STORAGE_KEY);
        if (savedPos) {
            const pos = JSON.parse(savedPos);
            recordButton.style.top = pos.top;
            recordButton.style.left = pos.left;
        } else {
            recordButton.style.top = '150px';
            recordButton.style.left = `${window.innerWidth - 120}px`;
        }

        makeDraggable(recordButton);
    }

    /**
     * Attaches event listeners to make the button draggable with both mouse and touch input.
     * @param {HTMLElement} button The button element to make draggable.
     */
    function makeDraggable(button) {
        let isDragging = false;
        let hasDragged = false;
        let startX, startY;
        let startTime = 0;
        let touchTimeout = null;
        let isProcessingClick = false; // Flag to prevent double-triggering

        function dragStart(e) {
            // Use touch event data if it's a touch screen, otherwise use mouse event data
            const event = e.type === 'touchstart' ? e.touches[0] : e;

            // Prevent default actions like text selection or page scrolling on touch
            if (e.type === 'touchstart') {
                e.preventDefault();
                
                // Clear any existing timeout
                if (touchTimeout) {
                    clearTimeout(touchTimeout);
                    touchTimeout = null;
                }
            }

            isDragging = true;
            hasDragged = false;
            startTime = Date.now();

            startX = event.clientX - button.offsetLeft;
            startY = event.clientY - button.offsetTop;

            // Add appropriate move and end listeners
            document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', dragMove);
            document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', dragEnd);
        }

        function dragMove(e) {
            if (!isDragging) return;
            hasDragged = true;

            const event = e.type === 'touchmove' ? e.touches[0] : e;
            const newX = event.clientX - startX;
            const newY = event.clientY - startY;
            button.style.left = `${newX}px`;
            button.style.top = `${newY}px`;
        }

        function dragEnd(e) {
            isDragging = false;
            const touchDuration = Date.now() - startTime;

            // Clean up listeners based on the event type that started the drag
            if (e.type === 'mouseup') {
                document.removeEventListener('mousemove', dragMove);
                document.removeEventListener('mouseup', dragEnd);
                
                // For mouse events, we can directly determine if it was a click or drag
                if (hasDragged) {
                    const finalPos = { top: button.style.top, left: button.style.left };
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(finalPos));
                } else if (!isProcessingClick) {
                    isProcessingClick = true;
                    logBattle();
                    // Reset the flag after a short delay
                    setTimeout(() => { isProcessingClick = false; }, 300);
                }
            } else { // touchend
                document.removeEventListener('touchmove', dragMove);
                document.removeEventListener('touchend', dragEnd);
                
                // For touch events, we need to be more careful to distinguish taps from drags
                if (hasDragged) {
                    const finalPos = { top: button.style.top, left: button.style.left };
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(finalPos));
                } else if (touchDuration < 300 && !isProcessingClick) { // Short touch duration indicates a tap
                    // Use a small delay to ensure it's not part of a gesture
                    isProcessingClick = true;
                    touchTimeout = setTimeout(() => {
                        logBattle();
                        touchTimeout = null;
                        // Reset the flag after a short delay
                        setTimeout(() => { isProcessingClick = false; }, 300);
                    }, 10);
                }
            }
        }

        // Add a dedicated tap/click handler for touch devices
        function handleTap(e) {
            // Prevent the default behavior to avoid any browser-specific handling
            e.preventDefault();
            
            // Only process if we're not already handling a click
            if (!isProcessingClick) {
                isProcessingClick = true;
                
                // Call logBattle directly for explicit tap events
                logBattle();
                
                // Reset the flag after a short delay
                setTimeout(() => { isProcessingClick = false; }, 300);
            }
        }
        
        // Add mouse, touch, and tap listeners to the button
        button.addEventListener('mousedown', dragStart);
        button.addEventListener('touchstart', dragStart, { passive: false });
        button.addEventListener('click', handleTap);
    }

    // === Core Feature Logic ===
    async function logBattle() {
        showToast('Logging battle...', false);
        try {
            const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const payload = {
                username: page.erepublik.citizen.name, userId: page.erepublik.citizen.citizenId,
                battleId: page.SERVER_DATA.battleId, battleZoneId: page.SERVER_DATA.battleZoneId,
                division: page.SERVER_DATA.currentDivision, round: page.SERVER_DATA.currentRoundNumber,
                invaderName: page.SERVER_DATA.countries[page.SERVER_DATA.realInvaderId],
                defenderName: page.SERVER_DATA.countries[page.SERVER_DATA.realDefenderId],
                regionName: document.getElementById('region_name_link')?.textContent?.trim() || 'Unknown Region'
            };
            const response = await fetch('https://n8n.yurii.live/webhook/new-battle', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            showToast('Battle logged successfully!');
        } catch (error) {
            console.error('Error logging battle:', error);
            showToast('Failed to log battle', true);
        }
    }

    function showToast(message, isError = false) {
        const toast = document.createElement('div');
        toast.className = `ex-log-battle-toast ${isError ? 'ex-error' : 'ex-success'}`;
        toast.textContent = message; document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('ex-show'), 100);
        setTimeout(() => {
            toast.classList.remove('ex-show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // Start the script once the window is loaded
    window.addEventListener('load', init);

})();
