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
