// Run on the trusted ACC server host with a final results file and session log.
// Requires its own provider HMAC key, never a Supabase service-role key.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalizeACC } from "../src/providers.js";
import { signBody } from "../src/signature.js";
import { pathToFileURL } from "node:url";
export async function signedProviderPost(
  path,
  payload,
  env = process.env,
  fetcher = fetch,
) {
  const secret = Buffer.from(env.ACC_PROVIDER_SECRET_BASE64 ?? "", "base64"),
    origin = new URL(env.BACKEND_API_BASE_URL);
  if (secret.length < 32 || origin.protocol !== "https:")
    throw new Error("acc_bridge_configuration_required");
  const bytes = Buffer.from(JSON.stringify(payload));
  for (let attempt = 0; attempt < 3; attempt++) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const r = await fetcher(new URL(path, origin), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telemetry-Key-Id": env.ACC_PROVIDER_KEY_ID,
          "X-Telemetry-Timestamp": timestamp,
          "X-Telemetry-Signature": signBody(
            secret,
            env.ACC_PROVIDER_KEY_ID,
            timestamp,
            bytes,
            path,
          ),
        },
        body: bytes,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const result = await r.json();
      if (r.ok) return result;
      if (r.status < 500)
        throw Object.assign(new Error("provider_report_rejected"), {
          terminal: true,
        });
    } catch (e) {
      if (e.terminal) throw e;
    }
    if (attempt < 2)
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error("provider_confirmation_unknown_retry_same_files");
}
export async function submitACC(
  resultPath,
  sessionLogPath,
  env = process.env,
  post = signedProviderPost,
) {
  const [bytes, logBytes] = await Promise.all([
    readFile(resultPath),
    readFile(sessionLogPath),
  ]);
  if (bytes.length > 8 * 1024 * 1024 || logBytes.length > 32768)
    throw new Error("acc_source_too_large");
  const result = JSON.parse(bytes),
    log = JSON.parse(logBytes);
  if (
    typeof result.metaData !== "string" ||
    log.external_session_id !== result.metaData ||
    typeof log.actual_start !== "string" ||
    !Number.isFinite(Date.parse(log.actual_start))
  )
    throw new Error("acc_session_log_binding_required");
  const digest = createHash("sha256")
    .update(bytes)
    .update(logBytes)
    .digest("hex");
  let after = null,
    completed = 0;
  for (let page = 0; page < 10000; page++) {
    const contexts = await post(
      "/api/v1/providers/contracts",
      { external_session_id: result.metaData, after },
      env,
    );
    if (!Array.isArray(contexts) || contexts.length > 100)
      throw new Error("invalid_contract_response");
    if (!contexts.length) return { submitted: completed };
    for (const c of contexts) {
      if (c.game !== "acc") throw new Error("wrong_simulator_contract");
      const report = normalizeACC(result, {
        challenge_id: c.challenge_id,
        event_id: c.event_id,
        source_id: `acc:${c.challenge_id}:${digest}`,
        external_session_id: c.external_session_id,
        track_name: c.track_name,
        actual_start: log.actual_start,
      });
      await post("/api/v1/providers/results", report, env);
      completed++;
    }
    after = contexts.at(-1).challenge_id;
    if (contexts.length < 100) return { submitted: completed };
  }
  throw new Error("acc_contract_page_limit");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.argv[2] || !process.argv[3]) {
    console.error(
      "usage: node server/acc-bridge.js final-result.json session-log.json",
    );
    process.exitCode = 1;
  } else
    submitACC(process.argv[2], process.argv[3])
      .then((r) => console.log(JSON.stringify(r)))
      .catch(() => {
        console.error("acc_report_unconfirmed_retry_same_source_files");
        process.exitCode = 1;
      });
}
