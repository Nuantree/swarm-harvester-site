// Optional CORS workaround: fetch public JSON locally, then paste stdout into the static site's importer.
// No RPC writes, wallet connection, private key, recipient setting or default address.
import { getAddress, isAddress } from "viem";
const raw = process.argv[2];
if (!raw || !isAddress(raw, { strict: false })) {
  console.error(
    "Usage: node scripts/collect-responses.mjs <wallet-address> [launch-UUID]",
  );
  process.exit(1);
}
const wallet = getAddress(raw.toLowerCase());
const requested = process.argv[3];
if (
  requested &&
  !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requested)
)
  throw new Error("The launch must be its API UUID.");
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} at ${url}`);
  return response.json();
}
const earned = await json(
  `https://explorer.imd.fun/api/earned?wallet=${wallet}`,
);
const ids = requested
  ? [requested]
  : [
      ...new Set([...earned.claimable, ...earned.unlocks.map((x) => x.id)]),
    ].slice(0, 24);
const bundle = {
  earned: {
    claimable: earned.claimable.filter((id) => ids.includes(id)),
    unlocks: earned.unlocks.filter((u) => ids.includes(u.id)),
  },
  launches: {},
  claims: {},
};
for (const id of ids) {
  try {
    bundle.launches[id] = await json(`https://api.imd.fun/launches/${id}`);
    bundle.claims[id] = await json(
      `https://explorer.imd.fun/api/claim?launch=${id}&wallet=${wallet}`,
    );
  } catch (error) {
    console.error(`${id}: ${error.message}`);
  }
}
console.log(JSON.stringify(bundle));
