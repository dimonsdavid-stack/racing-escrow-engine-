import { callRpc, createAdminClient } from "./settlement.js";
import { IRacingDataClient, commitProviderReport } from "./providers.js";
import { operatorAccessToken } from "./oauth.js";
import { createHash } from "node:crypto";
import { sweep } from "./sweep.js";
import { pathToFileURL } from "node:url";
export async function processResults(client, env = process.env) {
  const jobs = await callRpc(client, "sim_lease_jobs", { p_limit: 5 });
  let done = 0,
    retry = 0;
  for (const j of jobs) {
    try {
      const context = await callRpc(client, "sim_result_context", {
        p_tenant_id: j.tenant_id,
        p_challenge_id: j.challenge_id,
      });
      if (context.game !== "iracing")
        throw new Error("awaiting_signed_acc_host_report");
      const accessToken = await operatorAccessToken(
        client,
        j.tenant_id,
        env.IRACING_OPERATOR_AUTH_USER_ID,
        env,
      );
      const api = new IRacingDataClient({
        accessToken,
        downloadHosts: new Set(
          (env.IRACING_DOWNLOAD_HOSTS ?? "").split(",").map((s) => s.trim()),
        ),
      });
      const report = await api.report(context),
        hash = createHash("sha256")
          .update(JSON.stringify(report))
          .digest("hex");
      await commitProviderReport(
        client,
        { tenantId: j.tenant_id, providerId: context.provider_id },
        report,
        hash,
      );
      done++;
    } catch {
      retry++;
      await callRpc(client, "sim_retry_job", {
        p_tenant_id: j.tenant_id,
        p_challenge_id: j.challenge_id,
        p_lease_token: j.lease_token,
      });
    }
  }
  return { done, retry };
}
export async function runWorker() {
  const client = createAdminClient();
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  while (!stopping) {
    try {
      const results = await processResults(client),
        refunds = await sweep(client, { limit: 50 });
      console.log(JSON.stringify({ worker: "results", ...results, refunds }));
      await callRpc(
        client,
        "grid_cleanup_budgets",
        {},
        { attempts: 1, timeoutMs: 2000 },
      );
    } catch {
      console.error(
        JSON.stringify({ worker: "results", status: "retry_required" }),
      );
    }
    if (!stopping) await new Promise((r) => setTimeout(r, 15000));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runWorker().catch(() => {
    console.error("worker_configuration_required");
    process.exitCode = 1;
  });
