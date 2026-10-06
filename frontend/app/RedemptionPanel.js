"use client";
import { useEffect, useRef, useState } from "react";
export default function RedemptionPanel({
  api,
  config,
  signedIn,
  onSignIn,
  onRefresh,
  requestScope,
}) {
  const [state, setState] = useState(null),
    [amount, setAmount] = useState("50.00"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [submitted, setSubmitted] = useState(null);
  const pending = useRef(null),
    mounted = useRef(true),
    scope = useRef(requestScope);
  const storageKey = "gridstake-redemption:" + requestScope;
  useEffect(() => {
    scope.current = requestScope;
    pending.current = null;
    setState(null);
    setSubmitted(null);
    setError("");
    setBusy(false);
    if (!requestScope) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (
        saved &&
        /^[a-f0-9-]{36}$/.test(saved.request_id) &&
        /^\d{1,5}(\.\d{1,2})?$/.test(saved.amount_sc)
      ) {
        pending.current = saved;
        setAmount(saved.amount_sc);
      }
    } catch {
      setError(
        "Saved request could not be read. Keep this window open while confirming a redemption.",
      );
    }
  }, [storageKey, requestScope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function load() {
    if (!signedIn) return;
    const s = await api("redemptions");
    if (mounted.current && scope.current === requestScope) setState(s);
  }
  useEffect(() => {
    if (signedIn)
      load().catch(() => {
        if (mounted.current && scope.current === requestScope)
          setError(
            "We could not load your redemption history. Try refreshing.",
          );
      });
  }, [signedIn, api, requestScope]);
  async function action(fn) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (!mounted.current || scope.current !== requestScope) return;
      setError(
        e.status === 503
          ? "The provider could not confirm this request. Retry with the same amount; your request ID is retained."
          : e.status === 403
            ? "Complete identity, bank, location and program verification before redeeming."
            : e.status === 409
              ? "The request conflicts with your balance or saved terms. Refresh your wallet."
              : "The request could not be accepted. Check your account and amount.",
      );
    } finally {
      if (mounted.current && scope.current === requestScope) setBusy(false);
    }
  }
  async function redirect(path) {
    const { url } = await api(path, {});
    if (!mounted.current || scope.current !== requestScope) return;
    const u = new URL(url);
    const valid =
      path === "kyc/start"
        ? /(^|\.)sumsub\.com$/.test(u.hostname)
        : u.hostname === "connect.stripe.com";
    if (u.protocol !== "https:" || !valid)
      throw new Error("invalid_provider_url");
    window.location.assign(u.href);
  }
  async function redeem() {
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(amount))
      throw new Error("invalid_amount");
    const [whole, fraction = ""] = amount.split(".");
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (cents < 5000n || cents > 1000000n) throw new Error("redemption_limits");
    pending.current ??= { request_id: crypto.randomUUID(), amount_sc: amount };
    sessionStorage.setItem(storageKey, JSON.stringify(pending.current));
    const result = await api("redeem", pending.current);
    if (mounted.current && scope.current === requestScope) {
      setSubmitted(result);
      pending.current = null;
      sessionStorage.removeItem(storageKey);
    }
    try {
      await Promise.all([load(), onRefresh()]);
    } catch {
      setError(
        "Request confirmed. Wallet refresh is delayed; use Refresh redemption status.",
      );
    }
  }
  return (
    <section aria-labelledby="dialog-title" className="space-y-5">
      <span className="eyebrow">PRIZE REDEMPTION</span>
      <h2 id="dialog-title">Your race wins. Your wallet.</h2>
      <p>
        Only SC won in a verified challenge can be redeemed. Promotional grants
        remain available for play. 1 SC = $1 USD; minimum 50 SC, daily maximum
        10,000 SC.
      </p>
      <div className="rounded-xl border border-neutral-700 bg-neutral-950 p-4">
        <div className="text-sm text-neutral-400">Redeemable SC</div>
        <strong className="text-2xl">{state?.redeemable_sc ?? "—"}</strong>
        <div className="mt-2 text-sm">
          Identity: {state?.kyc_status ?? "Not checked"} · Bank:{" "}
          {state?.bank_connected ? "Connected" : "Not connected"}
        </div>
      </div>
      {!signedIn ? (
        <button className="primary" onClick={onSignIn}>
          Sign in to view redemptions
        </button>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              className="secondary"
              disabled={busy || !config?.kyc_available}
              onClick={() => action(() => redirect("kyc/start"))}
            >
              Verify identity
            </button>
            <button
              className="secondary"
              disabled={busy || !config?.redemption_available}
              onClick={() => action(() => redirect("bank/connect"))}
            >
              Connect bank securely
            </button>
          </div>
          {!config?.redemption_available && (
            <p role="status">
              Live verification and payout credentials have not been configured
              for this deployment.
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action(redeem);
            }}
            className="space-y-3"
          >
            <label className="block" htmlFor="redemption-amount">
              Amount in SC
            </label>
            <input
              id="redemption-amount"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              disabled={busy || Boolean(pending.current)}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-xl border border-neutral-700 bg-neutral-950 p-3"
              required
              pattern="[0-9]{1,5}(\.[0-9]{1,2})?"
            />
            <button
              className="primary w-full"
              disabled={busy || !config?.redemption_available}
            >
              {busy
                ? "Confirming request…"
                : pending.current
                  ? "Retry saved request"
                  : "Request redemption"}
            </button>
          </form>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => action(load)}
          >
            Refresh redemption status
          </button>
        </>
      )}
      {error && (
        <p className="text-amber-300" role="alert">
          {error}
        </p>
      )}
      {submitted && (
        <p role="status">
          Request {submitted.id.slice(0, 8)} confirmed: {submitted.state}. Funds
          are reserved until the payout provider confirms the result.
        </p>
      )}
      <p className="text-sm text-neutral-400">
        Identity documents and bank numbers stay with the verification and
        payout providers. A hosted verification return does not approve a
        payout.
      </p>
      {state?.requests?.length > 0 && (
        <div className="space-y-2">
          <h3>Redemption history</h3>
          {state.requests.map((r) => (
            <div
              key={r.id}
              className="flex justify-between gap-4 rounded-lg border border-neutral-700 p-3 text-sm"
            >
              <span>
                {r.amount_sc} SC{" "}
                <small className="block text-neutral-400">
                  {r.id.slice(0, 8)}
                </small>
              </span>
              <span>{r.state}</span>
            </div>
          ))}
        </div>
      )}
      <a className="text-button" href="/sweepstakes-rules.html">
        Program rules & free entry ↗
      </a>
    </section>
  );
}
