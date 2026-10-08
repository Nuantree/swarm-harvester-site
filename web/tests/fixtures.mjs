// Test-only chain/wallet model. Synthetic balances, proofs, events and receipts are never bundled.
import { readFileSync } from "node:fs";
import {
  decodeFunctionData,
  encodeFunctionResult,
  encodeErrorResult,
  encodeEventTopics,
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  keccak256,
  toHex,
  zeroAddress,
} from "viem";
export const config = JSON.parse(
  readFileSync(new URL("../deployment.json", import.meta.url), "utf8"),
);
export const abis = Object.fromEntries(
  config.contracts.map((c) => [
    c.name,
    JSON.parse(
      readFileSync(
        new URL(`../../docs/abi/${c.name}.json`, import.meta.url),
        "utf8",
      ),
    ),
  ]),
);
export const addr = Object.fromEntries(
  config.contracts.map((c) => [c.name, c.address]),
);
export const account = "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7";
export const other = "0x00372e0b68e2e6b8e53d25e03f061e582b2e3991";
export const distributor = "0x77904bc88f1e3310af72eb7d394a12c76c3f9f70";
export const deploymentTx =
  "0x3506bb74e03e294f3f24b2b390028c063f3ef6180db536e510039eff41620db1";
const hash = (n) => toHex(BigInt(n), { size: 32 });
export const root = hash(1001),
  blockNumber = BigInt(26146690),
  blockHash = hash(blockNumber);
const tokenAbi = parseAbi([
  "function name() view returns(string)",
  "function symbol() view returns(string)",
  "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)",
]);
const distributorAbi = parseAbi([
  "function token() view returns(address)",
  "function roundCount() view returns(uint256)",
  "function roundOf(uint256) view returns(bytes32)",
  "function claimed(uint256,address) view returns(bool)",
  "function claim(uint256,address,uint256,bytes32[])",
]);
const poolAbi = parseAbi([
  "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)",
]);
const stateAbi = parseAbi([
  "function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
]);
const permitAbi = parseAbi([
  "function allowance(address,address,address) view returns(uint160 amount,uint48 expiration,uint48 nonce)",
  "function approve(address,address,uint160,uint48)",
]);
export const routerAbi = parseAbi([
  "function execute(bytes,bytes[],uint256) payable",
]);
const poolId = (k) =>
  keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)",
      ),
      [k],
    ),
  );
function log(
  address,
  abi,
  eventName,
  args,
  dataTypes,
  data,
  transactionHash = deploymentTx,
  index = 0,
) {
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args }),
    data: encodeAbiParameters(parseAbiParameters(dataTypes), data),
    blockNumber: toHex(blockNumber),
    blockHash,
    transactionHash,
    transactionIndex: "0x0",
    logIndex: toHex(index),
    removed: false,
  };
}
const poolLog = (k) =>
  log(
    config.network.uniswapV4.poolManager,
    poolAbi,
    "Initialize",
    { id: poolId(k), currency0: k.currency0, currency1: k.currency1 },
    "uint24,int24,address,uint160,int24",
    [k.fee, k.tickSpacing, k.hooks, 2n ** 96n, 0],
  );
const receipt = (tx, logs = [], to = addr.SwarmHarvester) => ({
  transactionHash: tx,
  transactionIndex: "0x0",
  blockHash,
  blockNumber: toHex(blockNumber),
  from: account,
  to,
  cumulativeGasUsed: toHex(120000),
  gasUsed: toHex(120000),
  contractAddress: null,
  logs,
  logsBloom: "0x" + "00".repeat(256),
  status: "0x1",
  effectiveGasPrice: toHex(1000000000),
  type: "0x2",
});
export const launch = {
  id: config.launchId,
  launchNumber: 1029,
  status: "live",
  chainId: config.chainId,
  artifacts: [
    { role: "token", address: addr.LaunchToken, txHash: deploymentTx },
    { role: "distributor", address: distributor, txHash: deploymentTx },
  ],
};
export const proof = {
  claim: { root, amount: String(5n * 10n ** 18n), proof: [hash(1002)] },
};
export async function installMocks(page, options = {}) {
  const state = {
    calls: [],
    sent: [],
    claimed: false,
    balance: 5n * 10n ** 18n,
    allowances: new Map(),
    permit: [0n, 0, 0],
    receipts: new Map(),
    rejectNext: false,
    failSimulation: false,
    failApi: false,
    receiptDelay: 0,
    ...options,
  };
  const lower = (s) => String(s).toLowerCase();
  const abiFor = (to) =>
    lower(to) === lower(addr.SwarmSeller)
      ? abis.SwarmSeller
      : lower(to) === lower(addr.SwarmHarvester)
        ? abis.SwarmHarvester
        : lower(to) === lower(distributor)
          ? distributorAbi
          : lower(to) === lower(config.network.uniswapV4.quoter)
            ? quoterAbi
            : lower(to) === lower(config.network.uniswapV4.stateView)
              ? stateAbi
              : lower(to) === lower(config.network.uniswapV4.permit2)
                ? permitAbi
                : lower(to) === lower(config.network.uniswapV4.universalRouter)
                  ? routerAbi
                  : tokenAbi;
  function decode(to, data) {
    return decodeFunctionData({ abi: abiFor(to), data });
  }
  async function rpc({ method, params = [] }) {
    state.calls.push({ method, params });
    if (method === "eth_chainId") return toHex(config.chainId);
    if (method === "eth_getCode") return "0x60006000";
    if (method === "eth_blockNumber")
      return toHex(
        blockNumber +
          BigInt(
            state.calls.filter((c) => c.method === "eth_blockNumber").length,
          ),
      );
    if (method === "eth_getBalance") return toHex(10n ** 20n);
    if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas")
      return toHex(1000000000);
    if (method === "eth_estimateGas") return toHex(500000);
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getLogs")
      return [
        poolLog({
          currency0: zeroAddress,
          currency1: config.network.pairToken.address,
          fee: 3000,
          tickSpacing: 60,
          hooks: zeroAddress,
        }),
      ];
    if (method === "eth_getTransactionByHash") {
      const sent = state.sent.find((x) => x.hash === params[0]);
      return sent
        ? {
            ...sent.tx,
            hash: sent.hash,
            blockHash,
            blockNumber: toHex(blockNumber),
            transactionIndex: "0x0",
            nonce: "0x0",
            gas: toHex(500000),
            gasPrice: toHex(1000000000),
            value: sent.tx.value ?? "0x0",
            input: sent.tx.data,
            type: "0x2",
            chainId: toHex(config.chainId),
            r: hash(1),
            s: hash(1),
            v: "0x0",
          }
        : null;
    }
    if (method === "eth_getTransactionReceipt") {
      if (params[0] === deploymentTx)
        return receipt(deploymentTx, [poolLog(config.poolKey)]);
      const r = state.receipts.get(params[0]);
      if (r && Date.now() < r.at) return null;
      return r?.receipt ?? null;
    }
    if (method === "eth_getBlockByNumber")
      return {
        number: toHex(blockNumber),
        hash: blockHash,
        parentHash: hash(blockNumber - 1n),
        nonce: "0x0000000000000000",
        sha3Uncles: hash(0),
        logsBloom: "0x" + "00".repeat(256),
        transactionsRoot: hash(0),
        stateRoot: hash(0),
        receiptsRoot: hash(0),
        miner: account,
        difficulty: "0x0",
        totalDifficulty: "0x0",
        extraData: "0x",
        size: "0x0",
        gasLimit: toHex(60000000),
        gasUsed: toHex(1),
        timestamp: toHex(Math.floor(Date.now() / 1000)),
        transactions: [],
        uncles: [],
        baseFeePerGas: toHex(1000000000),
      };
    if (method === "eth_call") {
      const { to, data } = params[0];
      const { functionName: fn, args = [] } = decode(to, data);
      state.calls.push({ fn, to, args });
      let result;
      switch (fn) {
        case "poolManager":
          result = config.network.uniswapV4.poolManager;
          break;
        case "imd":
          result = config.network.pairToken.address;
          break;
        case "FEE_BPS":
          result = 50n;
          break;
        case "CLAIM_GAS_LIMIT":
          result = 200000n;
          break;
        case "symbol":
          result =
            lower(to) === lower(config.network.pairToken.address)
              ? "IMD"
              : "HARVEST";
          break;
        case "name":
          result = "Swarm Harvester";
          break;
        case "decimals":
          result = 18;
          break;
        case "balanceOf":
          result = state.balance;
          break;
        case "token":
          result = addr.LaunchToken;
          break;
        case "roundCount":
          result = 2n;
          break;
        case "roundOf":
          result = args[0] === 1n ? root : hash(1003);
          break;
        case "claimed":
          result = state.claimed;
          break;
        case "claim":
          result = undefined;
          break;
        case "claimMany":
          result = state.claimed ? 0n : BigInt(args[0].length);
          break;
        case "allowance":
          result =
            lower(to) === lower(config.network.uniswapV4.permit2)
              ? state.permit
              : (state.allowances.get(lower(to) + ":" + lower(args[1])) ?? 0n);
          break;
        case "approve":
          result =
            lower(to) === lower(config.network.uniswapV4.permit2)
              ? undefined
              : true;
          break;
        case "transfer":
          result = true;
          break;
        case "getSlot0":
          result = [2n ** 96n, 0, 0, 12500];
          break;
        case "quoteExactInputSingle": {
          const q = args[0];
          const input = q.zeroForOne
            ? q.poolKey.currency0
            : q.poolKey.currency1;
          result = [
            lower(input) === lower(zeroAddress)
              ? q.exactAmount * 1000n
              : q.exactAmount / 1000n,
            100000n,
          ];
          break;
        }
        case "sellMany":
          if (state.failSimulation)
            throw new Error("execution reverted: MinimumOutputNotMet");
          result = args[2];
          break;
        case "execute":
          if (state.failSimulation)
            throw new Error("execution reverted: MinimumOutputNotMet");
          result = undefined;
          break;
        default:
          throw new Error(`Unhandled mocked call ${fn}`);
      }
      return encodeFunctionResult({
        abi: abiFor(to),
        functionName: fn,
        result,
      });
    }
    throw new Error(`Unhandled mocked RPC: ${method}`);
  }
  await page.route(
    /https:\/\/(ethereum-rpc\.publicnode\.com|eth\.drpc\.org)\/?/,
    async (route) => {
      const input = route.request().postDataJSON();
      const handle = async (req) => {
        try {
          return { jsonrpc: "2.0", id: req.id, result: await rpc(req) };
        } catch (e) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: e.message.includes("execution reverted")
              ? {
                  code: 3,
                  message: "execution reverted",
                  data: encodeErrorResult({
                    abi: abis.SwarmSeller,
                    errorName: "MinimumOutputNotMet",
                  }),
                }
              : { code: -32000, message: e.message },
          };
        }
      };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          Array.isArray(input)
            ? await Promise.all(input.map(handle))
            : await handle(input),
        ),
      });
    },
  );
  await page.route("https://explorer.imd.fun/api/**", async (route) => {
    if (state.failApi) return route.abort("failed");
    const url = new URL(route.request().url());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        url.pathname.endsWith("earned")
          ? { claimable: state.empty ? [] : [config.launchId], unlocks: [] }
          : proof,
      ),
    });
  });
  await page.route("https://api.imd.fun/launches/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(launch),
    }),
  );
  await page.exposeFunction("__mockSend", async (tx) => {
    if (state.rejectNext) {
      state.rejectNext = false;
      return { error: 4001 };
    }
    const { functionName: fn, args = [] } = decode(tx.to, tx.data);
    const hashValue = hash(state.sent.length + 5000);
    state.sent.push({ tx, fn, args, hash: hashValue });
    let logs = [];
    if (fn === "claimMany") {
      state.claimed = true;
      state.balance += 5n * 10n ** 18n;
      logs = args[0].map((c, i) =>
        log(
          addr.SwarmHarvester,
          abis.SwarmHarvester,
          "ClaimResult",
          { distributor: c.distributor, account: c.account },
          "bool",
          [true],
          hashValue,
          i,
        ),
      );
    }
    if (fn === "approve") {
      if (lower(tx.to) === lower(config.network.uniswapV4.permit2))
        state.permit = [args[2], args[3], 0];
      else state.allowances.set(lower(tx.to) + ":" + lower(args[0]), args[1]);
    }
    if (fn === "sellMany") {
      state.balance = 0n;
      logs = [
        log(
          addr.SwarmSeller,
          abis.SwarmSeller,
          "SaleResult",
          { index: 0n, token: addr.LaunchToken },
          "bool,uint256",
          [true, 10n * 10n ** 18n],
          hashValue,
          0,
        ),
        log(
          addr.SwarmSeller,
          abis.SwarmSeller,
          "BatchSold",
          { caller: account, recipient: account },
          "uint256,uint256",
          [args[2], 5n * 10n ** 16n],
          hashValue,
          1,
        ),
      ];
    }
    state.receipts.set(hashValue, {
      receipt: receipt(hashValue, logs, tx.to),
      at: Date.now() + state.receiptDelay,
    });
    return { hash: hashValue };
  });
  if (!options.noWallet)
    await page.addInitScript(
      ({ account, chain }) => {
        const listeners = {};
        window.__wallet = {
          account,
          chain,
          calls: [],
          unknown: true,
          emit: (name, value) =>
            (listeners[name] ?? []).forEach((fn) => fn(value)),
        };
        window.ethereum = {
          on: (name, fn) => (listeners[name] ??= []).push(fn),
          removeListener: (name, fn) => {
            listeners[name] = (listeners[name] ?? []).filter((x) => x !== fn);
          },
          request: async (args) => {
            const w = window.__wallet;
            w.calls.push(args);
            if (
              args.method === "eth_requestAccounts" ||
              args.method === "eth_accounts"
            )
              return w.account ? [w.account] : [];
            if (args.method === "eth_chainId") return w.chain;
            if (args.method === "wallet_switchEthereumChain") {
              if (w.unknown) {
                throw { code: 4902, message: "Unknown chain" };
              }
              w.chain = args.params[0].chainId;
              w.emit("chainChanged", w.chain);
              return null;
            }
            if (args.method === "wallet_addEthereumChain") {
              w.unknown = false;
              return null;
            }
            if (args.method === "eth_sendTransaction") {
              const result = await window.__mockSend(args.params[0]);
              if (result.error)
                throw { code: result.error, message: "User rejected request" };
              return result.hash;
            }
            throw new Error(`Unhandled mock wallet method ${args.method}`);
          },
        };
      },
      { account, chain: options.chain ?? toHex(config.chainId) },
    );
  return state;
}
