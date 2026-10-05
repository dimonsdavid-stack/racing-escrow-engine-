import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { authenticate, SIGNING_PATH } from './signature.js';
import { Telemetry, decide } from './telemetry.js';
import { RpcError, settleCalculatedWinner, retryable } from './settlement.js';
import { safeLogger } from './logging.js';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

export function createApp({ client, keys = new Map(), log = record => console.log(JSON.stringify(record)), rpcOptions } = {}) {
  const writeLog = safeLogger(log);
  const configured = Boolean(client && keys.size);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set({ 'X-Request-Id': req.requestId, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/v1/status', (_req, res) => res.json({
    service: 'racing-escrow-engine', version: '1.1.0',
    settlement: configured ? 'configured' : 'configuration_required',
    database_connectivity: 'unchecked'
  }));
  app.use(express.static(publicDirectory, {
    dotfiles: 'deny', redirect: false, etag: false, lastModified: false,
    setHeaders(res) {
      res.set('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
  }));
  // Never register express.json() before this route: authenticate the EXACT bytes.
  app.post(SIGNING_PATH, (req, res, next) => {
    if (!configured) {
      res.set('Retry-After', '60');
      return res.status(503).json({ error: 'service_not_configured' });
    }
    if (!req.is('application/json')) return res.status(415).json({ error: 'application_json_required' });
    next();
  }, express.raw({ type: 'application/json', limit: '1mb', inflate: false }), async (req, res) => {
    const started = Date.now();
    const identity = authenticate(req, keys);
    if (!identity) return res.status(401).json({ error: 'invalid_signature' });
    let decoded;
    try {
      // Fatal UTF-8 decode prevents silently accepting replacement characters.
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body));
    } catch { return res.status(400).json({ error: 'invalid_json' }); }
    const parsed = Telemetry.safeParse(decoded);
    if (!parsed.success) return res.status(422).json({ error: 'invalid_telemetry' });
    const payload = parsed.data;
    const decision = decide(payload);
    const payloadSha256 = createHash('sha256').update(req.body).digest('hex');
    const context = { request_id: req.requestId, tenant_id: identity.tenantId,
      provider_id: identity.providerId, challenge_id: payload.challenge_id, event_id: payload.event_id };
    try {
      const result = await settleCalculatedWinner(client, identity, payload, decision, payloadSha256, rpcOptions);
      writeLog({ ...context, outcome: result.resolution, duplicate: result.duplicate, duration_ms: Date.now() - started });
      return res.status(200).json(result);
    } catch (cause) {
      const error = cause instanceof RpcError ? cause : new RpcError('NETWORK');
      writeLog({ ...context, outcome: 'rpc_error', code: error.code, duration_ms: Date.now() - started });
      if (retryable(error)) {
        res.set('Retry-After', '2');
        return res.status(503).json({ error: 'retry_same_event', request_id: req.requestId });
      }
      const status = ({ PT400: 400, PT403: 403, PT404: 404, PT409: 409, '23505': 409 })[error.code] ?? 500;
      return res.status(status).json({ error: status === 500 ? 'internal_error' : 'event_rejected', request_id: req.requestId });
    }
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413
      : Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    writeLog({ request_id: req.requestId, outcome: 'request_rejected', status });
    if (!res.headersSent) res.status(status).json({ error: 'invalid_request' });
  });
  return app;
}
