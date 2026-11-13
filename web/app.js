/* TAWAR arena — replays a negotiation session JSON.
   Data order: ?session=<path> -> data/sessions/index.json (latest) ->
   ../data/sessions/latest.json -> bundled samples.
   Ledger: ../data/ledger.json -> bundled sample ledger.
   Whenever sample data is on screen, the demo ribbon is shown.
   Live runs: when server.py is up (GET /health), the "Run it live" form
   POSTs /run and polls the growing session file until the outcome lands. */
(function () {
  "use strict";

  var MOVE_LABELS = {
    open: "Opening bid", concede: "Concede", hold: "Hold firm",
    bundle: "Bundle", deadline: "Deadline pressure",
    walk_away: "Walk away", accept: "Accept"
  };
  var OUTCOME_TAGS = {
    deal: "Deal", blocked_by_cap: "Blocked by cap",
    no_deal: "No deal", walked_away: "Walked away", halted: "Halted"
  };
  var ENFORCEMENT_TAGS = {
    offer_clamped: "Enforcer · offer clamped",
    deal_refused: "Enforcer · refusal",
    blocked_by_cap: "Enforcer · refusal",
    seller_concession_capped: "Enforcer · seller capped"
  };
  var BASE_DELAY = 2100;
  var LADDER_MIN_FRAC = 0.55; /* ladder zooms to the negotiation range */

  var state = {
    session: null, sessionIsSample: false, ledgerIsSample: false,
    revealed: 0, playing: false, timer: null, speed: 2, currentPrice: null,
    currentActor: null, lastSellerPrice: null, currency: "IDR",
    follow: true, index: null, live: false, livePoll: null, livePath: null
  };

  var el = {};
  ["demoRibbon", "itemName", "versusLine", "langChip", "curChip", "langNote", "provBadge",
   "idCeiling", "idAgentId", "idStatus", "idStatusText", "idCompact", "idDetails",
   "rowExpires", "idExpires", "rowHash", "idHash", "idKill", "killNote",
   "numList", "numTarget", "numCeiling", "numCurrent", "numCurrentWho",
   "numSaving", "numHeadroom", "hsSaved", "hsSavedLabel", "hsDeals",
   "ladder", "ladderDanger", "markTarget", "markCeiling", "markCurrent",
   "currentFlag", "targetVal", "ceilingVal", "ladderMin", "ladderMax",
   "transcript", "integrityBar", "btnVerify", "integrityResult",
   "resultBanner", "ledgerSum", "ledgerRows", "revenueLine", "btnPlay",
   "btnRestart", "btnSkip", "btnEnforcement", "btnHalt", "speedSel",
   "followToggle", "progressLabel", "personaGrid", "sellerSideLabel",
   "liveBadge", "liveFieldset", "liveForm", "liveNote", "liveError", "liveRunBtn",
   "lfItem", "lfList", "lfTarget", "lfCeiling", "lfSeller", "lfLang", "lfCurrency"
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtMoney(n, currency) {
    if (n == null || isNaN(n)) return "—";
    var neg = n < 0;
    var v = String(Math.round(Math.abs(n)));
    var out;
    if (String(currency || "").toUpperCase() === "USD") {
      out = "$" + v.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    } else {
      out = "Rp" + v.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    }
    return neg ? "-" + out : out;
  }
  /* Session-scoped shorthand: formats in the active session's currency. */
  function fmt(n) {
    return fmtMoney(n, state.currency);
  }
  function pct(part, whole) {
    if (!whole) return 0;
    return Math.round((part / whole) * 100);
  }
  function hhmm(iso) {
    if (!iso) return "";
    var m = String(iso).match(/T(\d{2}):(\d{2})/);
    return m ? m[1] + ":" + m[2] : "";
  }
  function fetchJSON(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function updateRibbon() {
    el.demoRibbon.hidden = !(state.sessionIsSample || state.ledgerIsSample);
  }
  function shortHash(h) {
    if (!h) return "";
    var s = String(h);
    return s.length > 14 ? s.slice(0, 10) + "…" + s.slice(-4) : s;
  }
  function shortPubkey(k) {
    if (!k) return "";
    var s = String(k);
    return s.length > 18 ? s.slice(0, 10) + "…" + s.slice(-6) : s;
  }

  /* Tolerate the engine's field aliases when the spec names are absent.
     Additive schema: session.mandate{...}, events may carry "h" hashes,
     plan/replan strategy events, extra enforcement types. */
  function normalizeSession(raw) {
    if (!raw || typeof raw !== "object") return raw;
    var s = Object.assign({}, raw);
    var m = (s.mandate && typeof s.mandate === "object") ? s.mandate : null;
    if (s.id == null && s.session_id != null) s.id = s.session_id;
    if (s.list_price_idr == null) s.list_price_idr = s.list_idr != null ? s.list_idr : (m ? m.list_idr : null);
    if (s.target_idr == null) s.target_idr = s.target_idr != null ? s.target_idr : (m ? m.target_idr : null);
    if (s.ceiling_idr == null) s.ceiling_idr = s.ceiling_idr != null ? s.ceiling_idr : (m ? m.ceiling_idr : null);
    if (s.final_price_idr == null && s.final_idr != null) s.final_price_idr = s.final_idr;
    if (s.created_at == null && s.started_at != null) s.created_at = s.started_at;
    if (!s.item && m && m.item) s.item = m.item;
    if (!s.currency && m && m.currency) s.currency = m.currency;
    if (!s.lang && m && m.lang) s.lang = m.lang;
    s.currency = String(s.currency || "IDR").toUpperCase() === "USD" ? "USD" : "IDR";
    if (!s.seller || typeof s.seller !== "object") {
      var key = s.seller_key || (m && m.seller_key) || "";
      s.seller = {
        name: s.seller_name || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Seller"),
        persona_label: key ? key.charAt(0).toUpperCase() + key.slice(1) : ""
      };
    }
    if (Array.isArray(s.events)) {
      s.events = s.events.map(function (e) {
        var ev = Object.assign({}, e);
        ev._raw = e; /* preserved for hash-chain verification */
        if (ev.t == null && ev.at != null) ev.t = ev.at;
        if (ev.text == null && ev.note != null) ev.text = ev.note;
        if (ev.text == null && ev.message != null) ev.text = ev.message;
        if (ev.text == null && ev.detail != null) ev.text = ev.detail;
        if (ev.text == null && ev.plan != null) ev.text = ev.plan;
        if (ev.price_idr == null && ev.offer_idr != null) ev.price_idr = ev.offer_idr;
        if (ev.price_idr == null && ev.price != null) ev.price_idr = ev.price;
        var t = String(ev.type || "").toLowerCase();
        ev.rawType = t;
        if (t === "buyer_offer") { ev.actor = "buyer"; ev.type = "offer"; }
        else if (t === "seller_reply") { ev.actor = "seller"; ev.type = "offer"; }
        else if (t === "session_start") { ev.actor = "system"; ev.type = "info"; }
        else if (t === "plan" || t === "replan") { ev.actor = "system"; ev.type = t; }
        else if (t === "offer_clamped" || t === "deal_refused" ||
                 t === "blocked_by_cap" || t === "seller_concession_capped") {
          if (!ev.actor) ev.actor = "system"; ev.type = "enforcement";
        }
        else if (/enforc|block|refus|clamp|capped/.test(t)) { if (!ev.actor) ev.actor = "system"; ev.type = "enforcement"; }
        else if (/outcome|session_end|deal_closed|halt/.test(t)) { if (!ev.actor) ev.actor = "system"; ev.type = "outcome"; }
        else if (!ev.actor) { ev.actor = "system"; }
        return ev;
      });
      /* Pull the final numbers + usage off the outcome event when the
         session header does not carry them (engine schema). */
      for (var i = s.events.length - 1; i >= 0; i--) {
        var oe = s.events[i];
        if (oe.type === "outcome") {
          if (s.final_price_idr == null && oe.final_price_idr != null) s.final_price_idr = oe.final_price_idr;
          if (s.saved_idr == null && oe.saved_idr != null) s.saved_idr = oe.saved_idr;
          if (s.total_tokens == null && oe.total_tokens != null) s.total_tokens = oe.total_tokens;
          if (!s.usage && oe.usage) s.usage = oe.usage;
          if (!s.outcome && oe.outcome) s.outcome = oe.outcome;
          /* Engine outcome events are structured, not prose: synthesize
             the row text so the outcome strip is never blank. */
          if (!oe.text) {
            var oc = oe.outcome || s.outcome || "";
            if (oc === "deal") {
              oe.text = "Deal closed" +
                (oe.final_price_idr != null ? " at " + fmtMoney(oe.final_price_idr, s.currency) : "") +
                (oe.saved_idr ? " · saved " + fmtMoney(oe.saved_idr, s.currency) : "") +
                (oe.rounds_used ? " · " + oe.rounds_used + " rounds" : "");
            } else if (oc === "walked_away") {
              oe.text = "Tawar walked away — the gap never closed to a price worth taking.";
            } else if (oc === "blocked_by_cap") {
              oe.text = "The enforcer refused the deal — the price was above the ceiling.";
            } else if (oc === "halted") {
              oe.text = "Session halted by the owner.";
            } else {
              oe.text = "No deal" + (oe.gap_idr != null ? " — final gap " + fmtMoney(oe.gap_idr, s.currency) : "") + ".";
            }
          }
          break;
        }
      }
    }
    return s;
  }

  function isEngineSession(s) {
    if (!s) return false;
    if (s.mandate && typeof s.mandate === "object") return true;
    if (s.buyer_model || s.seller_model) return true;
    if (Array.isArray(s.events) && s.events.some(function (e) { return e.h; })) return true;
    return false;
  }

  /* ---------- ladder ---------- */

  function ladderPos(v) {
    var s = state.session;
    var list = (s && s.list_price_idr) || 0;
    if (!list || v == null) return 0;
    var frac = v / list;
    var p = ((frac - LADDER_MIN_FRAC) / (1 - LADDER_MIN_FRAC)) * 100;
    return Math.max(0, Math.min(100, p));
  }

  /* ---------- session setup ---------- */

  function setSession(session, isSample) {
    stopReplay();
    stopLivePoll();
    state.live = false;
    el.btnHalt.hidden = true;
    state.session = session = normalizeSession(session);
    state.currency = session.currency;
    state.sessionIsSample = !!isSample;
    state.revealed = 0;
    state.currentPrice = session.list_price_idr || null;
    state.currentActor = null;
    state.lastSellerPrice = null;

    el.itemName.textContent = session.item || "Untitled item";
    var sellerName = (session.seller && session.seller.name) || "the seller";
    el.versusLine.textContent = "Tawar (your agent) vs " + sellerName +
      (session.seller && session.seller.persona_label ? " · persona: " + session.seller.persona_label : "");
    el.sellerSideLabel.textContent = sellerName;

    var lang = (session.lang || "en").toLowerCase();
    if (lang === "id") {
      el.langChip.textContent = "ID · Bahasa Indonesia";
      el.langChip.classList.add("id");
      el.langNote.hidden = false;
    } else {
      el.langChip.textContent = "EN · English";
      el.langChip.classList.remove("id");
      el.langNote.hidden = true;
    }

    el.curChip.textContent = state.currency === "USD" ? "USD · $" : "IDR · Rp";

    /* Provenance badge: engine runs (mandate block / chain hashes /
       model fields) vs bundled scripted samples. */
    if (isSample) {
      el.provBadge.hidden = false;
      el.provBadge.textContent = "Scripted sample";
      el.provBadge.classList.add("sample");
    } else if (isEngineSession(session)) {
      el.provBadge.hidden = false;
      el.provBadge.textContent = "Live engine run · " + (session.buyer_model || "serv-pro") +
        " vs " + (session.seller_model || "serv-mini");
      el.provBadge.classList.remove("sample");
    } else {
      el.provBadge.hidden = false;
      el.provBadge.textContent = "Recorded engine session";
      el.provBadge.classList.remove("sample");
    }

    renderIdCard(session);
    el.numList.textContent = fmt(session.list_price_idr);
    el.numTarget.textContent = fmt(session.target_idr);
    el.numCeiling.textContent = fmt(session.ceiling_idr);
    el.targetVal.textContent = fmt(session.target_idr);
    el.ceilingVal.textContent = fmt(session.ceiling_idr);

    var list = session.list_price_idr || 0;
    el.ladderMin.textContent = fmt(Math.round(list * LADDER_MIN_FRAC));
    el.ladderMax.textContent = fmt(list);
    el.markTarget.style.left = ladderPos(session.target_idr || 0) + "%";
    el.markCeiling.style.left = ladderPos(session.ceiling_idr || 0) + "%";
    el.ladderDanger.style.left = ladderPos(session.ceiling_idr || 0) + "%";
    el.ladderDanger.style.right = "0";
    setCurrentPrice(state.currentPrice, null);

    el.transcript.innerHTML = "";
    el.resultBanner.hidden = true;
    el.resultBanner.innerHTML = "";
    el.integrityResult.textContent = "";
    el.integrityResult.classList.remove("bad");
    updateIntegrityBar();
    updateProgress();
    updateRibbon();
    syncIdDetails();

    var key = personaKeyFor(session);
    Array.prototype.forEach.call(el.personaGrid.querySelectorAll(".persona"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-persona") === key);
    });

    startReplay();
  }

  function renderIdCard(session) {
    var m = (session.mandate && typeof session.mandate === "object") ? session.mandate : null;
    el.idCeiling.textContent = fmt(session.ceiling_idr);
    el.idCompact.textContent = "Tawar · ceiling " + fmt(session.ceiling_idr);
    var agentId = (m && m.agent_id) || "tawar.agent";
    var pub = m && m.agent_pubkey ? " · " + shortPubkey(m.agent_pubkey) : "";
    el.idAgentId.textContent = agentId + pub;
    if (m && m.expires_at) {
      el.rowExpires.hidden = false;
      el.idExpires.textContent = String(m.expires_at).replace("T", " ").slice(0, 16);
    } else {
      el.rowExpires.hidden = true;
    }
    if (m && m.hash) {
      el.rowHash.hidden = false;
      el.idHash.textContent = shortHash(m.hash);
    } else {
      el.rowHash.hidden = true;
    }
    /* The "verified" badge is only honest when the session's mandate
       actually carries a signature. */
    if (m && m.signature) {
      el.idStatus.classList.remove("demo");
      el.idStatusText.textContent = "verified";
    } else {
      el.idStatus.classList.add("demo");
      el.idStatusText.textContent = "demo identity";
    }
    el.killNote.textContent = state.live ? "· halt it any time with the button below" : "· active in live sessions";
    el.killNote.classList.toggle("greyed", !state.live);
    el.idKill.childNodes[0].textContent = "Owner can halt the session between any two rounds ";
  }

  function syncIdDetails() {
    if (!el.idDetails) return;
    if (window.innerWidth > 860) el.idDetails.open = true;
  }
  window.addEventListener("resize", syncIdDetails);

  function personaKeyFor(session) {
    var label = ((session.seller && session.seller.persona_label) || "").toLowerCase();
    if (["luluh", "keras", "kepepet"].indexOf(label) >= 0) return label;
    var name = ((session.seller && session.seller.name) || "").toLowerCase();
    if (name.indexOf("luluh") >= 0) return "luluh";
    if (name.indexOf("keras") >= 0) return "keras";
    if (name.indexOf("kepepet") >= 0) return "kepepet";
    return null;
  }

  function setCurrentPrice(v, actor) {
    state.currentPrice = v;
    if (actor) state.currentActor = actor;
    if (actor === "seller" && v != null) state.lastSellerPrice = v;
    el.markCurrent.style.left = ladderPos(v) + "%";
    el.markCurrent.classList.toggle("buyer-side", state.currentActor === "buyer");
    el.markCurrent.classList.toggle("seller-side", state.currentActor === "seller");
    var whoShort = state.currentActor === "buyer" ? "Tawar offers" :
                   state.currentActor === "seller" ? "Seller asks" : "";
    el.currentFlag.innerHTML = (whoShort ? '<span class="pill-who">' + esc(whoShort) + "</span>" : "") +
      esc(v != null ? fmt(v) : "—");
    var p = ladderPos(v);
    el.currentFlag.classList.toggle("zone-left", p < 14);
    el.currentFlag.classList.toggle("zone-right", p > 86);
    el.numCurrent.textContent = v != null ? fmt(v) : "—";
    el.numCurrentWho.textContent = whoShort;
    el.numCurrentWho.className = "mwho" + (state.currentActor ? " " + state.currentActor : "");
    updateMandateLive();
  }

  function updateMandateLive() {
    var s = state.session;
    if (!s) return;
    var sp = state.lastSellerPrice;
    if (sp != null && s.list_price_idr != null && s.list_price_idr - sp > 0) {
      el.numSaving.textContent = fmt(s.list_price_idr - sp);
    } else {
      el.numSaving.textContent = "—";
    }
    if (sp != null && s.ceiling_idr != null) {
      var head = s.ceiling_idr - sp;
      el.numHeadroom.textContent = fmt(head);
      el.numHeadroom.classList.toggle("neg", head < 0);
    } else {
      el.numHeadroom.textContent = "—";
      el.numHeadroom.classList.remove("neg");
    }
  }

  function updateIntegrityBar() {
    var s = state.session;
    var has = !!(s && Array.isArray(s.events) && s.events.some(function (e) { return e.h; }));
    el.integrityBar.hidden = !has;
  }

  /* ---------- transcript rendering ---------- */

  function eventText(ev) {
    return ev.text || ev.message || ev.detail || ev.plan || "";
  }

  function eventNode(ev) {
    var wrap = document.createElement("div");
    if (ev.type === "plan" || ev.type === "replan") {
      wrap.className = "ev system enter";
      wrap.innerHTML = '<div class="strategy-row' + (ev.type === "replan" ? " replan" : "") +
        '"><span class="sys-tag">' + (ev.type === "replan" ? "Re-plan" : "Strategy plan") +
        "</span>" + esc(eventText(ev)) + "</div>";
      return wrap;
    }
    if (ev.actor !== "buyer" && ev.actor !== "seller") {
      wrap.className = "ev system enter";
      var cls = "sys-row", tag = "System";
      if (ev.type === "enforcement") {
        var rawType = String(ev.rawType || "").toLowerCase();
        var refused = rawType === "deal_refused" || rawType === "blocked_by_cap" ||
          /refusal|refused|blocked/i.test(eventText(ev));
        cls += refused ? " enforcement" : " enforcement ok";
        tag = ENFORCEMENT_TAGS[rawType] || (refused ? "Enforcer · refusal" : "Enforcer · check");
      } else if (ev.type === "outcome") {
        cls += " outcome-row"; tag = "Outcome";
      } else {
        tag = "Session";
      }
      wrap.innerHTML = '<div class="' + cls + '"><span class="sys-tag">' + esc(tag) +
        "</span>" + esc(eventText(ev)) + "</div>";
      return wrap;
    }

    var isBuyer = ev.actor === "buyer";
    wrap.className = "ev enter " + (isBuyer ? "buyer" : "seller");
    var s = state.session || {};
    var who = isBuyer ? "Tawar · your agent" : ((s.seller && s.seller.name) || "Seller");
    var html = '<div class="bubble"><span class="who">' + esc(who) + "</span>";
    if (eventText(ev)) html += "<p>" + esc(eventText(ev)) + "</p>";
    var chips = "";
    if (ev.price_idr != null) chips += '<span class="price-chip">' + fmt(ev.price_idr) + "</span>";
    if (ev.move) chips += '<span class="move-chip">' + esc(MOVE_LABELS[ev.move] || ev.move) + "</span>";
    if (isBuyer && ev.price_idr != null && s.ceiling_idr != null && ev.price_idr > s.ceiling_idr) {
      chips += '<span class="over-cap">above ceiling</span>';
    }
    if (isBuyer && ev.requested_offer_idr != null && ev.price_idr != null && ev.requested_offer_idr > ev.price_idr) {
      chips += '<span class="over-cap">model asked ' + fmt(ev.requested_offer_idr) + " · clamped by code</span>";
    }
    if (chips) html += '<div class="chips">' + chips + "</div>";
    html += "</div>";
    if (isBuyer && ev.reasoning) {
      html += '<div class="reasoning"><span class="rlabel">SERV Reasoning</span>' + esc(ev.reasoning) + "</div>";
    }
    if (ev.t) html += '<span class="ev-time">' + esc(hhmm(ev.t)) + "</span>";
    wrap.innerHTML = html;
    return wrap;
  }

  function totalRounds() {
    if (!state.session) return 0;
    return state.session.events.filter(function (e) { return e.actor === "buyer" && e.type === "offer"; }).length;
  }
  function revealedRounds() {
    if (!state.session) return 0;
    return state.session.events.slice(0, state.revealed)
      .filter(function (e) { return e.actor === "buyer" && e.type === "offer"; }).length;
  }
  function updateProgress() {
    el.progressLabel.textContent = "Round " + revealedRounds() + " of " + totalRounds() +
      (state.live ? " · live" : "");
  }

  /* ---------- replay engine (no scroll-jacking) ---------- */

  function nearTranscriptBottom() {
    var r = el.transcript.getBoundingClientRect();
    return r.bottom <= window.innerHeight + 180;
  }
  function maybeScroll(node) {
    if (state.follow && nearTranscriptBottom()) {
      node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function appendEvent(ev, animate) {
    var node = eventNode(ev);
    if (!animate) node.classList.remove("enter");
    el.transcript.appendChild(node);
    if (ev.price_idr != null && ev.type === "offer") setCurrentPrice(ev.price_idr, ev.actor);
    else if (ev.price_idr != null && ev.actor === "seller") setCurrentPrice(ev.price_idr, "seller");
    updateProgress();
    maybeScroll(node);
    return node;
  }

  function revealNext() {
    var s = state.session;
    if (!s || state.revealed >= s.events.length) { finishReplay(); return; }
    var ev = s.events[state.revealed];
    state.revealed += 1;
    appendEvent(ev, true);
    if (state.revealed >= s.events.length) { finishReplay(); return; }
    schedule();
  }
  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(revealNext, BASE_DELAY / state.speed);
  }
  function startReplay() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("instant") === "1") { skipToResult(); return; }
    state.playing = true;
    el.btnPlay.textContent = "Pause";
    clearTimeout(state.timer);
    state.timer = setTimeout(revealNext, 650);
  }
  function stopReplay() {
    state.playing = false;
    clearTimeout(state.timer);
    el.btnPlay.textContent = "Play";
  }
  function finishReplay() {
    state.playing = false;
    clearTimeout(state.timer);
    el.btnPlay.textContent = "Replay";
    showResult(false);
  }
  function skipToResult() {
    var s = state.session;
    if (!s) return;
    stopReplay();
    while (state.revealed < s.events.length) {
      var ev = s.events[state.revealed];
      state.revealed += 1;
      appendEvent(ev, false);
    }
    el.btnPlay.textContent = "Replay";
    showResult(true);
  }

  el.btnPlay.addEventListener("click", function () {
    if (!state.session) return;
    if (state.revealed >= state.session.events.length) {
      setSession(state.session, state.sessionIsSample);
      return;
    }
    if (state.playing) { stopReplay(); }
    else { state.playing = true; el.btnPlay.textContent = "Pause"; schedule(); }
  });
  el.btnRestart.addEventListener("click", function () {
    if (state.session) setSession(state.session, state.sessionIsSample);
  });
  el.btnSkip.addEventListener("click", skipToResult);
  el.speedSel.addEventListener("change", function () {
    state.speed = parseFloat(el.speedSel.value) || 1;
    if (state.playing) schedule();
  });
  state.speed = parseFloat(el.speedSel.value) || 2;
  el.followToggle.addEventListener("change", function () {
    state.follow = !!el.followToggle.checked;
  });
  state.follow = !!el.followToggle.checked;

  /* ---------- result banner ---------- */

  function usageLine(s) {
    var buyer = s.buyer_model || "serv-pro";
    var seller = s.seller_model || "serv-mini";
    var total = s.total_tokens;
    if (total == null && s.usage) {
      total = 0;
      ["buyer", "seller"].forEach(function (k) {
        var u = s.usage[k];
        if (u) total += (u.prompt_tokens || 0) + (u.completion_tokens || 0);
      });
    }
    if (total == null) return "";
    return '<p class="usage-line">Buyer ' + esc(buyer) + " · seller " + esc(seller) +
      " · " + Number(total).toLocaleString("en-US") + " tokens total</p>";
  }

  function showResult(scroll) {
    var s = state.session;
    if (!s || !s.outcome) { el.resultBanner.hidden = true; return; }
    var b = el.resultBanner;
    var html = "";
    if (s.outcome === "deal") {
      b.className = "result deal";
      var saved = s.saved_idr != null ? s.saved_idr : (s.list_price_idr - s.final_price_idr);
      html = '<span class="r-eyebrow">Deal closed, under the ceiling</span>' +
        "<h3>Final price " + fmt(s.final_price_idr) + "</h3>" +
        '<div class="saved-big">Saved ' + fmt(saved) + "</div>" +
        "<p>" + pct(saved, s.list_price_idr) + "% off the list price of " + fmt(s.list_price_idr) +
        ", and " + fmt((s.ceiling_idr || 0) - (s.final_price_idr || 0)) +
        " under your ceiling. The enforcer checked this deal against the mandate before it was allowed to close.</p>" +
        usageLine(s);
    } else if (s.outcome === "blocked_by_cap") {
      b.className = "result blocked";
      var lowest = null;
      s.events.forEach(function (e) {
        if (e.actor === "seller" && e.price_idr != null) lowest = lowest == null ? e.price_idr : Math.min(lowest, e.price_idr);
      });
      html = '<span class="r-eyebrow">Blocked by the cap</span>' +
        "<h3>No deal. That is the point.</h3>" +
        "<p>The seller's lowest offer was " + fmt(lowest) + ", above your ceiling of " + fmt(s.ceiling_idr) +
        ". The agent was willing to accept it, the code refused, and the session closed. " +
        "An agent with a leash cannot talk itself into overspending.</p>" + usageLine(s);
    } else if (s.outcome === "walked_away") {
      b.className = "result none";
      html = '<span class="r-eyebrow">Walked away</span>' +
        "<h3>Tawar left the table.</h3>" +
        "<p>The gap never closed to anything worth taking, so the agent exercised the walk-away move instead of chasing the price upward. Nothing spent, mandate intact.</p>" +
        usageLine(s);
    } else if (s.outcome === "halted") {
      b.className = "result none";
      html = '<span class="r-eyebrow">Halted by the owner</span>' +
        "<h3>The kill switch works.</h3>" +
        "<p>The owner halted this session between rounds and the engine stopped. The agent negotiates, the owner decides when it ends.</p>" +
        usageLine(s);
    } else {
      b.className = "result none";
      var bBest = null, sBest = null;
      s.events.forEach(function (e) {
        if (e.price_idr == null) return;
        if (e.actor === "buyer") bBest = bBest == null ? e.price_idr : Math.max(bBest, e.price_idr);
        if (e.actor === "seller") sBest = sBest == null ? e.price_idr : Math.min(sBest, e.price_idr);
      });
      html = '<span class="r-eyebrow">No deal</span>' +
        "<h3>The rounds ran out.</h3>" +
        "<p>Tawar's best offer was " + fmt(bBest) + ", the seller never came below " + fmt(sBest) +
        ". The gap is reported honestly, no deal was forced, and nothing was spent.</p>" + usageLine(s);
    }
    b.innerHTML = html;
    b.hidden = false;
    if (scroll) b.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ---------- hash-chain verification ---------- */

  function stableStringify(o) {
    if (o === null || typeof o !== "object") return JSON.stringify(o);
    if (Array.isArray(o)) return "[" + o.map(stableStringify).join(",") + "]";
    var keys = Object.keys(o).sort();
    return "{" + keys.map(function (k) {
      return JSON.stringify(k) + ":" + stableStringify(o[k]);
    }).join(",") + "}";
  }
  function sha256Hex(str) {
    if (window.crypto && crypto.subtle) {
      return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (x) {
          return ("0" + x.toString(16)).slice(-2);
        }).join("");
      });
    }
    return Promise.resolve(null);
  }
  function hashMatches(computed, stored) {
    if (!computed || !stored) return false;
    var st = String(stored).toLowerCase().replace(/^0x/, "");
    return computed === st || computed.indexOf(st) === 0 || st.indexOf(computed.slice(0, 16)) === 0;
  }
  el.btnVerify.addEventListener("click", function () {
    var s = state.session;
    if (!s) return;
    var hashed = s.events.filter(function (e) { return e.h; });
    if (!hashed.length) { el.integrityBar.hidden = true; return; }
    el.integrityResult.textContent = "verifying…";
    el.integrityResult.classList.remove("bad");
    /* Try the plausible chain recipes; a full pass under any one of
       them counts as verified. */
    var recipes = [
      function (prev, ev, raw) { return prev + stableStringify(raw); },
      function (prev, ev, raw) { return stableStringify(raw) + prev; },
      function (prev, ev, raw) { return prev + JSON.stringify(raw); }
    ];
    var genesisOptions = ["", "GENESIS", "tawar-genesis"];
    function tryRecipe(ri, gi) {
      if (ri >= recipes.length) {
        if (gi + 1 < genesisOptions.length) return tryRecipe(0, gi + 1);
        return Promise.resolve(false);
      }
      var prev = genesisOptions[gi];
      var chain = Promise.resolve(true);
      hashed.forEach(function (ev) {
        chain = chain.then(function (ok) {
          if (!ok) return false;
          var raw = {};
          /* verify against the raw event as loaded, minus chain fields */
          var src = ev._raw || ev;
          Object.keys(src).forEach(function (k) {
            if (k !== "h" && k !== "hash" && k !== "_raw") raw[k] = src[k];
          });
          return sha256Hex(recipes[ri](prev, ev, raw)).then(function (c) {
            if (hashMatches(c, ev.h)) { prev = String(ev.h); return true; }
            return false;
          });
        });
      });
      return chain.then(function (ok) { return ok ? true : tryRecipe(ri + 1, gi); });
    }
    tryRecipe(0, 0).then(function (ok) {
      if (ok) {
        el.integrityResult.textContent = "Chain verified · " + hashed.length + " events";
        el.integrityResult.classList.remove("bad");
      } else {
        el.integrityResult.textContent = "Chain present · " + hashed.length +
          " hashed events · could not reproduce the chain with the known recipes";
        el.integrityResult.classList.add("bad");
      }
    });
  });

  /* ---------- ledger + hero stats + revenue ---------- */

  function ledgerRowsOf(ledger) {
    if (Array.isArray(ledger)) return ledger;
    if (ledger && Array.isArray(ledger.sessions)) return ledger.sessions;
    return [];
  }
  function rowCurrency(r) {
    return String(r.currency || "IDR").toUpperCase() === "USD" ? "USD" : "IDR";
  }
  function currencyOrder(order) {
    /* USD leads for the international judges, then IDR, then the rest. */
    var rank = { USD: 0, IDR: 1 };
    return order.slice().sort(function (a, b) {
      return (rank[a] != null ? rank[a] : 2) - (rank[b] != null ? rank[b] : 2);
    });
  }
  function dealSavingsByCurrency(rows) {
    var totals = {}, order = [], deals = 0;
    rows.forEach(function (r) {
      if (r.outcome !== "deal") return;
      deals += 1;
      var c = rowCurrency(r);
      if (!(c in totals)) { totals[c] = 0; order.push(c); }
      totals[c] += r.saved_idr || 0;
    });
    return { totals: totals, order: currencyOrder(order), deals: deals };
  }

  function renderHeroStats(rows) {
    var d = dealSavingsByCurrency(rows);
    if (d.order.length) {
      el.hsSaved.textContent = d.order.map(function (c) {
        return c + " " + fmtMoney(d.totals[c], c);
      }).join(" · ");
    } else {
      el.hsSaved.textContent = "—";
    }
    el.hsSavedLabel.textContent = state.ledgerIsSample
      ? "saved in sample runs"
      : "saved in live engine runs";
    el.hsDeals.textContent = d.deals ? String(d.deals) : "—";
  }

  function renderLedger(ledger) {
    var rows = ledgerRowsOf(ledger);
    /* Totals are grouped per currency (never summed across currencies);
       only deal outcomes count as savings. */
    var totals = {}, order = [];
    rows.forEach(function (r) {
      var c = rowCurrency(r);
      if (!(c in totals)) { totals[c] = 0; order.push(c); }
      totals[c] += r.saved_idr || 0;
    });
    el.ledgerSum.textContent = order.length
      ? currencyOrder(order).map(function (c) { return fmtMoney(totals[c], c); }).join(" · ")
      : fmtMoney(0, "IDR");
    var d = dealSavingsByCurrency(rows);
    if (d.order.length) {
      var fees = d.order.map(function (c) {
        return fmtMoney(Math.round(d.totals[c] * 0.10), c);
      }).join(" · ");
      el.revenueLine.innerHTML = "Tawar keeps 10% of verified savings. On this ledger that is <strong>" +
        esc(fees) + "</strong> — the business earns when you do.";
    } else {
      el.revenueLine.textContent = "Tawar keeps 10% of verified savings — the business earns when you do.";
    }
    renderHeroStats(rows);
    if (!rows.length) {
      el.ledgerRows.innerHTML = '<div class="lrow"><span class="litem">No sessions recorded yet.</span></div>';
      return;
    }
    el.ledgerRows.innerHTML = rows.map(function (r) {
      var cur = rowCurrency(r);
      var list = r.list_price_idr != null ? r.list_price_idr : r.list_idr;
      var fin = r.final_price_idr != null ? r.final_price_idr : r.deal_idr;
      var when = r.at || r.closed_at;
      var meta = "List " + fmtMoney(list, cur) +
        (fin != null ? " · Final " + fmtMoney(fin, cur) : " · No deal price") +
        (when ? " · " + esc(String(when).slice(0, 10)) : "") +
        " · simulated outcome";
      var saved = r.saved_idr || 0;
      return '<div class="lrow"><span class="litem">' + esc(r.item || "Item") +
        '<span class="lmeta">' + meta + "</span></span>" +
        '<span class="ltag ' + esc(r.outcome || "") + '">' + esc(OUTCOME_TAGS[r.outcome] || r.outcome || "") + "</span>" +
        '<span class="lsaved' + (saved ? "" : " zero") + '">' + fmtMoney(saved, cur) + "</span></div>";
    }).join("");
  }

  /* ---------- picker (prefers real sessions from index.json) ---------- */

  function sessionPathFor(key) {
    if (state.index && state.index.by_persona && state.index.by_persona[key]) {
      return "../data/sessions/" + state.index.by_persona[key];
    }
    return null;
  }
  function loadPersona(key) {
    var path = sessionPathFor(key);
    var samples = window.TAWAR_SAMPLE_SESSIONS || {};
    if (path) {
      fetchJSON(path).then(function (j) { setSession(j, false); })
        .catch(function () { if (samples[key]) setSession(samples[key], true); });
    } else if (samples[key]) {
      setSession(samples[key], true);
    }
  }
  el.personaGrid.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest(".persona") : null;
    if (!btn) return;
    loadPersona(btn.getAttribute("data-persona"));
  });
  el.btnEnforcement.addEventListener("click", function () {
    if (state.index && state.index.enforcement_demo) {
      fetchJSON("../data/sessions/" + state.index.enforcement_demo)
        .then(function (j) { setSession(j, false); })
        .catch(function () {});
    }
  });

  /* ---------- live-run mode ---------- */

  function stopLivePoll() {
    if (state.livePoll) { clearInterval(state.livePoll); state.livePoll = null; }
  }
  function setLiveUI(on) {
    el.liveFieldset.disabled = !on;
    el.liveBadge.textContent = on ? "live backend connected" : "static hosting · replay only";
    el.liveBadge.classList.toggle("on", on);
    el.liveNote.textContent = on
      ? "The engine runs on this machine and negotiates with SERV Reasoning in real time. The ceiling is enforced by code while you watch."
      : "Live runs need the local engine — clone the repo and start server.py. Replays below are real recorded sessions.";
  }
  function probeLive() {
    fetch("/health", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("no");
      return r.json();
    }).then(function (j) {
      setLiveUI(!!(j && j.live));
    }).catch(function () { setLiveUI(false); });
  }

  el.liveForm.addEventListener("submit", function (e) {
    e.preventDefault();
    el.liveError.hidden = true;
    var payload = {
      item: el.lfItem.value.trim(),
      list: parseInt(el.lfList.value, 10),
      target: parseInt(el.lfTarget.value, 10),
      ceiling: parseInt(el.lfCeiling.value, 10),
      seller: el.lfSeller.value,
      lang: el.lfLang.value,
      currency: el.lfCurrency.value
    };
    if (!payload.list || !payload.target || !payload.ceiling ||
        payload.target < 1 || payload.ceiling < payload.target || payload.list <= payload.ceiling) {
      el.liveError.textContent = "Check the mandate: list price must be above the ceiling, and the ceiling at or above the target.";
      el.liveError.hidden = false;
      return;
    }
    el.liveRunBtn.disabled = true;
    el.liveRunBtn.textContent = "Starting…";
    fetch("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
        throw new Error(j.error || ("HTTP " + r.status));
      });
      return r.json();
    }).then(function (j) {
      var file = j.file || (j.session_id ? j.session_id + ".json" : null);
      if (!file) throw new Error("Engine did not return a session id.");
      startLiveFollow("../data/sessions/" + file);
    }).catch(function (err) {
      el.liveError.textContent = "Could not start the run: " + err.message;
      el.liveError.hidden = false;
      el.liveRunBtn.disabled = false;
      el.liveRunBtn.textContent = "Start negotiation";
    });
  });

  function startLiveFollow(path) {
    stopReplay();
    stopLivePoll();
    state.live = true;
    state.livePath = path;
    el.btnHalt.hidden = false;
    el.resultBanner.hidden = true;
    el.transcript.innerHTML = "";
    el.progressLabel.textContent = "Live · waiting for the engine…";
    el.liveRunBtn.textContent = "Negotiating…";
    var started = false;
    state.livePoll = setInterval(function () {
      fetchJSON(path).then(function (j) {
        var s = normalizeSession(j);
        if (!started) {
          started = true;
          var keepLive = true;
          state.session = s;
          state.currency = s.currency;
          applySessionHeader(s, false);
          state.revealed = 0;
          state.live = keepLive;
        } else {
          state.session = s;
          state.currency = s.currency;
        }
        /* append any events we have not shown yet */
        while (state.revealed < s.events.length) {
          var ev = s.events[state.revealed];
          ev._raw = j.events[state.revealed];
          state.revealed += 1;
          appendEvent(ev, true);
        }
        updateIntegrityBar();
        if (s.outcome) {
          stopLivePoll();
          state.live = false;
          el.btnHalt.hidden = true;
          el.liveRunBtn.disabled = false;
          el.liveRunBtn.textContent = "Start negotiation";
          el.btnPlay.textContent = "Replay";
          renderIdCard(state.session);
          showResult(true);
          loadLedger();
        }
      }).catch(function () { /* session file not written yet */ });
    }, 2000);
  }

  /* Header/mandate/ID-card half of setSession, reused by live mode so a
     live session does not restart a timed replay. */
  function applySessionHeader(session, isSample) {
    state.session = session;
    state.currency = session.currency;
    state.sessionIsSample = !!isSample;
    state.currentPrice = session.list_price_idr || null;
    state.currentActor = null;
    state.lastSellerPrice = null;
    el.itemName.textContent = session.item || "Untitled item";
    var sellerName = (session.seller && session.seller.name) || "the seller";
    el.versusLine.textContent = "Tawar (your agent) vs " + sellerName +
      (session.seller && session.seller.persona_label ? " · persona: " + session.seller.persona_label : "");
    el.sellerSideLabel.textContent = sellerName;
    var lang = (session.lang || "en").toLowerCase();
    el.langChip.textContent = lang === "id" ? "ID · Bahasa Indonesia" : "EN · English";
    el.langChip.classList.toggle("id", lang === "id");
    el.langNote.hidden = lang !== "id";
    el.curChip.textContent = state.currency === "USD" ? "USD · $" : "IDR · Rp";
    if (isEngineSession(session)) {
      el.provBadge.hidden = false;
      el.provBadge.textContent = "Live engine run · " + (session.buyer_model || "serv-pro") +
        " vs " + (session.seller_model || "serv-mini");
      el.provBadge.classList.remove("sample");
    }
    renderIdCard(session);
    el.numList.textContent = fmt(session.list_price_idr);
    el.numTarget.textContent = fmt(session.target_idr);
    el.numCeiling.textContent = fmt(session.ceiling_idr);
    el.targetVal.textContent = fmt(session.target_idr);
    el.ceilingVal.textContent = fmt(session.ceiling_idr);
    var list = session.list_price_idr || 0;
    el.ladderMin.textContent = fmt(Math.round(list * LADDER_MIN_FRAC));
    el.ladderMax.textContent = fmt(list);
    el.markTarget.style.left = ladderPos(session.target_idr || 0) + "%";
    el.markCeiling.style.left = ladderPos(session.ceiling_idr || 0) + "%";
    el.ladderDanger.style.left = ladderPos(session.ceiling_idr || 0) + "%";
    el.ladderDanger.style.right = "0";
    setCurrentPrice(state.currentPrice, null);
    updateRibbon();
    syncIdDetails();
  }

  el.btnHalt.addEventListener("click", function () {
    el.btnHalt.disabled = true;
    fetch("/halt", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function () {
        el.btnHalt.textContent = "Halting…";
        setTimeout(function () {
          el.btnHalt.disabled = false;
          el.btnHalt.textContent = "Halt session";
        }, 4000);
      })
      .catch(function () { el.btnHalt.disabled = false; });
  });

  /* ---------- ledger loading ---------- */

  function loadLedger() {
    fetchJSON("../data/ledger.json").then(function (j) {
      state.ledgerIsSample = false;
      renderLedger(j);
      updateRibbon();
    }).catch(function () {
      state.ledgerIsSample = true;
      renderLedger(window.TAWAR_SAMPLE_LEDGER || { sessions: [] });
      updateRibbon();
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    var params = new URLSearchParams(window.location.search);
    var sessionPath = params.get("session");
    probeLive();
    loadLedger();
    syncIdDetails();

    var indexPromise = fetchJSON("../data/sessions/index.json")
      .then(function (j) { state.index = j; return j; })
      .catch(function () { state.index = null; return null; });

    indexPromise.then(function () {
      if (state.index && state.index.enforcement_demo) el.btnEnforcement.hidden = false;
      if (sessionPath) {
        fetchJSON(sessionPath).then(function (j) { setSession(j, false); })
          .catch(function () { fallbackSession(); });
        return;
      }
      var latestFile = state.index && state.index.latest
        ? "../data/sessions/" + state.index.latest : null;
      var firstTry = latestFile ? fetchJSON(latestFile) : Promise.reject(new Error("no index"));
      firstTry.then(function (j) { setSession(j, false); })
        .catch(function () {
          fetchJSON("../data/sessions/latest.json")
            .then(function (j) { setSession(j, false); })
            .catch(function () { fallbackSession(); });
        });
    });
  }
  function fallbackSession() {
    var samples = window.TAWAR_SAMPLE_SESSIONS || {};
    if (state.index && state.index.by_persona && state.index.by_persona.luluh) {
      fetchJSON("../data/sessions/" + state.index.by_persona.luluh)
        .then(function (j) { setSession(j, false); })
        .catch(function () { setSession(samples.luluh || { item: "No session available", events: [] }, true); });
      return;
    }
    setSession(samples.luluh || { item: "No session available", events: [] }, true);
  }

  boot();
})();
