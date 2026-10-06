import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
const files = [
  "sql/001_engine.sql",
  "supabase/migrations/20261005224115_customer_app.sql",
  "supabase/migrations/20261006073056_sim_racing_commerce.sql",
  "supabase/migrations/20261006092644_institutional_controls.sql",
  "supabase/migrations/20261006112856_cash_redemption.sql",
];
const sources = await Promise.all(files.map((f) => readFile(f, "utf8")));
await writeFile(
  "supabase/schema.sql",
  "-- FRESH INSTALL ONLY. Existing installations apply only unapplied migrations.\n-- Each migration is atomic; RPC calls are single PostgREST transactions.\n" +
    sources.map((s, i) => "\n-- Source: " + files[i] + "\n" + s).join("\n"),
);

await mkdir("frontend/public", { recursive: true });
for (const f of ["sweepstakes-rules.html", "rules.css", "rules.js"])
  await copyFile("public/" + f, "frontend/public/" + f);
