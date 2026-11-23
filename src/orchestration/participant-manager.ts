import type { AdapterRegistry } from "../providers/registry.js";
import type {
  ProviderAdapter,
  ProviderSessionHandle,
  TurnInput,
  TurnResult,
} from "../types/provider.js";
import type {
  ParticipantConfig,
  ParticipantSummary,
} from "../types/session.js";

interface ManagedParticipant {
  config: ParticipantConfig;
  adapter: ProviderAdapter;
  handle: ProviderSessionHandle;
}

export class ParticipantManager {
  private readonly participants = new Map<string, ManagedParticipant>();

  constructor(private readonly adapters: AdapterRegistry) {}

  async startParticipant(
    config: ParticipantConfig,
    options: {
      systemPrompt: string;
      cwd: string;
      readOnly?: boolean;
      allowReadOnlyTools?: boolean;
    },
  ): Promise<ProviderSessionHandle> {
    if (this.participants.has(config.id)) {
      throw new Error(`Duplicate participant ID "${config.id}"`);
    }
    const adapter = this.adapters[config.provider];
    const handle = await adapter.startSession({
      participantId: config.id,
      executablePath: config.executablePath,
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      readOnly: options.readOnly ?? true,
      allowReadOnlyTools: options.allowReadOnlyTools ?? true,
      model: config.model,
      effort: config.effort,
    });
    this.participants.set(config.id, { config, adapter, handle });
    return handle;
  }

  getConfig(participantId: string): ParticipantConfig {
    const entry = this.participants.get(participantId);
    if (!entry) {
      throw new Error(`Unknown participant "${participantId}"`);
    }
    return entry.config;
  }

  getHandle(participantId: string): ProviderSessionHandle {
    const entry = this.participants.get(participantId);
    if (!entry) {
      throw new Error(`Unknown participant "${participantId}"`);
    }
    return entry.handle;
  }

  async sendTurn(
    participantId: string,
    input: TurnInput,
  ): Promise<TurnResult> {
    const entry = this.participants.get(participantId);
    if (!entry) {
      throw new Error(`Unknown participant "${participantId}"`);
    }
    // "No limit" reaches here as Infinity; adapters expect 0 for "no timeout".
    const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 0;
    return entry.adapter.sendTurn(entry.handle, { ...input, timeoutMs });
  }

  cancelAll(): void {
    for (const [id, entry] of this.participants) {
      entry.adapter.cancel(id);
    }
  }

  getSummary(participantId: string): ParticipantSummary {
    const entry = this.participants.get(participantId);
    if (!entry) {
      throw new Error(`Unknown participant "${participantId}"`);
    }
    return {
      participantId: entry.config.id,
      label: entry.config.label,
      provider: entry.config.provider,
      role: entry.config.role,
      executablePath: entry.handle.executablePath,
      providerSessionId: entry.handle.providerSessionId,
      continuationMode: entry.handle.continuationMode,
      fallbackReason: entry.handle.fallbackReason,
      model: entry.handle.model,
      effort: entry.handle.effort,
      turnCount: entry.handle.turnCount,
    };
  }

  getAllSummaries(): ParticipantSummary[] {
    return Array.from(this.participants.keys()).map((id) =>
      this.getSummary(id),
    );
  }
}
