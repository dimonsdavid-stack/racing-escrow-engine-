export function corsPolicy(env = process.env) {
  const origins = new Set();
  for (const value of [
    env.APP_ORIGIN,
    ...(env.CORS_ALLOWED_ORIGINS || "").split(","),
  ].filter(Boolean)) {
    const url = new URL(value.trim());
    if (
      url.origin !== value.trim() ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          env.NODE_ENV !== "production" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    ) {
      throw new Error("invalid_cors_origin");
    }
    origins.add(url.origin);
  }
  return (req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const origin = req.get("origin");
    if (!origin) return next();
    res.vary("Origin");
    if (!origins.has(origin))
      return res.status(403).json({ error: "origin_not_allowed" });
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Expose-Headers", "X-Request-Id, Retry-After");
    if (req.method !== "OPTIONS") return next();
    const method = req.get("access-control-request-method");
    const headers = (req.get("access-control-request-headers") || "")
      .toLowerCase()
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (
      !["GET", "POST"].includes(method) ||
      headers.some((v) => !["authorization", "content-type"].includes(v))
    )
      return res.status(403).json({ error: "preflight_not_allowed" });
    res.set({
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    });
    return res.status(204).end();
  };
}
