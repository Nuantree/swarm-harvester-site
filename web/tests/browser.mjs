import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { decodeAbiParameters, parseAbiParameters, zeroAddress } from "viem";
import {
  installMocks,
  config,
  addr,
  account,
  other,
  launch,
  proof,
} from "./fixtures.mjs";
const root = fileURLToPath(new URL("../..", import.meta.url)),
  out = resolve(root, "docs/frontend");
await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://local").pathname,
    );
    if (!pathname.startsWith("/preview/")) {
      res.writeHead(404).end();
      return;
    }
    const file = resolve(
      root,
      "dist",
      pathname.slice("/preview/".length) || "index.html",
    );
    if (!file.startsWith(resolve(root, "dist") + "/"))
      throw new Error("Bad path");
    const content = await readFile(file);
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
    res.end(content);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}/preview/`;
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const report = {
  date: new Date().toISOString(),
  browser: browser.version(),
  exportSubpath: "/preview/",
  checks: [],
  consoleErrors: [],
  resourceFailures: [],
  screenshots: [],
  contrast: [],
  limitations: [
    "Mocked wallet/RPC interactions do not establish live transaction success.",
    "No native screen reader, physical wallet or native 200% browser zoom was tested.",
  ],
};
async function step(name, fn) {
  await fn();
  report.checks.push({ name, status: "passed" });
  console.log(`PASS ${name}`);
}
async function context(options = {}) {
  const c = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    reducedMotion: "reduce",
  });
  const p = await c.newPage();
  p.on("pageerror", (e) => report.consoleErrors.push(e.message));
  p.on("response", (r) => {
    if (r.url().startsWith(origin) && r.status() >= 400)
      report.resourceFailures.push({
        url: r.url().replace(origin, "/preview/"),
        status: r.status(),
      });
  });
  const state = await installMocks(p, options);
  await p.goto(origin);
  await p.getByText("Checked on chain", { exact: true }).waitFor();
  return { c, p, state };
}
async function clickConnect(p) {
  await p
    .locator("header")
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await p
    .getByText("Checked 1 launches. 1 ready to claim.", { exact: true })
    .waitFor({ timeout: 20000 });
}
async function screenshot(p, name) {
  await p.screenshot({ path: resolve(out, name), fullPage: true });
  report.screenshots.push(`docs/frontend/${name}`);
}
async function noOverflow(p) {
  const dimensions = await p.evaluate(() => ({
    width: innerWidth,
    body: document.documentElement.scrollWidth,
  }));
  assert(dimensions.body <= dimensions.width, JSON.stringify(dimensions));
}
try {
  await step(
    "Disconnected, missing wallet, invalid address, static subpath and keyboard focus",
    async () => {
      const { c, p } = await context({ noWallet: true });
      await p
        .locator("header")
        .getByRole("button", { name: "Connect wallet" })
        .click();
      await p.getByText(/No browser wallet found/).waitFor();
      await p.getByLabel("Wallet address or ENS name").fill("invalid");
      await p.getByRole("button", { name: "Find rewards" }).click();
      await p.locator("#address-error").waitFor();
      assert.equal(
        await p.locator("#wallet-address").getAttribute("aria-invalid"),
        "true",
      );
      assert.equal(
        await p
          .locator("#wallet-address")
          .evaluate((el) => document.activeElement === el),
        true,
      );
      await p.reload();
      await p.getByText("Checked on chain", { exact: true }).waitFor();
      await p.keyboard.press("Tab");
      assert.equal(
        await p.evaluate(() => document.activeElement.textContent),
        "Skip to content",
      );
      await p.keyboard.press("Enter");
      await p.keyboard.press("Tab");
      await screenshot(p, "desktop.png");
      const axe = await new AxeBuilder({ page: p }).analyze();
      assert.deepEqual(
        axe.violations.map((v) => ({ id: v.id, nodes: v.nodes.length })),
        [],
      );
      report.checks.push({
        name: "axe accessibility scan: disconnected desktop",
        status: "passed",
        violations: 0,
      });
      const pairs = await p.evaluate(() => {
        const selectors = [
          ".hero-copy",
          ".hero h1",
          ".empty-state .button",
          ".button.dark",
          ".metric-label",
          ".fee-note",
        ];
        function rgb(v) {
          return (v.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        }
        function light(a) {
          return a
            .map((x) => {
              x /= 255;
              return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
            })
            .reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
        }
        return selectors.map((selector) => {
          const el = document.querySelector(selector);
          let node = el;
          let bg;
          while (node) {
            bg = getComputedStyle(node).backgroundColor;
            if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") break;
            node = node.parentElement;
          }
          const fg = getComputedStyle(el).color;
          const a = light(rgb(fg)),
            b = light(rgb(bg));
          return {
            selector,
            foreground: fg,
            background: bg,
            ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        });
      });
      report.contrast = pairs;
      assert(pairs.every((p) => p.ratio >= 4.5));
      for (const width of [768, 390, 320]) {
        await p.setViewportSize({ width, height: 900 });
        await noOverflow(p);
        if (width === 390) await screenshot(p, "mobile.png");
      }
      await p.setViewportSize({ width: 640, height: 900 });
      await p.evaluate(
        () => (document.documentElement.style.fontSize = "200%"),
      );
      await noOverflow(p);
      await p.emulateMedia({ forcedColors: "active" });
      assert.equal(
        await p
          .locator("button")
          .first()
          .evaluate((el) => getComputedStyle(el).borderStyle),
        "solid",
      );
      await c.close();
    },
  );
  await step(
    "Unknown chain: switch, add exact configured chain, switch again; round 1 proof resolution",
    async () => {
      const { c, p, state } = await context({ chain: "0xaa36a7" });
      await clickConnect(p);
      assert.equal(
        await p.getByRole("button", { name: "Claim all (1)" }).count(),
        0,
      );
      await p
        .getByRole("button", { name: "Switch to Ethereum", exact: true })
        .click();
      await p.getByRole("button", { name: "Claim all (1)" }).waitFor();
      const calls = await p.evaluate(() => window.__wallet.calls);
      assert.deepEqual(
        calls.filter((x) => x.method === "wallet_addEthereumChain")[0].params,
        [config.walletAddChain],
      );
      assert.equal(
        calls.filter((x) => x.method === "wallet_switchEthereumChain").length,
        2,
      );
      assert(state.calls.some((x) => x.fn === "claimed" && x.args[0] === 1n));
      await c.close();
    },
  );
  await step(
    "Claim receipt, refreshed balances, exact seller approval, guarded sale, pending lock and outcome logs",
    async () => {
      const { c, p, state } = await context();
      await clickConnect(p);
      await p.getByRole("button", { name: "Claim all (1)" }).click();
      await p
        .getByText(/Balances and claimed status refreshed/)
        .waitFor({ timeout: 25000 });
      assert.equal(state.sent[0].fn, "claimMany");
      assert.equal(state.sent[0].args[0][0].round, 1n);
      assert.equal(state.sent[0].args[0][0].account.toLowerCase(), account);
      await p.getByRole("button", { name: "Quote token balances" }).click();
      await p
        .getByRole("button", { name: "Approve HARVEST", exact: true })
        .waitFor();
      assert(
        state.calls.some(
          (x) =>
            x.fn === "quoteExactInputSingle" &&
            x.to.toLowerCase() === config.network.uniswapV4.quoter,
        ),
      );
      state.rejectNext = true;
      await p
        .getByRole("button", { name: "Approve HARVEST", exact: true })
        .click();
      await p.getByText(/Request declined in your wallet/).waitFor();
      assert.equal(state.sent.length, 1);
      state.receiptDelay = 1200;
      await p
        .getByRole("button", { name: "Approve HARVEST", exact: true })
        .click();
      await p.getByText("Waiting for confirmation…", { exact: true }).waitFor();
      assert.equal(
        await p
          .getByRole("button", { name: "Approving…", exact: true })
          .isDisabled(),
        true,
      );
      await p
        .getByText(/Approval confirmed. Get a fresh quote/)
        .waitFor({ timeout: 20000 });
      const approval = state.sent[1];
      assert.equal(approval.fn, "approve");
      assert.equal(approval.args[0].toLowerCase(), addr.SwarmSeller);
      assert.equal(approval.args[1], 10n * 10n ** 18n);
      await p.getByRole("button", { name: "Quote token balances" }).click();
      await p
        .getByRole("button", { name: "Sell all to IMD", exact: true })
        .waitFor();
      await screenshot(p, "quoted-sale.png");
      const connectedAxe = await new AxeBuilder({ page: p }).analyze();
      assert.deepEqual(
        connectedAxe.violations.map((v) => v.id),
        [],
      );
      report.checks.push({
        name: "axe accessibility scan: connected quote",
        status: "passed",
        violations: 0,
      });
      for (const width of [768, 390, 320]) {
        await p.setViewportSize({ width, height: 900 });
        await noOverflow(p);
        if (width === 390) await screenshot(p, "mobile-quote.png");
      }
      await p.setViewportSize({ width: 1280, height: 960 });

      state.failSimulation = true;
      await p
        .getByRole("button", { name: "Sell all to IMD", exact: true })
        .click();
      await p
        .getByText(
          "The output fell below your minimum. Refresh the quote and try again.",
          { exact: true },
        )
        .waitFor();
      await p.waitForFunction(
        () => !document.querySelector(".sale-actions button")?.disabled,
      );
      assert.equal(state.sent.length, 2);
      state.failSimulation = false;
      await p
        .getByRole("button", { name: "Sell all to IMD", exact: true })
        .click();
      await p.getByText(/Sale confirmed: 1 sold/).waitFor({ timeout: 25000 });
      const sale = state.sent[2];
      assert.equal(sale.fn, "sellMany");
      assert.equal(sale.args[1].toLowerCase(), account);
      assert(sale.args[2] > 0n);
      assert.equal(sale.args[0][0].route.length, 2);
      assert.equal(
        sale.args[0][0].route[0].hooks.toLowerCase(),
        config.poolKey.hooks,
      );
      await c.close();
    },
  );
  await step(
    "Native HARVEST purchase: quote minimum, router calldata, simulation and no approvals",
    async () => {
      const { c, p, state } = await context();
      await clickConnect(p);
      await p.getByLabel("You pay ETH").fill("0.1");
      await p.getByRole("button", { name: "Get quote", exact: true }).click();
      await p.getByRole("button", { name: "Confirm purchase" }).waitFor();
      await p.getByRole("button", { name: "Confirm purchase" }).click();
      await p
        .getByText("Swap confirmed. Balances are refreshing.")
        .waitFor({ timeout: 20000 });
      assert.equal(state.sent.length, 1);
      assert.equal(state.sent[0].fn, "execute");
      assert.equal(BigInt(state.sent[0].tx.value), 10n ** 17n);
      assert.equal(
        state.sent[0].tx.to.toLowerCase(),
        config.network.uniswapV4.universalRouter,
      );
      const [actions, params] = decodeAbiParameters(
        parseAbiParameters("bytes,bytes[]"),
        state.sent[0].args[1][0],
      );
      assert.equal(actions, "0x060c0f");
      const [tuple] = decodeAbiParameters(
        parseAbiParameters(
          "((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)",
        ),
        params[0],
      );
      assert.equal(tuple.poolKey.hooks.toLowerCase(), config.poolKey.hooks);
      assert(tuple.amountOutMinimum > 0n);
      await c.close();
    },
  );
  await step(
    "HARVEST sale: separate token and Permit2 approvals, quote invalidation, account change",
    async () => {
      const { c, p, state } = await context();
      await clickConnect(p);
      const trade = p.locator("#trade");
      await trade
        .getByRole("button", { name: "Sell HARVEST", exact: true })
        .click();
      await p.getByLabel("You pay HARVEST").fill("1");
      await trade
        .getByRole("button", { name: "Get quote", exact: true })
        .click();
      await trade
        .getByRole("button", { name: "Approve HARVEST", exact: true })
        .click();
      await trade.getByText(/Approval confirmed/).waitFor({ timeout: 20000 });
      assert.equal(
        state.sent[0].args[0].toLowerCase(),
        config.network.uniswapV4.permit2,
      );
      await trade
        .getByRole("button", { name: "Get quote", exact: true })
        .click();
      await trade
        .getByRole("button", { name: "Approve router access", exact: true })
        .click();
      await trade.getByText(/Approval confirmed/).waitFor({ timeout: 20000 });
      assert.equal(
        state.sent[1].tx.to.toLowerCase(),
        config.network.uniswapV4.permit2,
      );
      assert.equal(
        state.sent[1].args[1].toLowerCase(),
        config.network.uniswapV4.universalRouter,
      );
      await trade
        .getByRole("button", { name: "Get quote", exact: true })
        .click();
      await trade
        .getByRole("button", { name: "Confirm sale", exact: true })
        .waitFor();
      await trade.getByLabel("Slippage limit (%)", { exact: true }).fill("0.7");
      assert.equal(
        await trade
          .getByRole("button", { name: "Confirm sale", exact: true })
          .count(),
        0,
      );
      await trade
        .getByRole("button", { name: "Get quote", exact: true })
        .click();
      await trade
        .getByRole("button", { name: "Confirm sale", exact: true })
        .waitFor();
      await p.evaluate((other) => {
        window.__wallet.account = other;
        window.__wallet.emit("accountsChanged", [other]);
      }, other);
      await trade
        .getByRole("button", { name: "Get quote", exact: true })
        .waitFor();
      assert.equal(state.sent.length, 2);
      await c.close();
    },
  );
  await step(
    "API error is recoverable through imported responses; viewed beneficiary remains separate from payer",
    async () => {
      const { c, p, state } = await context({ failApi: true });
      await p
        .locator("header")
        .getByRole("button", { name: "Connect wallet" })
        .click();
      await p.getByText(/data service could not be reached/).waitFor();
      await p.getByLabel("Public API JSON").fill(
        JSON.stringify({
          earned: { claimable: [config.launchId], unlocks: [] },
          launches: { [config.launchId]: launch },
          claims: { [config.launchId]: proof },
        }),
      );
      await p
        .getByRole("button", { name: "Verify imported responses" })
        .click();
      await p.getByRole("button", { name: "Claim all (1)" }).waitFor();
      assert.equal(
        await p.getByText("Imported record · verified against chain").count(),
        1,
      );
      await p.getByLabel("Wallet address or ENS name").fill(other);
      await p.getByRole("button", { name: "Find rewards" }).click();
      await p.getByText(/You are claiming for another address/).waitFor();
      await p.getByRole("button", { name: "Claim all (1)" }).click();
      await p
        .getByText(/Balances and claimed status refreshed/)
        .waitFor({ timeout: 20000 });
      assert.equal(state.sent[0].args[0][0].account.toLowerCase(), other);
      assert.equal(state.sent[0].tx.from.toLowerCase(), account);
      await c.close();
    },
  );
  await step(
    "Tiny output is rejected and expired quotes cannot request approval",
    async () => {
      const { c, p, state } = await context();
      await clickConnect(p);
      const trade = p.locator("#trade");
      await trade
        .getByRole("button", { name: "Sell HARVEST", exact: true })
        .click();
      await trade.getByLabel("You pay HARVEST").fill("0.000000000000001");
      await trade
        .getByRole("button", { name: "Get quote", exact: true })
        .click();
      await trade
        .getByText(
          "This output is below the minimum unit. Increase the amount.",
          { exact: true },
        )
        .waitFor();
      await trade.getByLabel("You pay HARVEST").fill("1");
      await trade
        .getByRole("button", { name: "Get quote", exact: true })
        .click();
      await trade
        .getByRole("button", { name: "Approve HARVEST", exact: true })
        .waitFor();
      await p.evaluate(() => {
        const original = Date.now;
        Date.now = () => original() + 61000;
      });
      await trade.getByText("Expired — refresh", { exact: true }).waitFor();
      assert.equal(
        await trade
          .getByRole("button", { name: "Approve HARVEST", exact: true })
          .count(),
        0,
      );
      assert.equal(state.sent.length, 0);
      await c.close();
    },
  );
  await step(
    "HARVEST transfer validates recipient and signs the reviewed amount",
    async () => {
      const { c, p, state } = await context();
      await clickConnect(p);
      await p.getByText("Transfer HARVEST", { exact: true }).click();
      await p.getByLabel("Recipient address or ENS name").fill(other);
      await p.getByLabel("HARVEST amount", { exact: true }).fill("1.5");
      await p.getByRole("button", { name: "Review HARVEST transfer" }).click();
      await p
        .getByText("HARVEST transfer confirmed.")
        .waitFor({ timeout: 20000 });
      assert.equal(state.sent[0].fn, "transfer");
      assert.equal(state.sent[0].args[1], 15n * 10n ** 17n);
      await c.close();
    },
  );
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.resourceFailures, []);
  await writeFile(
    resolve(out, "browser-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `Browser checks passed (${report.checks.length}); evidence written to docs/frontend.`,
  );
} catch (error) {
  console.error(error);
  for (const c of browser.contexts())
    for (const p of c.pages()) {
      await p
        .screenshot({ path: "/tmp/swarm-browser-failure.png", fullPage: true })
        .catch(() => {});
      console.error((await p.locator("body").innerText()).slice(-9000));
    }
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
