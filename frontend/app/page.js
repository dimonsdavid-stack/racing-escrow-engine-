"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import ProgramPanel from "./ProgramPanel.js";
import RedemptionPanel from "./RedemptionPanel.js";
import { PUBLISHED_PACKAGES } from "../../src/catalog.js";
const NAV = [
  ["lobby", "Challenge lobby", "grid"],
  ["events", "Race calendar", "flag"],
  ["races", "My challenges", "race"],
  ["wallet", "Wallet & coins", "wallet"],
  ["identity", "Connections", "link"],
];
function Icon({ name, size = 20 }) {
  const paths = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    flag: "M5 21V3m0 1c5-4 9 4 15 0v9c-6 4-10-4-15 0",
    race: "M3 17l3-8h12l3 8 M5 17v3m14-3v3M3 17h18M7 9l2-5h6l2 5M6 13h2m8 0h2",
    wallet: "M3 5h16v15H3z M3 5V3h14v2m-2 7h6v5h-6z",
    link: "M9 15l6-6M7 13l-2 2a4 4 0 005 5l3-3M11 7l3-3a4 4 0 015 5l-2 2",
    arrow: "M5 12h14m-6-6l6 6-6 6",
    search: "M16 16l5 5M18 10a8 8 0 11-16 0 8 8 0 0116 0",
    shield: "M12 2l8 3v6c0 6-8 11-8 11S4 17 4 11V5z M8 11l3 3 5-6",
    clock: "M12 7v5l3 2M22 12a10 10 0 11-20 0 10 10 0 0120 0",
    close: "M6 6l12 12M18 6L6 18",
    menu: "M3 6h18M3 12h18M3 18h18",
    plus: "M12 5v14M5 12h14",
    check: "M4 12l5 5L20 6",
    logout: "M9 4H3v16h6m5-14l6 6-6 6m-7-6h13",
    bolt: "M13 2L4 14h7l-1 8 10-12h-7z",
    info: "M12 11v6m0-10v1M22 12a10 10 0 11-20 0 10 10 0 0120 0",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.grid} />
    </svg>
  );
}
export function coin(value, places = 2) {
  if (value == null) return "—";
  const s = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return "—";
  const [a, b = ""] = s.split(".");
  const fraction = b.slice(0, 6).replace(/0+$/, "").padEnd(places, "0");
  return (
    a.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? "." + fraction : "")
  );
}
function amountPreview(value) {
  if (!/^\d{1,4}(\.\d{1,6})?$/.test(value)) return null;
  const [a, b = ""] = value.split(".");
  const n = BigInt(a) * 1000000n + BigInt(b.padEnd(6, "0"));
  const format = (x) =>
    coin(`${x / 1000000n}.${String(x % 1000000n).padStart(6, "0")}`);
  return {
    pool: format(n * 2n),
    rake: format((n * 2n) / 10n),
    payout: format((n * 18n) / 10n),
  };
}
function date(value) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
const initial = { events: [], offers: [] };
export default function Dashboard() {
  const [section, setSection] = useState("lobby"),
    [config, setConfig] = useState(null),
    [session, setSession] = useState(null),
    [me, setMe] = useState(null),
    [lobby, setLobby] = useState(initial),
    [catalog, setCatalog] = useState(PUBLISHED_PACKAGES),
    [program, setProgram] = useState(null),
    [compliance, setCompliance] = useState(null),
    [audit, setAudit] = useState(null),
    [liveUpdates, setLiveUpdates] = useState(false),
    [search, setSearch] = useState(""),
    [game, setGame] = useState("all"),
    [currency, setCurrency] = useState("GC"),
    [modal, setModal] = useState(null),
    [toast, setToast] = useState(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(null),
    [needsProfile, setNeedsProfile] = useState(false),
    [authEmail, setAuthEmail] = useState("");
  const auth = useRef(null),
    token = useRef(null),
    orderIds = useRef({}),
    freeEntryIds = useRef({}),
    request = useRef(null),
    mounted = useRef(true),
    epoch = useRef(0);
  const [draft, setDraft] = useState({
      event_id: "",
      mode: "driver_duel",
      entry_fee: "10.00",
      selection: "",
    }),
    [acceptSelection, setAcceptSelection] = useState(""),
    [consent, setConsent] = useState(false),
    [handle, setHandle] = useState("");
  const notice = useCallback((text) => setToast(text), []);
  const api = useCallback(async (path, body) => {
    const r = await fetch("/api/v1/app/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token.current ? { Authorization: "Bearer " + token.current } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (!r.ok) {
      const e = new Error(data.error || "request_failed");
      e.status = r.status;
      throw e;
    }
    return data;
  }, []);
  const refresh = useCallback(async () => {
    const generation = ++epoch.current;
    if (!token.current) {
      setLoading(false);
      return;
    }
    try {
      const state = await api("me");
      const [l, c, eligibility, checkpoint] = await Promise.all([
        api("lobby"),
        api("catalog"),
        api("compliance"),
        api("audit"),
      ]);
      if (!mounted.current || generation !== epoch.current) return;
      setMe(state);
      setLobby(l);
      setCatalog(c.packages?.length ? c.packages : PUBLISHED_PACKAGES);
      setCompliance(eligibility);
      setAudit(checkpoint);
      setProgram(eligibility.program ?? null);
      setNeedsProfile(false);
      setError(null);
    } catch (e) {
      if (generation !== epoch.current) return;
      if (e.status === 409) {
        setNeedsProfile(true);
        setModal("profile");
      } else
        setError(
          "Your account data could not be refreshed. Retry to check the latest confirmed balances.",
        );
    } finally {
      if (mounted.current && generation === epoch.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    let subscription;
    const onHash = () => {
      const key = location.hash.slice(1).split("?")[0];
      if (NAV.some((n) => n[0] === key) || ["help", "settings"].includes(key))
        setSection(key);
    };
    onHash();
    addEventListener("hashchange", onHash);
    Promise.all([
      fetch("/api/v1/app/config").then((r) => {
        if (!r.ok) throw new Error("configuration_unavailable");
        return r.json();
      }),
      fetch("/api/v1/app/program")
        .then((r) => (r.ok ? r.json() : { program: null }))
        .catch(() => ({ program: null })),
    ])
      .then(async ([c, p]) => {
        if (!mounted.current) return;
        setConfig(c);
        setProgram(p.program);
        if (!c.accounts_available) {
          setLoading(false);
          return;
        }
        const client = createClient(c.supabase_url, c.publishable_key, {
          auth: {
            flowType: "pkce",
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        });
        auth.current = client;
        const { data } = await client.auth.getSession();
        if (!mounted.current) return;
        token.current = data.session?.access_token ?? null;
        setSession(data.session);
        if (!data.session) setLoading(false);
        subscription = client.auth.onAuthStateChange((_event, s) => {
          token.current = s?.access_token ?? null;
          setSession(s);
          if (!s) {
            epoch.current++;
            setMe(null);
            setLobby(initial);
            setCatalog(PUBLISHED_PACKAGES);
            setCompliance(null);
            setAudit(null);
            freeEntryIds.current = {};
          }
        }).data.subscription;
      })
      .catch(() => {
        if (mounted.current) {
          setError("Account services could not be reached.");
          setLoading(false);
        }
      });
    return () => {
      mounted.current = false;
      subscription?.unsubscribe();
      removeEventListener("hashchange", onHash);
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    refresh();
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible") refresh();
      },
      liveUpdates ? 90000 : 30000,
    );
    return () => clearInterval(timer);
  }, [session, refresh, liveUpdates]);
  useEffect(() => {
    if (!session || !config?.realtime_available || !auth.current) return;
    let cancelled = false,
      channel,
      timer;
    const client = auth.current,
      userId = session.user.id;
    async function updateWallet() {
      if (document.visibilityState !== "visible" || cancelled) return;
      try {
        const [state, checkpoint] = await Promise.all([
          api("me"),
          api("audit"),
        ]);
        if (!cancelled && mounted.current && auth.current === client) {
          setMe(state);
          setAudit(checkpoint);
        }
      } catch {
        if (!cancelled) setLiveUpdates(false);
      }
    }
    client.realtime
      .setAuth(token.current)
      .then(() => {
        if (cancelled) return;
        channel = client
          .channel(`gridstake-wallet:${config.tenant_id}:${userId}`, {
            config: { private: true },
          })
          .on("broadcast", { event: "wallet_changed" }, () => {
            clearTimeout(timer);
            timer = setTimeout(updateWallet, 500);
          })
          .subscribe((status) => {
            if (!cancelled) setLiveUpdates(status === "SUBSCRIBED");
          });
      })
      .catch(() => {
        if (!cancelled) setLiveUpdates(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setLiveUpdates(false);
      if (channel) client.removeChannel(channel);
    };
  }, [session, config, api]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement;
    const dialog = document.querySelector("[role=dialog]");
    const focusables = () => [
      ...dialog.querySelectorAll(
        "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]",
      ),
    ];
    focusables()[0]?.focus();
    const listener = (e) => {
      if (e.key === "Escape" && !busy) setModal(null);
      if (e.key === "Tab") {
        const nodes = focusables(),
          first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    addEventListener("keydown", listener);
    document.body.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", listener);
      document.body.style.overflow = "";
      previous?.focus();
    };
  }, [modal, busy]);
  async function act(fn) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notice(
        e.status === 429
          ? "Too many requests. Wait a minute before retrying the same request."
          : e.status === 503
            ? "The action was not confirmed. Retry the same request; funds stay protected in escrow."
            : e.status === 403
              ? "This action requires an eligible account and an open event."
              : e.status === 409
                ? "The account or challenge state changed. Refresh and check the confirmed status."
                : "The request could not be confirmed. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function requireAccount() {
    if (!session) {
      setModal("signin");
      return false;
    }
    if (needsProfile || !me) {
      setModal("profile");
      return false;
    }
    return true;
  }
  function openCreate(event) {
    if (!requireAccount()) return;
    request.current = crypto.randomUUID();
    setDraft({
      event_id: event?.id ?? lobby.events[0]?.id ?? "",
      mode: "driver_duel",
      entry_fee: "10.00",
      selection: "",
    });
    setConsent(false);
    setModal("create");
  }
  function changeDraft(k, v) {
    request.current = crypto.randomUUID();
    setDraft((d) => ({ ...d, [k]: v }));
  }
  async function connect(provider) {
    if (!requireAccount()) return;
    await act(async () => {
      if (provider === "discord") {
        await api("identity/discord", {});
        notice("Discord identity verified.");
        await refresh();
      } else {
        const r = await api("identity/" + provider, {});
        const u = new URL(r.url),
          allowed =
            provider === "iracing" ? "oauth.iracing.com" : "steamcommunity.com";
        if (u.protocol !== "https:" || u.hostname !== allowed)
          throw new Error("invalid_provider_redirect");
        location.assign(u.href);
      }
    });
  }
  const event = draft.event_id
      ? lobby.events.find((e) => e.id === draft.event_id)
      : null,
    preview = amountPreview(draft.entry_fee);
  const available = lobby.events.filter(
    (e) =>
      (game === "all" || e.game === game) &&
      `${e.title} ${e.track_name}`.toLowerCase().includes(search.toLowerCase()),
  );
  const offers = lobby.offers.filter(
    (o) =>
      (game === "all" || o.game === game) &&
      o.token_type === currency &&
      `${o.title} ${o.track_name} ${o.handle}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  function empty(title, description, button) {
    return (
      <div className="empty">
        <div className="empty-icon">
          <Icon name="flag" size={30} />
        </div>
        <h3>{title}</h3>
        <p>{description}</p>
        {button}
      </div>
    );
  }
  const signedIn = Boolean(session && me);
  return (
    <div className="shell min-h-screen selection:bg-lime-300 selection:text-neutral-950">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <aside className="sidebar">
        <a className="brand" href="#lobby">
          <span className="brand-mark">≋</span>GRID<span>STAKE</span>
          <small>SIM RACING · P2P</small>
        </a>
        <div className="side-label">YOUR PADDOCK</div>
        <nav aria-label="Main navigation">
          {NAV.map(([id, label, icon]) => (
            <a
              key={id}
              href={"#" + id}
              className={section === id ? "nav-link active" : "nav-link"}
              aria-current={section === id ? "page" : undefined}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {id === "races" &&
                me?.contracts?.some((c) => c.status === "Active") && (
                  <b className="nav-dot" />
                )}
            </a>
          ))}
        </nav>
        <div className="sidebar-card">
          <Icon name="shield" />
          <strong>
            Clear stakes.
            <br />
            Verified outcomes.
          </strong>
          <p>Fixed terms, separate wallets, and an auditable escrow ledger.</p>
          <button className="text-button" onClick={() => setModal("rules")}>
            How challenges work <Icon name="arrow" size={15} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <a href="#help">
            <Icon name="info" /> Help & race rules
          </a>
          <a href="#settings">
            <Icon name="clock" /> Play controls
          </a>
          <div className="side-account">
            <span className="avatar">
              {(me?.handle ?? "G").slice(0, 2).toUpperCase()}
            </span>
            <div>
              <strong>{me?.handle ?? "Guest paddock"}</strong>
              <small>
                {signedIn ? "Verified account" : "Connect to enter challenges"}
              </small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <a href="#lobby" className="mobile-brand">
            <span className="brand-mark">≋</span>GRIDSTAKE
          </a>
          <div className="search-box">
            <Icon name="search" />
            <input
              aria-label="Search races and drivers"
              placeholder="Search races, tracks, players…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <kbd>⌕</kbd>
          </div>
          <div className="top-actions">
            <button
              className="balance"
              onClick={() => {
                location.hash = "wallet";
              }}
              aria-label="Open Gold Coin wallet"
            >
              <span className="coin gc">G</span>
              <span>
                <small>GOLD COINS</small>
                <b>{coin(me?.gc_balance, 0)}</b>
              </span>
            </button>
            <button
              className="balance sc-balance"
              onClick={() => {
                location.hash = "wallet";
              }}
              aria-label="Open Sweeps Coin wallet"
            >
              <span className="coin sc">S</span>
              <span>
                <small>SWEEPS COINS</small>
                <b>{coin(me?.sc_balance)}</b>
              </span>
            </button>
            <button
              className="account-button"
              onClick={() =>
                signedIn ? setModal("account") : setModal("signin")
              }
            >
              {signedIn ? (
                <span className="avatar small">
                  {me.handle.slice(0, 2).toUpperCase()}
                </span>
              ) : (
                <>
                  Sign in <Icon name="arrow" size={16} />
                </>
              )}
            </button>
          </div>
        </header>
        <main id="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">THE NEXT CHAPTER OF SIM RACING</div>
              <h1>
                {section === "lobby"
                  ? "Your race. Your rival."
                  : section === "events"
                    ? "Find your next grid."
                    : section === "races"
                      ? "Every challenge, accounted for."
                      : section === "wallet"
                        ? "Two coins. Clear balances."
                        : section === "identity"
                          ? "Connect your paddock."
                          : section === "settings"
                            ? "You set the pace."
                            : "Clean laps. Clear rules."}
              </h1>
              <p>
                {section === "lobby"
                  ? "A player-versus-player layer for the simulators you already race."
                  : section === "events"
                    ? "Scheduled external races with fixed challenge rules."
                    : section === "wallet"
                      ? "Track available coins, locked entries, and every ledger receipt."
                      : section === "identity"
                        ? "Prove ownership of your simulator and community identities."
                        : "Your race activity and account controls in one place."}
              </p>
            </div>
            <button
              className="primary create-main"
              onClick={() => openCreate()}
            >
              <Icon name="plus" size={18} /> Create challenge
            </button>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
              <button onClick={refresh}>Retry</button>
            </div>
          )}
          {config && !config.accounts_available && (
            <div className="activation-banner">
              <Icon name="info" />
              <div>
                <strong>Account activation is pending</strong>
                <span>
                  The dashboard is online. Connected accounts, live events, and
                  coin purchases will become available after operator setup.
                </span>
              </div>
              <button onClick={() => setModal("status")}>
                View status <Icon name="arrow" size={16} />
              </button>
            </div>
          )}
          {section === "lobby" && (
            <>
              <section className="hero">
                <div className="hero-copy">
                  <span className="pill">
                    <span className="dot" /> BUILT FOR EXTERNAL SIM RACES
                  </span>
                  <h2>
                    Make the next
                    <br />
                    lap <em>mean more.</em>
                  </h2>
                  <p>
                    Challenge another player. Agree on the stakes.
                    <br />
                    Let verified race results decide the outcome.
                  </p>
                  <div className="hero-actions">
                    <button className="primary" onClick={() => openCreate()}>
                      Find your rival <Icon name="arrow" size={18} />
                    </button>
                    <button
                      className="hero-link"
                      onClick={() => setModal("rules")}
                    >
                      How it works <span>↗</span>
                    </button>
                  </div>
                  <div className="sim-labels">
                    <span>iRacing</span>
                    <i />{" "}
                    <span>
                      ASSETTO CORSA
                      <br />
                      <small>COMPETIZIONE</small>
                    </span>
                    <span className="integration-caption">
                      External simulator integrations
                    </span>
                  </div>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="track-ring one" />
                  <div className="track-ring two" />
                  <div className="track-ring three" />
                  <div className="hero-number">
                    01<span>VS</span>01
                  </div>
                  <div className="hero-art-label">PLAYER / PLAYER</div>
                  <div className="chevron c1" />
                  <div className="chevron c2" />
                </div>
              </section>
              <div className="benefit-row">
                <div>
                  <span className="benefit-icon">
                    <Icon name="link" />
                  </span>
                  <span>
                    <strong>Race in your simulator</strong>
                    <small>iRacing & ACC result connections</small>
                  </span>
                </div>
                <div>
                  <span className="benefit-icon">
                    <Icon name="shield" />
                  </span>
                  <span>
                    <strong>Entries held in escrow</strong>
                    <small>Both players accept before funding</small>
                  </span>
                </div>
                <div>
                  <span className="benefit-icon">
                    <Icon name="check" />
                  </span>
                  <span>
                    <strong>Transparent settlement</strong>
                    <small>10% fee on wins · full refunds otherwise</small>
                  </span>
                </div>
              </div>
              <div className="content-grid">
                <section className="panel lobby-panel">
                  <div className="panel-head">
                    <div>
                      <span className="eyebrow">PICK YOUR MATCHUP</span>
                      <h2>Challenge lobby</h2>
                    </div>
                    <div
                      className="currency-switch"
                      aria-label="Lobby currency"
                    >
                      {["GC", "SC"].map((c) => (
                        <button
                          key={c}
                          className={currency === c ? "selected" : ""}
                          onClick={() => setCurrency(c)}
                        >
                          {c === "GC" ? "Gold Coins" : "Sweeps Coins"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="filter-row">
                    <div className="tabs">
                      {[
                        ["all", "All simulators"],
                        ["iracing", "iRacing"],
                        ["acc", "ACC"],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          className={game === id ? "selected" : ""}
                          onClick={() => setGame(id)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <span className="result-count">
                      {offers.length} open{" "}
                      {offers.length === 1 ? "challenge" : "challenges"}
                    </span>
                  </div>
                  {loading ? (
                    empty(
                      "Loading your paddock…",
                      "Retrieving confirmed account and race records.",
                    )
                  ) : offers.length ? (
                    <div className="offers">
                      {offers.map((o) => (
                        <article className="offer-card" key={o.id}>
                          <div className="offer-top">
                            <span className={"game-tag " + o.game}>
                              {o.game === "iracing" ? "iRACING" : "ACC"}
                            </span>
                            <span className="pill subtle">
                              {o.rule === "fastest_clean_lap"
                                ? "Fastest clean lap"
                                : "Finish position"}
                            </span>
                          </div>
                          <h3>{o.track_name}</h3>
                          <p className="event-subtitle">{o.title}</p>
                          <div className="rival">
                            <span className="avatar small">
                              {o.handle.slice(0, 2).toUpperCase()}
                            </span>
                            <span>
                              {o.handle}
                              <small>
                                {o.mode === "driver_duel"
                                  ? "Driver duel"
                                  : "Event matchup"}
                              </small>
                            </span>
                            <span className="vs">VS YOU</span>
                          </div>
                          <div className="offer-money">
                            <div>
                              <small>YOUR ENTRY</small>
                              <b>
                                {coin(o.entry_fee)} <span>{o.token_type}</span>
                              </b>
                            </div>
                            <div>
                              <small>WINNER RECEIVES</small>
                              <b className="lime">
                                {amountPreview(o.entry_fee)?.payout}{" "}
                                <span>{o.token_type}</span>
                              </b>
                            </div>
                          </div>
                          <button
                            className={o.mine ? "secondary" : "primary"}
                            disabled={busy}
                            onClick={() =>
                              o.mine
                                ? act(async () => {
                                    await api("cancel", { offer_id: o.id });
                                    await refresh();
                                    notice("Unfunded challenge cancelled.");
                                  })
                                : (setAcceptSelection(""),
                                  setConsent(false),
                                  setModal({ type: "accept", offer: o }))
                            }
                          >
                            {o.mine ? "Cancel invitation" : "Review & accept"}
                            <Icon name="arrow" size={16} />
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : (
                    empty(
                      session
                        ? "No open challenges in this view"
                        : "Your next rival starts here",
                      session
                        ? "Create a challenge for a registered upcoming event, or try another filter."
                        : "Sign in to see eligible race challenges and connect your simulator account.",
                      <button
                        className="secondary"
                        onClick={() =>
                          session ? openCreate() : setModal("signin")
                        }
                      >
                        {session
                          ? "Create a challenge"
                          : "Connect your account"}
                        <Icon name="arrow" size={16} />
                      </button>,
                    )
                  )}
                </section>
                <aside className="right-column">
                  <section className="panel start-panel">
                    <span className="eyebrow">YOUR STARTING GRID</span>
                    <h2>Three steps to the green.</h2>
                    {[
                      [
                        "01",
                        "Connect your identity",
                        "Sign in and verify your simulator account.",
                      ],
                      [
                        "02",
                        "Agree on a matchup",
                        "Choose an event, entry, and opponent.",
                      ],
                      [
                        "03",
                        "Race. Verify. Settle.",
                        "Results come from the external simulator.",
                      ],
                    ].map(([n, t, d]) => (
                      <div className="step" key={n}>
                        <b>{n}</b>
                        <div>
                          <strong>{t}</strong>
                          <p>{d}</p>
                        </div>
                      </div>
                    ))}
                    <button
                      className="secondary"
                      onClick={() => {
                        location.hash = "identity";
                      }}
                    >
                      Manage connections <Icon name="arrow" size={16} />
                    </button>
                  </section>
                  <section className="wallet-callout">
                    <span className="coin gc">G</span>
                    <span className="eyebrow">SOCIAL PLAY</span>
                    <h3>Start with Gold Coins.</h3>
                    <p>
                      GC are virtual utility coins. They have no cash value and
                      cannot be redeemed.
                    </p>
                    <button
                      className="text-button"
                      onClick={() => {
                        location.hash = "wallet";
                      }}
                    >
                      Explore your wallet <Icon name="arrow" size={16} />
                    </button>
                  </section>
                </aside>
              </div>
            </>
          )}
          {section === "events" && (
            <section className="panel">
              <div className="panel-head">
                <h2>Scheduled race events</h2>
                <div className="tabs">
                  {["all", "iracing", "acc"].map((g) => (
                    <button
                      key={g}
                      className={game === g ? "selected" : ""}
                      onClick={() => setGame(g)}
                    >
                      {g === "all"
                        ? "All"
                        : g === "iracing"
                          ? "iRacing"
                          : "ACC"}
                    </button>
                  ))}
                </div>
              </div>
              {available.length ? (
                <div className="event-grid">
                  {available.map((e) => (
                    <article className="event-card" key={e.id}>
                      <div className={"event-art " + e.game}>
                        <span>{e.game === "iracing" ? "iRACING" : "ACC"}</span>
                        <Icon name="flag" size={60} />
                      </div>
                      <div className="event-body">
                        <span className="eyebrow">
                          {e.rule === "fastest_clean_lap"
                            ? "CLEAN LAP DUEL"
                            : "EVENT MATCHUP"}
                        </span>
                        <h3>{e.title}</h3>
                        <p>{e.track_name}</p>
                        <div className="event-meta">
                          <Icon name="clock" size={16} />
                          {date(e.starts_at)}
                        </div>
                        <small>
                          Entries close {date(e.funding_closes_at)} ·{" "}
                          {e.entrants.length} registered drivers
                        </small>
                        <button
                          className="primary"
                          disabled={
                            Date.parse(e.funding_closes_at) <= Date.now()
                          }
                          onClick={() => openCreate(e)}
                        >
                          Create matchup <Icon name="arrow" size={16} />
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            navigator.clipboard
                              ?.writeText(e.id)
                              .then(() =>
                                notice("Event ID copied for Discord."),
                              )
                              .catch(() => notice("Event ID: " + e.id));
                          }}
                        >
                          Copy event ID
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                empty(
                  "No registered upcoming events",
                  "A verified league or telemetry provider must register the schedule before entries can open.",
                  <button
                    className="secondary"
                    onClick={() => setModal("rules")}
                  >
                    View event requirements
                  </button>,
                )
              )}
            </section>
          )}
          {section === "races" && (
            <section className="panel">
              <div className="panel-head">
                <h2>My challenges</h2>
                <button className="text-button" onClick={refresh}>
                  Refresh confirmed status ↻
                </button>
              </div>
              {me?.contracts?.length ? (
                <div className="race-list">
                  {me.contracts.map((c) => (
                    <article className="race-row" key={c.id}>
                      <div>
                        <span className="game-tag">
                          {c.game === "iracing" ? "iRACING" : "ACC"}
                        </span>
                        <h3>{c.title}</h3>
                        <p>
                          {c.track_name} ·{" "}
                          {c.rule === "fastest_clean_lap"
                            ? "Fastest clean lap"
                            : "Finish position"}
                        </p>
                        <small className="mono">{c.id}</small>
                      </div>
                      <div>
                        <span
                          className={
                            "status-pill " +
                            (c.status === "Active" ? "pending" : "")
                          }
                        >
                          {c.status === "Settled" && c.resolution !== "winner"
                            ? "Refunded"
                            : c.status}
                        </span>
                        <p>
                          {coin(c.entry_fee)} {c.token_type} entry
                        </p>
                        <small>Deadline {date(c.telemetry_deadline)}</small>
                      </div>
                      <div className="race-buttons">
                        <button
                          className="secondary"
                          onClick={() => setModal({ type: "result", race: c })}
                        >
                          View evidence
                        </button>
                        {c.status === "Active" && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              act(async () => {
                                await api("request-result", {
                                  challenge_id: c.id,
                                });
                                notice(
                                  "Provider validation requested. Entries remain in escrow until a verified result or full refund.",
                                );
                              })
                            }
                          >
                            Request validation ↗
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                empty(
                  "Your challenge history is clear",
                  "Accepted challenges, results, refunds, and provider evidence will appear here.",
                  <button
                    className="secondary"
                    onClick={() => {
                      location.hash = "lobby";
                    }}
                  >
                    Browse lobby
                  </button>,
                )
              )}
            </section>
          )}
          {section === "wallet" && (
            <>
              <div className="wallet-grid">
                <section className="wallet-card gold">
                  <span className="coin gc">G</span>
                  <span className="eyebrow">GOLD COINS · SOCIAL PLAY</span>
                  <h2>
                    {coin(me?.gc_balance, 0)} <small>GC</small>
                  </h2>
                  <p>
                    Available balance · {coin(me?.gc_locked_entry, 0)} GC held
                    in entries
                  </p>
                  <button
                    className="secondary"
                    disabled={!signedIn || busy}
                    onClick={() =>
                      act(async () => {
                        await api("daily", {});
                        await refresh();
                        notice(
                          "Daily GC grant confirmed. Each account can claim once per UTC day.",
                        );
                      })
                    }
                  >
                    Claim daily Gold Coins <Icon name="plus" size={16} />
                  </button>
                  <small>Virtual utility coins. No cash value.</small>
                </section>
                <section className="wallet-card sweeps">
                  <span className="coin sc">S</span>
                  <span className="eyebrow">SWEEPS COINS · PROMOTIONAL</span>
                  <h2>
                    {coin(me?.sc_balance)} <small>SC</small>
                  </h2>
                  <p>
                    Available balance · {coin(me?.sc_locked_entry)} SC held in
                    entries
                  </p>
                  <button
                    className="secondary"
                    onClick={() => setModal("redemption")}
                  >
                    View eligibility & redemption{" "}
                    <Icon name="arrow" size={16} />
                  </button>
                  <small>
                    {me?.sc_eligible
                      ? "Account eligible for SC challenges"
                      : "SC participation requires program and account approval."}
                  </small>
                </section>
              </div>
              <section className="panel shop">
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">GOLD COIN SHOP</span>
                    <h2>Choose your next session.</h2>
                  </div>
                  <span className="pill subtle">
                    <Icon name="shield" size={15} /> Hosted secure checkout
                  </span>
                </div>
                <p className="muted">
                  Purchases become available only when the operator’s approved
                  payment program is active. GC and SC remain separate balances.
                </p>
                <div className="mb-5 rounded-xl border border-lime-300/30 bg-lime-300/5 p-4 text-sm text-neutral-100">
                  <strong>No purchase necessary.</strong> Free promotional entry
                  is independent of checkout. Purchases do not improve a race
                  result.{" "}
                  <a className="text-button" href="#help">
                    View program rules & free entry ↗
                  </a>
                </div>
                {catalog.length ? (
                  <div className="pack-grid">
                    {catalog.map((p, i) => (
                      <article className="pack" key={p.id}>
                        <span className="pack-label">
                          {["BRONZE", "SILVER", "GOLD"][i] ?? "COIN PACK"}
                        </span>
                        <span className="coin gc">G</span>
                        <h3>
                          {coin(p.gc, 0)} <small>GC</small>
                        </h3>
                        {p.sc !== "0.000000" && (
                          <p>
                            + {coin(p.sc)} promotional SC · eligibility applies
                          </p>
                        )}
                        <div className="pack-price">
                          {new Intl.NumberFormat(undefined, {
                            style: "currency",
                            currency: "USD",
                          }).format(p.amount_cents / 100)}
                        </div>
                        <button
                          className="primary"
                          disabled={
                            !config?.commerce_available ||
                            p.available === false ||
                            busy
                          }
                          onClick={() =>
                            act(async () => {
                              if (!requireAccount()) return;
                              orderIds.current[p.id] ??= crypto.randomUUID();
                              const d = await api("checkout", {
                                order_id: orderIds.current[p.id],
                                package_id: p.id,
                              });
                              const url = new URL(d.url);
                              if (
                                url.hostname !== "checkout.stripe.com" ||
                                url.protocol !== "https:"
                              )
                                throw new Error("invalid_checkout");
                              location.assign(url.href);
                            })
                          }
                        >
                          {p.available === false
                            ? "Not activated"
                            : "Buy Gold Coins"}{" "}
                          <Icon name="arrow" size={16} />
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  empty(
                    "Coin purchases are not activated",
                    "No payment is taken through this dashboard until an approved catalog and merchant integration are configured.",
                  )
                )}
              </section>
              <section className="panel ledger">
                <div className="panel-head">
                  <h2>Wallet activity</h2>
                  <span className="muted">Confirmed ledger receipts</span>
                </div>
                {me?.history?.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Activity</th>
                          <th>Date</th>
                          <th>Currency</th>
                          <th>Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {me.history.map((h, i) => (
                          <tr key={h.id + ":" + i}>
                            <td>
                              <span className="ledger-icon">
                                <Icon
                                  name={h.kind === "fund" ? "shield" : "wallet"}
                                  size={16}
                                />
                              </span>
                              {h.kind === "grant"
                                ? "Coin grant / purchase"
                                : h.kind === "fund"
                                  ? "Entry locked"
                                  : h.kind === "refund"
                                    ? "Entry refunded"
                                    : "Challenge payout"}
                            </td>
                            <td>{date(h.created_at)}</td>
                            <td>{h.token_type}</td>
                            <td
                              className={h.delta.startsWith("-") ? "" : "lime"}
                            >
                              {h.delta.startsWith("-") ? "" : "+"}
                              {coin(h.delta)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  empty(
                    "No wallet activity yet",
                    "Sign in and complete your profile to view your available coins and journal receipts.",
                  )
                )}
              </section>
            </>
          )}
          {section === "identity" && (
            <>
              <div className="connection-grid">
                {[
                  [
                    "iracing",
                    "iRacing",
                    "Official OAuth connection",
                    "Connect your iRacing account to verify the customer ID used in race results.",
                  ],
                  [
                    "acc",
                    "ACC / Steam",
                    "Steam OpenID verification",
                    "Verify the Steam account that your ACC server results identify.",
                  ],
                  [
                    "discord",
                    "Discord",
                    "Verified community identity",
                    "Use Discord sign-in, then connect it here to issue and accept challenges in your league.",
                  ],
                ].map(([id, title, method, description]) => {
                  const linked = me?.identities?.find((i) => i.provider === id);
                  return (
                    <article className="panel connection" key={id}>
                      <div className={"connection-symbol " + id}>
                        {id === "iracing" ? "iR" : id === "acc" ? "AC" : "D"}
                      </div>
                      <h2>{title}</h2>
                      <span className="muted">{method}</span>
                      <p>{description}</p>
                      {linked ? (
                        <div className="verified">
                          <Icon name="check" size={17} /> Verified{" "}
                          <span className="mono">{linked.external_id}</span>
                        </div>
                      ) : (
                        <span className="status-pill pending">
                          Not connected
                        </span>
                      )}
                      <button
                        className="secondary"
                        disabled={
                          busy ||
                          (id === "iracing" && !config?.iracing_available) ||
                          (id === "acc" && !config?.steam_available)
                        }
                        onClick={() => connect(id === "acc" ? "steam" : id)}
                      >
                        {linked ? "Reconnect account" : "Connect account"}
                        <Icon name="link" size={17} />
                      </button>
                    </article>
                  );
                })}
              </div>
              <div className="note">
                <Icon name="shield" /> Connections are verified by the provider.
                A customer ID entered into a form cannot establish ownership.
                Account connections cannot change while your entries are locked
                in an active challenge.
              </div>
            </>
          )}
          {section === "settings" && (
            <section className="panel controls">
              <h2>Participation controls</h2>
              <p>
                Pause new challenges and purchases for a fixed period. Existing
                escrow stays protected and can still settle or refund. A shorter
                pause cannot override an active longer pause.
              </p>
              {me?.pause_until && (
                <div className="alert">Pause ends {date(me.pause_until)}</div>
              )}
              <div className="control-buttons">
                {[
                  [1, "1 hour"],
                  [24, "24 hours"],
                  [168, "7 days"],
                ].map(([hours, label]) => (
                  <button
                    className="secondary"
                    key={hours}
                    disabled={!signedIn || busy}
                    onClick={() => {
                      setModal({ type: "pause", hours, label });
                    }}
                  >
                    Pause for {label}
                  </button>
                ))}
              </div>
              <button
                className="text-button"
                onClick={() => setModal("account")}
              >
                Manage sign-in & account
              </button>
            </section>
          )}
          {section === "help" && (
            <>
              <section className="panel help">
                <h2>How a challenge settles</h2>
                <div className="help-grid">
                  {[
                    [
                      "Fixed terms before funding",
                      "Both players agree on a scheduled event, currency, entry, rule, and two distinct verified driver selections. Acceptance locks both entries in one database transaction.",
                    ],
                    [
                      "Authoritative race evidence",
                      "You race in iRacing or ACC. The web app does not simulate a race. A configured provider fetches official results or signs the ACC server report. Browser lap submissions cannot determine payouts.",
                    ],
                    [
                      "Winner, tie, or full refund",
                      "The lowest valid clean lap wins a lap duel. Event matchups compare agreed finish positions. The winner receives 90% of both entries. Ties, both drivers having no valid result, signed disconnects, or validation deadlines refund both entries without a fee.",
                    ],
                    [
                      "Separate currencies",
                      "GC are non-redeemable utility coins. SC are promotional assets with separate eligibility and redemption rules. The app does not automatically make a paid competition a legally approved sweepstakes.",
                    ],
                  ].map(([t, d]) => (
                    <article key={t}>
                      <Icon name="shield" />
                      <h3>{t}</h3>
                      <p>{d}</p>
                    </article>
                  ))}
                </div>
                <button
                  className="secondary"
                  onClick={() => setModal("status")}
                >
                  View integration status
                </button>
              </section>
              <ProgramPanel
                program={program}
                compliance={compliance}
                audit={audit}
                signedIn={signedIn}
                busy={busy}
                onSignIn={() => setModal("signin")}
                onConsent={(programId) =>
                  act(async () => {
                    await api("compliance/consent", {
                      program_id: programId,
                      accept_terms: true,
                    });
                    await refresh();
                    notice("Official rules acceptance recorded.");
                  })
                }
                onClaim={(programId) =>
                  act(async () => {
                    if (!requireAccount()) return;
                    freeEntryIds.current[programId] ??= crypto.randomUUID();
                    const r = await api("ame", {
                      request_id: freeEntryIds.current[programId],
                      program_id: programId,
                    });
                    if (r.state === "Credited" || r.state === "Rejected")
                      delete freeEntryIds.current[programId];
                    await refresh();
                    notice(
                      r.state === "Credited"
                        ? `Free entry confirmed: ${coin(r.amount)} SC. Receipt ${r.id}.`
                        : `Free entry recorded without a credit: ${String(r.reason).replaceAll("_", " ")}.`,
                    );
                  })
                }
              />
            </>
          )}
          <footer>
            <span>
              © {new Date().getFullYear()} Crestside Consultants L.L.C. ·
              GridStake
            </span>
            <div>
              <button onClick={() => setModal("rules")}>Challenge rules</button>
              <button onClick={() => setModal("privacy")}>Privacy</button>
              <a href="/operator.html">Operator disclosure</a>
              <a href="#settings">Play controls</a>
            </div>
            <p>
              Operated by Crestside Consultants L.L.C., a California limited
              liability company. Mailing address: 626 Wilshire Blvd, Suite 410,
              Los Angeles, CA 90017.
            </p>
            <p>
              Independent P2P platform. iRacing and Assetto Corsa Competizione
              are external simulators; no affiliation is implied. Availability
              depends on operator activation and eligibility.
            </p>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {NAV.map(([id, label, icon]) => (
          <a
            key={id}
            href={"#" + id}
            className={section === id ? "active" : ""}
          >
            <Icon name={icon} />
            <span>
              {id === "lobby"
                ? "Lobby"
                : id === "events"
                  ? "Events"
                  : id === "races"
                    ? "My races"
                    : id === "wallet"
                      ? "Wallet"
                      : "Connect"}
            </span>
          </a>
        ))}
      </nav>
      {toast && (
        <div className="toast" role="status">
          <Icon name="info" />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
          >
            <button
              className="modal-close"
              aria-label="Close dialog"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              <Icon name="close" />
            </button>
            {modal === "signin" && (
              <>
                <span className="eyebrow">WELCOME TO THE PADDOCK</span>
                <h2 id="dialog-title">Connect your account.</h2>
                <p>
                  Sign in to see your wallet, verify your simulator identity,
                  and agree to challenge terms.
                </p>
                {config?.accounts_available ? (
                  <>
                    <button
                      className="discord-button"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          const { error } =
                            await auth.current.auth.signInWithOAuth({
                              provider: "discord",
                              options: {
                                redirectTo: location.origin + "/#identity",
                                scopes: "identify email",
                              },
                            });
                          if (error) throw error;
                        })
                      }
                    >
                      Continue with Discord <Icon name="arrow" size={18} />
                    </button>
                    <div className="divider">or use your email</div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        act(async () => {
                          const { error } =
                            await auth.current.auth.signInWithOtp({
                              email: authEmail,
                              options: {
                                emailRedirectTo: location.origin + "/#lobby",
                              },
                            });
                          if (error) throw error;
                          notice("Check your email for a secure sign-in link.");
                        });
                      }}
                    >
                      <label>
                        Email address
                        <input
                          autoFocus
                          type="email"
                          autoComplete="email"
                          required
                          value={authEmail}
                          onChange={(e) => setAuthEmail(e.target.value)}
                          placeholder="you@example.com"
                        />
                      </label>
                      <button className="primary" disabled={busy} type="submit">
                        Send secure sign-in link
                      </button>
                    </form>
                  </>
                ) : (
                  <div className="alert">
                    Accounts are not activated yet. No credentials or payment
                    details are collected through this screen.
                  </div>
                )}
                <small>
                  Only verified accounts can create a platform wallet.
                </small>
              </>
            )}
            {modal === "profile" && (
              <>
                <h2 id="dialog-title">Create your driver profile.</h2>
                <p>
                  Choose your public handle. Your platform wallet is linked to
                  your verified sign-in identity.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(async () => {
                      await api("enroll", { handle, accept_terms: true });
                      setModal(null);
                      await refresh();
                      notice(
                        "Profile created. Your welcome Gold Coins are journaled in your wallet.",
                      );
                    });
                  }}
                >
                  <label>
                    Public handle
                    <input
                      autoFocus
                      required
                      pattern="[A-Za-z0-9_]{3,20}"
                      minLength={3}
                      maxLength={20}
                      value={handle}
                      onChange={(e) => setHandle(e.target.value)}
                      placeholder="YourRaceHandle"
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      required
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    I understand GC have no cash value, and I accept the
                    platform’s operational challenge rules.
                  </label>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      setModal("rules");
                      setNeedsProfile(true);
                    }}
                  >
                    Read challenge rules
                  </button>
                  <button className="primary" disabled={busy || !consent}>
                    Create profile
                  </button>
                </form>
              </>
            )}
            {modal === "create" && (
              <>
                <span className="eyebrow">
                  FIXED TERMS · BOTH PLAYERS CONSENT
                </span>
                <h2 id="dialog-title">Create a challenge.</h2>
                {!lobby.events.length ? (
                  <div className="alert">
                    No verified upcoming events are registered. Your wallet will
                    not be debited.
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      act(async () => {
                        await api("offers", {
                          request_id: request.current,
                          event_id: draft.event_id,
                          mode: draft.mode,
                          token_type: currency,
                          entry_fee: draft.entry_fee,
                          selection:
                            draft.mode === "event_match"
                              ? draft.selection
                              : null,
                        });
                        setModal(null);
                        await refresh();
                        notice(
                          "Challenge invitation opened. No entry is deducted until another player accepts.",
                        );
                      });
                    }}
                  >
                    <label>
                      Registered external event
                      <select
                        required
                        value={draft.event_id}
                        onChange={(e) =>
                          changeDraft("event_id", e.target.value)
                        }
                      >
                        <option value="">Select an event</option>
                        {lobby.events.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.title} · {e.track_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="form-grid">
                      <label>
                        Matchup type
                        <select
                          value={draft.mode}
                          onChange={(e) => changeDraft("mode", e.target.value)}
                        >
                          <option value="driver_duel">
                            Our own driver duel
                          </option>
                          <option value="event_match">
                            Two event driver selections
                          </option>
                        </select>
                      </label>
                      <label>
                        Currency
                        <select
                          value={currency}
                          onChange={(e) => {
                            setCurrency(e.target.value);
                            request.current = crypto.randomUUID();
                          }}
                        >
                          <option value="GC">Gold Coins (GC)</option>
                          <option value="SC" disabled={!me?.sc_eligible}>
                            Sweeps Coins (SC)
                          </option>
                        </select>
                      </label>
                    </div>
                    {draft.mode === "event_match" && (
                      <label>
                        Your driver selection
                        <select
                          required
                          value={draft.selection}
                          onChange={(e) =>
                            changeDraft("selection", e.target.value)
                          }
                        >
                          <option value="">Choose registered driver</option>
                          {event?.entrants?.map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label>
                      Entry per player
                      <input
                        required
                        inputMode="decimal"
                        pattern="\d{1,4}(\.\d{1,2})?"
                        value={draft.entry_fee}
                        onChange={(e) =>
                          changeDraft("entry_fee", e.target.value)
                        }
                      />
                    </label>
                    <div className="terms-summary">
                      <span>
                        Gross escrow pool
                        <b>
                          {preview?.pool ?? "—"} {currency}
                        </b>
                      </span>
                      <span>
                        Platform fee on a win (10%)
                        <b>
                          {preview?.rake ?? "—"} {currency}
                        </b>
                      </span>
                      <span>
                        Winner receives
                        <b className="lime">
                          {preview?.payout ?? "—"} {currency}
                        </b>
                      </span>
                      <small>
                        Full entries refunded with zero fee for an invalid
                        result, tie, confirmed disconnect, or expired
                        validation. Rule:{" "}
                        {event?.rule?.replaceAll("_", " ") ?? "select event"}.
                      </small>
                    </div>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        required
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      I agree to these fixed terms. A second player must accept
                      before both entries are locked.
                    </label>
                    <button
                      className="primary"
                      disabled={busy || !consent || !preview}
                    >
                      Open challenge invitation <Icon name="arrow" size={16} />
                    </button>
                  </form>
                )}
              </>
            )}
            {modal.type === "accept" && (
              <>
                <h2 id="dialog-title">Review this matchup.</h2>
                <p>
                  {modal.offer.handle} · {modal.offer.title} ·{" "}
                  {modal.offer.track_name}
                </p>
                <div className="terms-summary">
                  <span>
                    Your entry
                    <b>
                      {coin(modal.offer.entry_fee)} {modal.offer.token_type}
                    </b>
                  </span>
                  <span>
                    Winning payout (after 10% fee)
                    <b className="lime">
                      {amountPreview(modal.offer.entry_fee)?.payout}{" "}
                      {modal.offer.token_type}
                    </b>
                  </span>
                  <span>
                    Rule<b>{modal.offer.rule.replaceAll("_", " ")}</b>
                  </span>
                  <small>
                    Acceptance atomically locks both entries. Refunds return
                    each full entry with no fee. Event driver choices are fixed
                    on acceptance.
                  </small>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(async () => {
                      await api("accept", {
                        offer_id: modal.offer.id,
                        accept_terms: true,
                        selection:
                          modal.offer.mode === "event_match"
                            ? acceptSelection
                            : null,
                      });
                      setModal(null);
                      await refresh();
                      location.hash = "races";
                      notice(
                        "Both entries are confirmed in escrow. Race in the scheduled external simulator session.",
                      );
                    });
                  }}
                >
                  {modal.offer.mode === "event_match" && (
                    <label>
                      Your opposing driver
                      <select
                        value={acceptSelection}
                        required
                        onChange={(e) => setAcceptSelection(e.target.value)}
                      >
                        <option value="">Select a different driver</option>
                        {lobby.events
                          .find((e) => e.id === modal.offer.event_id)
                          ?.entrants.filter(
                            (id) => id !== modal.offer.selection_a,
                          )
                          .map((id) => (
                            <option key={id}>{id}</option>
                          ))}
                      </select>
                    </label>
                  )}
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      required
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    I accept the entry, rule, event, selections, payout, and
                    refund terms.
                  </label>
                  <button className="primary" disabled={busy || !consent}>
                    Accept & lock both entries <Icon name="shield" size={16} />
                  </button>
                </form>
              </>
            )}
            {modal.type === "result" && (
              <>
                <h2 id="dialog-title">Challenge evidence.</h2>
                <p>{modal.race.title}</p>
                <dl className="evidence">
                  <dt>Status</dt>
                  <dd>
                    {modal.race.status} /{" "}
                    {modal.race.resolution ?? "Awaiting provider"}
                  </dd>
                  <dt>Rule</dt>
                  <dd>{modal.race.rule.replaceAll("_", " ")}</dd>
                  <dt>Selection A / B</dt>
                  <dd>
                    {modal.race.selection_a} / {modal.race.selection_b}
                  </dd>
                  <dt>Metric A / B</dt>
                  <dd>
                    {modal.race.challenger_best ?? "—"} /{" "}
                    {modal.race.opponent_best ?? "—"}{" "}
                    {modal.race.rule === "fastest_clean_lap"
                      ? "seconds"
                      : "position"}
                  </dd>
                  <dt>Evidence hash</dt>
                  <dd className="mono">
                    {modal.race.evidence?.source_sha256 ??
                      "No completed provider evidence yet"}
                  </dd>
                  <dt>Source receipt</dt>
                  <dd className="mono">
                    {modal.race.evidence?.source_id ?? "Pending"}
                  </dd>
                </dl>
                <p>
                  Browser timing and user-entered lap data are not used to
                  settle this challenge.
                </p>
              </>
            )}
            {modal.type === "pause" && (
              <>
                <h2 id="dialog-title">Pause for {modal.label}?</h2>
                <p>
                  This blocks new challenges and purchases. Existing escrow can
                  settle or refund. You cannot shorten an active pause.
                </p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await api("pause", { hours: modal.hours });
                      setModal(null);
                      await refresh();
                      notice("Participation pause confirmed.");
                    })
                  }
                >
                  Confirm participation pause
                </button>
              </>
            )}
            {modal === "account" && (
              <>
                <h2 id="dialog-title">Your account.</h2>
                <p>{session?.user?.email ?? "You are browsing as a guest."}</p>
                <button
                  className="secondary"
                  onClick={() => {
                    setModal(null);
                    location.hash = "identity";
                  }}
                >
                  Manage verified connections
                </button>
                {session ? (
                  <button
                    className="text-button"
                    onClick={() =>
                      act(async () => {
                        const { error } = await auth.current.auth.signOut();
                        if (error) throw error;
                        setModal(null);
                        notice("Signed out.");
                      })
                    }
                  >
                    <Icon name="logout" size={16} /> Sign out
                  </button>
                ) : (
                  <button
                    className="primary"
                    onClick={() => setModal("signin")}
                  >
                    Sign in
                  </button>
                )}
              </>
            )}
            {modal === "redemption" && (
              <RedemptionPanel
                api={api}
                config={config}
                signedIn={Boolean(session)}
                onSignIn={() => setModal("auth")}
                onRefresh={refresh}
                requestScope={
                  me?.user_id ? `${config?.tenant_id}:${me.user_id}` : null
                }
              />
            )}
            {modal === "rules" && (
              <>
                <h2 id="dialog-title">Challenge operating rules.</h2>
                <p>
                  GridStake is operated by Crestside Consultants L.L.C., a
                  California limited liability company. See the{" "}
                  <a href="/operator.html">operator disclosure</a> and{" "}
                  <a href="/sweepstakes-rules.html">
                    program publication status
                  </a>
                  .
                </p>
                <p>
                  Race in the external simulator’s registered event. Both
                  players accept a fixed entry, currency, rule, and distinct
                  driver selections before funding closes.
                </p>
                <ol>
                  <li>Entries are deducted together and held in escrow.</li>
                  <li>
                    For lap duels, only explicitly valid positive clean laps
                    count. The fastest eligible lap determines the winner.
                  </li>
                  <li>
                    For event matchups, the agreed drivers’ verified finish
                    positions determine the result.
                  </li>
                  <li>
                    The winner receives 90% of the gross pool. The 10% fee is
                    charged only on a win.
                  </li>
                  <li>
                    Ties, no eligible result for either driver, signed race
                    disconnects, and missed validation deadlines refund both
                    full entries.
                  </li>
                  <li>
                    A temporary API or database outage triggers a retry, not a
                    browser-determined payout.
                  </li>
                </ol>
                <p className="muted">
                  These describe software behavior. They are not published
                  sweepstakes official rules or a determination that the
                  business may operate in a particular region. Commercial SC
                  play and redemption remain inactive.
                </p>
                <button
                  className="primary"
                  onClick={() => {
                    setModal(null);
                    location.hash = "help";
                  }}
                >
                  View help & verification
                </button>
              </>
            )}
            {modal === "status" && (
              <>
                <h2 id="dialog-title">Integration status.</h2>
                <dl className="evidence">
                  {[
                    ["Dashboard", "Online"],
                    [
                      "Verified accounts",
                      config?.accounts_available
                        ? "Configured — connection not independently verified"
                        : "Awaiting setup",
                    ],
                    [
                      "iRacing OAuth",
                      config?.iracing_available
                        ? "Configured — provider verification required"
                        : "Awaiting setup",
                    ],
                    [
                      "ACC / Steam",
                      config?.steam_available
                        ? "Configured — trusted host required"
                        : "Awaiting setup",
                    ],
                    [
                      "Coin checkout",
                      config?.commerce_available
                        ? "Configured — merchant activation required"
                        : "Inactive",
                    ],
                    [
                      "Cash redemption",
                      config?.redemption_available
                        ? "Configured — provider confirmation required"
                        : "Awaiting provider setup",
                    ],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
                <p>
                  Configured does not mean verified live. Your displayed wallet
                  contains only confirmed database records.
                </p>
              </>
            )}
            {modal === "privacy" && (
              <>
                <h2 id="dialog-title">Data used by the app.</h2>
                <p>
                  Crestside Consultants L.L.C. operates GridStake. Written
                  privacy inquiries may be addressed to Crestside Consultants
                  L.L.C., Attn: GridStake Privacy, 626 Wilshire Blvd, Suite 410,
                  Los Angeles, CA 90017.
                </p>
                <p>
                  When accounts are activated, the platform uses verified
                  account identities, provider customer IDs, accepted challenge
                  terms, payment receipts, and race evidence to operate escrow.
                  Provider access tokens are encrypted on the server.
                </p>
                <p>
                  Payment card details go directly to hosted checkout. This
                  dashboard does not collect card numbers. The operator’s
                  published privacy policy and retention terms are required
                  before a commercial launch.
                </p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
