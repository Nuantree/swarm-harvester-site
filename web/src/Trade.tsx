import { useEffect, useRef, useState } from "react";
import { parseUnits, zeroAddress, type Address } from "viem";
import { erc20Abi, permitAbi, same, type Runtime } from "./config";
import {
  checkPool,
  encodeSwap,
  explain,
  minimum,
  quoteHop,
  slippageBps,
  tradeApproval,
  transact,
  validPool,
  type TxStage,
} from "./chain";
import { Amount, Feedback, WalletGate } from "./components";
import type { Wallet } from "./wallet";
type Quote = {
  input: Address;
  amount: bigint;
  out: bigint;
  min: bigint;
  at: number;
  account: Address;
};
export function Trade({
  rt,
  wallet,
  verified,
  decimals,
  busy,
  onBusy,
}: {
  rt: Runtime;
  wallet: Wallet;
  verified: boolean;
  decimals: number;
  busy: boolean;
  onBusy: (b: boolean) => void;
}) {
  const [direction, setDirection] = useState("buy"),
    [amount, setAmount] = useState(""),
    [slippage, setSlippage] = useState("0.5");
  const [quote, setQuote] = useState<Quote>(),
    [approval, setApproval] = useState<"token" | "permit" | "ready">("ready");
  const [state, setState] = useState<TxStage>(),
    [tick, setTick] = useState(Date.now()),
    [balance, setBalance] = useState<bigint>();
  const generation = useRef(0),
    lock = useRef(false);
  const token = rt.contract("LaunchToken").address;
  const input = direction === "buy" ? zeroAddress : token;
  const inputSymbol = direction === "buy" ? "ETH" : "HARVEST",
    outputSymbol = direction === "buy" ? "HARVEST" : "ETH";
  const nativePair = validPool(rt.config.poolKey, zeroAddress, token);
  const expire = !!quote && tick - quote.at > 60000;
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    generation.current++;
    setQuote(undefined);
    setBalance(undefined);
    setState(undefined);
  }, [wallet.epoch, direction, amount, slippage]);
  useEffect(() => {
    let canceled = false;
    if (wallet.account)
      void (
        same(input, zeroAddress)
          ? rt.client.getBalance({ address: wallet.account })
          : rt.client.readContract({
              address: input,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [wallet.account],
            })
      )
        .then((b) => {
          if (!canceled) setBalance(b);
        })
        .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [rt, wallet.account, input, state?.hash, state?.pending]);
  async function execute(kind: "quote" | "approve" | "swap") {
    if (
      lock.current ||
      busy ||
      !wallet.account ||
      !wallet.provider ||
      !wallet.correctChain ||
      !verified
    )
      return;
    lock.current = true;
    onBusy(true);
    const epoch = generation.current;
    const account = wallet.account;
    setState({
      text:
        kind === "quote"
          ? "Getting a fresh pool quote…"
          : "Checking transaction…",
      pending: true,
    });
    try {
      if (!nativePair)
        throw new Error(
          "This trade panel requires the attested native ETH / HARVEST pair.",
        );
      if (kind === "quote") {
        if (
          !/^\d+(\.\d+)?$/.test(amount) ||
          (amount.split(".")[1]?.length ?? 0) >
            (direction === "buy" ? 18 : decimals)
        )
          throw new Error(
            "Enter a positive amount within the token’s decimal precision.",
          );
        const units = parseUnits(amount, direction === "buy" ? 18 : decimals),
          bps = slippageBps(slippage);
        const freshBalance = same(input, zeroAddress)
          ? await rt.client.getBalance({ address: account })
          : await rt.client.readContract({
              address: input,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [account],
            });
        if (units > freshBalance)
          throw new Error(`Not enough ${inputSymbol}. Reduce the amount.`);
        await checkPool(rt, rt.config.poolKey);
        const out = await quoteHop(
          rt,
          rt.config.poolKey,
          input,
          units,
          account,
        );
        if (out > (1n << 128n) - 1n)
          throw new Error("The quoted amount exceeds the router limit.");
        const min = minimum(out, bps);
        if (min <= 0n)
          throw new Error(
            "This output is below the minimum unit. Increase the amount.",
          );
        const step = await tradeApproval(rt, account, input, units);
        if (epoch !== generation.current) return;
        setQuote({
          input,
          amount: units,
          out,
          min,
          at: Date.now(),
          account,
        });
        setApproval(step);
        setState({
          text: "Quote ready. Review the minimum received before signing.",
          pending: false,
        });
      } else {
        if (
          !quote ||
          Date.now() - quote.at > 60000 ||
          !same(quote.account, account)
        )
          throw new Error(
            "The quote expired or the account changed. Get a new quote.",
          );
        const current = await tradeApproval(
          rt,
          account,
          quote.input,
          quote.amount,
        );
        if (kind === "approve") {
          if (current === "ready") {
            setApproval(current);
            setState({
              text: "Both allowances are sufficient.",
              pending: false,
            });
            return;
          }
          const u = rt.config.network.uniswapV4;
          const request =
            current === "token"
              ? {
                  address: quote.input,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [u.permit2, quote.amount],
                }
              : {
                  address: u.permit2,
                  abi: permitAbi,
                  functionName: "approve",
                  args: [
                    quote.input,
                    u.universalRouter,
                    quote.amount,
                    Math.floor(Date.now() / 1000) + 1200,
                  ],
                };
          const receipt = await transact(
            rt,
            wallet.provider,
            account,
            request,
            setState,
          );
          const next = await tradeApproval(
            rt,
            account,
            quote.input,
            quote.amount,
          );
          if (epoch !== generation.current) return;
          setApproval(next);
          setQuote(undefined);
          setState({
            text: "Approval confirmed. Get a fresh quote to continue.",
            hash: receipt.transactionHash,
            pending: false,
          });
        } else {
          if (current !== "ready") {
            setApproval(current);
            throw new Error(
              "An allowance has changed. Complete the displayed approval first.",
            );
          }
          const receipt = await transact(
            rt,
            wallet.provider,
            account,
            encodeSwap(rt, quote.input, quote.amount, quote.min),
            setState,
          );
          if (epoch !== generation.current) return;
          setQuote(undefined);
          setState({
            text: "Swap confirmed. Balances are refreshing.",
            hash: receipt.transactionHash,
            pending: false,
          });
        }
      }
    } catch (e) {
      if (epoch === generation.current)
        setState((s) => ({
          text: "",
          hash: s?.hash,
          pending: false,
          error: explain(e),
        }));
    } finally {
      lock.current = false;
      onBusy(false);
    }
  }
  return (
    <section
      className="trade-section"
      id="trade"
      aria-labelledby="trade-heading"
    >
      <div className="section-intro">
        <span className="eyebrow">The launch token</span>
        <h2 id="trade-heading">A place for HARVEST.</h2>
        <p>
          Trade the Swarm Harvester token in its ETH pool. This is separate from
          converting your launch rewards to IMD.
        </p>
        <p className="small muted">
          Quotes include the pool fee. Keep some ETH for network fees. USD
          pricing is unavailable.
        </p>
      </div>
      <div className="card trade-card">
        <div className="segmented" aria-label="Trade direction">
          <button
            aria-pressed={direction === "buy"}
            disabled={busy}
            onClick={() => setDirection("buy")}
          >
            Buy HARVEST
          </button>
          <button
            aria-pressed={direction === "sell"}
            disabled={busy}
            onClick={() => setDirection("sell")}
          >
            Sell HARVEST
          </button>
        </div>
        <label htmlFor="trade-amount">
          You pay <span>{inputSymbol}</span>
        </label>
        <input
          id="trade-amount"
          value={amount}
          inputMode="decimal"
          placeholder="0.0"
          disabled={busy}
          onChange={(e) => setAmount(e.target.value)}
        />
        <p className="small muted">
          Balance:{" "}
          {balance !== undefined ? (
            <Amount
              value={balance}
              decimals={direction === "buy" ? 18 : decimals}
              symbol={inputSymbol}
            />
          ) : wallet.account ? (
            "Loading…"
          ) : (
            "Connect to view"
          )}
        </p>
        <label htmlFor="trade-slippage">Slippage limit (%)</label>
        <input
          id="trade-slippage"
          className="compact-input"
          inputMode="decimal"
          value={slippage}
          disabled={busy}
          onChange={(e) => setSlippage(e.target.value)}
        />
        {quote && (
          <dl className="quote-details">
            <div>
              <dt>Estimated received</dt>
              <dd>
                <Amount
                  value={quote.out}
                  decimals={direction === "buy" ? decimals : 18}
                  symbol={outputSymbol}
                />
              </dd>
            </div>
            <div>
              <dt>Minimum received</dt>
              <dd>
                <Amount
                  value={quote.min}
                  decimals={direction === "buy" ? decimals : 18}
                  symbol={outputSymbol}
                />
              </dd>
            </div>
            <div>
              <dt>Quote</dt>
              <dd>
                {expire
                  ? "Expired — refresh"
                  : `${Math.min(60, Math.max(0, 60 - Math.floor((tick - quote.at) / 1000)))}s remaining`}
              </dd>
            </div>
          </dl>
        )}
        {quote && approval !== "ready" && (
          <p className="small">
            {approval === "token"
              ? "Step 1: approve only this amount of HARVEST to Permit2."
              : "Step 2: allow the configured Universal Router to spend this amount through Permit2 for 20 minutes."}
          </p>
        )}
        <WalletGate wallet={wallet} blocked={!verified || busy || !nativePair}>
          <div className="button-row">
            {!quote || expire ? (
              <button
                className="button primary"
                onClick={() => void execute("quote")}
              >
                Get quote
              </button>
            ) : approval !== "ready" ? (
              <button
                className="button primary"
                onClick={() => void execute("approve")}
              >
                {approval === "token"
                  ? "Approve HARVEST"
                  : "Approve router access"}
              </button>
            ) : (
              <button
                className="button primary"
                onClick={() => void execute("swap")}
              >
                Confirm {direction === "buy" ? "purchase" : "sale"}
              </button>
            )}
            {quote && !expire && (
              <button className="button" onClick={() => void execute("quote")}>
                Refresh quote
              </button>
            )}
          </div>
        </WalletGate>
        {!verified && (
          <p className="small muted">
            Transactions wait for deployment verification.
          </p>
        )}
        <Feedback state={state} rt={rt} />
      </div>
    </section>
  );
}
