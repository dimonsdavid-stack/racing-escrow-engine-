import { createHash } from "node:crypto";
import { z } from "zod";
import { callRpc } from "./settlement.js";

export const EventRegistration = z
  .object({
    event_id: z.uuid(),
    game: z.enum(["iracing", "acc"]),
    external_session_id: z.string().min(1).max(100),
    title: z.string().min(1).max(120),
    track_name: z.string().min(1).max(120),
    starts_at: z.iso.datetime({ offset: true }),
    funding_closes_at: z.iso.datetime({ offset: true }),
    deadline: z.iso.datetime({ offset: true }),
    rule: z.enum(["fastest_clean_lap", "finish_position"]),
    entrants: z.array(z.string().min(1).max(80)).min(2).max(200),
    min_lap_seconds: z
      .string()
      .regex(/^\d{1,5}(?:\.\d{1,6})?$/)
      .default("1.000000"),
    max_lap_seconds: z
      .string()
      .regex(/^\d{1,5}(?:\.\d{1,6})?$/)
      .default("3600.000000"),
  })
  .strict()
  .refine((d) => new Set(d.entrants).size === d.entrants.length);
export const ProviderReport = z
  .object({
    challenge_id: z.uuid(),
    event_id: z.uuid(),
    source_id: z.string().min(1).max(180),
    external_session_id: z.string().min(1).max(100),
    track_name: z.string().min(1).max(120),
    actual_start: z.iso.datetime({ offset: true }),
    final: z.literal(true),
    race_status: z.enum(["completed", "network_drop"]),
    drivers: z
      .array(
        z
          .object({
            external_id: z.string().min(1).max(80),
            finish_position: z
              .number()
              .int()
              .positive()
              .max(200)
              .nullable()
              .optional(),
            laps: z
              .array(
                z
                  .object({
                    is_clean: z.boolean(),
                    flags: z.number().int().min(0).max(4294967295).optional(),
                    lap_time_seconds: z.union([
                      z.string().regex(/^-?\d{1,6}(?:\.\d{1,6})?$/),
                      z.number().finite(),
                    ]),
                  })
                  .strict(),
              )
              .max(2000),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .refine(
    (d) =>
      new Set(d.drivers.map((x) => x.external_id)).size === d.drivers.length,
  );
export function decimalMicros(value) {
  const s = String(value);
  if (!/^\d{1,6}(?:\.\d{1,6})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const n = BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, "0"));
  return n > 0n && n <= 86400000000n ? n : null;
}
export function microsText(n) {
  return `${n / 1000000n}.${String(n % 1000000n).padStart(6, "0")}`;
}
export function providerDecision(report, context) {
  if (
    report.event_id !== context.event_id ||
    report.external_session_id !== context.external_session_id ||
    report.track_name !== context.track_name
  )
    throw new Error("provider_binding_mismatch");
  const selections = [context.selection_a, context.selection_b];
  const minimum = decimalMicros(context.min_lap_seconds ?? "1.000000");
  const maximum = decimalMicros(context.max_lap_seconds ?? "3600.000000");
  if (
    context.rule === "fastest_clean_lap" &&
    (minimum === null || maximum === null || maximum <= minimum)
  )
    throw new Error("invalid_registered_lap_bounds");
  const metrics = selections.map((id) => {
    const d = report.drivers.find((x) => x.external_id === id);
    if (!d && report.race_status !== "network_drop")
      throw new Error("incomplete_driver_report");
    if (context.rule === "finish_position")
      return d?.finish_position ? BigInt(d.finish_position) * 1000000n : null;
    let best = null;
    for (const lap of d?.laps ?? []) {
      if (lap.is_clean !== true || (lap.flags !== undefined && lap.flags !== 0))
        continue;
      const time = decimalMicros(lap.lap_time_seconds);
      if (
        time !== null &&
        time >= minimum &&
        time <= maximum &&
        (best === null || time < best)
      )
        best = time;
    }
    return best;
  });
  const [a, b] = metrics;
  const resolution =
    report.race_status === "network_drop"
      ? "network_drop"
      : a === null && b === null
        ? "no_clean_laps"
        : a === b
          ? "tie"
          : "winner";
  return {
    resolution,
    best_a: a === null ? null : microsText(a),
    best_b: b === null ? null : microsText(b),
  };
}
export async function commitProviderReport(client, identity, report, hash) {
  const context = await callRpc(client, "sim_result_context", {
    p_tenant_id: identity.tenantId,
    p_challenge_id: report.challenge_id,
  });
  if (!context || context.provider_id !== identity.providerId)
    throw new Error("provider_binding_mismatch");
  const d = providerDecision(report, context);
  return callRpc(client, "sim_commit_result", {
    p_tenant_id: identity.tenantId,
    p_provider_id: identity.providerId,
    p_challenge_id: report.challenge_id,
    p_source_id: report.source_id,
    p_external_session_id: report.external_session_id,
    p_track_name: report.track_name,
    p_actual_start: report.actual_start,
    p_payload_sha256: hash,
    p_resolution: d.resolution,
    p_best_a: d.best_a,
    p_best_b: d.best_b,
    p_summary: {
      game: context.game,
      rule: context.rule,
      source_id: report.source_id,
      selection_a: context.selection_a,
      selection_b: context.selection_b,
      best_a: d.best_a,
      best_b: d.best_b,
      resolution: d.resolution,
      source_sha256: hash,
    },
  });
}
// A pre-approved results bridge signs this normalized contract. Browser clients
// never send laps. ACC hosts translate server result files using normalizeACC.
export function normalizeACC(result, binding) {
  if (
    result.trackName !== binding.track_name ||
    result.metaData !== binding.external_session_id ||
    !Array.isArray(result.laps) ||
    !Array.isArray(result.sessionResult?.leaderBoardLines)
  )
    throw new Error("acc_result_binding_or_schema");
  const rows = result.sessionResult.leaderBoardLines,
    drivers = new Map();
  rows.forEach((row, index) => {
    for (const driver of row.car?.drivers ?? []) {
      if (typeof driver.playerId !== "string")
        throw new Error("acc_missing_driver_identity");
      drivers.set(driver.playerId, {
        external_id: driver.playerId,
        finish_position: index + 1,
        laps: [],
      });
    }
  });
  for (const lap of result.laps) {
    const car = rows.find((r) => r.car?.carId === lap.carId)?.car;
    if (!car) throw new Error("acc_unknown_car");
    const driver =
      car.drivers?.[
        Number.isInteger(lap.driverIndex)
          ? lap.driverIndex
          : car.drivers?.length === 1
            ? 0
            : -1
      ];
    if (
      !driver ||
      typeof lap.isValidForBest !== "boolean" ||
      !Number.isSafeInteger(lap.lapTime)
    )
      throw new Error("acc_ambiguous_lap");
    drivers.get(driver.playerId).laps.push({
      is_clean: lap.isValidForBest,
      lap_time_seconds:
        lap.lapTime > 0 ? microsText(BigInt(lap.lapTime) * 1000n) : "0",
    });
  }
  return ProviderReport.parse({
    ...binding,
    final: true,
    race_status: "completed",
    drivers: [...drivers.values()],
  });
}
export function maskIRacingSecret(secret, identifier) {
  return createHash("sha256")
    .update(secret + identifier.trim().toLowerCase())
    .digest("base64");
}
export function downloadURL(value, hosts) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !hosts.has(u.hostname)
  )
    throw new Error("unapproved_provider_download");
  return u;
}
export async function boundedJSON(
  url,
  { fetcher = fetch, headers = {}, hosts, maxBytes = 8 * 1024 * 1024 } = {},
) {
  if (hosts) downloadURL(url, hosts);
  const response = await fetcher(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("provider_request_failed");
  if (Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("provider_response_too_large");
  if (!response.body) throw new Error("provider_empty_response");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new Error("provider_response_too_large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}
export class IRacingDataClient {
  constructor({ accessToken, downloadHosts, fetcher = fetch }) {
    if (!accessToken || !downloadHosts?.size)
      throw new Error("iracing_configuration_required");
    this.token = accessToken;
    this.hosts = downloadHosts;
    this.fetcher = fetcher;
  }
  async data(path, params = {}) {
    if (!/^\/data\/(member\/info|results\/(get|lap_data))$/.test(path))
      throw new Error("unapproved_data_endpoint");
    const url = new URL(path, "https://members-ng.iracing.com");
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, String(v));
    const response = await boundedJSON(url, {
      fetcher: this.fetcher,
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return typeof response.link === "string"
      ? boundedJSON(response.link, { hosts: this.hosts, fetcher: this.fetcher })
      : response;
  }
  async lapData(session, custId) {
    const data = await this.data("/data/results/lap_data", {
      subsession_id: session,
      simsession_number: 0,
      cust_id: custId,
    });
    if (Array.isArray(data)) return data;
    const c = data.chunk_info;
    if (
      data.success !== true ||
      !c ||
      !Array.isArray(c.chunk_file_names) ||
      c.chunk_file_names.length > 40 ||
      c.num_chunks !== c.chunk_file_names.length
    )
      throw new Error("unsupported_iracing_lap_schema");
    const all = [];
    for (const name of c.chunk_file_names) {
      if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(name))
        throw new Error("invalid_chunk_name");
      const chunk = await boundedJSON(new URL(name, c.base_download_url), {
        hosts: this.hosts,
        fetcher: this.fetcher,
      });
      if (!Array.isArray(chunk) || all.length + chunk.length > 10000)
        throw new Error("invalid_lap_chunk");
      all.push(...chunk);
    }
    return all;
  }
  async report(context) {
    if (!/^\d{1,12}$/.test(context.external_session_id))
      throw new Error("invalid_iracing_session");
    const result = await this.data("/data/results/get", {
      subsession_id: context.external_session_id,
    });
    if (
      String(result.subsession_id) !== context.external_session_id ||
      result.track?.track_name !== context.track_name ||
      !result.start_time ||
      !Array.isArray(result.session_results)
    )
      throw new Error("iracing_result_binding_or_schema");
    const race = result.session_results.find((s) => s.simsession_number === 0);
    if (!Array.isArray(race?.results))
      throw new Error("iracing_session_incomplete");
    const drivers = [];
    for (const id of [context.selection_a, context.selection_b]) {
      const driver = race.results.find((r) => String(r.cust_id) === id);
      if (!driver) throw new Error("iracing_driver_missing");
      const laps = await this.lapData(context.external_session_id, id);
      drivers.push({
        external_id: id,
        finish_position: Number.isInteger(driver.finish_position)
          ? driver.finish_position + 1
          : null,
        laps: laps.map((l) => {
          if (
            String(l.cust_id) !== id ||
            !Number.isSafeInteger(l.lap_time) ||
            !Array.isArray(l.lap_events)
          )
            throw new Error("unsupported_iracing_lap_validity");
          // Missing validity is a schema error. SessionFlags are never a clean-lap proof.
          return {
            is_clean: l.lap_events.length === 0,
            lap_time_seconds:
              l.lap_time > 0 ? microsText(BigInt(l.lap_time) * 100n) : "0",
          };
        }),
      });
    }
    return ProviderReport.parse({
      challenge_id: context.challenge_id,
      event_id: context.event_id,
      source_id: `iracing:${context.external_session_id}:${context.challenge_id}`,
      external_session_id: context.external_session_id,
      track_name: context.track_name,
      actual_start: new Date(result.start_time).toISOString(),
      final: true,
      race_status: "completed",
      drivers,
    });
  }
}
