import { createHash } from "node:crypto";
import { callRpc } from "./settlement.js";
export function verifyAuditRecords(
  records,
  { tenantId, userId, sequence = "0", hash = "0".repeat(64) },
) {
  let last = BigInt(sequence),
    previous = hash;
  if (!/^[0-9a-f]{64}$/.test(previous)) throw new Error("invalid_audit_anchor");
  for (const r of records) {
    const payload = JSON.parse(r.canonical_payload);
    if (
      BigInt(r.sequence) !== last + 1n ||
      r.previous_hash !== previous ||
      payload.tenant_id !== tenantId ||
      payload.user_id !== userId ||
      payload.sequence !== r.sequence ||
      payload.journal?.tenant_id !== tenantId ||
      payload.journal?.transaction_id !== r.transaction_id
    )
      throw new Error("audit_chain_binding_failed");
    const computed = createHash("sha256")
      .update(previous + "\n" + r.canonical_payload)
      .digest("hex");
    if (computed !== r.hash) throw new Error("audit_chain_hash_failed");
    const lines = payload.journal.lines;
    if (!Array.isArray(lines) || lines.length < 2)
      throw new Error("audit_journal_missing");
    const sum = lines.reduce((n, l) => {
      if (!/^-?\d+(?:\.\d{1,6})?$/.test(l.delta))
        throw new Error("audit_amount_invalid");
      const sign = l.delta.startsWith("-") ? -1n : 1n;
      const [a, b = ""] = l.delta.replace(/^-/, "").split(".");
      return n + sign * (BigInt(a) * 1000000n + BigInt(b.padEnd(6, "0")));
    }, 0n);
    if (sum !== 0n) throw new Error("audit_journal_unbalanced");
    last = BigInt(r.sequence);
    previous = r.hash;
  }
  return { sequence: last.toString(), hash: previous };
}
export async function exportWalletAudit(
  client,
  tenantId,
  userId,
  { sequence = "0", hash = "0".repeat(64) } = {},
) {
  let anchor = { sequence, hash },
    target = null,
    records = [];
  for (;;) {
    const page = await callRpc(client, "grid_audit_export", {
      p_tenant_id: tenantId,
      p_user_id: userId,
      p_after_sequence: anchor.sequence,
      p_until_sequence: target?.sequence ?? null,
    });
    if (
      page.tenant_id !== tenantId ||
      page.user_id !== userId ||
      !Array.isArray(page.records)
    )
      throw new Error("invalid_audit_export");
    target ??= page.head ?? { sequence: "0", hash: "0".repeat(64) };
    if (BigInt(target.sequence) < BigInt(sequence))
      throw new Error("audit_anchor_ahead_of_head");
    if (!page.records.length) break;
    anchor = verifyAuditRecords(page.records, { tenantId, userId, ...anchor });
    records.push(...page.records);
    if (BigInt(anchor.sequence) >= BigInt(target.sequence)) break;
    if (records.length > 1000000)
      throw new Error("audit_export_too_large_use_checkpoint");
  }
  if (anchor.sequence !== target.sequence || anchor.hash !== target.hash)
    throw new Error("audit_export_incomplete_or_rewritten");
  return {
    version: 1,
    tenant_id: tenantId,
    user_id: userId,
    from_sequence: sequence,
    previous_anchor: hash,
    checkpoint: target,
    records,
  };
}
