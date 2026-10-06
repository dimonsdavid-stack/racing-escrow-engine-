import { readFile } from "node:fs/promises";
import { signBody } from "../src/signature.js";
const [path, file, role] = process.argv.slice(2);
const paths = {
  compliance: ["/api/v1/compliance/receipts"],
  operator: [
    "/api/v1/compliance/programs/publish",
    "/api/v1/compliance/programs/activate",
    "/api/v1/compliance/reviews/resolve",
  ],
  telemetry: ["/api/v1/providers/events", "/api/v1/telemetry/settle"],
};
if (!paths[role]?.includes(path) || !file)
  throw new Error("usage_send_signed_path_jsonfile_role");
const keyId = process.env.SIGNING_KEY_ID,
  secret = Buffer.from(process.env.SIGNING_SECRET_BASE64 || "", "base64");
if (
  !/^[a-zA-Z0-9_-]{1,80}$/.test(keyId ?? "") ||
  secret.length < 32 ||
  secret.toString("base64") !== process.env.SIGNING_SECRET_BASE64
)
  throw new Error("invalid_signing_configuration");
const origin = new URL(process.env.BACKEND_API_BASE_URL);
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/"
)
  throw new Error("https_backend_origin_required");
const body = await readFile(file);
if (body.length > 32768) throw new Error("payload_too_large");
JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
const timestamp = String(Math.floor(Date.now() / 1000));
const response = await fetch(new URL(path, origin), {
  method: "POST",
  redirect: "error",
  signal: AbortSignal.timeout(15000),
  headers: {
    "Content-Type": "application/json",
    "X-Telemetry-Key-Id": keyId,
    "X-Telemetry-Timestamp": timestamp,
    "X-Telemetry-Signature": signBody(secret, keyId, timestamp, body, path),
  },
  body,
});
console.log("HTTP " + response.status);
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
