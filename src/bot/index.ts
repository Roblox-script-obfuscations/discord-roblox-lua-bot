import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  Message,
  TextChannel,
  Colors,
  BaseGuildTextChannel,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  ButtonInteraction,
  MessageFlags,
} from "discord.js";
import { searchScript, fetchLatestScripts, type ScriptResult } from "./scriptblox.js";
import { getAIResponse } from "./ai.js";
import { translateToJapanese } from "./translate.js";
import { logger } from "../lib/logger.js";

const ALLOWED_GUILD = "1490495338296115364";
const ALLOWED_CHANNEL = "1510354846111371377";
const NOTIFY_CHANNEL = "1511170667414818857";

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2分ごと

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let aiChannelId: string | null = null;
const conversationHistory = new Map<string, { role: "user" | "assistant"; content: string }[]>();

// ボタンセッション: messageId -> { results, index }
const searchSessions = new Map<string, { results: ScriptResult[]; index: number }>();

// 新着スクリプト通知用: 確認済みID
const seenScriptIds = new Set<string>();
let notifyInitialized = false;

function isAllowed(guildId: string | null, channelId: string): boolean {
  return guildId === ALLOWED_GUILD && channelId === ALLOWED_CHANNEL;
}

// ────────────────────────────────────────────────────────
// Embed & Buttons
// ────────────────────────────────────────────────────────

async function buildScriptEmbed(s: ScriptResult, index: number, total: number): Promise<EmbedBuilder> {
  const descJP = await translateToJapanese(s.description);

  let descBody = "";
  if (descJP) descBody += descJP + "\n\n";

  const scriptBlock =
    s.script.length <= 1800
      ? "```lua\n" + s.script + "\n```"
      : "```lua\n" + s.script.slice(0, 1800) + "\n...(省略)\n```";

  descBody += scriptBlock;

  if (s.keySystem && s.keyLink) {
    descBody += `\n\n**Keyシステム:** [Keyを取得する](${s.keyLink})`;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(s.title)
    .setURL(`https://scriptblox.com/script/${s.slug}`)
    .addFields(
      { name: "ゲーム", value: s.game, inline: true },
      { name: "閲覧数", value: s.views.toLocaleString(), inline: true },
      { name: "認証済み", value: s.verified ? "✓ はい" : "✗ いいえ", inline: true },
    )
    .setDescription(descBody.slice(0, 4096))
    .setFooter({ text: `作成者: ${s.creator}　|　${s.game}　|　${index + 1} / ${total}` })
    .setTimestamp(s.createdAt ? new Date(s.createdAt) : new Date());

  if (s.imageUrl) embed.setThumbnail(s.imageUrl);

  return embed;
}

function buildNavRow(messageId: string, index: number, total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`search_prev_${messageId}`)
      .setLabel("PREV")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index === 0),
    new ButtonBuilder()
      .setCustomId(`search_next_${messageId}`)
      .setLabel("NEXT")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(index >= total - 1),
  );
}

// ────────────────────────────────────────────────────────
// 新着通知 embed
// ────────────────────────────────────────────────────────

async function buildNotifyEmbed(s: ScriptResult): Promise<EmbedBuilder> {
  const descJP = await translateToJapanese(s.description);

  let descBody = "";
  if (descJP) descBody += descJP + "\n\n";

  const scriptBlock =
    s.script.length <= 1800
      ? "```lua\n" + s.script + "\n```"
      : "```lua\n" + s.script.slice(0, 1800) + "\n...(省略)\n```";

  descBody += scriptBlock;

  if (s.keySystem && s.keyLink) {
    descBody += `\n\n**Keyシステム:** [Keyを取得する](${s.keyLink})`;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(s.title)
    .setURL(`https://scriptblox.com/script/${s.slug}`)
    .addFields(
      { name: "ゲーム", value: s.game, inline: true },
      { name: "閲覧数", value: s.views.toLocaleString(), inline: true },
      { name: "認証済み", value: s.verified ? "✓ はい" : "✗ いいえ", inline: true },
    )
    .setDescription(descBody.slice(0, 4096))
    .setFooter({ text: `作成者: ${s.creator}　|　${s.game}` })
    .setTimestamp(s.createdAt ? new Date(s.createdAt) : new Date());

  if (s.imageUrl) embed.setThumbnail(s.imageUrl);

  return embed;
}

// ────────────────────────────────────────────────────────
// 新着ポーリング
// ────────────────────────────────────────────────────────

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
    if (!guild) return;

    const ch = guild.channels.cache.get(NOTIFY_CHANNEL) as TextChannel | undefined;
    if (!ch) return;

    for (const s of newScripts) {
      const embed = await buildNotifyEmbed(s);
      await ch.send({ content: "@everyone 新しいスクリプトが投稿されました！", embeds: [embed] });
      logger.info({ title: s.title }, "New script notified");
    }
  } catch (err) {
    logger.error({ err }, "Poll new scripts error");
  }
}

// ────────────────────────────────────────────────────────
// Events
// ────────────────────────────────────────────────────────

client.once(Events.ClientReady, (c) => {
  logger.info({ tag: c.user.tag }, "Discord bot ready");
  pollNewScripts();
  setInterval(pollNewScripts, POLL_INTERVAL_MS);
});

// ボタンインタラクション
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const btn = interaction as ButtonInteraction;

  const id = btn.customId;
  if (!id.startsWith("search_prev_") && !id.startsWith("search_next_")) return;

  const isPrev = id.startsWith("search_prev_");
  const originalMsgId = id.replace("search_prev_", "").replace("search_next_", "");

  const session = searchSessions.get(originalMsgId);
  if (!session) {
    await btn.reply({ content: "セッションが期限切れです。再度検索してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  session.index = isPrev
    ? Math.max(0, session.index - 1)
    : Math.min(session.results.length - 1, session.index + 1);

  const s = session.results[session.index];
  const embed = await buildScriptEmbed(s, session.index, session.results.length);
  const row = buildNavRow(originalMsgId, session.index, session.results.length);

  await btn.update({ embeds: [embed], components: [row] });
});

// メッセージ
client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!isAllowed(message.guildId, message.channelId)) return;

  const content = message.content.trim();

  // !set / !unset
  if (content === "!set") {
    aiChannelId = message.channelId;
    conversationHistory.clear();
    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("AI自動応答 有効")
      .setDescription(
        `<#${message.channelId}> でAI自動応答を開始しました。\n` +
        `Roblox Luaの質問・難読化・リバースエンジニアリングに対応します。\n\n` +
        `停止するには \`!unset\` を送信してください。`,
      )
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  if (content === "!unset") {
    aiChannelId = null;
    conversationHistory.clear();
    const embed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("AI自動応答 無効")
      .setDescription("AI自動応答を停止しました。")
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  // !search_{query}
  if (content.startsWith("!search_")) {
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

      const s = results[0];
      const embed = await buildScriptEmbed(s, 0, results.length);
      const row = buildNavRow("PLACEHOLDER", 0, results.length);

      // まずメッセージを送信してIDを取得
      const sent = await (message.channel as TextChannel).send({
        embeds: [embed],
        components: results.length > 1 ? [row] : [],
      });

      // セッションをメッセージIDで登録し、ボタンのcustomIdも更新
      if (results.length > 1) {
        searchSessions.set(sent.id, { results, index: 0 });

        const realRow = buildNavRow(sent.id, 0, results.length);
        await sent.edit({ components: [realRow] });

        // 10分後にセッションクリーンアップ
        setTimeout(() => {
          searchSessions.delete(sent.id);
        }, 10 * 60 * 1000);
      }

      // スクリプトが長い場合はファイル添付
      if (s.script.length > 1800) {
        await (message.channel as TextChannel).send({
          content: "`script.lua` (全文)",
          files: [{ name: "script.lua", attachment: Buffer.from(s.script, "utf-8") }],
        });
      }
    } catch (err) {
      logger.error({ err }, "Script search error");
      await message.reply("スクリプトの検索中にエラーが発生しました。");
    }
    return;
  }

  // AI自動応答
  if (aiChannelId === message.channelId) {
    const userId = message.author.id;
    const history = conversationHistory.get(userId) ?? [];

    try {
      await (message.channel as BaseGuildTextChannel).sendTyping();
      const reply = await getAIResponse(content, history);

      history.push({ role: "user", content });
      history.push({ role: "assistant", content: reply });
      if (history.length > 20) history.splice(0, 2);
      conversationHistory.set(userId, history);

      const chunks = splitMessage(reply, 1990);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (err) {
      logger.error({ err }, "AI response error");
      await message.reply("AI応答中にエラーが発生しました。");
    }
  }
});

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
