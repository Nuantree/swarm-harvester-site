import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  keccak256,
  toBytes,
  parseAbi,
  getAddress,
  isAddress,
  type Abi,
  type Address,
} from "viem";

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};
export type Contract = {
  name: string;
  address: Address;
  abiHash: string;
  abiPath: string;
  abi: Abi;
};
export type Deployment = {
  version: 1;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: Omit<Contract, "abi">[];
  poolKey: PoolKey;
  network: {
    chainId: number;
    name: string;
    testnet: boolean;
    rpcUrls: string[];
    explorer: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    uniswapV4: {
      poolManager: Address;
      universalRouter: Address;
      quoter: Address;
      stateView: Address;
      positionManager: Address;
      permit2: Address;
      extendedSwapParams?: boolean;
    };
    pairToken: {
      address: Address;
      symbol: string;
      name: string;
      decimals: number;
    };
  };
  walletAddChain?: {
    chainId: string;
    chainName: string;
    rpcUrls: string[];
    nativeCurrency: { name: string; symbol: string; decimals: number };
    blockExplorerUrls: string[];
  };
  assets: { path: string; sha256: string }[];
};
export const services = {
  explorer: "https://explorer.imd.fun",
  launches: "https://api.imd.fun",
  // Hourly copy of the same public API data, served with CORS. Used only when
  // the services above refuse a browser request.
  snapshot:
    "https://raw.githubusercontent.com/Nuantree/swarm-harvester-data/main/data",
};
export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);
export const distributorAbi = parseAbi([
  "function token() view returns (address)",
  "function roundCount() view returns (uint256)",
  "function roundOf(uint256) view returns (bytes32)", // Only the first return word (root) is decoded; no timing assumptions.
  "function claimed(uint256,address) view returns (bool)",
  "function claim(uint256,address,uint256,bytes32[])",
]);
export const poolAbi = parseAbi([
  "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
]);
export const stateAbi = parseAbi([
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
]);
export const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
export const routerAbi = parseAbi([
  "function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
]);
export const permitAbi = parseAbi([
  "function allowance(address,address,address) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
]);
export const canonical = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.entries(x)
            .sort(([a], [b]) => a.localeCompare(b, "en"))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : x;
export const same = (a?: string, b?: string) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
export function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false }))
    throw new Error(
      "Enter a complete Ethereum address (0x followed by 40 hex characters).",
    );
  return getAddress(value.toLowerCase());
}
export const safePath = (p: string) =>
  /^[\w./-]+$/.test(p) && !p.startsWith("/") && !p.split("/").includes("..");
export async function loadConfig() {
  const response = await fetch("./imd-deployment.json", { cache: "no-store" });
  if (!response.ok)
    throw new Error(
      "Deployment configuration could not be loaded. Reload the page.",
    );
  const config = (await response.json()) as Deployment;
  if (
    config.version !== 1 ||
    config.chainId !== config.network?.chainId ||
    !config.poolKey
  )
    throw new Error(
      "Deployment configuration is inconsistent. Transactions are unavailable.",
    );
  const contracts: Contract[] = await Promise.all(
    config.contracts.map(async (c) => {
      if (!safePath(c.abiPath)) throw new Error("Invalid ABI path.");
      address(c.address);
      const res = await fetch(`./${c.abiPath}`);
      if (!res.ok) throw new Error(`${c.name} ABI could not be loaded.`);
      const abi = await res.json();
      if (
        !Array.isArray(abi) ||
        keccak256(toBytes(JSON.stringify(canonical(abi)))).slice(2) !==
          c.abiHash
      )
        throw new Error(`${c.name} ABI failed integrity verification.`);
      return { ...c, abi: abi as Abi };
    }),
  );
  const contract = (name: string) => {
    const found = contracts.find((c) => c.name === name);
    if (!found) throw new Error(`Missing ${name}.`);
    return found;
  };
  const chain = defineChain({
    id: config.chainId,
    name: config.network.name,
    nativeCurrency: config.network.nativeCurrency,
    rpcUrls: { default: { http: config.network.rpcUrls } },
    blockExplorers: {
      default: { name: "Explorer", url: config.network.explorer },
    },
  });
  const client = createPublicClient({
    chain,
    transport: fallback(
      config.network.rpcUrls.map((url) =>
        http(url, { timeout: 15000, retryCount: 1 }),
      ),
    ),
    pollingInterval: 4000,
  });
  return { config, contracts, contract, chain, client };
}
export type Runtime = Awaited<ReturnType<typeof loadConfig>>;
