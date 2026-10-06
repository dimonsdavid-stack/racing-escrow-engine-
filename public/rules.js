(async () => {
  const status = document.getElementById("program-status"),
    details = document.getElementById("program-details");
  try {
    const response = await fetch("/api/v1/app/program", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    const { program: p } = await response.json();
    if (!p) {
      status.textContent =
        "No active operator promotion has been published. The proposal below is available for review.";
      return;
    }
    const url = new URL(p.official_rules_url);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error();
    status.textContent = `Active program: ${p.title} · ${p.version}`;
    for (const [label, value] of [
      ["Sponsor", p.sponsor],
      ["Starts", p.starts_at],
      ["Ends", p.ends_at],
      ["Minimum age", p.minimum_age],
      ["Territories", p.territories?.join(", ")],
      ["Rules SHA-256", p.rules_sha256],
    ]) {
      const row = document.createElement("p");
      row.textContent = `${label}: ${value}`;
      details.append(row);
    }
    const link = document.createElement("a");
    link.textContent = "Read this program’s published official rules ↗";
    link.href = url.href;
    link.rel = "noopener noreferrer";
    details.append(link);
  } catch {
    status.textContent =
      "The program registry could not be confirmed. Please try again before entering.";
  }
})();
