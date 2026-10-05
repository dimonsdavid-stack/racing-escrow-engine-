import { createRuntimeApp } from "../src/runtime.js";
const port = Number(process.env.PORT || 3001);
const server = createRuntimeApp({}).listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
