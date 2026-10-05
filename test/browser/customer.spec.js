import { test, expect } from "@playwright/test";

// UI contract test with isolated fixtures. Real SQL authorization and atomic
// funding are separately exercised in the PostgreSQL suites, never mocked there.
test("confirmed account UI renders exact balances, acceptance terms and funded receipts", async ({
  page,
}, info) => {
  const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    offer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const profile = {
    user_id: uuid,
    handle: "Grid_Racer",
    gc_balance: "1000.000000",
    sc_balance: "0.000000",
    gc_locked_entry: "0.000000",
    sc_locked_entry: "0.000000",
    sc_eligible: false,
    pause_until: null,
    races: [],
    history: [],
  };
  const calls = [],
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/v1/app/config", (r) =>
    r.fulfill({
      json: {
        accounts_available: true,
        supabase_url: "https://example.supabase.co",
        publishable_key: "sb_publishable_test",
        commerce_available: false,
        redemption_available: false,
      },
    }),
  );
  await page.route("https://example.supabase.co/auth/v1/**", (r) =>
    r.fulfill({
      json: {
        access_token: "a".repeat(30),
        refresh_token: "b".repeat(30),
        expires_in: 3600,
      },
    }),
  );
  await page.route("**/api/v1/app/me", (r) => r.fulfill({ json: profile }));
  await page.route("**/api/v1/app/lobby", (r) =>
    r.fulfill({
      json: {
        tracks: [{ id: "coastal", enabled: true, session_minutes: 15 }],
        offers: [
          {
            id: offer,
            track_id: "coastal",
            token_type: "GC",
            entry_fee: "10.000000",
            handle: "Rival",
            session_minutes: 15,
            mine: false,
            expires_at: "2030-01-01T00:00:00Z",
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/app/accept", (r) => {
    calls.push(r.request().postDataJSON());
    profile.gc_balance = "990.000000";
    profile.gc_locked_entry = "10.000000";
    profile.races = [
      {
        id: offer,
        track_id: "coastal",
        opponent: "Rival",
        status: "Active",
        token_type: "GC",
        entry_fee: "10.000000",
        total_escrow_pool: "20.000000",
        platform_rake: "2.000000",
        rake_charged: "0.000000",
        remaining_escrow: "20.000000",
        session_id: uuid,
        created_at: "2026-10-05T12:00:00Z",
        telemetry_deadline: "2030-01-01T00:00:00Z",
        resolution: null,
      },
    ];
    return r.fulfill({
      json: { challenge_id: offer, status: "Active", duplicate: false },
    });
  });
  await page.goto("/");
  await expect(page.locator(".track-card")).toHaveCount(3);
  await page.locator("#account-button").click();
  await page.locator("#signin-tab").click();
  await page.locator("#email").fill("racer@example.test");
  await page.locator("#password").fill("Test-password-123");
  await page
    .locator("#auth-form")
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.locator("#header-balance")).toHaveText("1,000");
  await page.getByRole("button", { name: "Review & join" }).click();
  await expect(page.locator("#modal-content .receipt")).toContainText(
    "20.0 GC",
  );
  await expect(page.locator("#modal-content .receipt")).toContainText("2.0 GC");
  await expect(page.locator("#modal-content .receipt")).toContainText(
    "18.0 GC",
  );
  await page.locator("#accept-form input[type=checkbox]").check();
  await page.getByRole("button", { name: "Accept & lock entries" }).click();
  await expect(page.locator("#content")).toContainText("Active");
  expect(calls).toEqual([{ offer_id: offer, accept_terms: true }]);
  await page.getByRole("button", { name: "View ↗" }).click();
  await expect(page.locator("#modal-content")).toContainText(uuid);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.goto("/#wallet");
  await expect(page.locator(".metric").first()).toContainText("990");
  await expect(page.locator(".metric").nth(2)).toContainText("10");
  await page.screenshot({
    path: info.outputPath("wallet-contract.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("customer lobby, track discovery and honest account gating work without credentials", async ({
  page,
}, info) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon"))
      errors.push(m.text());
  });
  await page.goto("/");
  await expect(page.locator(".track-card")).toHaveCount(3);
  await expect(
    page.getByRole("heading", { name: /Your best lap/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("lobby.png"), fullPage: true });
  await page.locator("#account-button").click();
  await expect(page.locator("dialog")).toBeVisible();
  await expect(page.getByText("Account activation pending.")).toBeVisible();
  await expect(page.locator("dialog input")).toHaveCount(0);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.goto("/#practice");
  await expect(page.locator(".track-card")).toHaveCount(3);
  await page.getByRole("textbox", { name: "Search tracks" }).fill("night");
  await expect(page.locator(".track-card")).toHaveCount(1);
  await expect(page.locator(".track-card h3")).toHaveText("Night Run");
  await page
    .getByRole("textbox", { name: "Search tracks" })
    .fill("missing-track");
  await expect(page.getByText("No tracks match your search.")).toBeVisible();
  await page.getByRole("textbox", { name: "Search tracks" }).fill("");
  await page.getByRole("button", { name: "Rookie", exact: true }).click();
  await expect(page.locator(".track-card")).toHaveCount(1);
  await expect(page.locator(".track-card h3")).toHaveText("Coastal Sprint");
  for (const route of [
    "wallet",
    "races",
    "records",
    "guide",
    "fairplay",
    "settings",
    "rules",
    "privacy",
  ]) {
    await page.goto("/#" + route);
    await expect(page.locator("#content h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("keyboard and pointer controls move the car; pause and restart preserve practice isolation", async ({
  page,
}, info) => {
  const errors = [],
    writes = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.method() === "POST") writes.push(r.url());
  });
  await page.goto("/#drive/coastal");
  await expect(page.locator("#race-canvas")).toBeVisible();
  await page.locator("#play-game").click();
  if (info.project.name === "mobile") {
    const throttle = page.getByRole("button", { name: "Accelerate" });
    await throttle.scrollIntoViewIfNeeded();
    const box = await throttle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect
      .poll(async () =>
        Number((await page.locator("#speed").textContent()).split(" ")[0]),
      )
      .toBeGreaterThan(0);
    await page.mouse.up();
  } else {
    await page.keyboard.down("ArrowUp");
    await expect
      .poll(async () =>
        Number((await page.locator("#speed").textContent()).split(" ")[0]),
      )
      .toBeGreaterThan(0);
    await page.keyboard.up("ArrowUp");
  }
  await page.locator("#pause-game").click();
  const paused = await page.locator("#lap-time").textContent();
  await page.waitForTimeout(250);
  expect(await page.locator("#lap-time").textContent()).toBe(paused);
  await page.screenshot({
    path: info.outputPath("practice.png"),
    fullPage: true,
  });
  await page.locator("#reset-game").click();
  await expect(page.locator("#lap-time")).toHaveText("0:00.000");
  await expect(page.locator("#speed")).toHaveText("0 km/h");
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await page.goto("/#records");
  await expect(page.locator("#content h1")).toBeVisible();
});
