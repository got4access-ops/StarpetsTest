// Aggregates every StarPets pet listing into { "pet_name|VARIANT": cheapest_usd }.
// The CDN serves the cached blob instantly and refreshes it in the background.

const SOURCE = "https://market.apineural.com/api/v2/store/items/all";
const PAGE_SIZE = 72; // The API rejects anything larger.
const CONCURRENCY = 16;
const BUDGET_MS = 50000;

export const maxDuration = 60;

const normalise = (value) => String(value).toLowerCase().replace(/[\s-]+/g, "_");

const variantOf = ({ pumping, flyable, rideable }) =>
  (pumping === "mega_neon" ? "M" : pumping === "neon" ? "N" : "") +
  (flyable ? "F" : "") +
  (rideable ? "R" : "");

async function fetchPage(page) {
  const response = await fetch(SOURCE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filter: { types: [{ type: "pet" }] },
      page,
      amount: PAGE_SIZE,
      currency: "usd",
      sort: { popularity: "desc" },
    }),
  });
  if (!response.ok) throw new Error(`StarPets responded ${response.status}`);
  return response.json();
}

// Listings carry a display name ("Bat Dragon") and a kind slug ("winter_2022_bat_dragon"), so
// both are indexed — the game knows pets by display name, but slugs catch the odd mismatch.
function absorb(items = [], prices) {
  for (const listing of items) {
    const price = Number(listing.price);
    if (!(price > 0)) continue;
    const variant = variantOf(listing);
    for (const label of [listing.name, listing.realName]) {
      if (!label) continue;
      const key = `${normalise(label)}|${variant}`;
      if (!(key in prices) || price < prices[key]) prices[key] = price;
    }
  }
}

export default async function handler(_request, response) {
  const started = Date.now();
  const prices = {};
  let pages = 1;
  let truncated = false;

  try {
    const first = await fetchPage(1);
    absorb(first.items, prices);

    const perPage = first.items?.length || PAGE_SIZE;
    pages = Math.ceil((first.count ?? perPage) / perPage);

    let next = 2;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, Math.max(0, pages - 1)) }, async () => {
        while (true) {
          const page = next++;
          if (page > pages) return;
          if (Date.now() - started > BUDGET_MS) {
            truncated = true;
            return;
          }
          try {
            absorb((await fetchPage(page)).items, prices);
          } catch {
            try {
              absorb((await fetchPage(page)).items, prices); // One retry, then move on.
            } catch {}
          }
        }
      })
    );
  } catch (error) {
    response.setHeader("Cache-Control", "public, s-maxage=60");
    return response.status(502).json({ error: String(error.message || error), prices: {} });
  }

  response.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
  return response.json({
    updated: Date.now(),
    count: Object.keys(prices).length,
    pages,
    truncated,
    took_ms: Date.now() - started,
    prices,
  });
}
