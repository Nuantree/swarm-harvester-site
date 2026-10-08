import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { abiHash, files, sha256, json, safePath } from "./shared.mjs";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const m = await json("../dist/imd-deployment.json");
const template = await json("deployment.json");
const { assets, ...config } = m;
assert.deepEqual(config, template);
assert.deepEqual(
  Object.keys(m).sort(),
  [
    "version",
    "launchId",
    "chainId",
    "sourceCommit",
    "attestationHash",
    "contracts",
    "poolKey",
    "network",
    "walletAddChain",
    "assets",
  ].sort(),
);
assert.equal(m.version, 1);
assert.equal(m.chainId, m.network.chainId);
assert(assets.length <= 128);
assert.deepEqual(
  assets.map((a) => a.path).sort(),
  (await files("../dist")).filter((p) => p !== "imd-deployment.json"),
);
let total = 0;
for (const a of assets) {
  assert(safePath(a.path));
  const data = await readFile(`../dist/${a.path}`);
  total += data.length;
  assert(data.length <= 8388608);
  assert.equal(a.sha256, sha256(data));
  assert.match(a.sha256, /^[a-f0-9]{64}$/);
}
for (const c of m.contracts) {
  assert(safePath(c.abiPath));
  assert.equal(c.abiHash, abiHash(await json(`../dist/${c.abiPath}`)));
}
try {
  await stat("../.imd/reads/deployment.json");
  const h = await json("../.imd/reads/deployment.json");
  const n = await json("../.imd/reads/network.json");
  for (const k of [
    "launchId",
    "chainId",
    "sourceCommit",
    "attestationHash",
    "poolKey",
  ])
    assert.deepEqual(m[k], h[k]);
  assert.deepEqual(
    m.contracts.map(({ abiPath, ...c }) => c),
    h.contracts.map((c) => ({
      name: c.name,
      address: c.address,
      abiHash: c.abiHash,
    })),
  );
  assert.deepEqual(m.network, n.network);
  assert.deepEqual(m.walletAddChain, n.walletAddChain);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
assert(total < 8 * 1024 * 1024, "Export exceeds submission budget");
console.log(
  `Verified: ${m.contracts.length} pinned ABIs, ${assets.length} assets, ${total} bytes; exact handoff, network, pool key and SHA-256 inventory.`,
);
