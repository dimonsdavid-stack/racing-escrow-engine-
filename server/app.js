// Express application shared by standalone Node and Vercel. Raw webhook parsers
// are registered before JSON parsing. Importing this module does not open a port.
import { createRuntimeApp } from "../src/runtime.js";
export default createRuntimeApp();
