// Optional real-service browser evidence. Never injects a wallet or sends a transaction.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../..", import.meta.url));
const config = JSON.parse(
  await readFile(resolve(root, "dist/imd-deployment.json"), "utf8"),
);
const account = "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7";
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://local").pathname);
    if (!path.startsWith("/preview/")) throw new Error("Path");
    const file = resolve(root, "dist", path.slice(9) || "index.html");
    if (!file.startsWith(resolve(root, "dist") + "/")) throw new Error("Path");
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
      }[extname(file)] ?? "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const report = {
  date: new Date().toISOString(),
  browser: browser.version(),
  console: [],
  failedRequests: [],
  checks: [],
  walletConnected: false,
  broadcasts: 0,
};
page.on("console", (message) => {
  if (message.type() === "error") report.console.push(message.text());
});
page.on("requestfailed", (request) =>
  report.failedRequests.push({
    url: request.url(),
    reason: request.failure()?.errorText,
  }),
);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/preview/`);
  await page
    .getByText("Checked on chain", { exact: true })
    .waitFor({ timeout: 60000 });
  report.checks.push("Live RPC deployment verification rendered successfully");
  await page.getByLabel("Wallet address or ENS name").fill(account);
  await page.getByRole("button", { name: "Find rewards" }).click();
  await page.waitForFunction(
    () => !document.querySelector("#wallet-address")?.disabled,
    {},
    { timeout: 60000 },
  );
  const status = await page.locator(".rewards-card > .feedback").innerText();
  report.checks.push({ lookupStatus: status });
  const fetchJSON = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const [earned, launch, proof] = await Promise.all([
    fetchJSON(`https://explorer.imd.fun/api/earned?wallet=${account}`),
    fetchJSON(`https://api.imd.fun/launches/${config.launchId}`),
    fetchJSON(
      `https://explorer.imd.fun/api/claim?launch=${config.launchId}&wallet=${account}`,
    ),
  ]);
  const bundle = {
    earned: {
      claimable: earned.claimable.filter((id) => id === config.launchId),
      unlocks: earned.unlocks.filter((u) => u.id === config.launchId),
    },
    launches: { [config.launchId]: launch },
    claims: { [config.launchId]: proof },
  };
  await page.locator(".import-panel").evaluate((el) => (el.open = true));
  await page.getByLabel("Public API JSON").fill(JSON.stringify(bundle));
  await page.getByRole("button", { name: "Verify imported responses" }).click();
  await page.getByText(/Checked 1 launches\./).waitFor({ timeout: 90000 });
  report.checks.push({
    importedLaunch: await page.locator(".reward-row").innerText(),
  });
  await page
    .getByText("Deployment and live contract state", { exact: true })
    .click();
  await page.screenshot({
    path: resolve(root, "docs/frontend/live-import.png"),
    fullPage: true,
  });
  await writeFile(
    resolve(root, "docs/frontend/live-browser.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
