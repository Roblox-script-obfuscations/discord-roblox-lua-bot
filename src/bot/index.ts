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
  ButtonInteraction,
  MessageFlags,
} from "discord.js";
import { searchScript, fetchScriptDetail, fetchLatestScripts, type ScriptResult } from "./scriptblox.js";
import { getAIResponse } from "./ai.js";
import { translateToJapanese } from "./translate.js";
import { logger } from "../lib/logger.js";

const ALLOWED_GUILD = "1490495338296115364";
const ALLOWED_CHANNEL = "1510354846111371377";
const NOTIFY_CHANNEL = "1511170667414818857";
const POLL_INTERVAL_MS = 2 * 60 * 1000;

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let aiChannelId: string | null = null;
const conversationHistory = new Map<string, { role: "user" | "assistant"; content: string }[]>();
const searchSessions = new Map<string, { results: ScriptResult[]; index: number }>();
const seenScriptIds = new Set<string>();
let notifyInitialized = false;

function isAllowed(guildId: string | null, channelId: string): boolean {
  return guildId === ALLOWED_GUILD && channelId === ALLOWED_CHANNEL;
}

function isValidUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// 詳細を補完したScriptResultを返す
async function enrichScript(s: ScriptResult): Promise<ScriptResult> {
  if (s.creator && s.features) return s; // 既に補完済み
  const detail = await fetchScriptDetail(s.slug);
  return {
    ...s,
    creator: detail.creator || s.creator || "Anonymous",
    features: detail.features || s.features || "",
    keyLink: detail.keyLink || s.keyLink,
    imageUrl: detail.imageUrl !== undefined ? detail.imageUrl : s.imageUrl,
  };
}

// ────────────────────────────────────────────────────────
// Embed builder
// ────────────────────────────────────────────────────────

async function buildScriptEmbed(
  s: ScriptResult,
  index: number,
  total: number,
): Promise<EmbedBuilder> {
  const descRaw = s.features || "";
  // features が長い場合はタグ以降を除去してスッキリさせる
  const descClean = descRaw
    .replace(/\n*tags?\s*\(.*?\)[\s\S]*/i, "")
    .replace(/\n*tags?:\s*[\s\S]*/i, "")
    .trim();

  const descJP = descClean ? await translateToJapanese(descClean) : "";

  let descBody = "";
  if (descJP) descBody += descJP + "\n\n";

  const scriptBlock =
    s.script.length <= 1800
      ? "```lua\n" + s.script + "\n```"
      : "```lua\n" + s.script.slice(0, 1800) + "\n…(省略)\n```";

  descBody += scriptBlock;

  if (s.keySystem && s.keyLink) {
    descBody += `\n\n**Keyシステム:** [Keyを取得する](${s.keyLink})`;
  }

  const badges: string[] = [];
  if (s.isUniversal) badges.push("Universal");
  if (s.isHub) badges.push("Hub");
  if (s.isPatched) badges.push("Patched");

  const embed = new EmbedBuilder()
    .setColor(s.isPatched ? Colors.Red : Colors.Blue)
    .setTitle(
      (badges.length ? `[${badges.join(" | ")}] ` : "") + s.title,
    )
    .setURL(`https://scriptblox.com/script/${s.slug}`)
    .addFields(
      { name: "ゲーム", value: s.game || "Unknown", inline: true },
      { name: "閲覧数", value: s.views.toLocaleString(), inline: true },
      { name: "認証済み", value: s.verified ? "✓ はい" : "✗ いいえ", inline: true },
    )
    .setDescription(descBody.slice(0, 4096))
    .setFooter({
      text: `作成者: ${s.creator || "Anonymous"}　|　${s.game}　|　${index + 1} / ${total}`,
    })
    .setTimestamp(s.createdAt ? new Date(s.createdAt) : new Date());

  if (isValidUrl(s.imageUrl)) {
    embed.setThumbnail(s.imageUrl);
  }

  return embed;
}

function buildNavRow(
  msgId: string,
  index: number,
  total: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`sp_${msgId}`)
      .setLabel("PREV")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index === 0),
    new ButtonBuilder()
      .setCustomId(`sn_${msgId}`)
      .setLabel("NEXT")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(index >= total - 1),
  );
}

// ────────────────────────────────────────────────────────
// Notify embed
// ────────────────────────────────────────────────────────

async function buildNotifyEmbed(s: ScriptResult): Promise<EmbedBuilder> {
  const descRaw = s.features || "";
  const descClean = descRaw
    .replace(/\n*tags?\s*\(.*?\)[\s\S]*/i, "")
    .replace(/\n*tags?:\s*[\s\S]*/i, "")
    .trim();

  const descJP = descClean ? await translateToJapanese(descClean) : "";

  let descBody = "";
  if (descJP) descBody += descJP + "\n\n";

  const scriptBlock =
    s.script.length <= 1800
      ? "```lua\n" + s.script + "\n```"
      : "```lua\n" + s.script.slice(0, 1800) + "\n…(省略)\n```";

  descBody += scriptBlock;

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

  if (isValidUrl(s.imageUrl)) {
    embed.setThumbnail(s.imageUrl);
  }

  return embed;
}

// ────────────────────────────────────────────────────────
// New-script polling
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

    const newScripts = scripts.filter(
      (s) => s.scriptId && !seenScriptIds.has(s.scriptId),
    );
    for (const s of newScripts) seenScriptIds.add(s.scriptId);

    if (newScripts.length === 0) return;

    const guild = client.guilds.cache.get(ALLOWED_GUILD);
    if (!guild) return;

    const ch = guild.channels.cache.get(NOTIFY_CHANNEL) as TextChannel | undefined;
    if (!ch) return;

    for (const raw of newScripts) {
      const s = await enrichScript(raw);
      const embed = await buildNotifyEmbed(s);
      await ch.send({
        content: "@everyone 新しいスクリプトが投稿されました！",
        embeds: [embed],
      });
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

// Button interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const btn = interaction as ButtonInteraction;
  const id = btn.customId;

  const isPrev = id.startsWith("sp_");
  const isNext = id.startsWith("sn_");
  if (!isPrev && !isNext) return;

  const originalMsgId = id.slice(3);
  const session = searchSessions.get(originalMsgId);

  if (!session) {
    await btn.reply({
      content: "セッションが期限切れです。再度 `!search_` で検索してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.index = isPrev
    ? Math.max(0, session.index - 1)
    : Math.min(session.results.length - 1, session.index + 1);

  try {
    await btn.deferUpdate();
    const s = await enrichScript(session.results[session.index]);
    session.results[session.index] = s; // キャッシュ
    const embed = await buildScriptEmbed(s, session.index, session.results.length);
    const row = buildNavRow(originalMsgId, session.index, session.results.length);
    await btn.editReply({ embeds: [embed], components: [row] });
  } catch (err) {
    logger.error({ err }, "Button interaction error");
  }
});

// Messages
client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!isAllowed(message.guildId, message.channelId)) return;

  const content = message.content.trim();

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

  if (content.startsWith("!search_")) {
    const query = content.slice("!search_".length).trim();
    if (!query) {
      await message.reply(
        "スクリプト名を指定してください。例: `!search_infinite jump`",
      );
      return;
    }

    try {
      await (message.channel as BaseGuildTextChannel).sendTyping();
      const results = await searchScript(query, 20);

      if (results.length === 0) {
        await message.reply(
          `"${query}" に関するスクリプトが見つかりませんでした。`,
        );
        return;
      }

      // 1件目を詳細補完
      const first = await enrichScript(results[0]);
      results[0] = first;

      const embed = await buildScriptEmbed(first, 0, results.length);

      // まず仮のボタン（ID確定前）なしで送信
      const sent = await (message.channel as TextChannel).send({
        embeds: [embed],
      });

      if (results.length > 1) {
        searchSessions.set(sent.id, { results, index: 0 });
        const row = buildNavRow(sent.id, 0, results.length);
        await sent.edit({ components: [row] });

        setTimeout(() => searchSessions.delete(sent.id), 10 * 60 * 1000);
      }

      // スクリプト全文が長い場合はファイル添付
      if (first.script.length > 1800) {
        await (message.channel as TextChannel).send({
          content: "`script.lua` 全文",
          files: [
            {
              name: "script.lua",
              attachment: Buffer.from(first.script, "utf-8"),
            },
          ],
        });
      }
    } catch (err) {
      logger.error({ err }, "Script search error");
      await message.reply("スクリプトの検索中にエラーが発生しました。");
    }
    return;
  }

  // AI auto-reply
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

      for (const chunk of splitMessage(reply, 1990)) {
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
