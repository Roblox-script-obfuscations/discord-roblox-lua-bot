// ─── Per-guild runtime configuration (in-memory) ──────────────────────────────

export interface GuildConfig {
  searchChannelId?: string;
  aiChannelId?: string;
  notifyChannelId?: string;
}

export interface StatusTracker {
  channelId: string;
  guildId: string | null;
}

export const guildConfigs = new Map<string, GuildConfig>();
export const statusTrackers = new Map<string, StatusTracker>();

export function getGuildConfig(guildId: string): GuildConfig {
  if (!guildConfigs.has(guildId)) guildConfigs.set(guildId, {});
  return guildConfigs.get(guildId)!;
}

export function patchGuildConfig(guildId: string, patch: Partial<GuildConfig>): void {
  const cur = getGuildConfig(guildId);
  guildConfigs.set(guildId, { ...cur, ...patch });
}
