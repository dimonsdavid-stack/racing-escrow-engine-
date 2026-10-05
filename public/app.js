import { startPractice, formatTime } from "./game.js";
import { bestCleanLap } from "./physics.js";
const $ = (s) => document.querySelector(s),
  content = $("#content"),
  modal = $("#modal");
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const state = {
  currency: "GC",
  tracks: [],
  config: null,
  user: null,
  lobby: { offers: [], tracks: [] },
  session: null,
  search: "",
  filter: "all",
  game: null,
  refreshTimer: null,
  authView: "signup",
  enrollment: false,
};
const labels = {
  lobby: "Race lobby",
  practice: "Practice tracks",
  races: "My races",
  wallet: "Wallet",
  records: "Personal bests",
  guide: "How racing works",
  fairplay: "Fair play",
  settings: "Account & controls",
  rules: "Rules & eligibility",
  privacy: "Privacy",
};
function storedRecords() {
  try {
    const r = JSON.parse(localStorage.getItem("racing.practice.v1") ?? "[]");
    return Array.isArray(r)
      ? r
          .filter(
            (x) =>
              state.tracks.some((t) => t.id === x.track_id) &&
              Array.isArray(x.laps) &&
              x.laps.length === 3 &&
              x.laps.every(
                (l) =>
                  typeof l.is_clean === "boolean" &&
                  Number.isFinite(l.seconds) &&
                  l.seconds > 0,
              ) &&
              typeof x.completed_at === "string",
          )
          .slice(0, 50)
      : [];
  } catch {
    return [];
  }
}
function saveRecord(r) {
  try {
    localStorage.setItem(
      "racing.practice.v1",
      JSON.stringify([r, ...storedRecords()].slice(0, 50)),
    );
  } catch {
    toast("Practice finished. Your browser could not save this session.");
  }
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("visible"), 4500);
}
function coins(value) {
  if (typeof value !== "string") return "—";
  const [whole, frac = ""] = value.split(".");
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (frac.replace(/0+$/, "") ? "." + frac.replace(/0+$/, "") : "")
  );
}
function terms(entry = "10.00") {
  const [i, f = ""] = entry.split(".");
  const micros = BigInt(i) * 1000000n + BigInt(f.padEnd(6, "0"));
  const fmt = (n) =>
    `${n / 1000000n}.${
      String(n % 1000000n)
        .padStart(6, "0")
        .replace(/0+$/, "") || "0"
    }`;
  return {
    pool: fmt(micros * 2n),
    rake: fmt(micros / 5n),
    payout: fmt((micros * 9n) / 5n),
  };
}
function route(name) {
  location.hash = name;
}
function track(id) {
  return state.tracks.find((t) => t.id === id) ?? state.tracks[0];
}
function date(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
function trackSvg(t) {
  const paths = {
    coastal:
      "M105 150 C55 140 55 65 110 58 L260 58 C305 58 337 82 330 111 C328 143 302 150 260 150 Z",
    club: "M98 145 C57 132 60 65 100 56 L166 56 C196 56 190 96 221 96 L286 65 C320 51 350 101 315 130 L244 151 Z",
    night:
      "M91 142 C45 125 57 61 112 60 L260 50 C294 43 324 74 320 105 C323 134 293 144 251 140 L175 154 Z",
  };
  return `<svg viewBox="0 0 400 220" aria-hidden="true"><path d="${paths[t.id]}" fill="#12231e" stroke="#42534c" stroke-width="32"/><path d="${paths[t.id]}" fill="none" stroke="#a8c9ad" stroke-width="2"/><path d="${paths[t.id]}" fill="none" stroke="#bad4ae66" stroke-width="1" stroke-dasharray="7 9"/><g transform="translate(250 146) rotate(0)"><rect x="-14" y="-9" width="30" height="18" rx="4" fill="#c3f16b"/><rect x="1" y="-6" width="8" height="12" fill="#163b2b"/><rect x="-9" y="-6" width="5" height="12" fill="#264432"/></g><text x="200" y="110" text-anchor="middle" font-family="system-ui" font-weight="800" font-style="italic" font-size="25" fill="#9bc19c66">R /</text></svg>`;
}
function cards(list = state.tracks) {
  return `<div class="card-grid">${list.map((t, i) => `<article class="track-card"><div class="track-cover" style="--track-glow:${["#294d37", "#244855", "#3b2f58"][state.tracks.indexOf(t)]}"><span class="pill">FREE PRACTICE</span>${trackSvg(t)}<span class="track-number">0${state.tracks.indexOf(t) + 1}</span></div><div class="track-info"><h3>${escape(t.title)}</h3><p>${escape(t.description)}</p><div class="track-stats"><div>LEVEL<strong>${escape(t.difficulty)}</strong></div><div>SESSION<strong>3 laps</strong></div><div>MODE<strong>Time attack</strong></div></div><div class="track-buttons"><button class="button primary" data-drive-track="${t.id}">Drive now ↗</button><button class="button ghost" data-create="${t.id}">Challenge</button></div></div></article>`).join("")}</div>`;
}
function head(title, description, action = "") {
  return `<div class="page-head"><div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}
function empty(title, message, button = "") {
  return `<div class="empty"><span class="empty-icon">⚑</span><h3>${title}</h3><p>${message}</p>${button}</div>`;
}
function activation() {
  return !state.config?.accounts_available
    ? `<div class="notice"><p><strong>Practice is open.</strong> Accounts and coin-bearing races await activation of the dedicated racing database and telemetry provider.</p><a class="text-link" href="#guide">How it works ↗</a></div>`
    : state.currency === "SC"
      ? `<div class="notice"><p><strong>Sweeps Coins</strong> are separate from GC. SC participation requires verified eligibility. Purchases and redemption are not activated.</p><a href="#rules" class="text-link">Eligibility ↗</a></div>`
      : "";
}
function offerRows() {
  const offers = state.lobby.offers.filter(
    (o) => o.token_type === state.currency,
  );
  if (!offers.length)
    return empty(
      "The next challenge can be yours.",
      "There are no open challenges in this currency. Create one on a connected race provider, or sharpen your line in free practice.",
      `<button class="button ghost" data-create="coastal">Create a challenge</button>`,
    );
  return offers
    .map(
      (o) =>
        `<div class="duel-row"><div><h3>${escape(track(o.track_id)?.title ?? o.track_id)}</h3><p>@${escape(o.handle)} · Expires ${date(o.expires_at)}</p></div><div class="duel-amount">${coins(o.entry_fee)} ${escape(o.token_type)}<small>Entry per racer</small></div><button class="button ${o.mine ? "ghost" : "primary"} small" data-${o.mine ? "cancel" : "accept"}="${o.id}">${o.mine ? "Cancel offer" : "Review & join"}</button></div>`,
    )
    .join("");
}
function lobby() {
  return `<section class="hero"><div class="hero-content"><div class="eyebrow">PRACTICE THE LINE. CHALLENGE THE GRID.</div><h1>Your best lap.<br><em>Their next challenge.</em></h1><p>Three laps. One clean personal best. Get behind the wheel now, then take your pace into a head-to-head race.</p><div class="hero-actions"><button class="button primary" data-drive-track="coastal">Drive free practice ↗</button><button class="button ghost" data-create="coastal">Create challenge</button></div></div><figure class="hero-art">${trackSvg(state.tracks[0])}<figcaption>COASTAL SPRINT / TIME ATTACK</figcaption></figure></section>${activation()}<div class="section-heading"><h2>Find your circuit</h2><a href="#practice" class="text-link">All practice tracks ↗</a></div>${cards()}<div class="section-heading"><h2>Head-to-head challenges <span class="pill gold">${state.currency}</span></h2><button class="button small ghost" id="refresh-lobby">↻ Refresh</button></div><section class="panel">${offerRows()}</section><div class="section-heading"><h2>From the grid to the finish</h2><a class="text-link" href="#guide">Read the race guide ↗</a></div><div class="steps"><article><span class="step-index">01</span><h3>Choose your line</h3><p>Practice without an account, an entry fee, or any cash exposure.</p></article><article><span class="step-index">02</span><h3>Agree to the race</h3><p>Both racers accept the same entry. Funds lock together only when the challenge is accepted.</p></article><article><span class="step-index">03</span><h3>Let clean laps decide</h3><p>Verified provider telemetry settles the fastest clean lap. Invalid races receive a full entry refund.</p></article></div>`;
}
function practice() {
  const list = state.tracks.filter(
    (t) =>
      (state.filter === "all" || t.difficulty === state.filter) &&
      `${t.title} ${t.description}`
        .toLowerCase()
        .includes(state.search.toLowerCase()),
  );
  return (
    head(
      "Find your racing rhythm.",
      "Free, playable time attack. Keyboard or touch controls. No coins are moved.",
    ) +
    `<div class="searchbar"><input id="track-search" aria-label="Search tracks" placeholder="Search tracks…" value="${escape(state.search)}"><span class="chip">3 LAPS / SESSION</span></div><div class="filter-row">${["all", "Rookie", "Sport", "Pro"].map((f) => `<button class="filter ${state.filter === f ? "active" : ""}" data-filter="${f}">${f === "all" ? "All tracks" : f}</button>`).join("")}</div><div id="track-results">${list.length ? cards(list) : empty("No tracks match your search.", "Try another track name or difficulty.")}</div><div class="notice" style="margin-top:25px"><p>Practice records stay on this browser. They are never submitted as verified coin-bearing race results.</p><a href="#records" class="text-link">Personal bests ↗</a></div>`
  );
}
function gate(title) {
  return (
    head(
      title,
      "Your account keeps your wallet, challenges and race receipts together.",
    ) +
    empty(
      "Join your side of the grid.",
      "Create a verified account to access your wallet and head-to-head challenges. You can drive practice without one.",
      `<button class="button primary" data-auth>Join the grid</button> <button class="button ghost" data-drive-track="coastal">Try practice</button>`,
    )
  );
}
function races() {
  if (!state.user) return gate("My races");
  return (
    head(
      "Your races, every outcome.",
      "Follow escrow status, race deadlines and verified settlement receipts.",
      `<button class="button primary" data-create="coastal">Create challenge</button>`,
    ) +
    (!state.user.races.length
      ? empty(
          "No funded races yet.",
          "Create an offer or join a challenge when a racing provider is connected. Every funded race appears here with its receipt.",
        )
      : `<div class="table-scroll panel"><table class="race-table"><thead><tr><th>RACE</th><th>ENTRY</th><th>STATUS</th><th>OUTCOME</th><th>RECEIPT</th></tr></thead><tbody>${state.user.races.map((r) => `<tr><td><strong>${escape(track(r.track_id)?.title ?? "Provider race")}</strong><p>@${escape(r.opponent ?? "Racer")} · ${date(r.created_at)}</p></td><td>${coins(r.entry_fee)} ${r.token_type}</td><td><span class="pill ${r.status === "Active" ? "gold" : "muted"}">${r.status}</span></td><td>${r.status === "Settled" ? (r.resolution === "winner" ? (r.winner_id === state.user.user_id ? "Won" : "Completed") : "Refunded") : "Awaiting verified telemetry"}</td><td><button class="button small ghost" data-receipt="${r.id}">View ↗</button></td></tr>`).join("")}</tbody></table></div>`)
  );
}
function wallet() {
  if (!state.user) return gate("Your wallet");
  const u = state.user;
  const escrowValue =
    u[state.currency === "GC" ? "gc_locked_entry" : "sc_locked_entry"];
  return (
    head(
      "Two currencies. One clear wallet.",
      "Your spendable balance and escrow are shown separately.",
    ) +
    `<div class="metric-grid"><div class="metric"><div class="metric-label">GOLD COINS · SOCIAL PLAY</div><div class="metric-value">${coins(u.gc_balance)} <span class="coin">G</span></div><p>No cash value. Never redeemable.</p></div><div class="metric"><div class="metric-label">SWEEPS COINS · PROMOTIONAL</div><div class="metric-value">${coins(u.sc_balance)} SC</div><p>${u.sc_eligible ? "Eligibility recorded" : "Eligibility not activated"}</p></div><div class="metric"><div class="metric-label">YOUR LOCKED ENTRY · ${state.currency}</div><div class="metric-value">${coins(escrowValue)}</div><p>All funded races. Available balance excludes locked entries.</p></div></div><div class="split"><section class="panel"><h2>Your social-play allowance</h2><p>Claim 100 free GC once per UTC day. Claims are posted to your ledger and cannot pay twice.</p><button class="button primary" id="daily-claim">Claim daily GC</button><p class="form-help">GC purchase checkout and SC prize redemption are not activated. No payment details are collected.</p></section><section class="panel"><h2>Every entry has a receipt.</h2><p>Your balance changes only through a recorded grant, atomic race funding, settlement or full refund.</p><div class="info-list"><div><span>Platform share on winner settlement</span><strong>10% of gross pool</strong></div><div><span>Platform share on refunds</span><strong>0%</strong></div><div><span>GC → SC conversion</span><strong>Unavailable</strong></div></div></section></div><div class="section-heading"><h2>Wallet activity</h2><span class="chip">LATEST 50 ENTRIES</span></div><section class="panel table-scroll">${u.history.length ? `<table class="race-table"><thead><tr><th>DATE</th><th>TYPE</th><th>CURRENCY</th><th>AMOUNT</th></tr></thead><tbody>${u.history.map((h) => `<tr><td>${date(h.created_at)}</td><td>${escape(h.kind)}</td><td>${h.token_type}</td><td>${h.delta.startsWith("-") ? "" : "+"}${coins(h.delta)}</td></tr>`).join("")}</tbody></table>` : empty("No activity yet.", "Ledger entries will appear here when your account is funded or a race settles.")}</section>`
  );
}
function records() {
  const records = storedRecords();
  return (
    head(
      "The lap you’re chasing.",
      "Personal practice records on this browser. These are not verified competition standings.",
      `<button class="button primary" data-drive-track="coastal">Set a time ↗</button>`,
    ) +
    `<div class="metric-grid">${state.tracks
      .map((t) => {
        const best = bestCleanLap(
          records.filter((r) => r.track_id === t.id).flatMap((r) => r.laps),
        );
        return `<div class="metric"><div class="metric-label">${escape(t.title).toUpperCase()}</div><div class="metric-value record-time">${formatTime(best)}</div><p>Best clean practice lap</p></div>`;
      })
      .join(
        "",
      )}</div><section class="panel">${records.length ? `<div class="table-scroll"><table class="race-table"><thead><tr><th>SESSION</th><th>TRACK</th><th>CLEAN LAPS</th><th>BEST CLEAN TIME</th></tr></thead><tbody>${records.map((r) => `<tr><td>${date(r.completed_at)}</td><td>${escape(track(r.track_id).title)}</td><td>${r.laps.filter((l) => l.is_clean).length} / 3</td><td class="record-time">${formatTime(bestCleanLap(r.laps))}</td></tr>`).join("")}</tbody></table></div>` : empty("Your first lap is waiting.", "Complete a three-lap practice session. Clean laps build your personal record; off-track laps are marked invalid.", `<button class="button primary" data-drive-track="coastal">Drive your first session</button>`)}</section>`
  );
}
const articles = {
  guide: [
    "From practice to a head-to-head race.",
    `<h2>Start driving in seconds</h2><p>Choose a practice circuit and tap Drive. Use W or ↑ for throttle, S or ↓ for brake, and A/D or ←/→ to steer. On a phone, hold the on-screen controls. Complete three clockwise laps, passing every sector in order.</p><h2>Make a clean lap count</h2><p>Crossing either track edge invalidates that lap. Finish it and start fresh at the line. Your fastest clean positive time becomes your practice personal best. Practice runs stay on this browser and do not move wallet coins.</p><h2>Agree to a challenge</h2><p>With an activated account and connected racing provider, choose a circuit, currency and entry. Posting an offer does not deduct coins. An opponent reviews and accepts the exact terms. The database then checks and deducts both entries in one transaction.</p><h2>Complete the provider race</h2><p>The accepted challenge records its session ID and deadline. Use that session with the connected race provider. Only the provider’s authenticated final telemetry can settle the race. The browser practice game cannot report coin-bearing results.</p><h2>Read the outcome</h2><p>The fastest valid clean lap wins 90% of the combined entry pool. The remaining 10% is the platform share. If both racers have no valid clean lap, finish in an exact tie, the provider reports a network drop, or the deadline expires, both entries are refunded in full.</p>`,
  ],
  fairplay: [
    "Skill on track. Evidence at the finish.",
    `<h2>Provider-authenticated results</h2><p>Results are bound to the tenant, provider, race session and both registered competitors. A copied event cannot issue another payout, and a changed payload using the same event ID is rejected.</p><h2>Clean-lap standard</h2><p>Off-track and wall-riding laps marked unclean are disregarded. Zero, negative, malformed and nonfinite clean times cannot win. Timing precision is six decimal places; exact ties receive a zero-fee refund.</p><h2>Disconnected races</h2><p>A signed provider network-drop result refunds both racers. A lost response from this API is different: the caller retries the identical event because the database might already have committed.</p><h2>Control your play</h2><p>Use Account & controls to pause new coin-bearing race participation for one hour, one day or seven days. A pause cannot be shortened and does not cancel a funded race. Existing race outcomes and refunds still complete.</p><p><a class="text-link" href="#settings">Open account controls ↗</a></p>`,
  ],
  rules: [
    "Race terms & availability.",
    `<h2>Social play and practice</h2><p>Practice is free and requires no purchase or account. GC are utility coins with no cash value and no redemption rights. Account play requires a confirmed email, acceptance of these social-play terms and an activated racing database.</p><h2>Challenge acceptance</h2><p>Posting an offer is the creator’s acceptance of its displayed circuit, currency, entry, session window and platform share. The opponent must accept before funding. Open offers expire after fifteen minutes. Both racers must have sufficient available balance when acceptance occurs.</p><h2>Sweeps Coins</h2><p>SC are promotional assets separate from GC. SC participation is disabled by default and requires operator-approved eligibility. Sweepstakes rules, jurisdiction and age verification, promotional issuance and a cash redemption provider must be activated before SC participation can be offered. No SC purchases or redemption transactions are currently available.</p><h2>Settlement and refunds</h2><p>Winner payout equals 90% of the combined entry pool. No-clean-lap races, exact ties, authenticated network drops and overdue active sessions receive full zero-fee refunds. Disputed races stay locked for operator review.</p><h2>Current availability</h2><p>This release provides browser practice and the customer account, wallet and challenge software. Commercial account operation depends on database provisioning; coin-bearing races depend on an authenticated race provider and refund scheduler. The app shows unavailable capabilities explicitly.</p>`,
  ],
  privacy: [
    "Your account. Your race data.",
    `<h2>Practice data</h2><p>Practice lap history is stored in this browser’s local storage. It is not sent to the escrow settlement endpoint. Clear it from Account & controls. Device storage can be lost when you clear browser data.</p><h2>Account data</h2><p>When account infrastructure is activated, Supabase handles email authentication. Your public handle, wallet, challenge acceptance and ledger activity are stored in the tenant’s database. Public lobby cards show a handle and offer terms, never another racer’s email or wallet balance.</p><h2>Sessions and security</h2><p>Authentication credentials are sent over HTTPS. This app keeps its access session in memory, with a refresh token in session storage for the current browser tab; signing out clears it. Financial records and replay receipts are retained for reconciliation. Provider signing secrets and server database keys are never delivered to this browser.</p><h2>Operator privacy policy</h2><p>Operator identity, data-rights contact, retention periods and commercial privacy terms must be published before account-based commercial launch. This page describes the software’s current data behavior and does not substitute for that operator policy.</p>`,
  ],
};
function settings() {
  return (
    head(
      "Keep your pace under control.",
      "Account, session and device controls.",
    ) +
    `<div class="split"><section class="panel">${state.user ? `<div class="account-summary"><span class="avatar">${escape(state.user.handle[0].toUpperCase())}</span><div><h2>@${escape(state.user.handle)}</h2><p>Verified account · ${state.user.sc_eligible ? "SC eligibility recorded" : "Social play"}</p></div></div><div class="info-list"><div><span>Participation pause</span><strong>${state.user.pause_until && new Date(state.user.pause_until) > new Date() ? date(state.user.pause_until) : "No active pause"}</strong></div></div><h3 style="margin-top:25px">Take a break</h3><p>A pause stops new funded races and cannot be shortened. It does not interrupt existing settlements.</p><div class="settings-options"><button class="button small" data-pause="1">1 hour</button><button class="button small" data-pause="24">24 hours</button><button class="button small" data-pause="168">7 days</button></div><button class="button ghost" id="signout" style="margin-top:25px">Sign out</button>` : `<h2>Your racing account</h2><p>Keep real wallet activity and verified challenge receipts together in one account.</p><button class="button primary" data-auth>Join the grid</button>`}</section><section class="panel"><h2>Practice & device data</h2><p>Your saved practice sessions belong to this browser. Clearing them does not affect any account balance, funded race, or ledger receipt.</p><button class="button danger" id="clear-records">Clear practice history</button><div class="info-list" style="margin-top:20px"><div><span>Saved sessions</span><strong>${storedRecords().length}</strong></div><div><span>Practice submissions to settlement</span><strong>Never</strong></div></div><p class="form-help">Keyboard: arrows or WASD. On mobile: hold throttle and steering. Leaving the tab pauses your practice session.</p></section></div>`
  );
}
async function api(path, { method = "GET", body } = {}) {
  await ensureSession();
  const res = await fetch("/api/v1/app/" + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(state.session
        ? { Authorization: "Bearer " + state.session.access_token }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error ?? "request_failed");
    error.status = res.status;
    throw error;
  }
  return data;
}
async function authRequest(path, body, method = "POST") {
  if (!state.config?.accounts_available)
    throw new Error("accounts_not_activated");
  const res = await fetch(state.config.supabase_url + "/auth/v1/" + path, {
    method,
    headers: {
      apikey: state.config.publishable_key,
      "Content-Type": "application/json",
      ...(state.session
        ? { Authorization: "Bearer " + state.session.access_token }
        : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = res.status === 204 ? {} : await res.json();
  if (!res.ok)
    throw new Error(
      data.msg ?? data.error_description ?? "authentication_failed",
    );
  return data;
}
function sessionValue(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function setSession(session) {
  state.session = session;
  try {
    if (session?.refresh_token)
      sessionStorage.setItem("racing.refresh.v1", session.refresh_token);
    else sessionStorage.removeItem("racing.refresh.v1");
  } catch {}
}
let refreshing;
async function ensureSession() {
  if (state.session && Date.now() < state.session.expires_at * 1000 - 60000)
    return;
  if (!state.config?.accounts_available) return;
  const refresh =
    state.session?.refresh_token ?? sessionValue("racing.refresh.v1");
  if (!refresh) return;
  if (!refreshing)
    refreshing = authRequest("token?grant_type=refresh_token", {
      refresh_token: refresh,
    })
      .then((data) =>
        setSession({
          ...data,
          expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
        }),
      )
      .catch(() => {
        setSession(null);
        state.user = null;
      })
      .finally(() => {
        refreshing = null;
      });
  await refreshing;
}
async function sync() {
  if (!state.session) return;
  try {
    state.user = await api("me");
    state.lobby = await api("lobby");
    state.enrollment = false;
  } catch (e) {
    if (e.status === 409) {
      state.enrollment = true;
      state.user = null;
    } else if (e.status === 401) {
      setSession(null);
      state.user = null;
    } else throw e;
  }
  updateHeader();
}
function updateHeader() {
  $("#header-balance").textContent = state.user
    ? coins(state.user[state.currency === "GC" ? "gc_balance" : "sc_balance"])
    : "—";
  $("#account-button").textContent = state.user
    ? "@" + state.user.handle
    : "Join the grid";
  for (const b of document.querySelectorAll("[data-currency]"))
    b.classList.toggle("selected", b.dataset.currency === state.currency);
}
function render() {
  const name = location.hash.slice(1).split("/")[0] || "lobby";
  state.game?.destroy();
  state.game = null;
  clearInterval(state.refreshTimer);
  if (name === "drive") {
    renderGame(location.hash.split("/")[1]);
    return;
  }
  $("#page-label").textContent = labels[name] ?? "Race lobby";
  document
    .querySelectorAll("[data-nav],.mobile-nav a")
    .forEach((a) =>
      a.classList.toggle("active", a.getAttribute("href") === "#" + name),
    );
  content.innerHTML =
    name === "practice"
      ? practice()
      : name === "wallet"
        ? wallet()
        : name === "races"
          ? races()
          : name === "records"
            ? records()
            : name === "settings"
              ? settings()
              : articles[name]
                ? head(articles[name][0], "") +
                  `<article class="panel text-content">${articles[name][1]}</article>`
                : lobby();
  wire();
  if (["races", "lobby"].includes(name) && state.user)
    state.refreshTimer = setInterval(async () => {
      if (document.hidden || modal.open) return;
      try {
        await sync();
        render();
      } catch {}
    }, 15000);
}
function showModal(title, body) {
  state.game?.pause();
  $("#modal-content").innerHTML =
    `<div class="modal-body"><div class="modal-heading"><h2 id="modal-title">${title}</h2><button class="close-button" aria-label="Close dialog" id="close-modal">×</button></div>${body}</div>`;
  if (!modal.open) modal.showModal();
  $("#close-modal").onclick = () => modal.close();
}
function showAuth(mode = "signup") {
  state.authView = mode;
  const enabled = state.config?.accounts_available;
  if (state.enrollment && state.session) {
    showEnroll();
    return;
  }
  showModal(
    "Your place on the grid.",
    `<div class="modal-tabs"><button id="signup-tab" class="${mode === "signup" ? "active" : ""}">Create account</button><button id="signin-tab" class="${mode === "signin" ? "active" : ""}">Sign in</button></div>${!enabled ? `<div class="notice"><p><strong>Account activation pending.</strong> The dedicated racing database has not been provisioned. Free practice is playable now; no email or password is collected here.</p></div><button class="button primary wide" id="auth-practice">Drive free practice ↗</button>` : `<form id="auth-form">${mode === "signup" ? `<div class="form-field"><label class="label" for="handle">Racing handle</label><input id="handle" required pattern="[A-Za-z0-9_]{3,20}" minlength="3" maxlength="20" autocomplete="nickname" placeholder="Your public racing handle"></div>` : ""}<div class="form-field"><label class="label" for="email">Email</label><input id="email" type="email" required autocomplete="email" placeholder="you@example.com"></div><div class="form-field"><label class="label" for="password">Password</label><input id="password" type="password" required minlength="12" maxlength="128" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" placeholder="At least 12 characters"></div>${mode === "signup" ? `<label class="check-row"><input id="terms" type="checkbox" required><span>I accept the social-play <a class="text-link" href="#rules" id="terms-link">race terms</a>. GC have no cash value.</span></label>` : ""}<button class="button primary wide" type="submit">${mode === "signup" ? "Create racing account" : "Sign in"}</button><p class="form-help">${mode === "signup" ? "Confirm your email before your wallet is created. New accounts receive 1,000 GC for social play." : "Use your confirmed account email. Forgot your password?"} ${mode === "signin" ? '<button type="button" class="button small ghost" id="reset-password">Send reset link</button>' : ""}</p><p class="error-message" id="auth-message" role="status"></p></form>`}`,
  );
  $("#signup-tab").onclick = () => showAuth("signup");
  $("#signin-tab").onclick = () => showAuth("signin");
  if (!enabled) {
    $("#auth-practice").onclick = () => {
      modal.close();
      route("drive/coastal");
    };
    return;
  }
  $("#terms-link")?.addEventListener("click", () => modal.close());
  $("#reset-password")?.addEventListener("click", async () => {
    const email = $("#email").value;
    if (!email) {
      $("#auth-message").textContent = "Enter your account email first.";
      return;
    }
    try {
      await authRequest(
        "recover?redirect_to=" +
          encodeURIComponent(location.origin + "/#recovery"),
        { email },
      );
      $("#auth-message").textContent =
        "If the account exists, a reset email has been sent. Open the link to choose a new password.";
    } catch (e) {
      $("#auth-message").textContent = humanError(e);
    }
  });
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector("[type=submit]");
    button.disabled = true;
    const email = $("#email").value,
      password = $("#password").value;
    try {
      if (mode === "signup") {
        const handle = $("#handle").value;
        try {
          sessionStorage.setItem("racing.pending-handle", handle);
        } catch {}
        const data = await authRequest(
          "signup?redirect_to=" + encodeURIComponent(location.origin + "/"),
          { email, password },
        );
        if (!data.access_token) {
          $("#auth-message").textContent =
            "Check your email to confirm your account. Then return here and sign in to finish your racing profile.";
          return;
        }
        setSession({
          ...data,
          expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
        });
        await sync();
        showEnroll();
      } else {
        const data = await authRequest("token?grant_type=password", {
          email,
          password,
        });
        setSession({
          ...data,
          expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
        });
        await sync();
        if (state.enrollment) showEnroll();
        else {
          modal.close();
          render();
          toast("Welcome back to the grid.");
        }
      }
    } catch (error) {
      $("#auth-message").textContent = humanError(error);
    } finally {
      button.disabled = false;
    }
  };
}
function humanError(error) {
  return (
    {
      accounts_not_activated: "Accounts are awaiting database activation.",
      race_conflict_or_profile_required:
        "The race, balance or profile changed. Refresh and review the current terms before retrying.",
      play_not_available:
        "Participation is paused, currency eligibility is missing, or this race is unavailable.",
      retry_same_request:
        "Connection interrupted. Your request ID has been retained. Retry the same action.",
      sign_in_required: "Please sign in to continue.",
      verified_account_required: "Confirm your email and sign in again.",
      authentication_unavailable: "Authentication is temporarily unavailable.",
    }[error.message] ??
    "The request could not be completed. Check your details and try again."
  );
}
function showEnroll() {
  showModal(
    "Choose your racing identity.",
    `<form id="enroll-form"><div class="form-field"><label class="label" for="enroll-handle">Public handle</label><input id="enroll-handle" required pattern="[A-Za-z0-9_]{3,20}" minlength="3" maxlength="20" value="${escape(sessionValue("racing.pending-handle") ?? "")}"></div><label class="check-row"><input id="enroll-terms" type="checkbox" required><span>I accept the social-play race terms and understand that GC have no cash value.</span></label><button class="button primary wide">Create my racing profile</button><p class="error-message" id="enroll-message"></p></form>`,
  );
  $("#enroll-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button");
    b.disabled = true;
    try {
      await api("enroll", {
        method: "POST",
        body: { handle: $("#enroll-handle").value, accept_terms: true },
      });
      await sync();
      try {
        sessionStorage.removeItem("racing.pending-handle");
      } catch {}
      modal.close();
      render();
      toast("Profile created. Your 1,000 social-play GC are in your wallet.");
    } catch (error) {
      $("#enroll-message").textContent = humanError(error);
    } finally {
      b.disabled = false;
    }
  };
}
function createOffer(id) {
  if (!state.user) {
    showAuth();
    return;
  }
  const t = track(id),
    connected = state.lobby.tracks.find((x) => x.id === t.id)?.enabled;
  if (!connected) {
    showModal(
      "Connect the race before the coins.",
      `<p>${escape(t.title)} is playable in free practice. Its coin-bearing race provider is not connected, so no funded challenge can be created yet.</p><p class="form-help">A trusted provider must receive the accepted session and send its signed final telemetry. Practice results cannot unlock escrow.</p><button class="button primary wide" id="provider-practice">Practice this circuit ↗</button>`,
    );
    $("#provider-practice").onclick = () => {
      modal.close();
      route("drive/" + t.id);
    };
    return;
  }
  const requestId = crypto.randomUUID();
  showModal(
    "Set the challenge.",
    `<form id="offer-form"><div class="form-field"><label class="label" for="offer-track">Circuit</label><input id="offer-track" value="${escape(t.title)}" disabled></div><div class="form-row"><div class="form-field"><label class="label" for="entry">Entry per racer</label><select id="entry"><option value="5.00">5.00</option><option value="10.00" selected>10.00</option><option value="25.00">25.00</option><option value="50.00">50.00</option></select></div><div class="form-field"><label class="label" for="offer-currency">Currency</label><input id="offer-currency" value="${state.currency}" disabled></div></div><div id="offer-receipt"></div><label class="check-row"><input type="checkbox" required><span>I accept these race terms. Entries lock only when another racer accepts. Offers expire after 15 minutes. The final telemetry window is ${state.lobby.tracks.find((x) => x.id === t.id)?.session_minutes ?? 15} minutes from acceptance.</span></label><button class="button primary wide" ${state.currency === "SC" && !state.user.sc_eligible ? "disabled" : ""}>Post challenge</button><p class="error-message" id="offer-message"></p></form>`,
  );
  const receipt = () => {
    const v = terms($("#entry").value);
    $("#offer-receipt").innerHTML =
      `<div class="receipt"><div><span>Gross escrow pool</span><strong>${v.pool} ${state.currency}</strong></div><div><span>Platform share (10%)</span><strong>${v.rake} ${state.currency}</strong></div><div class="total"><span>Winner receives</span><strong>${v.payout} ${state.currency}</strong></div><div><span>Refund for invalid race</span><strong>Full entry · zero fee</strong></div></div>`;
  };
  receipt();
  $("#entry").onchange = receipt;
  let sentBody;
  $("#offer-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button");
    b.disabled = true;
    sentBody ??= {
      request_id: requestId,
      track_id: t.id,
      token_type: state.currency,
      entry_fee: $("#entry").value,
    };
    try {
      await api("offers", { method: "POST", body: sentBody });
      await sync();
      modal.close();
      route("lobby");
      render();
      toast("Challenge posted. No coins deducted until it is accepted.");
    } catch (error) {
      $("#offer-message").textContent = humanError(error);
      $("#entry").disabled = Boolean(sentBody);
    } finally {
      b.disabled = false;
    }
  };
}
function acceptOffer(id) {
  const o = state.lobby.offers.find((x) => x.id === id);
  if (!o) return;
  const v = terms(o.entry_fee);
  showModal(
    "Review your head-to-head.",
    `<h3>${escape(track(o.track_id).title)} · @${escape(o.handle)}</h3><div class="receipt"><div><span>Your entry</span><strong>${coins(o.entry_fee)} ${o.token_type}</strong></div><div><span>Total escrow</span><strong>${v.pool} ${o.token_type}</strong></div><div><span>Platform share</span><strong>${v.rake} ${o.token_type}</strong></div><div class="total"><span>Winner receives</span><strong>${v.payout} ${o.token_type}</strong></div></div><p class="form-help">Final telemetry is due within ${o.session_minutes} minutes of acceptance. Both entries lock together. An invalid race, exact tie, signed network drop or deadline expiry returns both entries in full. You cannot cancel a funded race.</p><form id="accept-form"><label class="check-row"><input type="checkbox" required><span>I accept the entry, circuit, currency and settlement terms.</span></label><button class="button primary wide">Accept & lock entries</button><p class="error-message" id="accept-message"></p></form>`,
  );
  $("#accept-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button");
    b.disabled = true;
    try {
      await api("accept", {
        method: "POST",
        body: { offer_id: o.id, accept_terms: true },
      });
      await sync();
      modal.close();
      route("races");
      render();
      toast(
        "Both entries are locked. View your provider session in the race receipt.",
      );
    } catch (error) {
      $("#accept-message").textContent = humanError(error);
    } finally {
      b.disabled = false;
    }
  };
}
function showReceipt(id) {
  const r = state.user.races.find((x) => x.id === id);
  if (!r) return;
  showModal(
    "Your race receipt.",
    `<h3>${escape(track(r.track_id)?.title ?? "Provider race")}</h3><div class="receipt">${[
      ["Status", r.status],
      ["Entry", `${coins(r.entry_fee)} ${r.token_type}`],
      ["Gross pool", `${coins(r.total_escrow_pool)} ${r.token_type}`],
      ["Rake charged", `${coins(r.rake_charged)} ${r.token_type}`],
      ["Escrow remaining", `${coins(r.remaining_escrow)} ${r.token_type}`],
      ["Resolution", r.resolution ?? "Awaiting telemetry"],
      ["Deadline", date(r.telemetry_deadline)],
      ["Your session ID", r.session_id],
    ]
      .map(
        ([label, value]) =>
          `<div><span>${label}</span><strong style="overflow-wrap:anywhere;max-width:65%;text-align:right">${escape(value)}</strong></div>`,
      )
      .join(
        "",
      )}</div><p class="form-help">Use this session ID with the connected race provider. Browser practice cannot settle this escrow.</p><button class="button ghost wide" id="copy-receipt">Copy receipt</button>`,
  );
  $("#copy-receipt").onclick = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
      toast("Receipt copied.");
    } catch {
      toast("Clipboard is unavailable. The receipt is displayed above.");
    }
  };
}
function wire() {
  content
    .querySelectorAll("[data-drive-track]")
    .forEach((b) => (b.onclick = () => route("drive/" + b.dataset.driveTrack)));
  content
    .querySelectorAll("[data-create]")
    .forEach((b) => (b.onclick = () => createOffer(b.dataset.create)));
  content
    .querySelectorAll("[data-auth]")
    .forEach((b) => (b.onclick = () => showAuth()));
  content
    .querySelectorAll("[data-accept]")
    .forEach((b) => (b.onclick = () => acceptOffer(b.dataset.accept)));
  content.querySelectorAll("[data-cancel]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api("cancel", {
            method: "POST",
            body: { offer_id: b.dataset.cancel },
          });
          await sync();
          render();
          toast("Open offer cancelled. No funds were locked.");
        } catch (e) {
          toast(humanError(e));
          b.disabled = false;
        }
      }),
  );
  content
    .querySelectorAll("[data-receipt]")
    .forEach((b) => (b.onclick = () => showReceipt(b.dataset.receipt)));
  $("#track-search")?.addEventListener("input", (e) => {
    state.search = e.target.value;
    const list = state.tracks.filter(
      (t) =>
        (state.filter === "all" || t.difficulty === state.filter) &&
        t.title.toLowerCase().includes(state.search.toLowerCase()),
    );
    $("#track-results").innerHTML = list.length
      ? cards(list)
      : empty("No tracks match your search.", "Try another circuit name.");
    wireCardButtons();
  });
  content.querySelectorAll("[data-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        state.filter = b.dataset.filter;
        render();
      }),
  );
  $("#refresh-lobby")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      if (state.user) await sync();
      render();
      toast(
        state.user
          ? "Challenge list refreshed."
          : "Sign in to see account challenges. Free practice is open.",
      );
    } catch (error) {
      toast(humanError(error));
      e.target.disabled = false;
    }
  });
  $("#daily-claim")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const result = await api("daily", { method: "POST", body: {} });
      await sync();
      render();
      toast(
        result.duplicate
          ? "You already claimed today’s GC."
          : "100 free GC added to your wallet.",
      );
    } catch (error) {
      toast(humanError(error));
      e.target.disabled = false;
    }
  });
  $("#signout")?.addEventListener("click", async () => {
    try {
      await authRequest("logout", {});
    } catch {}
    setSession(null);
    state.user = null;
    state.lobby = { offers: [], tracks: [] };
    render();
    updateHeader();
    toast("Signed out.");
  });
  content.querySelectorAll("[data-pause]").forEach(
    (b) =>
      (b.onclick = () => {
        showModal(
          "Pause new race participation?",
          `<p>Pause new coin-bearing races for ${b.dataset.pause} hour(s). This cannot be shortened. Existing funded races still settle or refund.</p><button class="button primary wide" id="confirm-pause">Confirm participation pause</button><p class="error-message" id="pause-message"></p>`,
        );
        $("#confirm-pause").onclick = async (e) => {
          e.target.disabled = true;
          try {
            await api("pause", {
              method: "POST",
              body: { hours: Number(b.dataset.pause) },
            });
            await sync();
            modal.close();
            render();
            toast("Participation pause is active.");
          } catch (error) {
            $("#pause-message").textContent = humanError(error);
            e.target.disabled = false;
          }
        };
      }),
  );
  $("#clear-records")?.addEventListener("click", () => {
    showModal(
      "Clear this browser’s practice history?",
      `<p>This removes saved practice sessions only. Account balances and ledger records are unaffected.</p><button class="button danger wide" id="confirm-clear">Clear practice records</button>`,
    );
    $("#confirm-clear").onclick = () => {
      try {
        localStorage.removeItem("racing.practice.v1");
      } catch {
        toast("Browser storage is unavailable.");
        return;
      }
      modal.close();
      render();
      toast("Practice history cleared.");
    };
  });
}
function wireCardButtons() {
  content
    .querySelectorAll("[data-drive-track]")
    .forEach((b) => (b.onclick = () => route("drive/" + b.dataset.driveTrack)));
  content
    .querySelectorAll("[data-create]")
    .forEach((b) => (b.onclick = () => createOffer(b.dataset.create)));
}
function renderGame(id) {
  const t = track(id);
  $("#page-label").textContent = t.title + " / Practice";
  content.innerHTML =
    head(
      t.title,
      "Free practice · 3 clockwise laps · Clean laps only",
      `<a class="button ghost small" href="#practice">← Tracks</a>`,
    ) +
    `<div class="game-layout"><section class="game-panel"><div class="game-hud"><div><small>LAP</small><div class="hud-value" id="lap-counter">1 / 3</div></div><div><small>LAP TIME</small><div class="hud-value" id="lap-time">0:00.000</div></div><div><small>BEST CLEAN</small><div class="hud-value" id="best-time">—</div></div><div><small>SPEED</small><div class="hud-value" id="speed">0</div></div></div><div class="game-banner" id="game-state" role="status">Ready to drive. Practice never moves wallet coins.</div><canvas class="game-canvas" id="race-canvas" tabindex="0" aria-label="Practice racing circuit. Use arrow keys to drive clockwise."></canvas><div class="game-controls"><div class="touch-steering"><button class="drive-button" data-drive="left" aria-label="Steer left">←</button><button class="drive-button" data-drive="right" aria-label="Steer right">→</button></div><div class="touch-steering"><button class="drive-button" data-drive="brake" aria-label="Brake">▰</button><button class="drive-button throttle" data-drive="throttle" aria-label="Accelerate">THROTTLE</button></div></div><p class="game-note">Arrows / WASD · Hold controls on mobile · Pass every sector clockwise</p></section><aside class="game-sidebar"><section class="panel"><span class="pill">TIME ATTACK</span><h3 style="margin-top:18px">Find a clean line.</h3><p>Cross a track edge and that lap is invalid. Complete three laps to save this session.</p><p class="clean-indicator" id="clean-lap">CLEAN LAP</p><div class="game-actions"><button class="button primary small" id="play-game">Drive ▶</button><button class="button ghost small" id="pause-game">Pause</button><button class="button ghost small" id="reset-game">Restart ↻</button></div></section><section class="panel"><h3>Session laps</h3><div id="session-laps"><p>No completed laps yet.</p></div><a class="text-link" href="#records">Your personal bests ↗</a></section></aside></div>`;
  let lastLapCount = 0;
  state.game = startPractice({
    track: t,
    canvas: $("#race-canvas"),
    onUpdate: (s, running) => {
      $("#lap-counter").textContent = Math.min(s.laps.length + 1, 3) + " / 3";
      $("#lap-time").textContent = formatTime(s.time - s.lapStart);
      $("#speed").textContent = Math.round(s.speed * 0.7) + " km/h";
      $("#best-time").textContent = formatTime(bestCleanLap(s.laps));
      $("#clean-lap").textContent = s.dirty
        ? "OFF TRACK · LAP INVALID"
        : "CLEAN LAP";
      $("#clean-lap").classList.toggle("dirty", s.dirty);
      $("#play-game").disabled = s.complete;
      $("#play-game").textContent = s.time ? "Resume ▶" : "Drive ▶";
      if (s.laps.length !== lastLapCount) {
        lastLapCount = s.laps.length;
        $("#session-laps").innerHTML = s.laps
          .map(
            (l, i) =>
              `<div class="lap-item ${l.is_clean ? "" : "dirty"}"><span>Lap ${i + 1} ${l.is_clean ? "✓" : "×"}</span><strong>${formatTime(l.seconds)}</strong></div>`,
          )
          .join("");
      }
    },
    onComplete: (r) => {
      saveRecord(r);
      $("#game-state").textContent =
        r.best === null
          ? "Session complete. No clean laps. Try a smoother line."
          : "Session complete · Best clean lap " + formatTime(r.best);
      $("#game-state").classList.toggle("bad", r.best === null);
      toast(
        r.best === null
          ? "Session saved. All laps were invalid."
          : "Clean session saved to your personal practice records.",
      );
    },
  });
  $("#play-game").onclick = () => {
    state.game.play();
    $("#race-canvas").focus();
    $("#game-state").textContent =
      "Session in progress. Stay inside both track edges.";
  };
  $("#pause-game").onclick = () => {
    state.game.pause();
    $("#game-state").textContent =
      "Practice paused. Resume whenever you’re ready.";
  };
  $("#reset-game").onclick = () => {
    state.game.reset();
    lastLapCount = 0;
    $("#session-laps").innerHTML = "<p>No completed laps yet.</p>";
    $("#game-state").textContent = "New session ready. Tap Drive to start.";
    $("#game-state").classList.remove("bad");
  };
}
window.addEventListener("hashchange", () => {
  if (modal.open) modal.close();
  render();
  window.scrollTo({ top: 0 });
});
document.querySelectorAll("[data-currency]").forEach(
  (b) =>
    (b.onclick = () => {
      state.currency = b.dataset.currency;
      updateHeader();
      if (state.currency === "SC" && !state.user?.sc_eligible)
        toast(
          "SC participation and redemption are not activated. Practice is free.",
        );
      if (!location.hash.startsWith("#drive")) render();
    }),
);
$("#account-button").onclick = () =>
  state.user ? route("settings") : showAuth();
document
  .querySelectorAll("[data-route]")
  .forEach((b) => (b.onclick = () => route(b.dataset.route)));
modal.addEventListener("click", (e) => {
  if (e.target === modal) {
    const r = modal.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      modal.close();
  }
});
const callbackParams = new URLSearchParams(location.hash.slice(1));
const callbackSession = callbackParams.has("access_token")
  ? {
      access_token: callbackParams.get("access_token"),
      refresh_token: callbackParams.get("refresh_token"),
      expires_at:
        Math.floor(Date.now() / 1000) +
        Math.min(
          3600,
          Math.max(60, Number(callbackParams.get("expires_in")) || 3600),
        ),
    }
  : null;
const recoveryCallback = callbackParams.get("type") === "recovery";
if (callbackSession)
  history.replaceState(
    null,
    "",
    location.pathname + location.search + "#lobby",
  );
function showRecovery() {
  showModal(
    "Choose a new password.",
    `<form id="recovery-form"><div class="form-field"><label class="label" for="new-password">New password</label><input id="new-password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></div><button class="button primary wide">Update password</button><p class="error-message" id="recovery-message" role="status"></p></form>`,
  );
  $("#recovery-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector("button");
    button.disabled = true;
    try {
      await authRequest("user", { password: $("#new-password").value }, "PUT");
      modal.close();
      toast("Password updated.");
      if (state.enrollment) showEnroll();
    } catch (error) {
      $("#recovery-message").textContent = humanError(error);
    } finally {
      button.disabled = false;
    }
  };
}
async function init() {
  try {
    const [config, catalog] = await Promise.all([
      fetch("/api/v1/app/config").then((r) => r.json()),
      fetch("/api/v1/app/tracks").then((r) => r.json()),
    ]);
    if (!Array.isArray(catalog.tracks) || !catalog.tracks.length)
      throw new Error("catalog_unavailable");
    state.config = config;
    state.tracks = catalog.tracks;
    if (callbackSession && config.accounts_available)
      setSession(callbackSession);
    await ensureSession();
    if (state.session)
      try {
        await sync();
      } catch {
        toast(
          "Account data is temporarily unavailable. Practice is still open.",
        );
      }
    updateHeader();
    render();
    if (callbackSession && state.session) {
      if (recoveryCallback) showRecovery();
      else if (state.enrollment) showEnroll();
      else toast("Your account is confirmed. Welcome to the grid.");
    }
  } catch {
    content.innerHTML =
      head(
        "The grid is temporarily unavailable.",
        "The track catalog could not load. Check your connection and retry.",
      ) +
      `<button class="button primary" id="retry-app">Retry loading</button>`;
    $("#retry-app").onclick = init;
  }
}
init();
