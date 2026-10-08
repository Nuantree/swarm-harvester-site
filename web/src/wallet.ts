import { useEffect, useState } from "react";
import type { Address } from "viem";
import { address, type Runtime } from "./config";
import { explain, switchNetwork, type Provider } from "./chain";
type Choice = { id: string; name: string; provider: Provider };
declare global {
  interface Window {
    ethereum?: Provider;
  }
}
export function useWallet(rt: Runtime) {
  const [choices, setChoices] = useState<Choice[]>([]);
  const [choice, setChoice] = useState("");
  const [provider, setProvider] = useState<Provider>();
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const add = (value: Choice) =>
      setChoices((prev) =>
        prev.some((c) => c.provider === value.provider)
          ? prev
          : [...prev, value],
      );
    const announced = (event: Event) => {
      const { info, provider } = (
        event as CustomEvent<{
          info: { uuid: string; name: string };
          provider: Provider;
        }>
      ).detail;
      add({ id: info.uuid, name: info.name, provider });
    };
    window.addEventListener("eip6963:announceProvider", announced);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    if (window.ethereum)
      add({ id: "browser", name: "Browser wallet", provider: window.ethereum });
    return () =>
      window.removeEventListener("eip6963:announceProvider", announced);
  }, []);
  useEffect(() => {
    if (!provider) return;
    const changed = (...args: unknown[]) => {
      const a = args[0] as string[];
      setAccount(a?.[0] ? address(a[0]) : undefined);
      setEpoch((e) => e + 1);
    };
    const chainChanged = (...args: unknown[]) => {
      setChainId(Number(BigInt(String(args[0]))));
      setEpoch((e) => e + 1);
    };
    const disconnected = () => {
      setAccount(undefined);
      setChainId(undefined);
      setEpoch((e) => e + 1);
    };
    provider.on?.("accountsChanged", changed);
    provider.on?.("chainChanged", chainChanged);
    provider.on?.("disconnect", disconnected);
    return () => {
      provider.removeListener?.("accountsChanged", changed);
      provider.removeListener?.("chainChanged", chainChanged);
      provider.removeListener?.("disconnect", disconnected);
    };
  }, [provider]);
  async function connect() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const selected = choices.find((c) => c.id === choice) ?? choices[0];
      if (!selected)
        throw new Error(
          "No browser wallet found. Open this page in an Ethereum wallet browser or enable a wallet extension. You can still look up any address.",
        );
      const p = selected.provider;
      const accounts = await p.request({ method: "eth_requestAccounts" });
      if (!accounts[0])
        throw new Error(
          "No account was selected. Reconnect and select an account.",
        );
      setProvider(p);
      setAccount(address(accounts[0]));
      setChainId(Number(BigInt(await p.request({ method: "eth_chainId" }))));
      setEpoch((e) => e + 1);
    } catch (e) {
      setError(explain(e));
    } finally {
      setPending(false);
    }
  }
  async function switchChain() {
    if (!provider || pending) return;
    setPending(true);
    setError("");
    try {
      await switchNetwork(provider, rt);
      setChainId(
        Number(BigInt(await provider.request({ method: "eth_chainId" }))),
      );
      setEpoch((e) => e + 1);
    } catch (e) {
      setError(explain(e));
    } finally {
      setPending(false);
    }
  }
  function disconnect() {
    setAccount(undefined);
    setProvider(undefined);
    setChainId(undefined);
    setError("");
    setEpoch((e) => e + 1);
  }
  return {
    choices,
    choice,
    setChoice,
    provider,
    account,
    chainId,
    pending,
    error,
    epoch,
    connect,
    switchChain,
    disconnect,
    correctChain: chainId === rt.config.chainId,
  };
}
export type Wallet = ReturnType<typeof useWallet>;
