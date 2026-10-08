import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { keccak256, toBytes } from "viem";
export const canonical = (x) =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x;
export const abiHash = (abi) =>
  keccak256(toBytes(JSON.stringify(canonical(abi)))).slice(2);
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function files(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const all = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) throw new Error("Symlinks are not export assets");
    const p = prefix + e.name;
    if (e.isDirectory())
      all.push(...(await files(`${dir}/${e.name}`, `${p}/`)));
    else all.push(p);
  }
  return all.sort();
}
export const json = async (p) => JSON.parse(await readFile(p, "utf8"));
export const safePath = (p) =>
  typeof p === "string" &&
  /^[\w./-]+$/.test(p) &&
  !p.startsWith("/") &&
  !p.split("/").includes("..");
