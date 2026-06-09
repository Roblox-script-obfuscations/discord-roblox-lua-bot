import {
  Events,
  Message,
  TextChannel,
  Colors,
  EmbedBuilder,
  BaseGuildTextChannel,
  ButtonInteraction,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { client } from "./client.js";
import { fetchScriptDetail, fetchLatestScripts, type ScriptResult } from "./scriptblox.js";
import { getAIResponse } from "./ai.js";
import { logger } from "../lib/logger.js";
import {
  enrichScript,
  buildScriptEmbed,
  buildNavRow,
  buildFilterRow,
  applyFilters,
  searchSessions,
  isValidUrl,
  type SearchSession,
} from "./searchUtils.js";
import { searchScript } from "./scriptblox.js";
import { translateToJapanese } from "./translate.js";
import {
  getGuildConfig,
  patchGuildConfig,
  guildConfigs,
  statusTrackers,
} from "./guildConfig.js";
import { registerSlashCommands, handleSlashCommand, buildStatusEmbed } from "./slashCommands.js";

// ─── Intervals ────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const VIEW_UPDATE_MS   = 5  * 1000;
const STATUS_UPDATE_MS = 5  * 1000;

// ─── AI conversation history (per user) ──────────────────────────────────────
const conversationHistory = new Map<string, { role: "user" | "assistant"; content: string }[]>();

// ─── New-script watcher ───────────────────────────────────────────────────────
const seenScriptIds = new Set<string>();
let notifyInitialized = false;

// ─── View-count live trackers ─────────────────────────────────────────────────
type ViewTracker = { slug: string; channelId: string; guildId: string; type: "search" | "notify"; script?: ScriptResult };
const viewTrackers = new Map<string, ViewTracker>();

// ─────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  while (text.length > maxLen) {
    let idx = text.lastIndexOf("\n", maxLen);
    if (idx < 0) idx = maxLen;
    chunks.push(text.slice(0, idx));
    text = text.slice(idx).trimStart();
  }
  if (text) chunks.push(text);
  return chunks;
}

function getTextChannel(guildId: string, channelId: string): TextChannel | undefined {
  return client.guilds.cache.get(guildId)?.channels.cache.get(channelId) as TextChannel | undefined;
}

// ─────────────────────────────────────────────────
// Notification embed
// ─────────────────────────────────────────────────

async function buildNotifyEmbed(s: ScriptResult): Promise<EmbedBuilder> {
  const clean = (s.features ?? "")
    .replace(/\n*tags?\s*\(.*?\)[\s\S]*/i, "")
    .replace(/\n*tags?:\s*[\s\S]*/i, "")
    .trim();
  const descJP = clean ? await translateToJapanese(clean) : "";
  let descBody = descJP ? descJP + "\n\n" : "";
  descBody += s.script.length <= 1800
    ? "```lua\n" + s.script + "\n```"
    : "```lua\n" + s.script.slice(0, 1800) + "\n…(省略)\n```";
  if (s.keySystem && s.keyLink) descBody += `\n\n**Keyシステム:** [Keyを取得する](${s.keyLink})`;

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🆕 " + s.title)
    .setURL(`https://scriptblox.com/script/${s.slug}`)
    .addFields(
      { name: "ゲーム",   value: s.game || "Unknown",                    inline: true },
      { name: "閲覧数",   value: s.views.toLocaleString(),                inline: true },
      { name: "認証済み", value: s.verified ? "✓ はい" : "✗ いいえ",     inline: true },
    )
    .setDescription(descBody.slice(0, 4096))
    .setFooter({ text: `作成者: ${s.creator || "Anonymous"}　|　${s.game}` })
    .setTimestamp(s.createdAt ? new Date(s.createdAt) : new Date());
  if (isValidUrl(s.imageUrl)) embed.setThumbnail(s.imageUrl);
  return embed;
}

// ─────────────────────────────────────────────────
// New-script polling (all guilds)
// ─────────────────────────────────────────────────

async function pollNewScripts(): Promise<void> {
  try {
    const scripts = await fetchLatestScripts(1);
    if (!notifyInitialized) {
      for (const s of scripts) seenScriptIds.add(s.scriptId);
      notifyInitialized = true;
      logger.info({ count: seenScriptIds.size }, "Script watcher initialized");
      return;
    }
    const newScripts = scripts.filter(s => s.scriptId && !seenScriptIds.has(s.scriptId));
    for (const s of newScripts) seenScriptIds.add(s.scriptId);
    if (newScripts.length === 0) return;

    // Notify all configured guilds
    for (const [guildId, cfg] of guildConfigs) {
      if (!cfg.notifyChannelId) continue;
      const ch = getTextChannel(guildId, cfg.notifyChannelId);
      if (!ch) continue;
      for (const raw of newScripts) {
        const s = await enrichScript(raw);
        const embed = await buildNotifyEmbed(s);
        const sent = await ch.send({ content: "@everyone 新しいスクリプトが投稿されました！", embeds: [embed] });
        logger.info({ title: s.title, guild: guildId }, "New script notified");
        // Register for view-count live tracking (1 hour)
        viewTrackers.set(sent.id, { slug: s.slug, channelId: cfg.notifyChannelId, guildId, type: "notify", script: s });
        setTimeout(() => viewTrackers.delete(sent.id), 60 * 60 * 1000);
      }
    }
  } catch (err) {
    logger.error({ err }, "pollNewScripts error");
  }
}

// ─────────────────────────────────────────────────
// View-count refresh (every 5 s)
// ─────────────────────────────────────────────────

async function refreshViewCounts(): Promise<void> {
  for (const [msgId, tracker] of viewTrackers) {
    try {
      const ch = getTextChannel(tracker.guildId, tracker.channelId);
      if (!ch) continue;
      const detail = await fetchScriptDetail(tracker.slug);
      const freshViews = typeof detail.views === "number" ? detail.views : null;

      if (tracker.type === "search") {
        const session = searchSessions.get(msgId);
        if (!session) { viewTrackers.delete(msgId); continue; }
        const s = session.filtered[session.index];
        if (!s || s.slug !== tracker.slug) continue;
        if (freshViews !== null) s.views = freshViews;
        const msg = await ch.messages.fetch(msgId).catch(() => null);
        if (!msg) { viewTrackers.delete(msgId); continue; }
        const embed = await buildScriptEmbed(s, session.index, session.filtered.length);
        await msg.edit({ embeds: [embed], components: msg.components });
      } else {
        const s = tracker.script;
        if (!s) continue;
        if (freshViews !== null) s.views = freshViews;
        const msg = await ch.messages.fetch(msgId).catch(() => null);
        if (!msg) { viewTrackers.delete(msgId); continue; }
        const embed = await buildNotifyEmbed(s);
        await msg.edit({ embeds: [embed] });
      }
    } catch { /* silent */ }
  }
}

// ─────────────────────────────────────────────────
// Status message refresh (every 5 s)
// ─────────────────────────────────────────────────

async function refreshStatusMessages(): Promise<void> {
  for (const [msgId, { channelId, guildId }] of statusTrackers) {
    try {
      let ch: TextChannel | undefined;
      if (guildId) {
        ch = getTextChannel(guildId, channelId);
      } else {
        // DM or global — find by iterating channels
        for (const guild of client.guilds.cache.values()) {
          ch = guild.channels.cache.get(channelId) as TextChannel | undefined;
          if (ch) break;
        }
      }
      if (!ch) continue;
      const msg = await ch.messages.fetch(msgId).catch(() => null);
      if (!msg) { statusTrackers.delete(msgId); continue; }
      await msg.edit({ embeds: [buildStatusEmbed()] });
    } catch { /* silent */ }
  }
}

// ─────────────────────────────────────────────────
// Search result sender (for !search_ prefix)
// ─────────────────────────────────────────────────

async function sendSearchResults(
  channel: TextChannel,
  guildId: string,
  results: ScriptResult[],
  query: string,
): Promise<void> {
  const noFilter: SearchSession["filters"] = { verified: false, keySystem: false, universal: false, hub: false };
  const filtered = results; // No filter for prefix command

  filtered[0] = await enrichScript(filtered[0]);
  const embed = await buildScriptEmbed(filtered[0], 0, filtered.length);
  const sent = await channel.send({ embeds: [embed] });

  const session: SearchSession = { allResults: results, filtered, index: 0, query, filters: noFilter };
  searchSessions.set(sent.id, session);

  const components = filtered.length > 1
    ? [buildNavRow(sent.id, 0, filtered.length), buildFilterRow(sent.id, noFilter)]
    : [buildFilterRow(sent.id, noFilter)];
  await sent.edit({ components });

  viewTrackers.set(sent.id, { slug: filtered[0].slug, channelId: channel.id, guildId, type: "search" });

  setTimeout(() => {
    searchSessions.delete(sent.id);
    viewTrackers.delete(sent.id);
    sent.edit({ components: [] }).catch(() => {});
  }, 10 * 60 * 1000);

  if (filtered[0].script.length > 1800) {
    await channel.send({
      content: "`script.lua` 全文",
      files: [{ name: "script.lua", attachment: Buffer.from(filtered[0].script, "utf-8") }],
    });
  }
}

// ─────────────────────────────────────────────────
// Button handler
// ─────────────────────────────────────────────────

async function handleButton(btn: ButtonInteraction): Promise<void> {
  const id = btn.customId;
  const isNav    = id.startsWith("sp_") || id.startsWith("sn_");
  const isFilter = id.startsWith("sf_");
  if (!isNav && !isFilter) return;

  const isPrev    = id.startsWith("sp_");
  const filterKey = isFilter ? id.slice(3, 5) : "";
  const msgId     = isNav ? id.slice(3) : id.slice(5);

  const session = searchSessions.get(msgId);
  if (!session) {
    await btn.reply({ content: "セッションが期限切れです。再度検索してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  await btn.deferUpdate();

  if (isNav) {
    session.index = isPrev
      ? Math.max(0, session.index - 1)
      : Math.min(session.filtered.length - 1, session.index + 1);
    session.filtered[session.index] = await enrichScript(session.filtered[session.index]);
    const t = viewTrackers.get(msgId);
    if (t) viewTrackers.set(msgId, { ...t, slug: session.filtered[session.index].slug });
  }

  if (isFilter) {
    if      (filterKey === "r_") { session.filters = { verified: false, keySystem: false, universal: false, hub: false }; }
    else if (filterKey === "v_") { session.filters.verified  = !session.filters.verified; }
    else if (filterKey === "k_") { session.filters.keySystem = !session.filters.keySystem; }
    else if (filterKey === "u_") { session.filters.universal = !session.filters.universal; }
    else if (filterKey === "h_") { session.filters.hub       = !session.filters.hub; }

    session.filtered = applyFilters(session.allResults, session.filters);
    session.index    = 0;

    if (session.filtered.length === 0) {
      await btn.editReply({ content: "フィルター条件に一致するスクリプトが見つかりませんでした。", embeds: [], components: [] });
      return;
    }
    session.filtered[0] = await enrichScript(session.filtered[0]);
    const t = viewTrackers.get(msgId);
    if (t) viewTrackers.set(msgId, { ...t, slug: session.filtered[0].slug });
  }

  const s = session.filtered[session.index];
  const embed = await buildScriptEmbed(s, session.index, session.filtered.length);
  const components = session.filtered.length > 1
    ? [buildNavRow(msgId, session.index, session.filtered.length), buildFilterRow(msgId, session.filters)]
    : [buildFilterRow(msgId, session.filters)];
  await btn.editReply({ embeds: [embed], components });
}

// ─────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  logger.info({ tag: c.user.tag }, "Discord bot ready");
  await registerSlashCommands(c.user.id);
  pollNewScripts();
  setInterval(pollNewScripts,        POLL_INTERVAL_MS);
  setInterval(refreshViewCounts,     VIEW_UPDATE_MS);
  setInterval(refreshStatusMessages, STATUS_UPDATE_MS);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction as ChatInputCommandInteraction).catch(err => logger.error({ err }, "Slash command error"));
  } else if (interaction.isButton()) {
    await handleButton(interaction as ButtonInteraction).catch(err => logger.error({ err }, "Button error"));
  }
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot || !message.guildId) return;
  const content  = message.content.trim();
  const guildId  = message.guildId;
  const cfg      = getGuildConfig(guildId);

  // ── !set / !unset ──────────────────────────────
  if (content === "!set") {
    patchGuildConfig(guildId, { aiChannelId: message.channelId });
    conversationHistory.clear();
    await message.reply({
      embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("AI自動応答 有効").setDescription(`<#${message.channelId}> でAI自動応答を開始しました。\n\`!unset\` で停止できます。`).setTimestamp()],
    });
    return;
  }
  if (content === "!unset") {
    patchGuildConfig(guildId, { aiChannelId: undefined });
    conversationHistory.clear();
    await message.reply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("AI自動応答 無効").setDescription("AI自動応答を停止しました。").setTimestamp()],
    });
    return;
  }

  // ── !search_ prefix ────────────────────────────
  if (content.startsWith("!search_")) {
    const inSearchCh = !cfg.searchChannelId || message.channelId === cfg.searchChannelId;
    if (!inSearchCh) return;
    const query = content.slice("!search_".length).trim();
    if (!query) { await message.reply("スクリプト名を指定してください。例: `!search_infinite jump`"); return; }
    try {
      await (message.channel as BaseGuildTextChannel).sendTyping();
      const results = await searchScript(query, 20);
      if (results.length === 0) { await message.reply(`"${query}" に関するスクリプトが見つかりませんでした。`); return; }
      await sendSearchResults(message.channel as TextChannel, guildId, results, query);
    } catch (err) {
      logger.error({ err }, "!search_ error");
      await message.reply("スクリプトの検索中にエラーが発生しました。");
    }
    return;
  }

  // ── AI auto-reply ──────────────────────────────
  if (cfg.aiChannelId && message.channelId === cfg.aiChannelId) {
    const userId  = message.author.id;
    const history = conversationHistory.get(userId) ?? [];
    try {
      await (message.channel as BaseGuildTextChannel).sendTyping();
      const reply = await getAIResponse(content, history);
      history.push({ role: "user", content });
      history.push({ role: "assistant", content: reply });
      if (history.length > 20) history.splice(0, 2);
      conversationHistory.set(userId, history);
      for (const chunk of splitMessage(reply, 1990)) await message.reply(chunk);
    } catch (err) {
      logger.error({ err }, "AI reply error");
      await message.reply("AI応答中にエラーが発生しました。");
    }
  }
});

// ─────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────

export function startBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) { logger.error("DISCORD_BOT_TOKEN not set"); return; }
  client.login(token).catch(err => logger.error({ err }, "Discord login failed"));
}
