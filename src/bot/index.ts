import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  Message,
  TextChannel,
  Colors,
  BaseGuildTextChannel,
} from "discord.js";
import { searchScript } from "./scriptblox.js";
import { getAIResponse } from "./ai.js";
import { logger } from "../lib/logger.js";

const ALLOWED_GUILD = "1490495338296115364";
const ALLOWED_CHANNEL = "1510354846111371377";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let aiChannelId: string | null = null;
const conversationHistory = new Map<string, { role: "user" | "assistant"; content: string }[]>();

function isAllowed(guildId: string | null, channelId: string): boolean {
  return guildId === ALLOWED_GUILD && channelId === ALLOWED_CHANNEL;
}

client.once(Events.ClientReady, (c) => {
  logger.info({ tag: c.user.tag }, "Discord bot ready");
});

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
      await message.reply("スクリプト名を指定してください。例: `!search_infinite jump`");
      return;
    }

    try {
      await (message.channel as BaseGuildTextChannel).sendTyping();
      const results = await searchScript(query);

      if (results.length === 0) {
        await message.reply(`"${query}" に関するスクリプトが見つかりませんでした。`);
        return;
      }

      const s = results[0];

      const embed = new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(s.title)
        .setURL(`https://scriptblox.com/script/${s.slug}`)
        .addFields(
          { name: "ゲーム", value: s.game || "不明", inline: true },
          { name: "閲覧数", value: s.views.toLocaleString(), inline: true },
          { name: "認証済み", value: s.verified ? "はい" : "いいえ", inline: true },
        )
        .setTimestamp(s.createdAt ? new Date(s.createdAt) : new Date())
        .setFooter({ text: `作成者: ${s.creator}` });

      if (s.description) {
        embed.setDescription(s.description.slice(0, 1024));
      }

      if (s.imageUrl) {
        embed.setThumbnail(s.imageUrl);
      }

      const files: { name: string; attachment: Buffer }[] = [];
      if (s.script.length > 1900) {
        files.push({
          name: "script.lua",
          attachment: Buffer.from(s.script, "utf-8"),
        });
      }

      await (message.channel as TextChannel).send({ embeds: [embed], files });

      if (s.script.length <= 1900) {
        const scriptText = s.script;
        const codeEmbed = new EmbedBuilder()
          .setColor(Colors.DarkGrey)
          .setTitle("スクリプトコード")
          .setDescription("```lua\n" + scriptText + "\n```");
        await (message.channel as TextChannel).send({ embeds: [codeEmbed] });
      }

      if (s.keySystem && s.keyLink) {
        const keyEmbed = new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setTitle("Keyシステム")
          .setDescription(
            `このスクリプトにはKeyシステムがあります。\n[Keyを取得する](${s.keyLink})`,
          );
        await (message.channel as TextChannel).send({ embeds: [keyEmbed] });
      }
    } catch (err) {
      logger.error({ err }, "Script search error");
      await message.reply("スクリプトの検索中にエラーが発生しました。");
    }
    return;
  }

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
