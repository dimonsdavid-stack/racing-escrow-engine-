import { writeFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { createAdminClient } from "../src/settlement.js";
import { exportWalletAudit } from "../src/audit.js";
const user = z.uuid().parse(process.argv[2]),
  output = process.argv[3];
if (!output) throw new Error("output_path_required");
const tenant = z.uuid().parse(process.env.RACING_TENANT_ID);
const checkpoint = process.argv[4]
  ? JSON.parse(await readFile(process.argv[4], "utf8"))
  : undefined;
if (
  checkpoint &&
  (checkpoint.tenant_id !== tenant || checkpoint.user_id !== user)
)
  throw new Error("checkpoint_binding_mismatch");
const data = await exportWalletAudit(
  createAdminClient(),
  tenant,
  user,
  checkpoint?.checkpoint,
);
await writeFile(output, JSON.stringify(data, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  "Verified export saved. Store its checkpoint in independent immutable storage.",
);
