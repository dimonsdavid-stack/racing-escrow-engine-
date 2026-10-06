import { pathToFileURL } from "node:url";
import { createAdminClient, callRpc } from "./settlement.js";
import { payoutClient, reconcileRedemption } from "./redemption.js";
export async function processRedemption(admin, stripe) {
  const j = await callRpc(admin, "cash_lease", {});
  if (!j || j.empty === true) return false;
  try {
    await reconcileRedemption(admin, stripe, j);
  } finally {
    await callRpc(admin, "cash_release", {
      p_tenant_id: j.tenant_id,
      p_request_id: j.id,
      p_lease_token: j.lease_token,
    });
  }
  return true;
}
export async function runRedemptionWorker() {
  const admin = createAdminClient(),
    stripe = payoutClient();
  let stopping = false;
  const controller = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      stopping = true;
      controller.abort();
    });
  while (!stopping) {
    try {
      if (await processRedemption(admin, stripe)) continue;
    } catch {
      console.error(
        JSON.stringify({
          worker: "redemptions",
          status: "reconciliation_retry_required",
        }),
      );
    }
    if (!stopping)
      await new Promise((resolve) => {
        const timer = setTimeout(done, 10000);
        function done() {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", done);
          resolve();
        }
        controller.signal.addEventListener("abort", done, { once: true });
      });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runRedemptionWorker().catch(() => {
    console.error("redemption_worker_configuration_required");
    process.exitCode = 1;
  });
