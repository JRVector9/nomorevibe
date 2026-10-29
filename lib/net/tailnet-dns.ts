import { lookup as systemLookup, promises as dns, type LookupAddress, type LookupOptions } from "node:dns";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

/**
 * Tailscale MagicDNS names (*.ts.net) for model engines, e.g. an engine behind `tailscale serve` with an HTTPS certificate.
 * Containers (OrbStack/Docker) resolve through the embedded DNS, which does not know the tailnet, yet they reach tailnet
 * addresses and Tailscale's resolver 100.100.100.100. So: the system resolver first, then that resolver for *.ts.net only.
 * TLS still verifies the certificate against the hostname (SNI unchanged); nothing else changes for any other name.
 */
export const TAILNET_RESOLVER = "100.100.100.100";
const TAILNET_NAME = /\.ts\.net\.?$/i;

type Callback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolve4 = (hostname: string) => Promise<string[]>;
const resolver = new dns.Resolver({ timeout: 2_000, tries: 2 });
resolver.setServers([TAILNET_RESOLVER]);

/** net.connect lookup: with autoSelectFamily it is called with { all: true } and must answer an address array. */
export function tailnetLookup(hostname: string, options: LookupOptions | undefined, callback: Callback,
  resolve4: Resolve4 = name => resolver.resolve4(name), system: typeof systemLookup = systemLookup): void {
  const answer = (list: LookupAddress[]) => options?.all ? callback(null, list) : callback(null, list[0].address, list[0].family);
  system(hostname, { ...options, all: true }, (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
    const list = Array.isArray(addresses) ? addresses : [];
    if (!error && list.length) return answer(list);
    if (!TAILNET_NAME.test(hostname)) return callback(error ?? Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "", 4);
    resolve4(hostname.replace(/\.$/, "")).then(found => found.length ? answer(found.map(address => ({ address, family: 4 })))
      : callback(error, "", 4), () => callback(error, "", 4));
  });
}

const installed = Symbol.for("nomorevibe.tailnetDns");
/**
 * Process start (worker, web): the default global dispatcher with the tailnet-aware lookup. Same Agent defaults otherwise.
 * A dispatcher someone already installed (tests' MockAgent, the replay egress guard) is left alone.
 */
export function installTailnetDns(): boolean {
  const holder = globalThis as { [installed]?: true };
  // The default is an Agent: this package's, or Node's bundled one once a built-in fetch ran (Node 24 shares the v2 slot).
  if (holder[installed] || getGlobalDispatcher().constructor.name !== "Agent") return false;
  setGlobalDispatcher(new Agent({ connect: { lookup: tailnetLookup as never } }));
  holder[installed] = true;
  return true;
}
