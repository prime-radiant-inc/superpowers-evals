// Detail hover card for the read-only dashboard. The card markup is rendered
// inside each cell (so SSE swaps carry it) but sits [hidden] because the grid
// container is overflow:auto with a sticky header and would clip it. On hover we
// clone the card into #card-host and show it position:fixed, flipping left/up if
// it would spill the viewport.
(function () {
  "use strict";

  function hideCard() {
    const host = document.getElementById("card-host");
    if (host) host.innerHTML = "";
  }

  function showCard(cell) {
    const src = cell.querySelector("[data-card]");
    const host = document.getElementById("card-host");
    if (!src || !host) return;
    const clone = src.cloneNode(true);
    clone.removeAttribute("hidden");
    host.innerHTML = "";
    host.appendChild(clone);
    const r = cell.getBoundingClientRect();
    const cr = clone.getBoundingClientRect();
    const margin = 8;
    let left = r.right + 6;
    if (left + cr.width > window.innerWidth - margin) {
      left = r.left - cr.width - 6; // flip to the left of the cell
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - cr.width - margin));
    let top = r.top;
    if (top + cr.height > window.innerHeight - margin) {
      top = window.innerHeight - cr.height - margin; // clamp up so it stays on-screen
    }
    top = Math.max(margin, top);
    clone.style.left = left + "px";
    clone.style.top = top + "px";
  }

  document.addEventListener("mouseover", (e) => {
    const cell = e.target.closest("td.c");
    if (cell) {
      if (cell.querySelector("[data-card]")) showCard(cell);
      else hideCard();
    }
  });
  document.addEventListener("mouseout", (e) => {
    const cell = e.target.closest("td.c");
    if (cell && !cell.contains(e.relatedTarget)) hideCard();
  });
})();
