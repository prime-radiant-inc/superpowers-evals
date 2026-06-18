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

  // Column highlight: light the whole (agent, os) column by ATTRIBUTE match —
  // never positional index — so it survives the multi-OS two-tier header and SSE
  // <td> swaps. An agent-group header (.agent-col) has no data-os, so hovering it
  // lights every column for that agent.
  function clearColumnHighlight() {
    for (const el of document.querySelectorAll(".col-hi")) {
      el.classList.remove("col-hi");
    }
  }

  function highlightColumn(el) {
    const agent = el.getAttribute("data-agent");
    if (agent === null) return;
    const os = el.getAttribute("data-os");
    const a = CSS.escape(agent);
    const selector =
      os !== null
        ? `[data-agent="${a}"][data-os="${CSS.escape(os)}"]`
        : `[data-agent="${a}"]`;
    for (const node of document.querySelectorAll(selector)) {
      node.classList.add("col-hi");
    }
  }

  document.addEventListener("mouseover", (e) => {
    const cell = e.target.closest("td.c");
    if (cell) {
      if (cell.querySelector("[data-card]")) showCard(cell);
      else hideCard();
    }
    const colSource = e.target.closest("[data-agent]");
    clearColumnHighlight();
    if (colSource) highlightColumn(colSource);
  });
  document.addEventListener("mouseout", (e) => {
    const cell = e.target.closest("td.c");
    if (cell && !cell.contains(e.relatedTarget)) hideCard();
    const colSource = e.target.closest("[data-agent]");
    if (colSource && !colSource.contains(e.relatedTarget)) {
      clearColumnHighlight();
    }
  });
})();
