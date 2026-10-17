// Aggregates every StarPets pet listing into { "pet_name|VARIANT": cheapest_usd }.
// The CDN serves the cached blob instantly and refreshes it in the background.

const SOURCE = "https://market.apineural.com/api/v2/store/items/all";
const PAGE_SIZE = 200;
const CONCURRENCY = 10;
const BUDGET_MS = 45000;

export const maxDuration = 60;

const variantOf = ({ pumping, flyable, rideable }) =>
  (pumping === "mega_neon" ? "M" : pumping === "neon" ? "N" : "") +
  (flyable ? "F" : "") +
  (rideable ? "R" : "");

const keyOf = (name, listing) =>
  `${String(name).toLowerCase().replace(/[\s-]+/g, "_")}|${variantOf(listing)}`;

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

function absorb(items = [], prices) {
  for (const listing of items) {
    const price = Number(listing.price);
    if (!listing.realName || !(price > 0)) continue;
    const key = keyOf(listing.realName, listing);
    if (!(key in prices) || price < prices[key]) prices[key] = price;
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

    // The API may cap `amount`, so page size comes from what it actually returned.
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
            // One bad page shouldn't sink the whole sweep.
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
