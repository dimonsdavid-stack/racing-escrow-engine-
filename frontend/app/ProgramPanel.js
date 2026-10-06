"use client";
import { useState, useEffect } from "react";
const reasons = {
  program_unavailable: "An active promotion program has not been published.",
  account_review: "Your account is under review. Contact the program operator.",
  rules_consent_required: "Review and accept the current official rules.",
  identity_verification_required:
    "Verified identity and age evidence are required.",
  location_verification_required: "Fresh location verification is required.",
  territory_unavailable:
    "This program is unavailable in your verified location.",
  risk_verification_required:
    "Your verification provider must refresh the risk decision.",
  eligible: "Your current eligibility checks are confirmed.",
};
function safeRules(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
export default function ProgramPanel({
  program,
  compliance,
  audit,
  signedIn,
  busy,
  onSignIn,
  onConsent,
  onClaim,
}) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => setAccepted(false), [program?.id]);
  const rules = safeRules(program?.official_rules_url),
    eligible = compliance?.eligible === true,
    consent = compliance?.consent_recorded === true,
    remaining = compliance?.entries_remaining;
  function exportReceipts() {
    const contents = {
      exported_at: new Date().toISOString(),
      program,
      requests: compliance?.requests ?? [],
      wallet_checkpoint: audit ?? null,
    };
    const blob = new Blob([JSON.stringify(contents, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "gridstake-free-entry-receipts.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section
      id="free-entry"
      className="panel mt-6 border border-lime-300/25 bg-neutral-900/80 p-5 sm:p-7"
      aria-labelledby="free-entry-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <a className="text-button" href="/sweepstakes-rules.html">
            Program rules & publication status ↗
          </a>
          <span className="eyebrow">ALTERNATIVE METHOD OF ENTRY</span>
          <h2 id="free-entry-title">No purchase necessary.</h2>
          <p className="max-w-2xl text-sm text-neutral-200">
            A purchase is not required for the free promotional entry method.
            Buying coins does not improve the result of a race. Promotion
            availability, awards, eligibility, and redemption conditions are
            defined in the operator’s official rules.
          </p>
        </div>
        <span className="pill subtle">
          {program ? "Published program" : "Activation pending"}
        </span>
      </div>
      <ol className="my-6 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
        {[
          [
            "Read the official rules",
            "Check the sponsor, eligible locations, age requirement, program dates, free award, and request limits.",
          ],
          [
            "Sign in without buying coins",
            "Create a verified account. You do not need a Gold Coin purchase, a checkout session, or a funded challenge to request free entry.",
          ],
          [
            "Confirm your eligibility",
            "The operator’s trusted provider verifies identity, age, and current physical location. Client-entered locations cannot approve SC access.",
          ],
          [
            "Request and keep your receipt",
            "Submit the free request below. A confirmed award credits SC directly. Your receipt shows the request status, exact credit, and ledger reference.",
          ],
        ].map(([title, body], i) => (
          <li
            key={title}
            className="rounded-xl border border-neutral-700/70 bg-neutral-950/50 p-4"
          >
            <span className="mb-2 block font-mono text-xs text-lime-300">
              0{i + 1}
            </span>
            <h3 className="m-0 text-sm font-semibold text-white">{title}</h3>
            <p className="mb-0 mt-2 text-sm text-neutral-300">{body}</p>
          </li>
        ))}
      </ol>
      {program ? (
        <>
          <div className="grid grid-cols-2 gap-4 rounded-xl border border-neutral-700 p-4 text-sm sm:grid-cols-4">
            <div>
              <span className="block text-xs text-neutral-400">FREE AWARD</span>
              <strong>{program.free_sc} SC</strong>
            </div>
            <div>
              <span className="block text-xs text-neutral-400">
                REQUEST LIMIT
              </span>
              <strong>
                {program.entries_per_period} / {program.period_hours} hours
              </strong>
            </div>
            <div>
              <span className="block text-xs text-neutral-400">
                MINIMUM AGE
              </span>
              <strong>{program.minimum_age}+</strong>
            </div>
            <div>
              <span className="block text-xs text-neutral-400">
                PROGRAM VERSION
              </span>
              <strong className="break-words">{program.version}</strong>
            </div>
          </div>
          <p className="text-sm text-neutral-300">
            Sponsor: {program.sponsor}. Ends{" "}
            {new Date(program.ends_at).toLocaleString()}. Eligible territories:{" "}
            {program.territories.join(", ")}.
          </p>
          {rules && (
            <a
              className="text-button"
              href={rules}
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the official promotion rules ↗
            </a>
          )}
          {!signedIn ? (
            <button className="primary mt-4" onClick={onSignIn}>
              Sign in for free entry
            </button>
          ) : (
            <>
              <p
                role="status"
                className="rounded-lg border border-neutral-700 px-4 py-3 text-sm"
              >
                {reasons[compliance?.reason] ??
                  "Checking your verified eligibility."}
              </p>
              {!consent && (
                <div className="my-4 rounded-xl border border-neutral-700 p-4">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={accepted}
                      onChange={(e) => setAccepted(e.target.checked)}
                    />
                    <span className="text-sm">
                      I have read and accept the official rules for program{" "}
                      {program.version}.
                    </span>
                  </label>
                  <button
                    className="secondary mt-3"
                    disabled={!accepted || busy}
                    onClick={() => onConsent(program.id)}
                  >
                    Record rules acceptance
                  </button>
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-4">
                <button
                  className="primary"
                  disabled={!eligible || busy || remaining === 0}
                  onClick={() => onClaim(program.id)}
                >
                  Request free Sweeps Coins
                </button>
                <span className="text-xs text-neutral-300">
                  {remaining === 0
                    ? "This period’s free requests are complete."
                    : remaining != null
                      ? `${remaining} free request${remaining === 1 ? "" : "s"} remaining this period.`
                      : "Eligibility is checked before every credit."}
                </span>
              </div>
              {remaining === 0 && compliance.next_period_at && (
                <p className="text-sm text-neutral-300">
                  Next period begins{" "}
                  {new Date(compliance.next_period_at).toLocaleString()}.
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <p className="rounded-xl border border-neutral-700 bg-neutral-950 p-4 text-sm text-neutral-300">
          Free entry is awaiting published official program rules and verified
          eligibility services. No SC request, payment, or redemption is
          accepted through an inactive program.
        </p>
      )}
      {signedIn && (
        <div className="mt-6 border-t border-neutral-700 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="m-0">Free-entry request history</h3>
            <button className="secondary" onClick={exportReceipts}>
              Export my receipts
            </button>
          </div>
          {compliance?.requests?.length ? (
            <div className="table-wrap mt-4">
              <table>
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Status</th>
                    <th>SC credit</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {compliance.requests.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <span className="font-mono text-xs">
                          {r.id.slice(0, 8)}
                        </span>
                        <br />
                        <small>{new Date(r.created_at).toLocaleString()}</small>
                      </td>
                      <td>{r.state}</td>
                      <td className="font-mono">{r.amount}</td>
                      <td className="text-xs">
                        {r.reason.replaceAll("_", " ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-neutral-300">
              No free-entry requests have been submitted by this account.
            </p>
          )}
          {audit && (
            <p className="mt-4 break-all font-mono text-xs text-neutral-400">
              Wallet journal checkpoint · {audit.sequence} entries ·{" "}
              {audit.hash}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
