import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits, zeroAddress, type Address } from "viem";
import { erc20Abi, same, type Runtime } from "./config";
import {
  events,
  explain,
  slippageBps,
  transact,
  verifyDeployment,
  type TxStage,
} from "./chain";
import {
  claimUrl,
  earnedUrl,
  launchUrl,
  loadEarned,
  loadReward,
  parseImport,
  quoteSales,
  refreshReward,
  remember,
  resolveInput,
  storedIds,
  uuid,
  type Earned,
  type ImportData,
  type Reward,
  type SalePlan,
} from "./rewards";
import { AddressLink, Amount, Feedback, Icon, WalletGate } from "./components";
import { useWallet } from "./wallet";
import { Trade } from "./Trade";
export default function App({ rt }: { rt: Runtime }) {
  const wallet = useWallet(rt);
  const [verification, setVerification] =
    useState<Awaited<ReturnType<typeof verifyDeployment>>>();
  const [verifyError, setVerifyError] = useState(""),
    [verifying, setVerifying] = useState(false);
  const [lookup, setLookup] = useState(""),
    [beneficiary, setBeneficiary] = useState<Address>(),
    [addressError, setAddressError] = useState("");
  const [rows, setRows] = useState<Reward[]>([]),
    [earned, setEarned] = useState<Earned>(),
    [remaining, setRemaining] = useState<string[]>([]);
  const [scan, setScan] = useState<TxStage>(),
    [claimState, setClaimState] = useState<TxStage>(),
    [quoteState, setQuoteState] = useState<TxStage>(),
    [saleState, setSaleState] = useState<TxStage>();
  const [busy, setBusy] = useState(false),
    [tab, setTab] = useState<"claims" | "balances">("claims");
  const [plan, setPlan] = useState<SalePlan>(),
    [sellSlippage, setSellSlippage] = useState("1"),
    [now, setNow] = useState(Date.now());
  const [importText, setImportText] = useState(""),
    [imported, setImported] = useState<ImportData>({}),
    [importError, setImportError] = useState("");
  const [manualId, setManualId] = useState(""),
    [transferTo, setTransferTo] = useState(""),
    [transferAmount, setTransferAmount] = useState(""),
    [transferState, setTransferState] = useState<TxStage>();
  const [tokenBalance, setTokenBalance] = useState<bigint>(),
    [imdBalance, setImdBalance] = useState<bigint>();
  const scanGeneration = useRef(0),
    transactionLock = useRef(false),
    generation = useRef(0),
    lookupRef = useRef<HTMLInputElement>(null);
  const ready = rows.filter((r) => r.status === "ready"),
    selected = ready.filter((r) => r.selected),
    held = rows.filter((r) => r.balance > 0n);
  const connectedBeneficiary =
    !!wallet.account && same(wallet.account, beneficiary);
  const approved = plan?.quotes.find(
    (q) =>
      (rows.find((r) => same(r.token, q.token))?.allowance ?? 0n) < q.amountIn,
  );
  const quoteExpired = !!plan && now - plan.at > 60000;
  const transactionReady =
    !!verification && wallet.correctChain && !!wallet.account;
  const busyAny = busy || !!scan?.pending;
  const pending =
    !!claimState?.pending || !!saleState?.pending || !!transferState?.pending;
  useEffect(() => {
    if (addressError) lookupRef.current?.focus();
  }, [addressError]);
  const check = useCallback(async () => {
    setVerifying(true);
    setVerification(undefined);
    setVerifyError("");
    try {
      setVerification(await verifyDeployment(rt));
    } catch (e) {
      setVerifyError(explain(e));
    } finally {
      setVerifying(false);
    }
  }, [rt]);
  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    generation.current++;
    scanGeneration.current++;
    setPlan(undefined);
    setImported({});
    setRows([]);
    setEarned(undefined);
    setRemaining([]);
    setBeneficiary(undefined);
    setScan(undefined);
    setTokenBalance(undefined);
    setImdBalance(undefined);
    if (wallet.account) {
      setLookup(wallet.account);
      void scanWallet(wallet.account, {});
    } else setLookup("");
  }, [wallet.account]); // Wallet identity is the invalidation boundary.
  useEffect(() => {
    generation.current++;
    setPlan(undefined);
  }, [wallet.epoch]);
  useEffect(() => {
    generation.current++;
    setPlan(undefined);
  }, [sellSlippage]);
  useEffect(() => {
    let stopped = false;
    if (!wallet.account || !verification) return;
    void Promise.all([
      rt.client.readContract({
        ...rt.contract("LaunchToken"),
        functionName: "balanceOf",
        args: [wallet.account],
      }),
      rt.client.readContract({
        address: rt.config.network.pairToken.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.account],
      }),
    ])
      .then(([token, imd]) => {
        if (!stopped) {
          setTokenBalance(token as bigint);
          setImdBalance(imd);
        }
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [wallet.account, verification, pending, rt]);
  async function populate(
    ids: string[],
    account: Address,
    data: ImportData,
    initial: Reward[],
    schedule: Earned | undefined,
    run: number,
  ) {
    const batch = ids.slice(0, 24),
      later = ids.slice(24);
    let completed = 0;
    const result = [...initial];
    // Four launches in flight bounds RPC pressure; each launch resolves proof/round before eligibility.
    for (let offset = 0; offset < batch.length; offset += 4) {
      if (run !== scanGeneration.current) return;
      const group = await Promise.all(
        batch
          .slice(offset, offset + 4)
          .map((id) =>
            loadReward(
              rt,
              id,
              account,
              data,
              !!schedule?.unlocks.some(
                (u) => u.id === id && Date.parse(u.at) > Date.now(),
              ),
            ),
          ),
      );
      if (run !== scanGeneration.current) return;
      for (const row of group) {
        const old = result.findIndex((r) => r.id === row.id);
        if (old < 0) result.push(row);
        else result[old] = row;
      }
      completed += group.length;
      setRows([...result]);
      setScan({
        text: `Checking launches: ${completed} of ${batch.length}…`,
        pending: true,
      });
    }
    if (run !== scanGeneration.current) return;
    remember(
      account,
      result.filter((r) => r.token).map((r) => r.id),
    );
    setRemaining(later);
    setScan({
      text: result.length
        ? `Checked ${result.length} launches. ${result.filter((r) => r.status === "ready").length} ready to claim.`
        : "No claimable launches found. Check back after contributing to a launch.",
      pending: false,
    });
  }
  async function scanWallet(value: string, data: ImportData = imported) {
    if (transactionLock.current) return;
    const run = ++scanGeneration.current;
    setAddressError("");
    setPlan(undefined);
    setScan({ text: "Finding your launch rewards…", pending: true });
    try {
      const account = await resolveInput(value, rt);
      if (
        same(account, zeroAddress) ||
        same(account, rt.contract("SwarmHarvester").address)
      )
        throw new Error("Use a wallet address that can receive rewards.");
      if (run !== scanGeneration.current) return;
      setBeneficiary(account);
      setLookup(account);
      setRows([]);
      setRemaining([]);
      setEarned(undefined);
      const schedule = await loadEarned(account, data);
      if (run !== scanGeneration.current) return;
      setEarned(schedule);
      const ids = [
        ...new Set([
          ...schedule.claimable,
          ...storedIds(account),
          ...schedule.unlocks.map((x) => x.id),
        ]),
      ];
      await populate(ids, account, data, [], schedule, run);
    } catch (e) {
      if (run !== scanGeneration.current) return;
      const message = explain(e);
      setScan({ text: "", error: message, pending: false });
      if (
        !/^0x[\da-f]{40}$/i.test(value.trim()) &&
        !value.trim().endsWith(".eth")
      ) {
        setAddressError(message);
      }
    }
  }
  async function addLaunch() {
    if (!uuid(manualId)) {
      setImportError("Enter a launch UUID from its public launch record.");
      return;
    }
    if (!beneficiary) {
      setImportError("Look up a wallet address first.");
      return;
    }
    setImportError("");
    setPlan(undefined);
    const run = ++scanGeneration.current;
    setScan({ text: "Checking this launch…", pending: true });
    await populate([manualId], beneficiary, imported, rows, earned, run);
    setManualId("");
  }
  async function importResponses() {
    try {
      const data = parseImport(importText);
      const merged = {
        ...imported,
        ...data,
        launches: { ...imported.launches, ...data.launches },
        claims: { ...imported.claims, ...data.claims },
      };
      setImported(merged);
      setImportError("");
      setImportText("");
      setPlan(undefined);
      if (data.earned) await scanWallet(lookup, merged);
      else if (beneficiary) {
        const ids = [
          ...new Set([
            ...rows.map((r) => r.id),
            ...Object.keys(data.launches ?? {}),
          ]),
        ];
        const run = ++scanGeneration.current;
        setScan({
          text: "Verifying imported responses on chain…",
          pending: true,
        });
        await populate(ids, beneficiary, merged, [], earned, run);
      }
    } catch (e) {
      setImportError(explain(e));
    }
  }
  async function refreshRows(target: Address, expected: number) {
    const fresh = await Promise.all(
      rows.map((r) => refreshReward(rt, r, target)),
    );
    if (generation.current === expected && same(target, beneficiary)) {
      setRows(fresh);
      setScan({
        text: `Checked ${fresh.length} launches. ${fresh.filter((r) => r.status === "ready").length} ready to claim.`,
        pending: false,
      });
    }
    return fresh;
  }
  async function transaction(
    kind: "claim" | "quote" | "approve" | "reset" | "sell" | "transfer",
  ) {
    if (
      transactionLock.current ||
      busy ||
      !transactionReady ||
      !wallet.provider ||
      !wallet.account
    )
      return;
    const update =
      kind === "claim"
        ? setClaimState
        : kind === "quote"
          ? setQuoteState
          : kind === "transfer"
            ? setTransferState
            : setSaleState;
    transactionLock.current = true;
    setBusy(true);
    const run = generation.current;
    const account = wallet.account;
    update({ text: "Checking action…", pending: true });
    try {
      if (kind === "claim") {
        if (!selected.length || !beneficiary)
          throw new Error("Select at least one verified claim.");
        if (selected.some((r) => !same(r.claim?.account, beneficiary)))
          throw new Error("The beneficiary changed. Refresh these claims.");
        const claims = selected.map((r) => r.claim!);
        const receipt = await transact(
          rt,
          wallet.provider,
          account,
          {
            ...rt.contract("SwarmHarvester"),
            functionName: "claimMany",
            args: [claims],
          },
          update,
          (result) => {
            if (result === 0n)
              throw new Error(
                "None of these claims can succeed now. Refresh the rewards.",
              );
          },
        );
        const outcomes = events(rt, receipt, "SwarmHarvester")
          .filter((e) => e.eventName === "ClaimResult")
          .map((e) => e.args as unknown as { ok: boolean });
        const successes = outcomes.filter((e) => e.ok).length;
        update({
          text: `Claim confirmed: ${successes} paid, ${outcomes.length - successes} skipped. Checking claimed status and balances…`,
          hash: receipt.transactionHash,
          pending: true,
        });
        await refreshRows(beneficiary, run);
        update({
          text: `Claim confirmed: ${successes} distributor calls completed; ${outcomes.length - successes} skipped. Balances and claimed status refreshed.`,
          hash: receipt.transactionHash,
          pending: false,
        });
        if (run === generation.current) setTab("balances");
      } else if (kind === "quote") {
        if (!connectedBeneficiary)
          throw new Error("Look up your connected wallet to sell its tokens.");
        const unique = [
          ...new Map(
            held.filter((r) => r.token).map((r) => [r.token!.toLowerCase(), r]),
          ).values(),
        ];
        const result = await quoteSales(
          rt,
          unique,
          account,
          slippageBps(sellSlippage),
          (text) => update({ text, pending: true }),
          imported.bridgePool,
        );
        if (run !== generation.current) return;
        setPlan(result);
        setSaleState(undefined);
        if (!result.quotes.length)
          throw new Error(
            "No supported balances could be quoted. Review the per-token reasons below.",
          );
        await refreshRows(account, run);
        update({
          text: `Quoted ${result.quotes.length} token${result.quotes.length === 1 ? "" : "s"}. Review the amounts and minimum received.`,
          pending: false,
        });
      } else if (kind === "transfer") {
        const to = await resolveInput(transferTo, rt);
        if (same(to, zeroAddress))
          throw new Error("Enter a recipient that can receive tokens.");
        if (
          !/^\d+(\.\d+)?$/.test(transferAmount) ||
          (transferAmount.split(".")[1]?.length ?? 0) >
            (verification?.decimals ?? 18)
        )
          throw new Error(
            "Enter a positive HARVEST amount within its decimal precision.",
          );
        const value = parseUnits(transferAmount, verification?.decimals ?? 18);
        if (value <= 0n) throw new Error("Enter an amount greater than zero.");
        const receipt = await transact(
          rt,
          wallet.provider,
          account,
          {
            ...rt.contract("LaunchToken"),
            functionName: "transfer",
            args: [to, value],
          },
          update,
        );
        update({
          text: "HARVEST transfer confirmed.",
          hash: receipt.transactionHash,
          pending: false,
        });
      } else {
        if (!plan || !same(plan.account, account) || !connectedBeneficiary)
          throw new Error("The account changed. Quote your balances again.");
        if (kind === "approve" || kind === "reset") {
          if (!approved)
            throw new Error(
              "All amounts are already approved. Refresh the quote.",
            );
          const amount = kind === "reset" ? 0n : approved.amountIn;
          const receipt = await transact(
            rt,
            wallet.provider,
            account,
            {
              address: approved.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [rt.contract("SwarmSeller").address, amount],
            },
            update,
          );
          await refreshRows(account, run);
          setPlan(undefined);
          update({
            text:
              kind === "reset"
                ? "Allowance reset. Get a new quote, then approve the required amount."
                : "Approval confirmed. Get a fresh quote to continue.",
            hash: receipt.transactionHash,
            pending: false,
          });
        } else {
          if (Date.now() - plan.at > 60000)
            throw new Error(
              "The quote expired. Get a new quote before selling.",
            );
          for (const q of plan.quotes) {
            const allowance = await rt.client.readContract({
              address: q.token,
              abi: erc20Abi,
              functionName: "allowance",
              args: [account, rt.contract("SwarmSeller").address],
            });
            if (allowance < q.amountIn)
              throw new Error(
                "A token allowance changed. Get a new quote and approve it again.",
              );
          }
          const sales = plan.quotes.map(
            ({ token, amountIn, minOut, route }) => ({
              token,
              amountIn,
              minOut,
              route,
            }),
          );
          const receipt = await transact(
            rt,
            wallet.provider,
            account,
            {
              ...rt.contract("SwarmSeller"),
              functionName: "sellMany",
              args: [
                sales,
                account,
                plan.minNet,
                BigInt(Math.floor(Date.now() / 1000) + 120),
              ],
            },
            update,
          );
          const logs = events(rt, receipt, "SwarmSeller");
          const results = logs
            .filter((e) => e.eventName === "SaleResult")
            .map((e) => e.args as unknown as { ok: boolean });
          const batch = logs.find((e) => e.eventName === "BatchSold")?.args as
            | { netImdOut: bigint; burned: bigint }
            | undefined;
          update({
            text: `Sale confirmed: ${results.filter((r) => r.ok).length} sold, ${results.filter((r) => !r.ok).length} skipped or refunded.${batch ? ` Received ${formatUnits(batch.netImdOut, rt.config.network.pairToken.decimals)} IMD.` : ""} Refreshing balances…`,
            hash: receipt.transactionHash,
            pending: true,
          });
          await refreshRows(account, run);
          setPlan(undefined);
          update((s) => ({
            ...s!,
            text: s!.text.replace(
              " Refreshing balances…",
              " Balances refreshed.",
            ),
            pending: false,
          }));
        }
      }
    } catch (e) {
      update((s) => ({
        text: "",
        error: explain(e),
        hash: s?.hash,
        pending: false,
      }));
    } finally {
      transactionLock.current = false;
      setBusy(false);
    }
  }
  const shown = tab === "claims" ? rows : held;
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="site-shell">
        <header className="header">
          <a className="brand" href="#">
            <img src="./mark.svg" width="38" height="38" alt="" />
            <span>
              swarm<span className="brand-light">harvester</span>
            </span>
          </a>
          <nav aria-label="Main navigation">
            <a href="#rewards">Rewards</a>
            <a href="#trade">Trade</a>
            <a href="#about">How it works</a>
          </nav>
          <div className="wallet-control">
            <span className="network">
              <span className="network-dot" />
              Ethereum
            </span>
            {wallet.choices.length > 1 && !wallet.account && (
              <select
                aria-label="Choose wallet"
                value={wallet.choice}
                onChange={(e) => wallet.setChoice(e.target.value)}
              >
                {wallet.choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {wallet.account ? (
              <>
                <AddressLink value={wallet.account} rt={rt} />
                <button
                  className="text-button"
                  disabled={busyAny}
                  onClick={wallet.disconnect}
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                className="button dark"
                onClick={() => void wallet.connect()}
                disabled={wallet.pending || busyAny}
              >
                <Icon name="wallet" size={17} />
                {wallet.pending ? "Connecting…" : "Connect wallet"}
              </button>
            )}
          </div>
        </header>
        {wallet.error && (
          <p className="notice error-text" role="alert">
            {wallet.error}
          </p>
        )}
        {wallet.account && !wallet.correctChain && (
          <div className="network-warning" role="alert">
            <span>
              Your wallet is on another network. Use Ethereum for these
              contracts.
            </span>
            <button
              className="button"
              disabled={wallet.pending || busyAny}
              onClick={() => void wallet.switchChain()}
            >
              Switch to Ethereum
            </button>
          </div>
        )}
        <main id="main">
          <section className="hero">
            <div>
              <div className="eyebrow">
                <span className="mini-mark">✳</span>Built for the contributors
              </div>
              <h1>
                Your work.
                <br />
                <span>Your rewards.</span>
              </h1>
              <p className="hero-copy">
                Bring your launch rewards together. Claim in one transaction,
                then keep your tokens or turn them into IMD.
              </p>
              <a className="hero-link" href="#rewards">
                Collect what you earned <Icon />
              </a>
            </div>
            <div className="hero-aside">
              <div className="harvest-art" aria-hidden="true">
                <div className="art-grid">
                  {Array.from({ length: 16 }, (_, i) => (
                    <span key={i} className={`seed seed-${i}`} />
                  ))}
                </div>
                <span className="art-label">
                  Small contributions. Shared growth.
                </span>
              </div>
              <div className="hero-footnote">
                <span>01 / Claim together</span>
                <span>02 / Choose what’s next</span>
              </div>
            </div>
          </section>
          <section
            className="lookup-section"
            id="rewards"
            aria-labelledby="lookup-title"
          >
            <div>
              <span className="eyebrow">Your reward workspace</span>
              <h2 id="lookup-title">Start with a wallet.</h2>
              <p>Connect yours or look up any Ethereum address.</p>
            </div>
            <form
              className="lookup-form"
              onSubmit={(e) => {
                e.preventDefault();
                void scanWallet(lookup);
              }}
            >
              <label htmlFor="wallet-address">Wallet address or ENS name</label>
              <div className="input-action">
                <input
                  id="wallet-address"
                  ref={lookupRef}
                  autoComplete="off"
                  spellCheck={false}
                  value={lookup}
                  placeholder="0x… or name.eth"
                  aria-invalid={!!addressError}
                  aria-describedby={addressError ? "address-error" : undefined}
                  disabled={busyAny}
                  onChange={(e) => {
                    setLookup(e.target.value);
                    setAddressError("");
                  }}
                />
                <button
                  className="button dark"
                  disabled={busyAny}
                  type="submit"
                >
                  {scan?.pending ? (
                    <>
                      <span className="spinner" />
                      Looking up…
                    </>
                  ) : (
                    <>
                      Find rewards <Icon size={17} />
                    </>
                  )}
                </button>
              </div>
              {addressError && (
                <p className="error-text small" id="address-error">
                  {addressError}
                </p>
              )}
            </form>
          </section>
          <div className="metrics">
            <div>
              <span className="metric-label">Ready to claim</span>
              <strong>
                {beneficiary && rows.length ? ready.length : earned ? "0" : "—"}
                <small> launches</small>
              </strong>
            </div>
            <div>
              <span className="metric-label">Tokens in this wallet</span>
              <strong>
                {beneficiary && rows.length ? held.length : earned ? "0" : "—"}
                <small> balances</small>
              </strong>
            </div>
            <div>
              <span className="metric-label">Conversion fee</span>
              <strong>
                0.5%<small> of IMD output</small>
              </strong>
            </div>
            <div>
              <span className="metric-label">Deployment</span>
              <strong className="metric-status">
                {verification ? (
                  <>
                    <Icon name="check" size={17} />
                    Checked on chain
                  </>
                ) : verifying ? (
                  "Checking…"
                ) : (
                  "Unavailable"
                )}
              </strong>
              <a href="#deployment">
                View contract details <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
          {verifyError && (
            <div className="notice" role="alert">
              <p>{verifyError}</p>
              <button
                className="button"
                onClick={() => void check()}
                disabled={verifying || busyAny}
              >
                Retry verification
              </button>
            </div>
          )}
          <div className="workspace">
            <section
              className="card rewards-card"
              aria-labelledby="rewards-title"
            >
              <div className="card-heading">
                <div>
                  <h2 id="rewards-title">Launch rewards</h2>
                  <p>
                    {beneficiary ? (
                      <>
                        Viewing <AddressLink value={beneficiary} rt={rt} />
                      </>
                    ) : (
                      "The tokens you helped bring to life."
                    )}
                  </p>
                </div>
                <button
                  className="icon-button"
                  aria-label="Refresh rewards"
                  disabled={!beneficiary || busyAny}
                  onClick={() => void scanWallet(beneficiary!)}
                >
                  <Icon name="refresh" />
                </button>
              </div>
              <div className="tabs">
                <button
                  aria-pressed={tab === "claims"}
                  onClick={() => setTab("claims")}
                >
                  Allocations {rows.length > 0 && <span>{rows.length}</span>}
                </button>
                <button
                  aria-pressed={tab === "balances"}
                  onClick={() => setTab("balances")}
                >
                  Token balances {held.length > 0 && <span>{held.length}</span>}
                </button>
              </div>
              <Feedback state={scan} rt={rt} />
              {shown.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-symbol">
                    <Icon name="leaf" size={29} />
                  </div>
                  <h3>
                    {scan?.pending
                      ? "Gathering your rewards"
                      : beneficiary && earned
                        ? tab === "balances"
                          ? "No token balances yet"
                          : "You’re all caught up"
                        : "Your next harvest starts here"}
                  </h3>
                  <p>
                    {scan?.pending
                      ? "Checking launch records, proofs and on-chain balances."
                      : beneficiary && earned
                        ? "Claim new allocations or add a previous launch below to check its balance."
                        : "Find a wallet to see its allocations. Each claim is checked before it is ready to collect."}
                  </p>
                  {!wallet.account && !beneficiary && (
                    <button
                      className="button"
                      disabled={wallet.pending}
                      onClick={() => void wallet.connect()}
                    >
                      <Icon name="wallet" size={17} />
                      Connect wallet
                    </button>
                  )}
                </div>
              ) : (
                <div className="reward-list">
                  {shown.map((row, index) => (
                    <article className="reward-row" key={row.id}>
                      <div
                        className={`token-avatar tone-${index % 3}`}
                        aria-hidden="true"
                      >
                        {row.symbol === "Token" ? "?" : row.symbol.slice(0, 2)}
                      </div>
                      <div className="reward-info">
                        <div className="row-title">
                          <h3>
                            {row.symbol === "Token" ? row.name : row.symbol}
                          </h3>
                          <span
                            className={`status-badge ${row.status === "ready" ? "success" : ""}`}
                          >
                            {tab === "balances"
                              ? "In wallet"
                              : {
                                  ready: "Ready",
                                  claimed: "Claimed",
                                  locked: "Locked",
                                  unavailable: "Needs verification",
                                }[row.status]}
                          </span>
                        </div>
                        <p>
                          {row.symbol !== "Token" && `${row.name} · `}
                          {row.token ? (
                            <AddressLink value={row.token} rt={rt} />
                          ) : (
                            <a
                              href={launchUrl(row.id)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open launch record ↗
                            </a>
                          )}
                        </p>
                        {row.reason && (
                          <p className="row-reason">{row.reason}</p>
                        )}
                        {row.imported && (
                          <small>
                            Imported record · verified against chain
                          </small>
                        )}
                      </div>
                      <div className="reward-value">
                        {tab === "claims" && row.claim ? (
                          <Amount
                            value={row.claim.amount}
                            decimals={row.decimals}
                          />
                        ) : row.token ? (
                          <Amount value={row.balance} decimals={row.decimals} />
                        ) : (
                          <span>—</span>
                        )}
                        <small>
                          {tab === "balances"
                            ? "token balance"
                            : row.claim
                              ? "allocation"
                              : "awaiting data"}
                        </small>
                        {tab === "claims" && row.status === "ready" && (
                          <label className="select-claim">
                            <input
                              type="checkbox"
                              checked={row.selected}
                              disabled={busyAny}
                              onChange={(e) =>
                                setRows((prev) =>
                                  prev.map((r) =>
                                    r.id === row.id
                                      ? { ...r, selected: e.target.checked }
                                      : r,
                                  ),
                                )
                              }
                            />{" "}
                            Include
                          </label>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {remaining.length > 0 && (
                <button
                  className="button load-more"
                  disabled={busyAny}
                  onClick={() => {
                    const run = ++scanGeneration.current;
                    setScan({ text: "Checking more launches…", pending: true });
                    void populate(
                      remaining,
                      beneficiary!,
                      imported,
                      rows,
                      earned,
                      run,
                    );
                  }}
                >
                  Check next {Math.min(remaining.length, 24)} launches (
                  {remaining.length} remaining)
                </button>
              )}
              <div className="claim-footer">
                <p>
                  <Icon name="check" size={16} />
                  Rewards go directly to the viewed wallet.
                </p>
                {beneficiary && wallet.account && !connectedBeneficiary && (
                  <p className="notice small">
                    You are claiming for another address. Your connected wallet
                    pays gas; rewards go to{" "}
                    <AddressLink value={beneficiary} rt={rt} />.
                  </p>
                )}
                <WalletGate
                  wallet={wallet}
                  blocked={!verification || busyAny || !selected.length}
                >
                  <button
                    className="button primary full"
                    onClick={() => void transaction("claim")}
                  >
                    {claimState?.pending ? (
                      <>
                        <span className="spinner" />
                        Claiming…
                      </>
                    ) : (
                      <>
                        {selected.length === ready.length
                          ? "Claim all"
                          : "Claim selected"}
                        {selected.length > 0 ? ` (${selected.length})` : ""}
                        <Icon />
                      </>
                    )}
                  </button>
                </WalletGate>
                {wallet.account && selected.length === 0 && (
                  <p className="small muted">
                    Verified, unlocked allocations will appear here when
                    available.
                  </p>
                )}
                <Feedback state={claimState} rt={rt} />
              </div>
            </section>
            <aside
              className="card conversion-card"
              aria-labelledby="sell-title"
            >
              <div className="card-heading">
                <span className="eyebrow">After the harvest</span>
                <span className="circle-arrow">
                  <Icon />
                </span>
              </div>
              <h2 id="sell-title">
                Many tokens.
                <br /> One balance.
              </h2>
              <p className="muted">
                Convert your claimed tokens to IMD in a single batch.
              </p>
              <ol className="steps">
                <li>
                  <span>1</span>
                  <div>
                    <strong>Get a live quote</strong>
                    <p>Review the output and your minimum.</p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>Approve each token</strong>
                    <p>Allow only the amount you’re selling.</p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>Sell all to IMD</strong>
                    <p>Receive IMD in your connected wallet.</p>
                  </div>
                </li>
              </ol>
              <div className="conversion-settings">
                <label htmlFor="sell-slippage">
                  Slippage limit <span>(%)</span>
                </label>
                <input
                  id="sell-slippage"
                  className="compact-input"
                  inputMode="decimal"
                  value={sellSlippage}
                  disabled={busyAny}
                  onChange={(e) => setSellSlippage(e.target.value)}
                />
              </div>
              {plan && (
                <>
                  <dl className="quote-details">
                    <div>
                      <dt>Gross output</dt>
                      <dd>
                        <Amount value={plan.gross} symbol="IMD" />
                      </dd>
                    </div>
                    <div>
                      <dt>0.5% sent to burn sink</dt>
                      <dd>
                        <Amount value={plan.burn} symbol="IMD" />
                      </dd>
                    </div>
                    <div>
                      <dt>You receive</dt>
                      <dd>
                        <Amount value={plan.net} symbol="IMD" />
                      </dd>
                    </div>
                    <div className="minimum-row">
                      <dt>Minimum received</dt>
                      <dd>
                        <Amount value={plan.minNet} symbol="IMD" />
                      </dd>
                    </div>
                    <div>
                      <dt>Quote</dt>
                      <dd>
                        {quoteExpired
                          ? "Expired"
                          : `${Math.min(60, Math.max(0, 60 - Math.floor((now - plan.at) / 1000)))}s remaining`}
                      </dd>
                    </div>
                  </dl>
                  <details>
                    <summary>
                      Review {plan.quotes.length} quoted token
                      {plan.quotes.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="quote-list">
                      {plan.quotes.map((q) => (
                        <li key={q.token}>
                          <strong>
                            <Amount
                              value={q.amountIn}
                              decimals={q.row.decimals}
                              symbol={q.row.symbol}
                            />
                          </strong>
                          <span>
                            {q.route.length === 2
                              ? `${q.row.symbol} → ETH → IMD`
                              : `${q.row.symbol} → IMD`}
                          </span>
                          <span>
                            Gross minimum:{" "}
                            <Amount value={q.minOut} symbol="IMD" />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                  {plan.failures.length > 0 && (
                    <div className="notice small">
                      <strong>
                        {plan.failures.length} token
                        {plan.failures.length === 1 ? "" : "s"} excluded
                      </strong>
                      <ul>
                        {plan.failures.map((f) => (
                          <li key={f.id}>
                            {rows.find((r) => r.id === f.id)?.symbol}:{" "}
                            {f.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
              {wallet.account && !connectedBeneficiary && (
                <p className="notice small">
                  Look up your connected wallet to sell its balances. Only the
                  caller’s tokens can be sold.
                </p>
              )}
              {approved && plan && !quoteExpired && (
                <div className="notice small">
                  <p>
                    Approve{" "}
                    <Amount
                      value={approved.amountIn}
                      decimals={approved.row.decimals}
                      symbol={approved.row.symbol}
                    />{" "}
                    to{" "}
                    <AddressLink
                      value={rt.contract("SwarmSeller").address}
                      rt={rt}
                      label="SwarmSeller"
                    />
                    .
                  </p>
                </div>
              )}
              <WalletGate
                wallet={wallet}
                blocked={
                  !verification ||
                  busyAny ||
                  !connectedBeneficiary ||
                  held.length === 0
                }
              >
                <div className="sale-actions">
                  {!plan || !plan.quotes.length || quoteExpired ? (
                    <button
                      className="button primary full"
                      onClick={() => void transaction("quote")}
                    >
                      {quoteState?.pending ? (
                        <>
                          <span className="spinner" />
                          Getting quotes…
                        </>
                      ) : (
                        <>
                          Quote token balances
                          <Icon />
                        </>
                      )}
                    </button>
                  ) : approved ? (
                    <>
                      <button
                        className="button primary full"
                        onClick={() => void transaction("approve")}
                      >
                        {saleState?.pending
                          ? "Approving…"
                          : `Approve ${approved.row.symbol}`}
                      </button>
                      {(rows.find((r) => same(r.token, approved.token))
                        ?.allowance ?? 0n) > 0n && (
                        <button
                          className="text-button"
                          onClick={() => void transaction("reset")}
                        >
                          Reset existing allowance first
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      className="button primary full"
                      onClick={() => void transaction("sell")}
                    >
                      {saleState?.pending
                        ? "Selling…"
                        : plan.failures.length
                          ? `Sell ${plan.quotes.length} quoted tokens to IMD`
                          : "Sell all to IMD"}
                      <Icon />
                    </button>
                  )}
                  {plan && plan.quotes.length > 0 && !quoteExpired && (
                    <button
                      className="text-button"
                      onClick={() => void transaction("quote")}
                    >
                      Refresh quotes
                    </button>
                  )}
                </div>
              </WalletGate>
              {held.length === 0 && (
                <p className="small muted">
                  Claim rewards first, or look up a wallet with launch tokens.
                </p>
              )}
              <Feedback state={quoteState} rt={rt} />
              <Feedback state={saleState} rt={rt} />
              <p className="fee-note">
                The seller sends 0.5% of gross IMD to the fixed burn sink. Your
                aggregate net minimum protects the entire batch. ETH is needed
                for gas. USD pricing is unavailable.
              </p>
            </aside>
          </div>
          {earned && earned.unlocks.length > 0 && (
            <details className="disclosure">
              <summary>Upcoming unlocks ({earned.unlocks.length})</summary>
              <ul>
                {earned.unlocks.map((u) => (
                  <li key={u.id}>
                    <a href={launchUrl(u.id)} target="_blank" rel="noreferrer">
                      Launch {u.id.slice(0, 8)}
                    </a>{" "}
                    ·{" "}
                    <time dateTime={u.at}>
                      {new Date(u.at).toLocaleString()}
                    </time>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details className="disclosure import-panel" open={!!scan?.error}>
            <summary>
              Missing a launch? Import API responses or add a launch
            </summary>
            <p>
              Some reward APIs block requests from static websites. Open their
              public JSON responses in a new tab, then paste them here. Imported
              records still require matching on-chain tokens, rounds and
              simulations.
            </p>
            {beneficiary && (
              <p>
                <a
                  href={earnedUrl(beneficiary)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open this wallet’s earned response ↗
                </a>
              </p>
            )}
            <div className="import-help">
              <details>
                <summary>Import format and response links</summary>
                <p>
                  Paste an earned response directly. To supply launch data, use
                  a JSON object with <code>launches</code> and{" "}
                  <code>claims</code>, each keyed by the launch UUID. Copy the
                  complete launch record and claim response as their values. An
                  optional <code>bridgePool</code> accepts the exact ETH / IMD
                  pool key.
                </p>
                <pre>
                  {
                    '{\n  "earned": { "claimable": [], "unlocks": [] },\n  "launches": {},\n  "claims": {}\n}'
                  }
                </pre>
                {beneficiary &&
                  rows.map((r) => (
                    <p key={r.id}>
                      {r.name}:{" "}
                      <a
                        href={launchUrl(r.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Launch JSON
                      </a>{" "}
                      ·{" "}
                      <a
                        href={claimUrl(r.id, beneficiary)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Claim JSON
                      </a>
                    </p>
                  ))}
              </details>
            </div>
            <label htmlFor="import-json">Public API JSON</label>
            <textarea
              id="import-json"
              rows={5}
              value={importText}
              disabled={busyAny}
              onChange={(e) => setImportText(e.target.value)}
              spellCheck={false}
              placeholder="Paste an earned response or a launch / claim bundle"
            />
            <button
              className="button"
              disabled={busyAny || !beneficiary}
              onClick={() => void importResponses()}
            >
              Verify imported responses
            </button>
            {!beneficiary && (
              <p className="small muted">
                Look up a wallet address before importing.
              </p>
            )}
            <div className="add-launch">
              <label htmlFor="launch-id">
                Add a previously claimed launch (UUID)
              </label>
              <div className="input-action">
                <input
                  id="launch-id"
                  value={manualId}
                  onChange={(e) => setManualId(e.target.value)}
                  disabled={busyAny}
                  placeholder="Launch UUID from its public record"
                />
                <button
                  className="button"
                  disabled={busyAny || !beneficiary}
                  onClick={() => void addLaunch()}
                >
                  Check launch
                </button>
              </div>
            </div>
            {importError && (
              <p className="error-text" role="alert">
                {importError}
              </p>
            )}
          </details>
          <Trade
            rt={rt}
            wallet={wallet}
            verified={!!verification}
            decimals={verification?.decimals ?? 18}
            busy={busyAny}
            onBusy={setBusy}
          />
          <section
            className="how-section"
            id="about"
            aria-labelledby="how-title"
          >
            <div>
              <span className="eyebrow">Made to stay yours</span>
              <h2 id="how-title">
                One harvest.
                <br /> You’re in control.
              </h2>
            </div>
            <div className="principles">
              <article>
                <span>01</span>
                <h3>Straight to your wallet</h3>
                <p>
                  The harvester submits your claims together. Each distributor
                  sends its tokens directly to the named account.
                </p>
              </article>
              <article>
                <span>02</span>
                <h3>Only sell what you approve</h3>
                <p>
                  The seller spends the connected wallet’s approved tokens.
                  Every sale has a minimum output, with a net minimum for the
                  batch.
                </p>
              </article>
              <article>
                <span>03</span>
                <h3>Open, fixed contracts</h3>
                <p>
                  No owner, upgrades or pause switch. The HARVEST launch pool
                  pairs with native ETH; reward sales independently settle in
                  IMD.
                </p>
              </article>
            </div>
          </section>
          <section id="deployment" className="deployment-section">
            <details className="disclosure">
              <summary>Deployment and live contract state</summary>
              <p>
                {verification
                  ? `Checked block ${verification.block.toString()} · ${new Date(verification.checkedAt).toLocaleTimeString()}`
                  : "Deployment has not been verified."}
              </p>
              <button
                className="button"
                disabled={verifying || busyAny}
                onClick={() => void check()}
              >
                {verifying ? "Checking…" : "Refresh contract state"}
              </button>
              <dl className="deployment-list">
                {rt.contracts.map((c) => (
                  <div key={c.name}>
                    <dt>{c.name}</dt>
                    <dd>
                      <AddressLink value={c.address} rt={rt} />
                      <code className="full-address">{c.address}</code>
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>Seller fee</dt>
                  <dd>{verification ? `${verification.fee / 100}%` : "—"}</dd>
                </div>
                <div>
                  <dt>Gas limit per claim</dt>
                  <dd>{verification?.claimGas.toLocaleString() ?? "—"}</dd>
                </div>
                <div>
                  <dt>Connected HARVEST balance</dt>
                  <dd>
                    {tokenBalance !== undefined ? (
                      <Amount
                        value={tokenBalance}
                        decimals={verification?.decimals ?? 18}
                        symbol="HARVEST"
                      />
                    ) : (
                      "Connect wallet to read"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Connected IMD balance</dt>
                  <dd>
                    {imdBalance !== undefined ? (
                      <Amount
                        value={imdBalance}
                        decimals={rt.config.network.pairToken.decimals}
                        symbol="IMD"
                      />
                    ) : (
                      "Connect wallet to read"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Deployed source commit</dt>
                  <dd>
                    <code>{rt.config.sourceCommit}</code>
                  </dd>
                </div>
              </dl>
              <a href="./imd-deployment.json" target="_blank" rel="noreferrer">
                View deployment configuration and asset hashes ↗
              </a>
            </details>
            <details className="disclosure">
              <summary>Transfer HARVEST</summary>
              <p>
                Send HARVEST directly to a recipient. Review the address and
                amount in your wallet before confirming; a confirmed transfer
                cannot be undone.
              </p>
              <div className="transfer-form">
                <label htmlFor="transfer-to">
                  Recipient address or ENS name
                  <input
                    id="transfer-to"
                    value={transferTo}
                    disabled={busyAny}
                    onChange={(e) => setTransferTo(e.target.value)}
                    placeholder="0x… or name.eth"
                  />
                </label>
                <label htmlFor="transfer-amount">
                  HARVEST amount
                  <input
                    id="transfer-amount"
                    inputMode="decimal"
                    value={transferAmount}
                    disabled={busyAny}
                    onChange={(e) => setTransferAmount(e.target.value)}
                  />
                </label>
              </div>
              <WalletGate wallet={wallet} blocked={!verification || busyAny}>
                <button
                  className="button"
                  onClick={() => void transaction("transfer")}
                >
                  {transferState?.pending
                    ? "Transferring…"
                    : "Review HARVEST transfer"}
                </button>
              </WalletGate>
              <Feedback state={transferState} rt={rt} />
            </details>
          </section>
        </main>
        <footer>
          <a className="brand" href="#">
            <img src="./mark.svg" width="28" height="28" alt="" />
            <span>
              swarm<span className="brand-light">harvester</span>
            </span>
          </a>
          <span>A tool for the identity.md contributor network.</span>
          <a href="#deployment">
            Verify the contracts <Icon name="external" size={14} />
          </a>
        </footer>
      </div>
    </>
  );
}
