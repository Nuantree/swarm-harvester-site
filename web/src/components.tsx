import { useState, type ReactNode } from "react";
import { formatUnits, type Address } from "viem";
import { getAddress } from "viem";
import type { Runtime } from "./config";
import type { TxStage } from "./chain";
import type { Wallet } from "./wallet";
export function Icon({
  name = "arrow",
  size = 20,
}: {
  name?:
    | "arrow"
    | "wallet"
    | "grid"
    | "check"
    | "copy"
    | "external"
    | "leaf"
    | "refresh";
  size?: number;
}) {
  const paths = {
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    wallet: (
      <>
        <path d="M4 7V5a1 1 0 0 1 1-1h13v3M4 7h16v13H4z" />
        <path d="M20 11h-5v5h5m-3-2.5h.01" />
      </>
    ),
    grid: (
      <>
        <rect x="4" y="4" width="6" height="6" />
        <rect x="14" y="4" width="6" height="6" />
        <rect x="4" y="14" width="6" height="6" />
        <rect x="14" y="14" width="6" height="6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M15 8V4H4v11h4" />
      </>
    ),
    external: (
      <>
        <path d="M14 4h6v6m0-6L10 14" />
        <path d="M10 4H4v16h16v-6" />
      </>
    ),
    leaf: (
      <>
        <path d="M20 4C7 2 2 8 5 15s17 5 15-11Z" />
        <path d="m4 21 11-12" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M5.5 7a8 8 0 0 1 13.8 1M4.7 16a8 8 0 0 0 13.8 1" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function Amount({
  value,
  decimals = 18,
  symbol,
}: {
  value: bigint;
  decimals?: number;
  symbol?: string;
}) {
  const full = formatUnits(value, decimals);
  const [whole, part = ""] = full.split(".");
  const concise =
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (part ? "." + part.slice(0, 6) : "");
  return (
    <span className="amount" title={`${full} ${symbol ?? ""}`}>
      {value > 0n && value * 1000000n < 10n ** BigInt(decimals)
        ? "＜0.000001"
        : concise}
      {symbol && (
        <>
          {" "}
          <span className="unit">{symbol}</span>
        </>
      )}
    </span>
  );
}
export function AddressLink({
  value,
  rt,
  label,
}: {
  value: Address;
  rt: Runtime;
  label?: string;
}) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  const full = getAddress(value);
  return (
    <span className="address-group">
      <a
        href={`${rt.config.network.explorer}/address/${full}`}
        target="_blank"
        rel="noreferrer"
        title={full}
      >
        {label ?? `${full.slice(0, 6)}…${full.slice(-4)}`}
        <Icon name="external" size={13} />
      </a>
      <button
        className="icon-button"
        type="button"
        aria-label={copied ? "Address copied" : `Copy ${label ?? "address"}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(full);
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
      </button>
      {failed && (
        <small className="address-full">Copy this address: {full}</small>
      )}
    </span>
  );
}
export function Feedback({ state, rt }: { state?: TxStage; rt: Runtime }) {
  return (
    <div className="feedback" role="status" aria-live="polite">
      {state && (
        <>
          <p className={state.error ? "error-text" : ""}>
            {state.pending && <span className="spinner" />}
            {state.error ?? state.text}
          </p>
          {state.hash && (
            <a
              href={`${rt.config.network.explorer}/tx/${state.hash}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction <Icon name="external" size={14} />
            </a>
          )}
        </>
      )}
    </div>
  );
}
export function WalletGate({
  wallet,
  children,
  blocked = false,
}: {
  wallet: Wallet;
  children: ReactNode;
  blocked?: boolean;
}) {
  if (!wallet.account)
    return (
      <button
        className="button"
        disabled={wallet.pending}
        onClick={() => void wallet.connect()}
      >
        <Icon name="wallet" />
        {wallet.pending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  if (!wallet.correctChain)
    return (
      <p className="notice">
        Switch to Ethereum using the network control above to continue.
      </p>
    );
  return (
    <fieldset disabled={blocked} className="action-fieldset">
      {children}
    </fieldset>
  );
}
