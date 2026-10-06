// Published package definitions. Database enablement is a separate operator action.
export const TOKEN_PACKAGES = Object.freeze({
  pack_bronze_10: Object.freeze({
    id: "pack_bronze_10",
    name: "Bronze",
    amount_cents: 1000,
    gc: "10000.000000",
    sc: "10.000000",
  }),
  pack_silver_20: Object.freeze({
    id: "pack_silver_20",
    name: "Silver",
    amount_cents: 2000,
    gc: "25000.000000",
    sc: "22.000000",
  }),
  pack_gold_50: Object.freeze({
    id: "pack_gold_50",
    name: "Gold",
    amount_cents: 5000,
    gc: "60000.000000",
    sc: "55.000000",
  }),
});
export const PUBLISHED_PACKAGES = Object.freeze(
  Object.values(TOKEN_PACKAGES).map((p) =>
    Object.freeze({ ...p, available: false }),
  ),
);
