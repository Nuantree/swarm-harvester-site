import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  custom,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  erc20Abi,
  permitAbi,
  poolAbi,
  quoterAbi,
  routerAbi,
  same,
  stateAbi,
  type PoolKey,
  type Runtime,
} from "./config";
export type Provider = EIP1193Provider & {
  on?: (event: string, fn: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, fn: (...args: unknown[]) => void) => void;
};
export const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const messages: Record<string, string> = {
  MinimumOutputNotMet:
    "The output fell below your minimum. Refresh the quote and try again.",
  DeadlineExpired: "The quote expired. Refresh the quote and try again.",
  InvalidRecipient: "Choose a valid recipient address.",
  IncompleteSwap:
    "The pool cannot fill the entire amount. Try a smaller trade.",
  UnexpectedTokenReturn: "This token is not supported by the seller.",
  SettlementMismatch:
    "The token did not settle correctly. This sale is unavailable.",
  InvalidSale: "This sale route is unavailable. Refresh balances and quotes.",
  ERC20InsufficientBalance:
    "The wallet balance is too low. Refresh balances or reduce the amount.",
  ERC20InsufficientAllowance:
    "The token allowance is too low. Approve the displayed amount first.",
};
export function explain(error: unknown): string {
  const e = error as {
    code?: number;
    message?: string;
    shortMessage?: string;
    cause?: unknown;
  };
  if (e?.code === 4001 || /user rejected|user denied/i.test(e?.message ?? ""))
    return "Request declined in your wallet. You can try again when ready.";
  if (e?.code === -32002)
    return "A request is already open in your wallet. Complete it there first.";
  if (/insufficient funds/i.test(e?.message ?? ""))
    return "Not enough ETH for the transaction and network fee.";
  if (error instanceof BaseError) {
    const cause = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (cause instanceof ContractFunctionRevertedError)
      return (
        messages[cause.data?.errorName ?? ""] ??
        `Contract simulation failed${cause.reason ? `: ${cause.reason}` : ""}. Refresh the quote or reduce the amount.`
      );
  }
  if (
    /failed to fetch|network|fetch failed|timeout|HTTP request failed/i.test(
      e?.message ?? "",
    )
  )
    return "The data service could not be reached. Retry, or import the API responses below.";
  return (
    e?.shortMessage ||
    e?.message ||
    "The request failed. Retry after checking your wallet and connection."
  ).slice(0, 450);
}
export async function switchNetwork(provider: Provider, rt: Runtime) {
  const chainId = `0x${rt.config.chainId.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch (err) {
    const e = err as {
      code?: number;
      message?: string;
      data?: { originalError?: { code?: number } };
    };
    if (
      !(
        e.code === 4902 ||
        e.data?.originalError?.code === 4902 ||
        /unknown chain|unrecognized chain|not added/i.test(e.message ?? "")
      )
    )
      throw err;
    if (!rt.config.walletAddChain)
      throw new Error(
        "This chain is unavailable in your wallet and has no approved network settings.",
      );
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [rt.config.walletAddChain as never],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  }
}
export async function verifyDeployment(rt: Runtime) {
  if ((await rt.client.getChainId()) !== rt.config.chainId)
    throw new Error(
      "The RPC is on the wrong chain. Transactions are disabled.",
    );
  const dependencies = [
    ...rt.contracts.map((c) => c.address),
    ...Object.values(rt.config.network.uniswapV4).filter(
      (x): x is Address => typeof x === "string",
    ),
    rt.config.network.pairToken.address,
  ];
  for (const addr of [...new Set(dependencies)]) {
    const code = await rt.client.getCode({ address: addr });
    if (!code || code === "0x")
      throw new Error(
        `No deployed code at ${addr}. Transactions are disabled.`,
      );
  }
  const seller = rt.contract("SwarmSeller");
  const [manager, imd, fee, claimGas, symbol, decimals] = await Promise.all([
    rt.client.readContract({ ...seller, functionName: "poolManager" }),
    rt.client.readContract({ ...seller, functionName: "imd" }),
    rt.client.readContract({ ...seller, functionName: "FEE_BPS" }),
    rt.client.readContract({
      ...rt.contract("SwarmHarvester"),
      functionName: "CLAIM_GAS_LIMIT",
    }),
    rt.client.readContract({
      address: rt.contract("LaunchToken").address,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    rt.client.readContract({
      address: rt.contract("LaunchToken").address,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);
  if (
    !same(String(manager), rt.config.network.uniswapV4.poolManager) ||
    !same(String(imd), rt.config.network.pairToken.address) ||
    fee !== 50n
  )
    throw new Error(
      "Seller dependencies do not match the deployment configuration.",
    );
  return {
    fee: Number(fee),
    claimGas: Number(claimGas),
    symbol,
    decimals,
    checkedAt: Date.now(),
    block: await rt.client.getBlockNumber(),
  };
}
export async function assertWallet(
  provider: Provider,
  rt: Runtime,
  account: Address,
) {
  const [accounts, chain] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  if (!same(accounts[0], account))
    throw new Error(
      "The wallet account changed. Reconnect and review the action again.",
    );
  if (Number(BigInt(chain)) !== rt.config.chainId)
    throw new Error(`Switch your wallet to ${rt.config.network.name} first.`);
}
export type TxStage = {
  text: string;
  hash?: Hash;
  pending: boolean;
  error?: string;
};
export async function transact(
  rt: Runtime,
  provider: Provider,
  account: Address,
  request: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    value?: bigint;
  },
  update: (s: TxStage) => void,
  validate?: (result: unknown) => void,
) {
  update({ text: "Checking transaction…", pending: true });
  await assertWallet(provider, rt, account);
  await verifyDeployment(rt);
  const simulation = await rt.client.simulateContract({
    ...request,
    abi: request.abi as never,
    account,
  });
  validate?.(simulation.result);
  await assertWallet(provider, rt, account);
  update({ text: "Confirm in your wallet…", pending: true });
  const wallet = createWalletClient({
    chain: rt.chain,
    transport: custom(provider),
  });
  const hash = await wallet.writeContract({ ...simulation.request, account });
  update({ text: "Waiting for confirmation…", hash, pending: true });
  const receipt = await rt.client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 180_000,
    onReplaced: (replacement) =>
      update({
        text: "Following replacement transaction…",
        hash: replacement.transaction.hash,
        pending: true,
      }),
  });
  if (receipt.status !== "success")
    throw new Error(
      "The transaction reverted. No action was completed. Refresh and try again.",
    );
  return receipt;
}
export function events(rt: Runtime, receipt: TransactionReceipt, name: string) {
  const contract = rt.contract(name);
  return receipt.logs
    .filter((log) => same(log.address, contract.address))
    .flatMap((log) => {
      try {
        return [
          decodeEventLog({
            abi: contract.abi,
            data: log.data,
            topics: log.topics,
          }),
        ];
      } catch {
        return [];
      }
    });
}
export const poolTuple =
  "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
export const poolId = (key: PoolKey) =>
  keccak256(encodeAbiParameters(parseAbiParameters(poolTuple), [key]));
export function validPool(key: PoolKey, a: Address, b: Address) {
  const [c0, c1] = [a, b].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
  return (
    same(key.currency0, c0) &&
    same(key.currency1, c1) &&
    key.tickSpacing > 0 &&
    key.fee >= 0 &&
    key.fee <= 0xffffff
  );
}
export async function checkPool(rt: Runtime, key: PoolKey) {
  const [sqrt] = await rt.client.readContract({
    address: rt.config.network.uniswapV4.stateView,
    abi: stateAbi,
    functionName: "getSlot0",
    args: [poolId(key)],
  });
  if (sqrt === 0n) throw new Error("The pool has not been initialized.");
}
export function poolsFromReceipt(
  rt: Runtime,
  receipt: TransactionReceipt,
): PoolKey[] {
  return receipt.logs
    .filter((l) => same(l.address, rt.config.network.uniswapV4.poolManager))
    .flatMap((l) => {
      try {
        const { args } = decodeEventLog({
          abi: poolAbi,
          data: l.data,
          topics: l.topics,
        });
        return [
          {
            currency0: args.currency0,
            currency1: args.currency1,
            fee: args.fee,
            tickSpacing: args.tickSpacing,
            hooks: args.hooks,
          },
        ];
      } catch {
        return [];
      }
    });
}
export async function quoteHop(
  rt: Runtime,
  poolKey: PoolKey,
  input: Address,
  amount: bigint,
  account: Address,
) {
  if (amount <= 0n || amount > (1n << 127n) - 1n)
    throw new Error("The amount is outside the supported range.");
  const { result } = await rt.client.simulateContract({
    address: rt.config.network.uniswapV4.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey,
        zeroForOne: same(input, poolKey.currency0),
        exactAmount: amount,
        hookData: "0x",
      },
    ],
    account,
  });
  if (result[0] <= 0n) throw new Error("No liquidity for this amount.");
  return result[0];
}
export function slippageBps(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw new Error(
      "Use a slippage between 0.1% and 5%, with at most two decimal places.",
    );
  const bps = Math.round(Number(value) * 100);
  if (bps < 10 || bps > 500)
    throw new Error("Use a slippage between 0.1% and 5%.");
  return BigInt(bps);
}
export const minimum = (amount: bigint, bps: bigint) =>
  (amount * (10_000n - bps)) / 10_000n;
export const netAfterBurn = (gross: bigint) => gross - gross / 200n;
export function encodeSwap(
  rt: Runtime,
  input: Address,
  amountIn: bigint,
  amountOutMinimum: bigint,
) {
  const key = rt.config.poolKey;
  const zeroForOne = same(key.currency0, input);
  const output = zeroForOne ? key.currency1 : key.currency0;
  const fields = rt.config.network.uniswapV4.extendedSwapParams
    ? `${poolTuple} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData`
    : `${poolTuple} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData`;
  const tuple = {
    ...{ poolKey: key, zeroForOne, amountIn, amountOutMinimum },
    ...(rt.config.network.uniswapV4.extendedSwapParams
      ? { minHopPriceX36: 0n }
      : {}),
    hookData: "0x",
  };
  const swap = encodeAbiParameters(parseAbiParameters(`(${fields})`), [
    tuple as never,
  ]);
  const settle = encodeAbiParameters(parseAbiParameters("address,uint256"), [
    input,
    amountIn,
  ]);
  const take = encodeAbiParameters(parseAbiParameters("address,uint256"), [
    output,
    amountOutMinimum,
  ]);
  const packed = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [
    "0x060c0f",
    [swap, settle, take],
  ]);
  return {
    address: rt.config.network.uniswapV4.universalRouter,
    abi: routerAbi,
    functionName: "execute",
    args: [
      "0x10",
      [packed],
      BigInt(Math.floor(Date.now() / 1000) + 120),
    ] as const,
    value: same(input, zeroAddress) ? amountIn : 0n,
  };
}
export async function tradeApproval(
  rt: Runtime,
  account: Address,
  input: Address,
  amount: bigint,
) {
  if (same(input, zeroAddress)) return "ready" as const;
  const u = rt.config.network.uniswapV4;
  const allowance = await rt.client.readContract({
    address: input,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, u.permit2],
  });
  if (allowance < amount) return "token" as const;
  const [permitted, expiration] = await rt.client.readContract({
    address: u.permit2,
    abi: permitAbi,
    functionName: "allowance",
    args: [account, input, u.universalRouter],
  });
  if (permitted < amount || Number(expiration) < Date.now() / 1000 + 150)
    return "permit" as const;
  return "ready" as const;
}
export function asHex(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{64}$/.test(value))
    throw new Error("The proof or root is not a 32-byte hex value.");
  return value as Hex;
}
