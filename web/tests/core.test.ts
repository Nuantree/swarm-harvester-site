import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeAbiParameters,
  parseAbiParameters,
  zeroAddress,
  type Address,
} from "viem";
import {
  encodeSwap,
  minimum,
  netAfterBurn,
  poolId,
  slippageBps,
  switchNetwork,
  validPool,
  explain,
} from "../src/chain";
import { canonical, safePath, type Runtime } from "../src/config";
import { parseEarned, parseImport, resolveRound } from "../src/rewards";
const config = JSON.parse(
  readFileSync(new URL("../deployment.json", import.meta.url), "utf8"),
);
const rt = { config } as Runtime;
test("minimum and aggregate burn use exact integers and one rounding per batch", () => {
  assert.equal(netAfterBurn(20001n), 19901n);
  assert.equal(netAfterBurn(199n), 199n);
  assert.equal(minimum(20001n, 100n), 19800n);
  assert.equal(
    minimum(90071992547409930000000001n, 50n),
    89621632584672880350000000n,
  );
  assert.equal(slippageBps("0.50"), 50n);
  for (const invalid of ["-1", "0", "10", "abc", "1e2", "0.009", "0.555"])
    assert.throws(() => slippageBps(invalid));
});
test("router calldata binds the handoff pool, minimum, action order and native value", () => {
  const request = encodeSwap(rt, zeroAddress, 100n, 95n);
  assert.equal(request.address, config.network.uniswapV4.universalRouter);
  assert.equal(request.value, 100n);
  assert.equal(request.args[0], "0x10");
  const [actions, params] = decodeAbiParameters(
    parseAbiParameters("bytes,bytes[]"),
    request.args[1][0],
  );
  assert.equal(actions, "0x060c0f");
  const [tuple] = decodeAbiParameters(
    parseAbiParameters(
      "((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)",
    ),
    params[0],
  );
  assert.equal(tuple.poolKey.hooks.toLowerCase(), config.poolKey.hooks);
  assert.equal(tuple.poolKey.fee, 12500);
  assert.equal(tuple.amountOutMinimum, 95n);
  assert.equal(tuple.zeroForOne, true);
  const [input, settle] = decodeAbiParameters(
    parseAbiParameters("address,uint256"),
    params[1],
  );
  assert.equal(input, zeroAddress);
  assert.equal(settle, 100n);
  const sell = encodeSwap(rt, config.poolKey.currency1, 123n, 5n);
  assert.equal(sell.value, 0n);
});
test("extended router adds the required zero price field", () => {
  const extended = {
    config: {
      ...config,
      network: {
        ...config.network,
        uniswapV4: { ...config.network.uniswapV4, extendedSwapParams: true },
      },
    },
  } as Runtime;
  const request = encodeSwap(extended, config.poolKey.currency1, 100n, 95n);
  const [, params] = decodeAbiParameters(
    parseAbiParameters("bytes,bytes[]"),
    request.args[1][0],
  );
  const [tuple] = decodeAbiParameters(
    parseAbiParameters(
      "((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)",
    ),
    params[0],
  );
  assert.equal(tuple.minHopPriceX36, 0n);
  assert.equal(tuple.zeroForOne, false);
});
test("missing chain requests the exact add-chain object, then switches again", async () => {
  const calls: unknown[] = [];
  let count = 0;
  const provider = {
    request: async (args: unknown) => {
      calls.push(args);
      if (count++ === 0) throw { code: 4902 };
    },
  };
  await switchNetwork(provider as never, rt);
  assert.deepEqual(calls, [
    { method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] },
    { method: "wallet_addEthereumChain", params: [config.walletAddChain] },
    { method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] },
  ]);
});
test("rejected network change does not request add-chain", async () => {
  let count = 0;
  await assert.rejects(() =>
    switchNetwork(
      {
        request: async () => {
          count++;
          throw { code: 4001 };
        },
      } as never,
      rt,
    ),
  );
  assert.equal(count, 1);
  assert.match(explain({ code: 4001 }), /declined/);
});
test("round root is matched, never assumed zero; ambiguous and absent roots fail closed", async () => {
  const roots = ["0x" + "11".repeat(32), "0x" + "22".repeat(32)];
  const fake = {
    client: {
      readContract: async ({
        functionName,
        args,
      }: {
        functionName: string;
        args: bigint[];
      }) => (functionName === "roundCount" ? 2n : roots[Number(args[0])]),
    },
  } as unknown as Runtime;
  const d = config.contracts[1].address as Address;
  assert.equal(await resolveRound(fake, d, roots[1] as never), 1n);
  await assert.rejects(() =>
    resolveRound(fake, d, ("0x" + "33".repeat(32)) as never),
  );
  roots[0] = roots[1];
  await assert.rejects(
    () => resolveRound(fake, d, roots[1] as never),
    /exactly one/,
  );
});
test("untrusted JSON, path traversal and invalid IDs are rejected", () => {
  for (const path of [
    "../key",
    "/abi.json",
    "https://example.org/abi.json",
    "abi/../../config",
  ])
    assert.equal(safePath(path), false);
  assert.equal(safePath("abi/LaunchToken.json"), true);
  assert.throws(() => parseEarned({ claimable: ["953"], unlocks: [] }));
  assert.deepEqual(parseImport('{"claimable":[],"unlocks":[]}'), {
    earned: { claimable: [], unlocks: [] },
  });
  assert.throws(() => parseImport('{"owner":"unknown"}'));
  assert.deepEqual(canonical({ z: 1, a: { d: 1, c: 2 } }), {
    a: { c: 2, d: 1 },
    z: 1,
  });
});
test("pool sorting is exact and hooks contribute to pool identity", () => {
  const k = config.poolKey;
  assert(validPool(k, k.currency1, k.currency0));
  assert(
    !validPool(
      { ...k, currency0: k.currency1, currency1: k.currency0 },
      k.currency1,
      k.currency0,
    ),
  );
  assert.notEqual(poolId(k), poolId({ ...k, hooks: zeroAddress }));
});

test("bridge discovery survives RPC range limits and skips recently initialized dry pools", async () => {
  const { discoverBridge } = await import("../src/rewards");
  let split = false;
  const mock = {
    config,
    client: {
      getBlockNumber: async () => 25000n,
      getLogs: async ({
        fromBlock,
        toBlock,
      }: {
        fromBlock: bigint;
        toBlock: bigint;
      }) => {
        if (toBlock - fromBlock >= 5000n) {
          split = true;
          throw new Error("Log range exceeds provider limit");
        }
        return [
          {
            args: {
              currency0: zeroAddress,
              currency1: config.network.pairToken.address,
              fee: toBlock > 15000n ? 10003 : 3000,
              tickSpacing: 60,
              hooks: zeroAddress,
            },
          },
        ];
      },
      simulateContract: async ({
        args,
      }: {
        args: { poolKey: { fee: number } }[];
      }) => {
        if (args[0].poolKey.fee === 10003) throw new Error("No liquidity");
        return { result: [1000n, 50000n] };
      },
    },
  } as unknown as Runtime;
  const keys = await discoverBridge(
    mock,
    () => {},
    undefined,
    100n,
    config.contracts[1].address,
  );
  assert(split);
  assert(keys.length > 0);
  assert(keys.every((k) => k.fee === 3000));
});
