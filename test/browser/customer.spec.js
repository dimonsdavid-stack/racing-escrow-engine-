import { test, expect } from "@playwright/test";

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
