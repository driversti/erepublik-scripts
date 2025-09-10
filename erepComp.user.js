// ==UserScript==
// @name         ErepComp
// @version      0.1
// @author       Mike Dreams
// @match        https://www.erepublik.com/en/economy/myCompanies
// @match        https://www.erepublik.com/uk/economy/myCompanies
// @grant        none
// ==/UserScript==

(function () {
  var ePar = document.getElementById("help_manage").parentElement;

  function selectallhp() {
    for (var e = Math.floor((erepublik.citizen.energy + erepublik.citizen.energyFromFoodRemaining) / 10), t = getCompanies(), n = 0; n < t.length;) t[n].classList.contains("active") ? 0 < e ? e-- : (t[n].classList.remove("active"), calculateProduction(t[n].parentElement.parentElement, !0)) : 0 < e && (t[n].classList.add("active"), calculateProduction(t[n].parentElement.parentElement, !0), e--), n++;
    finalize()
  }

  function plus10() {
    for (var e = getCompanies(), t = 0, n = 0; n < 10 && t < e.length;) e[t].classList.contains("active") || (e[t].classList.add("active"), calculateProduction(e[t].parentElement.parentElement, !0), n++), t++;
    finalize()
  }

  function minus10() {
    for (var e = getCompanies(), t = e.length - 1, n = 0; n < 10 && -1 < t;) e[t].classList.contains("active") && (e[t].classList.remove("active"), calculateProduction(e[t].parentElement.parentElement, !0), n++), t--;
    finalize(e[t])
  }

  function getCompanies() {
    for (var e = Array.from(document.getElementsByClassName("as_employee")), t = e.length - 1; -1 < t; t--) {
      var n = e[t].parentElement.parentElement;
      (n.classList.contains("disabled") || n.classList.contains("cannotWorkAsManager")) && e.splice(t, 1)
    }
    return e
  }

  function finalize() {
    checkHealth(), checkTax(), calculateTotals(), warnForCritical()
  }

  ePar.innerHTML += "<button id='bselall'>Choose for all HP</button><button id='bplus10'>+10 companies</button><button id='bminus10'>-10 companies</button>", document.getElementById("bselall").addEventListener("click", selectallhp), document.getElementById("bplus10").addEventListener("click", plus10), document.getElementById("bminus10").addEventListener("click", minus10);
})();
