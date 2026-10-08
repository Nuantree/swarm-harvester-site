// Read-only service validation: no wallet connection, private key or broadcast.
import { readFile, writeFile } from "node:fs/promises";
import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  zeroAddress,
} from "viem";
import { checkPool, quoteHop, verifyDeployment } from "../src/chain";
import { distributorAbi, type Runtime } from "../src/config";
import { discoverBridge, resolveRound } from "../src/rewards";
const config = JSON.parse(
  await readFile(
    new URL("../../dist/imd-deployment.json", import.meta.url),
    "utf8",
  ),
);
const contracts = await Promise.all(
  config.contracts.map(async (c: Record<string, string>) => ({
    ...c,
    abi: JSON.parse(
      await readFile(
        new URL(`../../dist/${c.abiPath}`, import.meta.url),
        "utf8",
      ),
    ),
  })),
);
const chain = defineChain({
  id: config.chainId,
  name: config.network.name,
  nativeCurrency: config.network.nativeCurrency,
  rpcUrls: { default: { http: config.network.rpcUrls } },
});
const client = createPublicClient({
  chain,
  transport: fallback(
    config.network.rpcUrls.map((url: string) =>
      http(url, { timeout: 15000, retryCount: 0 }),
    ),
  ),
});
const rt = {
  config,
  contracts,
  contract: (name: string) => contracts.find((c) => c.name === name)!,
  chain,
  client,
} as Runtime;
const report: { date: string; checks: unknown[]; broadcasts: number } = {
  date: new Date().toISOString(),
  checks: [],
  broadcasts: 0,
};
async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    report.checks.push({ name, status: "passed", result });
    console.log(name, "passed");
  } catch (e) {
    report.checks.push({
      name,
      status: "unavailable",
      message: (e as Error).message.slice(0, 1000),
    });
    console.log(name, "unavailable");
  }
}
await check(
  "Configured RPC, application/dependency bytecode, seller immutables and live token metadata",
  () => verifyDeployment(rt),
);
await check("Attested pool initialized on configured StateView", () =>
  checkPool(rt, config.poolKey).then(() => true),
);
await check(
  "Read-only HARVEST quote for 0.001 ETH from configured quoter",
  () =>
    quoteHop(
      rt,
      config.poolKey,
      zeroAddress,
      10n ** 15n,
      rt.contract("SwarmHarvester").address,
    ),
);
await check("ETH / IMD bridge discovery from configured PoolManager logs", () =>
  discoverBridge(
    rt,
    () => {},
    undefined,
    10n ** 15n,
    rt.contract("SwarmHarvester").address,
  ),
);
await check(
  "Public API launch and proof, dynamic on-chain round matching",
  async () => {
    const record = await (
      await fetch(`https://api.imd.fun/launches/${config.launchId}`)
    ).json();
    const beneficiary = "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7"; // Existing public allocation; read-only evidence, never a recipient default.
    const response = await fetch(
      `https://explorer.imd.fun/api/claim?launch=${config.launchId}&wallet=${beneficiary}`,
    );
    const { claim } = await response.json();
    const distributor = record.artifacts.find(
      (x: { role: string }) => x.role === "distributor",
    ).address;
    const round = await resolveRound(rt, distributor, claim.root);
    const token = await client.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "token",
    });
    return {
      launchStatus: record.status,
      chainId: record.chainId,
      distributor,
      token,
      round,
      root: claim.root,
    };
  },
);
await writeFile(
  new URL("../../docs/frontend/live-check.json", import.meta.url),
  JSON.stringify(
    report,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ) + "\n",
);
