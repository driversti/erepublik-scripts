// ==UserScript==
// @name         eRepublik Battle Logger
// @namespace    https://github.com/driversti/erepublik-scripts
// @version      1.0
// @description  Adds a draggable button to log battle data. Its position is saved automatically.
// @author       driversti https://www.erepublik.com/en/citizen/profile/4690052
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

    /**
     * Main function to initialize the button and its functionality
     */
    function init() {
        // 1. Create the button element
        const recordButton = document.createElement('div');
        recordButton.id = BUTTON_ID;
        recordButton.textContent = 'Record';
        document.body.appendChild(recordButton);

        // 2. Load saved position from Local Storage
        const savedPos = localStorage.getItem(STORAGE_KEY);
        if (savedPos) {
            const pos = JSON.parse(savedPos);
            recordButton.style.top = pos.top;
            recordButton.style.left = pos.left;
        } else {
            // Default position if none is saved (top right corner)
            recordButton.style.top = '150px';
            recordButton.style.left = `${window.innerWidth - 120}px`;
        }

        // 3. Make the button draggable
        makeDraggable(recordButton);
    }

    /**
     * Attaches mousedown event listener to make the button draggable.
     * @param {HTMLElement} button The button element to make draggable.
     */
    function makeDraggable(button) {
        let isDragging = false;
        let hasDragged = false;
        let startX, startY;

        button.addEventListener('mousedown', (e) => {
            // Prevent default drag behavior (like image ghosting)
            e.preventDefault();
            isDragging = true;
            hasDragged = false;

            startX = e.clientX - button.offsetLeft;
            startY = e.clientY - button.offsetTop;

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        function onMouseMove(e) {
            if (!isDragging) return;
            hasDragged = true; // Register that a drag has occurred

            // Position the button based on mouse movement
            const newX = e.clientX - startX;
            const newY = e.clientY - startY;
            button.style.left = `${newX}px`;
            button.style.top = `${newY}px`;
        }

        function onMouseUp() {
            // Clean up global event listeners
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            if (hasDragged) {
                // If the button was dragged, save the new position
                const finalPos = { top: button.style.top, left: button.style.left };
                localStorage.setItem(STORAGE_KEY, JSON.stringify(finalPos));
            } else {
                // If not dragged, it's a click. Perform the action.
                // This correctly prevents requests while dragging.
                logBattle();
            }
            isDragging = false;
        }
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
