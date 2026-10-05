import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeApp } from "../src/runtime.js";
import { createApp } from "../src/app.js";
import { randomBytes } from "node:crypto";
import { T, P } from "./fixtures.js";

async function withApp(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("missing or invalid server configuration leaves health online and settlement disabled", async () => {
  for (const env of [
    {},
    { TELEMETRY_KEYS_JSON: "{secret-data" },
    {
      TELEMETRY_KEYS_JSON: JSON.stringify([
        {
          key_id: "deployment-test",
          tenant_id: T,
          provider_id: P,
          secret_base64: randomBytes(32).toString("base64"),
        },
      ]),
      SUPABASE_URL: "https://example.supabase.co",
    },
  ]) {
    await withApp(createRuntimeApp(env), async (origin) => {
      const health = await fetch(`${origin}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok" });
      const status = await (await fetch(`${origin}/api/v1/status`)).json();
      assert.equal(status.settlement, "configuration_required");
      assert.equal(status.database_connectivity, "unchecked");
      const denied = await fetch(`${origin}/api/v1/telemetry/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(denied.status, 503);
      assert.deepEqual(await denied.json(), {
        error: "service_not_configured",
      });
      const serialized = JSON.stringify(status);
      assert.ok(
        !serialized.includes("supabase.co") &&
          !serialized.includes("secret-data"),
      );
    });
  }
});

test("configured status does not claim database readiness or bypass signature verification", async () => {
  let calls = 0;
  await withApp(
    createApp({
      client: {
        rpc() {
          calls++;
        },
      },
      keys: new Map([
        ["test", { tenantId: T, providerId: P, secret: randomBytes(32) }],
      ]),
    }),
    async (origin) => {
      const response = await fetch(`${origin}/api/v1/status`);
      assert.equal(response.status, 200);
      const status = await response.json();
      assert.equal(status.settlement, "configured");
      assert.equal(status.database_connectivity, "unchecked");
      const denied = await fetch(`${origin}/api/v1/telemetry/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(denied.status, 401);
    },
  );
  assert.equal(calls, 0);
});

test("Vercel entrypoint imports without secrets and serves customer app assets", async () => {
  const { default: app } = await import("../server.js");
  await withApp(app, async (origin) => {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy"),
      /default-src 'self'/,
    );
    assert.equal(page.headers.get("x-powered-by"), null);
    const html = await page.text();
    assert.match(html, /name="viewport"/);
    assert.match(html, /type="module" src="\/app.js"/);
    for (const path of ["/app.css", "/app.js", "/game.js", "/physics.js"]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 200);
    }
    assert.equal((await fetch(`${origin}/.env`)).status, 404);
    assert.equal((await fetch(`${origin}/sql/001_engine.sql`)).status, 404);
  });
});

test("HTTP refund worker denies missing/wrong secrets and runs bounded atomic refund RPCs", async () => {
  const secret = "x".repeat(48),
    calls = [];
  const client = {
    rpc(name, args) {
      calls.push({ name, args });
      return {
        abortSignal() {
          return Promise.resolve({
            data:
              name === "list_expired_challenges"
                ? [{ tenant_id: T, challenge_id: P }]
                : { duplicate: false },
            error: null,
            status: 200,
          });
        },
      };
    },
  };
  await withApp(
    createApp({ client, cronSecret: secret, log: () => {} }),
    async (origin) => {
      const path = origin + "/api/v1/operations/refund-expired";
      assert.equal((await fetch(path)).status, 401);
      assert.equal(
        (await fetch(path, { headers: { Authorization: "Bearer incorrect" } }))
          .status,
        401,
      );
      assert.equal(calls.length, 0);
      const response = await fetch(path, {
        headers: { Authorization: "Bearer " + secret },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { processed: 1, failures: 0 });
      assert.equal(calls[0].name, "list_expired_challenges");
      assert.equal(calls[0].args.p_limit, 10);
      assert.equal(calls[1].name, "refund_expired_challenge");
    },
  );
  await withApp(createApp({ client }), async (origin) =>
    assert.equal(
      (await fetch(origin + "/api/v1/operations/refund-expired")).status,
      503,
    ),
  );
});
