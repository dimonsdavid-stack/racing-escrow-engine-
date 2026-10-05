import express from 'express';
import { createRuntimeApp } from './src/runtime.js';

// First-class Vercel Express entrypoint: no listening socket at import time.
const app = express();
app.disable('x-powered-by');
app.use(createRuntimeApp());
export default app;
