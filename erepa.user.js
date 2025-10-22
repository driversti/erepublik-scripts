// ==UserScript==
// @name eRepa
// @version 1.9.1
// @description An Uber-script aiming to cover all you might need in the game.
// @namespace https://github.com/driversti/erepublik-scripts
// @author driversti (https://www.erepublik.com/en/citizen/profile/4690052)
// @icon https://www.google.com/s2/favicons?sz=64&domain=erepublik.com
// @match https://www.erepublik.com/*
// @grant GM_setValue
// @grant GM_getValue
// @grant GM_deleteValue
// @grant GM_listValues
// @grant unsafeWindow
// @grant GM_xmlhttpRequest
// @license UNLICENSED
// @updateURL https://driversti.github.io/erepublik-scripts/erepa.user.js
// @downloadURL https://driversti.github.io/erepublik-scripts/erepa.user.js
// ==/UserScript==

(function() {
    'use strict';
    const script = document.createElement('script');
    script.src = 'https://driversti.github.io/erepublik-scripts/erepa.js';
    document.head.appendChild(script);
})();
