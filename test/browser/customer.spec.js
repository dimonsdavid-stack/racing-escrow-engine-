import { test, expect } from "@playwright/test";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
test("external sim dashboard navigates without a game or fabricated account data", async ({
  page,
}, info) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your race. Your rival." }),
  ).toBeVisible();
  await expect(page.locator(".hero")).toContainText("PLAYER / PLAYER");
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.locator(".activation-banner")).toContainText(
    "Account activation is pending",
  );
  await page.screenshot({ path: info.outputPath("lobby.png"), fullPage: true });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(
    "Accounts are not activated",
  );
  await expect(page.getByRole("dialog").locator("input")).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (const route of [
    "events",
    "races",
    "wallet",
    "identity",
    "settings",
    "help",
  ]) {
    await page.goto("/#" + route);
    await expect(page.locator("#content h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto("/#wallet");
  await page.screenshot({
    path: info.outputPath("wallet-unconfigured.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
async function account(page) {
  await page.route("**/api/v1/app/compliance", (r) =>
    r.fulfill({
      json: { eligible: false, reason: "program_unavailable", requests: [] },
    }),
  );
  await page.route("**/api/v1/app/audit", (r) =>
    r.fulfill({ json: { sequence: "1", hash: "a".repeat(64) } }),
  );
  const user = {
    id: A,
    email: "racer@example.test",
    email_confirmed_at: "2026-10-01T00:00:00Z",
    app_metadata: { provider: "email" },
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-10-01T00:00:00Z",
  };
  const token =
    "eyJhbGciOiJIUzI1NiJ9." +
    Buffer.from(
      JSON.stringify({ sub: A, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url") +
    ".signature";
  await page.addInitScript(
    ({ token, user }) => {
      localStorage.setItem(
        "sb-example-auth-token",
        JSON.stringify({
          access_token: token,
          refresh_token: "refresh-test-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          expires_in: 3600,
          token_type: "bearer",
          user,
        }),
      );
    },
    { token, user },
  );
  await page.route("**/api/v1/app/config", (r) =>
    r.fulfill({
      json: {
        accounts_available: true,
        supabase_url: "https://example.supabase.co",
        publishable_key: "sb_publishable_test",
        commerce_available: false,
        iracing_available: false,
        steam_available: false,
      },
    }),
  );
  await page.route("https://example.supabase.co/auth/v1/**", (r) =>
    r.fulfill({
      json: {
        user,
        access_token: token,
        refresh_token: "refresh-test-token",
        expires_in: 3600,
      },
    }),
  );
}
test("confirmed wallet, fixed consent and external evidence survive challenge acceptance", async ({
  page,
}, info) => {
  const errors = [],
    calls = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await account(page);
  const profile = {
    user_id: A,
    handle: "Grid_Racer",
    gc_balance: "1000.000000",
    sc_balance: "0.000000",
    gc_locked_entry: "0.000000",
    sc_locked_entry: "0.000000",
    sc_eligible: false,
    identities: [
      {
        provider: "iracing",
        external_id: "123",
        verified_at: "2026-10-01T00:00:00Z",
      },
    ],
    contracts: [],
    history: [],
  };
  const event = {
    id: E,
    game: "iracing",
    title: "League Challenge",
    track_name: "Spa-Francorchamps",
    starts_at: "2030-01-01T12:00:00Z",
    funding_closes_at: "2030-01-01T11:55:00Z",
    deadline: "2030-01-01T15:00:00Z",
    rule: "fastest_clean_lap",
    entrants: ["123", "456"],
  };
  const offer = {
    id: B,
    event_id: E,
    game: "iracing",
    title: event.title,
    track_name: event.track_name,
    rule: event.rule,
    handle: "Rival",
    mode: "driver_duel",
    entry_fee: "10.000000",
    token_type: "GC",
    mine: false,
  };
  await page.route("**/api/v1/app/me", (r) => r.fulfill({ json: profile }));
  await page.route("**/api/v1/app/catalog", (r) =>
    r.fulfill({ json: { packages: [] } }),
  );
  await page.route("**/api/v1/app/lobby", (r) =>
    r.fulfill({ json: { events: [event], offers: [offer] } }),
  );
  await page.route("**/api/v1/app/accept", (r) => {
    calls.push(r.request().postDataJSON());
    profile.gc_balance = "990.000000";
    profile.gc_locked_entry = "10.000000";
    profile.contracts = [
      {
        ...event,
        id: B,
        event_id: E,
        selection_a: "456",
        selection_b: "123",
        status: "Active",
        resolution: null,
        token_type: "GC",
        entry_fee: "10.000000",
        total_escrow_pool: "20.000000",
        platform_rake: "2.000000",
        telemetry_deadline: event.deadline,
        evidence: null,
      },
    ];
    return r.fulfill({
      json: { challenge_id: B, status: "Active", duplicate: false },
    });
  });
  await page.goto("/");
  await expect(page.locator(".balance").first()).toContainText("1,000");
  await page.getByRole("button", { name: "Review & accept" }).click();
  await expect(page.getByRole("dialog")).toContainText("18.00 GC");
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Accept & lock both entries" })
    .click();
  await expect(page.locator(".race-row")).toContainText("Active");
  expect(calls).toEqual([{ offer_id: B, accept_terms: true, selection: null }]);
  await page.getByRole("button", { name: "View evidence" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "No completed provider evidence yet",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.goto("/#wallet");
  await expect(page.locator(".wallet-card.gold")).toContainText("990");
  await expect(page.locator(".wallet-card.gold")).toContainText("10 GC held");
  await page.screenshot({
    path: info.outputPath("wallet-confirmed.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("new challenge quotes precise micro-value payout and keeps retry identity after an ambiguous response", async ({
  page,
}) => {
  await account(page);
  const calls = [];
  const event = {
    id: E,
    title: "League session",
    track_name: "Spa",
    game: "iracing",
    rule: "fastest_clean_lap",
    entrants: ["123", "456"],
    funding_closes_at: "2030-01-01T12:00:00Z",
  };
  await page.route("**/api/v1/app/me", (r) =>
    r.fulfill({
      json: {
        user_id: A,
        handle: "Driver",
        gc_balance: "1000.000000",
        sc_balance: "0.000000",
        identities: [],
        history: [],
        contracts: [],
      },
    }),
  );
  await page.route("**/api/v1/app/lobby", (r) =>
    r.fulfill({ json: { events: [event], offers: [] } }),
  );
  await page.route("**/api/v1/app/catalog", (r) =>
    r.fulfill({ json: { packages: [] } }),
  );
  await page.route("**/api/v1/app/offers", (r) => {
    calls.push(r.request().postDataJSON());
    return calls.length === 1
      ? r.fulfill({ status: 503, json: { error: "retry_same_request" } })
      : r.fulfill({ json: { offer_id: B, state: "Open" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Find your rival" }).click();
  await page.getByLabel("Entry per player", { exact: true }).fill("0.01");
  await expect(page.getByRole("dialog")).toContainText("0.018 GC");
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Open challenge invitation" }).click();
  await expect(page.getByRole("status")).toContainText("not confirmed");
  await page.getByRole("button", { name: "Open challenge invitation" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(calls.length).toBe(2);
  expect(calls[0].request_id).toBe(calls[1].request_id);
  expect(calls[0].entry_fee).toBe("0.01");
  expect(calls[0].user_id).toBeUndefined();
});

test("free entry is visible from the shop and does not accept requests before program activation", async ({
  page,
}, info) => {
  await page.goto("/#wallet");
  await page
    .getByRole("link", { name: /View official rules & free entry/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "No purchase necessary." }),
  ).toBeVisible();
  await expect(page.locator("#free-entry")).toContainText(
    "Sign in without buying coins",
  );
  await expect(page.locator("#free-entry")).toContainText("Activation pending");
  await expect(
    page.getByRole("button", { name: "Request free Sweeps Coins" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("free-entry-inactive.png"),
    fullPage: true,
  });
});

test("free entry records consent, retries the same receipt and displays only confirmed awards", async ({
  page,
}, info) => {
  await account(page);
  const program = {
    id: E,
    version: "Test rules v4",
    sponsor: "Browser test sponsor",
    title: "Test-only program",
    official_rules_url: "https://rules.example.test/official",
    free_sc: "1.000000",
    entries_per_period: 1,
    period_hours: 24,
    minimum_age: 21,
    territories: ["US-CA"],
    starts_at: "2026-10-01T00:00:00Z",
    ends_at: "2030-01-01T00:00:00Z",
  };
  let consent = false,
    credited = false,
    attempts = [];
  await page.route("**/api/v1/app/program", (r) =>
    r.fulfill({ json: { program } }),
  );
  await page.route("**/api/v1/app/me", (r) =>
    r.fulfill({
      json: {
        user_id: A,
        handle: "Free_Racer",
        gc_balance: "1000.000000",
        sc_balance: credited ? "1.000000" : "0.000000",
        gc_locked_entry: "0.000000",
        sc_locked_entry: "0.000000",
        sc_eligible: consent,
        identities: [],
        contracts: [],
        history: [],
      },
    }),
  );
  await page.route("**/api/v1/app/lobby", (r) =>
    r.fulfill({ json: { events: [], offers: [], players: [] } }),
  );
  await page.route("**/api/v1/app/catalog", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/v1/app/compliance", (r) =>
    r.fulfill({
      json: {
        program,
        eligible: consent,
        consent_recorded: consent,
        reason: consent ? "eligible" : "rules_consent_required",
        entries_remaining: credited ? 0 : 1,
        next_period_at: "2030-01-02T00:00:00Z",
        requests: credited
          ? [
              {
                id: attempts[0].request_id,
                program_id: E,
                state: "Credited",
                amount: "1.000000",
                reason: "free_entry_confirmed",
                created_at: "2026-10-06T09:00:00Z",
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/v1/app/compliance/consent", (r) => {
    expect(r.request().postDataJSON()).toEqual({
      program_id: E,
      accept_terms: true,
    });
    consent = true;
    return r.fulfill({ json: { consent_recorded: true } });
  });
  await page.route("**/api/v1/app/ame", (r) => {
    attempts.push(r.request().postDataJSON());
    if (attempts.length === 1)
      return r.fulfill({ status: 503, json: { error: "retry_same_request" } });
    credited = true;
    return r.fulfill({
      json: {
        id: attempts[0].request_id,
        state: "Credited",
        amount: "1.000000",
      },
    });
  });
  await page.goto("/#help");
  const panel = page.locator("#free-entry");
  await expect(
    panel.getByRole("button", { name: "Record rules acceptance" }),
  ).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Record rules acceptance" }).click();
  await expect(
    panel.getByRole("button", { name: "Request free Sweeps Coins" }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "Request free Sweeps Coins" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The action was not confirmed" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Request free Sweeps Coins" }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "Request free Sweeps Coins" })
    .click();
  await expect(
    panel.getByRole("button", { name: "Request free Sweeps Coins" }),
  ).toBeDisabled();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect(panel).toContainText("1.000000");
  await expect(panel).toContainText("Credited");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Export my receipts" }).click();
  expect((await download).suggestedFilename()).toBe(
    "gridstake-free-entry-receipts.json",
  );
  await page.screenshot({
    path: info.outputPath("free-entry-confirmed.png"),
    fullPage: true,
  });
});

test("cash redemption retries the persisted request across reload and shows only confirmed state", async ({
  page,
}, info) => {
  await account(page);
  await page.route("**/api/v1/app/config", (r) =>
    r.fulfill({
      json: {
        accounts_available: true,
        supabase_url: "https://example.supabase.co",
        publishable_key: "sb_publishable_test",
        tenant_id: E,
        redemption_available: true,
        kyc_available: true,
      },
    }),
  );
  const profile = {
    user_id: A,
    handle: "Grid_Racer",
    gc_balance: "1000.000000",
    sc_balance: "90.000000",
    sc_locked_entry: "0.000000",
    gc_locked_entry: "0.000000",
    sc_eligible: true,
    identities: [],
    contracts: [],
    history: [],
  };
  let state = {
    kyc_status: "Verified",
    bank_connected: true,
    redeemable_sc: "90.000000",
    requests: [],
  };
  await page.route("**/api/v1/app/me", (r) => r.fulfill({ json: profile }));
  await page.route("**/api/v1/app/lobby", (r) =>
    r.fulfill({ json: { events: [], offers: [] } }),
  );
  await page.route("**/api/v1/app/catalog", (r) =>
    r.fulfill({ json: { packages: [] } }),
  );
  await page.route("**/api/v1/app/redemptions", (r) =>
    r.fulfill({ json: state }),
  );
  const attempts = [];
  await page.route("**/api/v1/app/redeem", (r) => {
    const body = r.request().postDataJSON();
    attempts.push(body);
    if (attempts.length === 1)
      return r.fulfill({ status: 503, json: { error: "retry_same_request" } });
    state = {
      ...state,
      redeemable_sc: "40.000000",
      requests: [
        { id: body.request_id, amount_sc: "50.000000", state: "Reserved" },
      ],
    };
    profile.sc_balance = "40.000000";
    return r.fulfill({
      status: 202,
      json: { id: body.request_id, state: "Reserved", amount_sc: "50.000000" },
    });
  });
  await page.goto("/#wallet");
  await page
    .getByRole("button", { name: /View eligibility & redemption/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("90.000000", { exact: true })).toBeVisible();
  await expect(dialog.locator("input")).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "Request redemption", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Retry with the same amount",
  );
  await expect(dialog.getByText("90.000000", { exact: true })).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: /View eligibility & redemption/ })
    .click();
  await expect(page.getByLabel("Amount in SC")).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry saved request" }).click();
  await expect(dialog.getByRole("status")).toContainText("confirmed: Reserved");
  expect(attempts[0]).toEqual(attempts[1]);
  await expect(dialog.getByText("40.000000", { exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("redemption-reserved.png"),
    fullPage: true,
  });
});
test("public program rules disclose publication status and keep the unverified postal address inactive", async ({
  page,
}, info) => {
  await page.goto("/sweepstakes-rules.html");
  await expect(
    page.getByRole("heading", {
      name: "Program rules. Clear terms, before entry.",
    }),
  ).toBeVisible();
  await expect(page.locator("#program-status")).toContainText(
    "No active operator promotion",
  );
  await expect(page.locator("#entry")).toContainText("Do not send mail");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("program-rules.png"),
    fullPage: true,
  });
});
