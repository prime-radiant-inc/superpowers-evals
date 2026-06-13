// Hover preview chip + confirm dialog. Launch lives on the ▶ affordance only;
// the only element that POSTs is the Confirm button, so no unconfirmed launch
// path exists. Counts/estimates come from server-rendered data-* attributes.
(function () {
  "use strict";

  function fmtEst(raw) {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? "~$" + n.toFixed(0) : "~$—";
  }

  function clearWash() {
    document.querySelectorAll(".prev").forEach((el) => el.classList.remove("prev"));
    document.querySelectorAll(".armed").forEach((el) => el.classList.remove("armed"));
    const chip = document.getElementById("hover-chip");
    if (chip) chip.remove();
  }

  function washColumn(agent) {
    document.querySelectorAll(`#grid tbody tr`).forEach((tr) => {
      const cells = tr.querySelectorAll("td.c");
      const idx = [...document.querySelectorAll("#grid thead th")].findIndex(
        (th) => th.dataset.agent === agent
      );
      if (idx > 0 && cells[idx - 1]) cells[idx - 1].classList.add("prev");
    });
  }

  function washRow(scenario) {
    const row = [...document.querySelectorAll("#grid tbody tr")].find(
      (tr) => tr.querySelector("td.rl")?.dataset.scenario === scenario
    );
    if (row) row.querySelectorAll("td.c").forEach((c) => c.classList.add("prev"));
  }

  function chipFor(target, label) {
    const chip = document.createElement("div");
    chip.id = "hover-chip";
    chip.className = "chip";
    const count = target.dataset.count || "?";
    const est = fmtEst(target.dataset.estimate);
    chip.innerHTML =
      `<span class="go">▶ ${label}</span> · ${count} runnable <span class="est">· ${est}</span>`;
    const r = target.getBoundingClientRect();
    chip.style.left = r.left + "px";
    chip.style.top = Math.max(4, r.top - 30) + "px";
    document.body.appendChild(chip);
  }

  function openConfirm(target, kind, label) {
    clearWash();
    const host = document.getElementById("confirm-host");
    const count = target.dataset.count || "?";
    const est = fmtEst(target.dataset.estimate);
    host.innerHTML =
      `<div class="confirm"><span class="go">Run ${count} cells</span>` +
      `<span class="est">· ${est}</span>` +
      `<button id="confirm-go">Confirm</button>` +
      `<button id="confirm-cancel">Cancel</button></div>`;
    document.getElementById("confirm-cancel").onclick = () => (host.innerHTML = "");
    document.getElementById("confirm-go").onclick = () => {
      host.innerHTML = "";
      const body = new URLSearchParams({ kind });
      if (kind === "column") body.set("agent", target.dataset.agent);
      if (kind === "row") body.set("scenario", target.dataset.scenario);
      fetch("/launch", { method: "POST", body, headers: { Accept: "text/html" } }).then((r) =>
        r.text().then((html) => {
          // 200 returns the seeded run strip ("Running N · …") so the strip is
          // correct from first paint (S4); 409 returns the busy message. Both
          // render into #runbar; live updates then arrive via the SSE strip event.
          document.getElementById("runbar").innerHTML = html;
        })
      );
    };
  }

  // --- detail hover card --------------------------------------------------
  // The card markup is rendered inside each cell (so SSE swaps carry it) but
  // sits [hidden] because the grid container is overflow:auto with a sticky
  // header and would clip it. On hover we clone the card into #card-host and
  // show it position:fixed, flipping left/up if it would spill the viewport.
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

  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-launch]");
    if (!t) return;
    clearWash();
    const kind = t.dataset.launch;
    if (kind === "column") { t.classList.add("armed"); washColumn(t.dataset.agent); chipFor(t, "Run " + t.dataset.agent); }
    else if (kind === "row") { t.classList.add("armed"); washRow(t.dataset.scenario); chipFor(t, "Run " + t.dataset.scenario); }
    else if (kind === "all") { chipFor(t, "Run all"); }
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest("[data-launch]")) clearWash();
  });
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-launch]");
    if (!t) return;
    const kind = t.dataset.launch;
    const label = kind === "column" ? "Run " + t.dataset.agent
      : kind === "row" ? "Run " + t.dataset.scenario : "Run all";
    openConfirm(t, kind, label);
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest(".stop")) {
      fetch("/stop", { method: "POST" });
    }
  });
})();
