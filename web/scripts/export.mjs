import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { abiHash, files, sha256, json } from "./shared.mjs";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const config = await json("deployment.json");
for (const c of config.contracts) {
  const sourcePath = `docs/abi/${c.name}.json`;
  const pinned = execFileSync(
    "git",
    ["show", `${config.sourceCommit}:${sourcePath}`],
    { cwd: ".." },
  );
  const current = await readFile(`../${sourcePath}`);
  if (!pinned.equals(current))
    throw new Error(`${sourcePath} differs from the pinned implementation`);
  const abi = JSON.parse(pinned);
  if (!Array.isArray(abi) || abiHash(abi) !== c.abiHash)
    throw new Error(`ABI mismatch: ${c.name}`);
  await mkdir("../dist/abi", { recursive: true });
  await writeFile(`../dist/${c.abiPath}`, pinned);
}
const assets = [];
for (const path of await files("../dist")) {
  if (path === "imd-deployment.json") continue;
  const bytes = await readFile(`../dist/${path}`);
  assets.push({ path, sha256: sha256(bytes) });
}
await writeFile(
  "../dist/imd-deployment.json",
  JSON.stringify({ ...config, assets }, null, 2) + "\n",
);
await import("./verify.mjs");
