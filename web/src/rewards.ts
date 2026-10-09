import {
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  address,
  distributorAbi,
  erc20Abi,
  poolAbi,
  same,
  services,
  type PoolKey,
  type Runtime,
} from "./config";
import {
  asHex,
  checkPool,
  explain,
  minimum,
  netAfterBurn,
  poolsFromReceipt,
  quoteHop,
  validPool,
} from "./chain";
export type LaunchRecord = {
  id: string;
  launchNumber?: number;
  status: string;
  chainId: number;
  artifacts: {
    role: string;
    address: Address;
    txHash: Hash;
    blockNumber?: number;
  }[];
};
export type ClaimProof = { root: Hex; amount: string; proof: Hex[] };
export type Claim = {
  distributor: Address;
  round: bigint;
  account: Address;
  amount: bigint;
  proof: Hex[];
};
export type Reward = {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  token?: Address;
  distributor?: Address;
  balance: bigint;
  allowance: bigint;
  claim?: Claim;
  status: "ready" | "claimed" | "locked" | "unavailable";
  reason?: string;
  pool?: PoolKey;
  selected: boolean;
  imported?: boolean;
};
export type Earned = {
  claimable: string[];
  unlocks: { id: string; at: string }[];
};
export type ImportData = {
  earned?: Earned;
  launches?: Record<string, LaunchRecord>;
  claims?: Record<string, { claim: ClaimProof | null }>;
  bridgePool?: PoolKey;
};
export type SaleQuote = {
  row: Reward;
  token: Address;
  amountIn: bigint;
  minOut: bigint;
  gross: bigint;
  route: PoolKey[];
};
export const uuid = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const earnedUrl = (wallet: Address) =>
  `${services.explorer}/api/earned?wallet=${wallet}`;
export const claimUrl = (id: string, wallet: Address) =>
  `${services.explorer}/api/claim?launch=${encodeURIComponent(id)}&wallet=${wallet}`;
export const launchUrl = (id: string) =>
  `${services.launches}/launches/${encodeURIComponent(id)}`;
async function request(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok)
    throw new Error(
      `The data service returned HTTP ${response.status}. Retry or import its JSON response.`,
    );
  return response.json();
}
type WalletSnapshot = {
  earned: Earned;
  claims: Record<string, { claim: ClaimProof | null }>;
};
const walletSnapshots = new Map<string, Promise<WalletSnapshot>>();
function walletSnapshot(wallet: Address) {
  const key = wallet.toLowerCase();
  let pending = walletSnapshots.get(key);
  if (!pending) {
    pending = fetch(`${services.snapshot}/wallets/${key}.json`, {
      signal: AbortSignal.timeout(20000),
    }).then((response) => {
      // A wallet missing from the snapshot holds no allocations.
      if (response.status === 404)
        return { earned: { claimable: [], unlocks: [] }, claims: {} };
      if (!response.ok)
        throw new Error(
          `The reward snapshot returned HTTP ${response.status}. Retry or import the JSON responses.`,
        );
      return response.json();
    });
    pending.catch(() => walletSnapshots.delete(key));
    walletSnapshots.set(key, pending);
  }
  return pending;
}
// The IMD services do not send CORS headers to static sites, so a failed
// direct request falls back to the hourly snapshot of the same responses.
async function withSnapshot<T>(url: string, fallback: () => Promise<T>) {
  try {
    return (await request(url)) as T;
  } catch {
    return fallback();
  }
}
export function parseEarned(data: unknown): Earned {
  const e = data as Earned;
  if (
    !Array.isArray(e?.claimable) ||
    !e.claimable.every(uuid) ||
    (e.unlocks &&
      (!Array.isArray(e.unlocks) ||
        !e.unlocks.every(
          (x) => uuid(x.id) && Number.isFinite(Date.parse(x.at)),
        )))
  )
    throw new Error(
      "This is not a valid earned API response. Paste the complete JSON object.",
    );
  if (e.claimable.length + (e.unlocks?.length ?? 0) > 3000)
    throw new Error(
      "This response is too large. Import a smaller group of launches.",
    );
  return { claimable: [...new Set(e.claimable)], unlocks: e.unlocks ?? [] };
}
export function parseImport(text: string): ImportData {
  const data = JSON.parse(text);
  // Accept the earned response alone, or a bundle with the exact public API responses.
  const imported: ImportData = Array.isArray(data.claimable)
    ? { earned: parseEarned(data) }
    : data;
  if (
    !imported ||
    typeof imported !== "object" ||
    (!imported.earned &&
      !imported.launches &&
      !imported.claims &&
      !imported.bridgePool)
  )
    throw new Error(
      "Paste an earned response or an import bundle with earned, launches and claims.",
    );
  if (imported.earned) imported.earned = parseEarned(imported.earned);
  if (
    imported.launches &&
    (!Object.keys(imported.launches).every(uuid) ||
      Object.keys(imported.launches).length > 3000)
  )
    throw new Error("Launch records must be keyed by launch UUID.");
  if (imported.claims && !Object.keys(imported.claims).every(uuid))
    throw new Error("Claim responses must be keyed by launch UUID.");
  if (imported.bridgePool) {
    const p = imported.bridgePool;
    for (const k of ["currency0", "currency1", "hooks"] as const) address(p[k]);
    if (!Number.isInteger(p.fee) || !Number.isInteger(p.tickSpacing))
      throw new Error("The pool fee and tick spacing must be integers.");
  }
  return imported;
}
export async function loadEarned(
  wallet: Address,
  imported: ImportData,
): Promise<Earned> {
  return imported.earned
    ? parseEarned(imported.earned)
    : parseEarned(
        await withSnapshot(
          earnedUrl(wallet),
          async () => (await walletSnapshot(wallet)).earned,
        ),
      );
}
export async function resolveRound(
  rt: Runtime,
  distributor: Address,
  root: Hex,
) {
  const count = await rt.client.readContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "roundCount",
  });
  if (count === 0n || count > 128n)
    throw new Error(
      "Round metadata is unavailable or exceeds the supported 128-round window. This claim is withheld.",
    );
  const matches: bigint[] = [];
  for (let round = 0n; round < count; round++) {
    const current = await rt.client.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "roundOf",
      args: [round],
    });
    if (current.toLowerCase() === root.toLowerCase()) matches.push(round);
  }
  if (matches.length !== 1)
    throw new Error(
      "The proof root does not match exactly one on-chain round. This claim is withheld.",
    );
  return matches[0];
}
export async function loadReward(
  rt: Runtime,
  id: string,
  wallet: Address,
  imported: ImportData,
  locked = false,
): Promise<Reward> {
  const row: Reward = {
    id,
    name: `Launch ${id.slice(0, 8)}`,
    symbol: "Token",
    decimals: 18,
    balance: 0n,
    allowance: 0n,
    status: "unavailable",
    selected: false,
    imported: !!imported.launches?.[id],
  };
  try {
    if (!uuid(id)) throw new Error("Use the launch UUID from the explorer.");
    const record: LaunchRecord =
      imported.launches?.[id] ??
      (await withSnapshot<LaunchRecord>(launchUrl(id), async () => {
        const response = await fetch(
          `${services.snapshot}/launches/${encodeURIComponent(id)}.json`,
          { signal: AbortSignal.timeout(20000) },
        );
        if (!response.ok)
          throw new Error(
            "This launch is not in the reward snapshot yet. Retry later or import its record.",
          );
        return response.json();
      }));
    if (
      record.id !== id ||
      record.chainId !== rt.config.chainId ||
      record.status !== "live" ||
      !Array.isArray(record.artifacts)
    )
      throw new Error(
        "This launch is not live on the configured Ethereum chain.",
      );
    row.name = record.launchNumber
      ? `Launch #${record.launchNumber}`
      : row.name;
    const tokenArtifact = record.artifacts.find((x) => x.role === "token");
    const distribution = record.artifacts.find((x) => x.role === "distributor");
    if (!tokenArtifact || !distribution)
      throw new Error(
        "The launch record has no token or distributor artifact.",
      );
    const token = address(tokenArtifact.address),
      distributor = address(distribution.address);
    const codes = await Promise.all([
      rt.client.getCode({ address: token }),
      rt.client.getCode({ address: distributor }),
    ]);
    if (codes.some((c) => !c || c === "0x"))
      throw new Error("The token or distributor has no deployed code.");
    const distributorToken = await rt.client.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "token",
    });
    if (!same(distributorToken, token))
      throw new Error(
        "The distributor token does not match the launch record.",
      );
    const [symbol, decimals, balance, allowance, receipt] = await Promise.all([
      rt.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      rt.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      rt.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
      }),
      rt.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet, rt.contract("SwarmSeller").address],
      }),
      rt.client.getTransactionReceipt({ hash: asHex(tokenArtifact.txHash) }),
    ]);
    if (receipt.status !== "success")
      throw new Error("The launch deployment transaction did not succeed.");
    if (decimals > 36)
      throw new Error("This token uses unsupported display precision.");
    Object.assign(row, {
      symbol: symbol.slice(0, 24),
      decimals,
      balance,
      allowance,
      token,
      distributor,
    });
    row.pool = poolsFromReceipt(rt, receipt).find(
      (k) =>
        validPool(k, token, rt.config.network.pairToken.address) ||
        validPool(k, token, zeroAddress),
    );
    if (same(token, rt.contract("LaunchToken").address))
      row.pool = rt.config.poolKey;
    try {
      const response =
        imported.claims?.[id] ??
        (await withSnapshot<{ claim: ClaimProof | null }>(
          claimUrl(id, wallet),
          async () =>
            (await walletSnapshot(wallet)).claims[id] ?? { claim: null },
        ));
      const proof: ClaimProof | null = response.claim;
      if (!proof)
        throw new Error("No allocation proof is available for this address.");
      const root = asHex(proof.root);
      if (
        typeof proof.amount !== "string" ||
        !/^\d+$/.test(proof.amount) ||
        BigInt(proof.amount) <= 0n ||
        BigInt(proof.amount) >= 1n << 256n ||
        !Array.isArray(proof.proof) ||
        proof.proof.length > 64
      )
        throw new Error(
          "The allocation proof has invalid amounts or siblings.",
        );
      const round = await resolveRound(rt, distributor, root);
      const claimed = await rt.client.readContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "claimed",
        args: [round, wallet],
      });
      if (claimed) {
        row.status = "claimed";
        return row;
      }
      row.claim = {
        distributor,
        round,
        account: wallet,
        amount: BigInt(proof.amount),
        proof: proof.proof.map(asHex),
      };
      if (locked) {
        row.status = "locked";
        row.reason = "Allocation unlocks later. Refresh after the unlock time.";
        return row;
      }
      await rt.client.simulateContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "claim",
        args: [round, wallet, row.claim.amount, row.claim.proof],
        account: rt.contract("SwarmHarvester").address,
      });
      row.status = "ready";
      row.selected = true;
    } catch (error) {
      row.status = "unavailable";
      row.claim = undefined;
      row.reason = explain(error);
    }
  } catch (error) {
    row.reason = explain(error);
  }
  return row;
}
export async function refreshReward(rt: Runtime, row: Reward, wallet: Address) {
  if (!row.token) return row;
  const [balance, allowance, claimed] = await Promise.all([
    rt.client.readContract({
      address: row.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
    }),
    rt.client.readContract({
      address: row.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [wallet, rt.contract("SwarmSeller").address],
    }),
    row.claim
      ? rt.client.readContract({
          address: row.claim.distributor,
          abi: distributorAbi,
          functionName: "claimed",
          args: [row.claim.round, wallet],
        })
      : false,
  ]);
  return {
    ...row,
    balance,
    allowance,
    ...(claimed ? { status: "claimed" as const, selected: false } : {}),
  };
}
export async function discoverBridge(
  rt: Runtime,
  progress: (s: string) => void,
  imported?: PoolKey,
  amount?: bigint,
  account?: Address,
): Promise<PoolKey[]> {
  const imd = rt.config.network.pairToken.address;
  if (imported) {
    if (!validPool(imported, zeroAddress, imd))
      throw new Error("The imported bridge must be the native ETH / IMD pool.");
    await checkPool(rt, imported);
    return [imported];
  }
  // Indexed Initialize logs are the authority for fees and hooks; never invent a pool key.
  let toBlock = await rt.client.getBlockNumber();
  for (let chunk = 0; chunk < 100; chunk++) {
    const fromBlock = toBlock > 9999n ? toBlock - 9999n : 0n;
    progress(`Finding the ETH / IMD pool (${chunk + 1}/100)…`);
    const readWindow = async (from: bigint, to: bigint): Promise<PoolKey[]> => {
      try {
        const logs = await rt.client.getLogs({
          address: rt.config.network.uniswapV4.poolManager,
          event: poolAbi[0],
          args: { currency0: zeroAddress, currency1: imd },
          fromBlock: from,
          toBlock: to,
          strict: true,
        });
        return logs.map(({ args: k }) => ({
          currency0: k.currency0,
          currency1: k.currency1,
          fee: k.fee,
          tickSpacing: k.tickSpacing,
          hooks: k.hooks,
        }));
      } catch (error) {
        // Public RPC providers differ in their historical log limits.
        if (to - from < 1000n || !/range|too large|limit/i.test(String(error)))
          throw error;
        const middle = (from + to) / 2n;
        return [
          ...(await readWindow(middle + 1n, to)),
          ...(await readWindow(from, middle)),
        ];
      }
    };
    const logs = await readWindow(fromBlock, toBlock);
    if (logs.length) {
      const keys = logs;
      if (amount && account) {
        const tested = await Promise.allSettled(
          keys.map(async (key) => {
            await quoteHop(rt, key, zeroAddress, amount, account);
            return key;
          }),
        );
        const usable = tested.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        if (usable.length) return usable;
      } else return keys;
    }
    if (fromBlock === 0n) break;
    toBlock = fromBlock - 1n;
  }
  throw new Error(
    "No ETH / IMD pool was found in the last 1,000,000 blocks. Import its exact on-chain pool key to quote this route.",
  );
}
export async function quoteSales(
  rt: Runtime,
  rows: Reward[],
  account: Address,
  bps: bigint,
  progress: (s: string) => void,
  bridgePool?: PoolKey,
) {
  const quotes: SaleQuote[] = [],
    failures: { id: string; message: string }[] = [];
  const imd = rt.config.network.pairToken.address;
  let bridges: PoolKey[] | undefined;
  for (const row of rows) {
    if (!row.token || row.balance <= 0n || same(row.token, imd)) continue;
    try {
      if (!row.pool)
        throw new Error(
          "No supported pool was found in the launch deployment receipt.",
        );
      progress(`Quoting ${row.symbol}…`);
      const fresh = await rt.client.readContract({
        address: row.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      });
      if (fresh <= 0n)
        throw new Error("The token balance is now zero. Refresh balances.");
      await checkPool(rt, row.pool);
      let gross = await quoteHop(rt, row.pool, row.token, fresh, account);
      let route = [row.pool];
      if (!validPool(row.pool, row.token, imd)) {
        if (!validPool(row.pool, row.token, zeroAddress))
          throw new Error("This token does not have a supported sale route.");
        bridges ??= await discoverBridge(
          rt,
          progress,
          bridgePool,
          gross,
          account,
        );
        const candidates = await Promise.allSettled(
          bridges.map(async (pool) => ({
            pool,
            out: await quoteHop(rt, pool, zeroAddress, gross, account),
          })),
        );
        const best = candidates
          .flatMap((c) => (c.status === "fulfilled" ? [c.value] : []))
          .sort((a, b) => (a.out > b.out ? -1 : 1))[0];
        if (!best)
          throw new Error("The ETH / IMD bridge has no quote for this amount.");
        route = [row.pool, best.pool];
        gross = best.out;
      }
      const minOut = minimum(gross, bps);
      if (minOut <= 0n)
        throw new Error("This output is below the minimum unit.");
      quotes.push({
        row,
        token: row.token,
        amountIn: fresh,
        minOut,
        gross,
        route,
      });
    } catch (e) {
      failures.push({ id: row.id, message: explain(e) });
    }
  }
  const gross = quotes.reduce((sum, q) => sum + q.gross, 0n);
  const minGross = quotes.reduce((sum, q) => sum + q.minOut, 0n);
  return {
    quotes,
    failures,
    gross,
    burn: gross / 200n,
    net: netAfterBurn(gross),
    minNet: netAfterBurn(minGross),
    at: Date.now(),
    account,
    bps,
  };
}
export type SalePlan = Awaited<ReturnType<typeof quoteSales>>;
export function storedIds(wallet: Address): string[] {
  try {
    return (
      JSON.parse(
        localStorage.getItem(`swarm:${wallet.toLowerCase()}`) ?? "[]",
      ) as unknown[]
    ).filter(uuid);
  } catch {
    return [];
  }
}
export function remember(wallet: Address, ids: string[]) {
  try {
    localStorage.setItem(
      `swarm:${wallet.toLowerCase()}`,
      JSON.stringify([...new Set([...storedIds(wallet), ...ids])].slice(-1000)),
    );
  } catch {
    /* Storage is optional. */
  }
}
export async function resolveInput(
  value: string,
  rt: Runtime,
): Promise<Address> {
  const input = value.trim();
  if (isAddress(input, { strict: false }))
    return getAddress(input.toLowerCase());
  if (input.endsWith(".eth")) {
    const result = await rt.client.getEnsAddress({ name: input.toLowerCase() });
    if (result) return result;
    throw new Error(
      "This ENS name has no Ethereum address. Use its full address instead.",
    );
  }
  return address(input);
}
