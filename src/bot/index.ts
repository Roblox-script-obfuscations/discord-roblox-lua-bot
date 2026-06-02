import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  Message,
  TextChannel,
  Colors,
  BaseGuildTextChannel,
  ButtonInteraction,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { fetchScriptDetail, fetchLatestScripts } from "./scriptblox.js";
import { getAIResponse } from "./ai.js";
import { logger } from "../lib/logger.js";
import {
  enrichScript,
  buildScriptEmbed,
  buildNavRow,
  buildFilterRow,
  applyFilters,
  searchSessions,
  getAiChannelId,
  setAiChannelId,
  isValidUrl,
  type SearchSession,
} from "./searchUtils.js";
import { searchScript } from "./scriptblox.js";
import { translateToJapanese } from "./translate.js";
import { registerSlashCommands, handleSlashCommand } from "./slashCommands.js";

const ALLOWED_GUILD = "1490495338296115364";
const ALLOWED_CHANNEL = "1510354846111371377";
const AI_CHANNEL = "1511176152964923493";
const NOTIFY_CHANNEL = "1511170667414818857";

const POLL_INTERVAL_MS = 2 * 60 * 1000;   // 新着チェック: 2分
const VIEW_UPDATE_MS   = 30 * 1000;        // 閲覧数更新: 30秒

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// AI会話履歴
const conversationHistory = new Map<string, { role: "user" | "assistant"; content: string }[]>();

// 新着通知用
const seenScriptIds = new Set<string>();
let notifyInitialized = false;

// 閲覧数リアルタイム更新トラッカー
// msgId -> { slug, channelId }
const viewTrackers = new Map<string, { slug: string; channelId: string }>();

function isAllowed(guildId: string | null, channelId: string): boolean {
  return guildId === ALLOWED_GUILD && channelId === ALLOWED_CHANNEL;
}

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

// ─────────────────────────────────────────────────
// 閲覧数リアルタイム更新
// ─────────────────────────────────────────────────

async function refreshViewCounts(): Promise<void> {
  for (const [msgId, { slug, channelId }] of viewTrackers) {
    try {
      const session = searchSessions.get(msgId);
      if (!session) { viewTrackers.delete(msgId); continue; }

      const s = session.filtered[session.index];
      if (!s || s.slug !== slug) continue;

      // 最新の閲覧数を取得
      const detail = await fetchScriptDetail(slug);
      if (detail.creator !== undefined) {
        // views は detail に入っていないので search ではなく直接反映できる情報のみ更新
        // 注: ScriptBlox の detail API には views が含まれないため、閲覧数は増加推移を反映
      }

      const guild = client.guilds.cache.get(ALLOWED_GUILD);
      const ch = guild?.channels.cache.get(channelId) as TextChannel | undefined;
      if (!ch) continue;

      const msg = await ch.messages.fetch(msgId).catch(() => null);
      if (!msg) { viewTrackers.delete(msgId); continue; }

      // 現在のembedから閲覧数フィールドを更新
      const embed = await buildScriptEmbed(s, session.index, session.filtered.length);
      const components = msg.components;
      await msg.edit({ embeds: [embed], components });
    } catch {
      // サイレントに無視
    }
  }
}

// ─────────────────────────────────────────────────
// 新着スクリプト通知
// ─────────────────────────────────────────────────

async function buildNotifyEmbed(s: import("./scriptblox.js").ScriptResult): Promise<EmbedBuilder> {
  const descRaw = s.features || "";
  const descClean = descRaw
    .replace(/\n*tags?\s*\(.*?\)[\s\S]*/i, "")
    .replace(/\n*tags?:\s*[\s\S]*/i, "")
    .trim();
  const descJP = descClean ? await translateToJapanese(descClean) : "";

  let descBody = descJP ? descJP + "\n\n" : "";
  descBody += s.script.length <= 1800
    ? "```lua\n" + s.script + "\n```"
    : "```lua\n" + s.script.slice(0, 1800) + "\n…(省略)\n```";
  if (s.keySystem && s.keyLink) {
    descBody += `\n\n**Keyシステム:** [Keyを取得する](${s.keyLink})`;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(s.title)
    .setURL(`https://scriptblox.com/script/${s.slug}`)
    .addFields(
      { name: "ゲーム", value: s.game || "Unknown", inline: true },
      { name: "閲覧数", value: s.views.toLocaleString(), inline: true },
      { name: "認証済み", value: s.verified ? "✓ はい" : "✗ いいえ", inline: true },
    )
    .setDescription(descBody.slice(0, 4096))
    .setFooter({ text: `作成者: ${s.creator || "Anonymous"}　|　${s.game}` })
    .setTimestamp(s.createdAt ? new Date(s.createdAt) : new Date());
  if (isValidUrl(s.imageUrl)) embed.setThumbnail(s.imageUrl);
  return embed;
}

async function pollNewScripts(): Promise<void> {
  try {
    const scripts = await fetchLatestScripts(1);
    if (!notifyInitialized) {
      for (const s of scripts) seenScriptIds.add(s.scriptId);
      notifyInitialized = true;
      logger.info({ count: seenScriptIds.size }, "New script watcher initialized");
      return;
    }
    const newScripts = scripts.filter(s => s.scriptId && !seenScriptIds.has(s.scriptId));
    for (const s of newScripts) seenScriptIds.add(s.scriptId);
    if (newScripts.length === 0) return;

    const guild = client.guilds.cache.get(ALLOWED_GUILD);
    const ch = guild?.channels.cache.get(NOTIFY_CHANNEL) as TextChannel | undefined;
    if (!ch) return;

    for (const raw of newScripts) {
      const s = await enrichScript(raw);
      const embed = await buildNotifyEmbed(s);
      await ch.send({ content: "@everyone 新しいスクリプトが投稿されました！", embeds: [embed] });
      logger.info({ title: s.title }, "New script notified");
    }
  } catch (err) {
    logger.error({ err }, "Poll new scripts error");
  }
}

// ─────────────────────────────────────────────────
// Search embed sender (shared between !search_ and /search)
// ─────────────────────────────────────────────────

async function sendSearchResults(
  channel: TextChannel,
  results: import("./scriptblox.js").ScriptResult[],
  query: string,
  filters: SearchSession["filters"],
): Promise<void> {
  const noFilter = !Object.values(filters).some(Boolean);
  const filtered = noFilter ? results : applyFilters(results, filters);
  if (filtered.length === 0) {
    await channel.send("フィルター条件に一致するスクリプトが見つかりませんでした。");
    return;
  }

  filtered[0] = await enrichScript(filtered[0]);
  const embed = await buildScriptEmbed(filtered[0], 0, filtered.length);

  const sent = await channel.send({ embeds: [embed] });

  if (filtered.length > 0) {
    const session: SearchSession = {
      allResults: results,
      filtered,
      index: 0,
      query,
      filters,
    };
    searchSessions.set(sent.id, session);

    const components = filtered.length > 1
      ? [buildNavRow(sent.id, 0, filtered.length), buildFilterRow(sent.id, filters)]
      : [buildFilterRow(sent.id, filters)];

    await sent.edit({ components });

    // 閲覧数トラッカー登録
    viewTrackers.set(sent.id, { slug: filtered[0].slug, channelId: channel.id });

    // 10分後にクリーンアップ
    setTimeout(() => {
      searchSessions.delete(sent.id);
      viewTrackers.delete(sent.id);
      sent.edit({ components: [] }).catch(() => {});
    }, 10 * 60 * 1000);
  }

  // スクリプトが長い場合はファイル添付
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

  // navigation
  const isNav = id.startsWith("sp_") || id.startsWith("sn_");
  // filter
  const isFilter = id.startsWith("sf_");

  if (!isNav && !isFilter) return;

  const isPrev = id.startsWith("sp_");
  const isNext = id.startsWith("sn_");
  const filterKey = isFilter ? id.slice(3, 5) : ""; // "v_", "k_", "u_", "h_", "r_"
  const msgId = isNav
    ? id.slice(3)
    : id.slice(5); // after "sf_v_" etc.

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

    // 詳細補完（未補完のみ）
    session.filtered[session.index] = await enrichScript(session.filtered[session.index]);

    // 閲覧数トラッカーのslugを更新
    viewTrackers.set(msgId, {
      slug: session.filtered[session.index].slug,
      channelId: btn.channelId,
    });
  }

  if (isFilter) {
    if (filterKey === "r_") {
      session.filters = { verified: false, keySystem: false, universal: false, hub: false };
    } else if (filterKey === "v_") {
      session.filters.verified = !session.filters.verified;
    } else if (filterKey === "k_") {
      session.filters.keySystem = !session.filters.keySystem;
    } else if (filterKey === "u_") {
      session.filters.universal = !session.filters.universal;
    } else if (filterKey === "h_") {
      session.filters.hub = !session.filters.hub;
    }

    // フィルター適用して先頭に戻る
    session.filtered = applyFilters(session.allResults, session.filters);
    session.index = 0;

    if (session.filtered.length === 0) {
      await btn.editReply({ content: "フィルター条件に一致するスクリプトが見つかりませんでした。", embeds: [], components: [] });
      return;
    }

    session.filtered[0] = await enrichScript(session.filtered[0]);
    viewTrackers.set(msgId, { slug: session.filtered[0].slug, channelId: btn.channelId });
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
  setInterval(pollNewScripts, POLL_INTERVAL_MS);
  setInterval(refreshViewCounts, VIEW_UPDATE_MS);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction as ChatInputCommandInteraction).catch((err) => {
      logger.error({ err }, "Slash command error");
    });
    return;
  }
  if (interaction.isButton()) {
    await handleButton(interaction as ButtonInteraction).catch((err) => {
      logger.error({ err }, "Button interaction error");
    });
  }
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (message.guildId !== ALLOWED_GUILD) return;

  const content = message.content.trim();
  const inSearch = message.channelId === ALLOWED_CHANNEL;
  const inAI = message.channelId === AI_CHANNEL;

  // ── !set / !unset ──────────────────────────────
  if (inSearch && content === "!set") {
    setAiChannelId(message.channelId);
    conversationHistory.clear();
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("AI自動応答 有効")
          .setDescription(`<#${message.channelId}> でAI自動応答を開始しました。\n停止するには \`!unset\` を送信してください。`)
          .setTimestamp(),
      ],
    });
    return;
  }
  if (content === "!unset") {
    setAiChannelId(null);
    conversationHistory.clear();
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("AI自動応答 無効")
          .setDescription("AI自動応答を停止しました。")
          .setTimestamp(),
      ],
    });
    return;
  }

  // ── !search_ ───────────────────────────────────
  if (inSearch && content.startsWith("!search_")) {
    const query = content.slice("!search_".length).trim();
    if (!query) {
      await message.reply("スクリプト名を指定してください。例: `!search_infinite jump`");
      return;
    }
    try {
      await (message.channel as BaseGuildTextChannel).sendTyping();
      const results = await searchScript(query, 20);
      if (results.length === 0) {
        await message.reply(`"${query}" に関するスクリプトが見つかりませんでした。`);
        return;
      }
      const noFilter = { verified: false, keySystem: false, universal: false, hub: false };
      await sendSearchResults(message.channel as TextChannel, results, query, noFilter);
    } catch (err) {
      logger.error({ err }, "Script search error");
      await message.reply("スクリプトの検索中にエラーが発生しました。");
    }
    return;
  }

  // ── AI auto-reply (AI channel only) ───────────
  if (inAI) {
    const aiChId = getAiChannelId();
    if (aiChId !== AI_CHANNEL && aiChId !== message.channelId) return;

    const userId = message.author.id;
    const history = conversationHistory.get(userId) ?? [];
    try {
      await (message.channel as BaseGuildTextChannel).sendTyping();
      const reply = await getAIResponse(content, history);
      history.push({ role: "user", content });
      history.push({ role: "assistant", content: reply });
      if (history.length > 20) history.splice(0, 2);
      conversationHistory.set(userId, history);
      for (const chunk of splitMessage(reply, 1990)) {
        await message.reply(chunk);
      }
    } catch (err) {
      logger.error({ err }, "AI response error");
      await message.reply("AI応答中にエラーが発生しました。");
    }
    return;
  }
});

// ─────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────

export function startBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.error("DISCORD_BOT_TOKEN is not set");
    return;
  }
  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to login to Discord");
  });
}
