import type {
  ProviderAdapter,
  ProviderCheckOptions,
  ProviderCheckResult,
  ProviderId,
} from "../types/provider.js";
import { AgyAdapter } from "./agy.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

export type AdapterRegistry = Record<ProviderId, ProviderAdapter>;

export function createDefaultAdapters(): AdapterRegistry {
  return {
    codex: new CodexAdapter(),
    claude: new ClaudeAdapter(),
    agy: new AgyAdapter(),
  };
}

export function getAdapter(
  provider: ProviderId,
  registry: AdapterRegistry = createDefaultAdapters(),
): ProviderAdapter {
  return registry[provider];
}

export interface CheckProvidersOptions {
  providers?: ProviderId[];
  executableOverrides?: Partial<Record<ProviderId, string>>;
  cwd?: string;
  prompt?: string;
  timeoutMs?: number;
  skipLive?: boolean;
  adapters?: AdapterRegistry;
}

export async function checkProviders(
  options: CheckProvidersOptions = {},
): Promise<ProviderCheckResult[]> {
  const providers = options.providers ?? ["codex", "claude", "agy"];
  const registry = options.adapters ?? createDefaultAdapters();

  return Promise.all(
    providers.map((provider) => {
      const adapter = registry[provider];
      const checkOpts: ProviderCheckOptions = {
        executablePath: options.executableOverrides?.[provider],
        cwd: options.cwd,
        prompt: options.prompt,
        timeoutMs: options.timeoutMs,
        skipLive: options.skipLive,
      };
      return adapter.checkAvailability(checkOpts);
    }),
  );
}
