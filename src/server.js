import { createRuntimeApp } from "./runtime.js";
import { parseKeys } from "./signature.js";
import { createAdminClient } from "./settlement.js";

let server;
try {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("invalid_port");
  const client = createAdminClient();
  const keys = parseKeys(process.env.TELEMETRY_KEYS_JSON || "[]");
  server = createRuntimeApp().listen(port, "0.0.0.0", () =>
    console.log(JSON.stringify({ event: "listening", port })),
  );
  server.requestTimeout = 45000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on("error", () => {
    console.error("server_failed");
    process.exit(1);
  });
} catch {
  // Do not print configuration exceptions: validation libraries may include secrets.
  console.error("startup_failed_check_server_configuration");
  process.exit(1);
}
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 45000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
