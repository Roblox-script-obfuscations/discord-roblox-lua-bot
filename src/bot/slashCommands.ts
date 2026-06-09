import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  Colors,
  MessageFlags,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { searchScript, fetchLatestScripts, fetchScriptDetail } from "./scriptblox.js";
import { getAIResponse, obfuscateLua, deobfuscateLua, explainLua, fixLua } from "./ai.js";
import { logger } from "../lib/logger.js";
import {
  enrichScript,
  buildScriptEmbed,
  buildNavRow,
  buildFilterRow,
  applyFilters,
  searchSessions,
  type SearchSession,
} from "./searchUtils.js";
import {
  getGuildConfig,
  patchGuildConfig,
  statusTrackers,
} from "./guildConfig.js";
import { client } from "./client.js";

// ─────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  return !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
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

function fmtUptime(): string {
  const s = Math.floor(process.uptime());
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}時間${m}分${sec}秒`;
}

// ─────────────────────────────────────────────────
// Status embed (exported for live update in index.ts)
// ─────────────────────────────────────────────────

export function buildStatusEmbed(): EmbedBuilder {
  const ping = client.ws.ping;
  const pingStr = ping < 0 ? "計測中…" : `${ping}ms`;
  const pingEmoji = ping < 0 ? "⚙️" : ping < 100 ? "🟩" : ping < 300 ? "🟨" : "🟥";

  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("🤖 Bot ステータス")
    .setDescription(`${pingEmoji} **オンライン稼働中**`)
    .addFields(
      { name: "📡 Ping",          value: pingStr,                               inline: true },
      { name: "🌐 参加サーバー数",  value: `${client.guilds.cache.size}台`,      inline: true },
      { name: "⏱️ 稼働時間",       value: fmtUptime(),                           inline: true },
      { name: "📊 検索セッション",  value: `${searchSessions.size}件`,            inline: true },
      { name: "📡 API状態",         value: "🟩 ScriptBlox  🟩 Groq  🟩 Gemini",   inline: false },
    )
    .setFooter({ text: "5秒ごとにリアルタイム更新" })
    .setTimestamp();
}

// ─────────────────────────────────────────────────
// Command definitions (global — no guild restriction)
// ─────────────────────────────────────────────────

export const commandDefinitions = [
  // ── 管理者設定 ──────────────────────────────────
  new SlashCommandBuilder()
    .setName("setsearch")
    .setDescription("スクリプト検索チャンネルを設定します（管理者専用）")
    .addChannelOption(o => o.setName("channel").setDescription("検索チャンネル").setRequired(true)),

  new SlashCommandBuilder()
    .setName("setai")
    .setDescription("AI自動応答チャンネルを設定します（管理者専用）")
    .addChannelOption(o => o.setName("channel").setDescription("AIチャンネル").setRequired(true)),

  new SlashCommandBuilder()
    .setName("setnotify")
    .setDescription("新着スクリプト通知チャンネルを設定します（管理者専用）")
    .addChannelOption(o => o.setName("channel").setDescription("通知チャンネル").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unsetnotify")
    .setDescription("新着スクリプト通知を停止します（管理者専用）"),

  new SlashCommandBuilder()
    .setName("config")
    .setDescription("このサーバーの現在の設定を確認します"),

  // ── スクリプト検索 ──────────────────────────────
  new SlashCommandBuilder()
    .setName("search")
    .setDescription("Roblox Luaスクリプトを検索します")
    .addStringOption(o => o.setName("query").setDescription("スクリプト名・ゲーム名").setRequired(true))
    .addBooleanOption(o => o.setName("verified").setDescription("認証済みのみ表示"))
    .addBooleanOption(o => o.setName("key").setDescription("Keyシステムのみ表示"))
    .addBooleanOption(o => o.setName("universal").setDescription("Universalのみ表示"))
    .addBooleanOption(o => o.setName("hub").setDescription("Script Hubのみ表示")),

  new SlashCommandBuilder()
    .setName("latest")
    .setDescription("ScriptBloxの最新スクリプトを表示します"),

  new SlashCommandBuilder()
    .setName("hub")
    .setDescription("Script Hubを専用検索します")
    .addStringOption(o => o.setName("query").setDescription("キーワード（省略可）")),

  new SlashCommandBuilder()
    .setName("keyinfo")
    .setDescription("スクリプトのKeyシステム情報を確認します")
    .addStringOption(o => o.setName("slug").setDescription("スクリプトのslug（URLの末尾部分）").setRequired(true)),

  // ── AI・コード操作 ──────────────────────────────
  new SlashCommandBuilder()
    .setName("aichat")
    .setDescription("AIにRoblox Luaの質問をします")
    .addStringOption(o => o.setName("question").setDescription("質問内容").setRequired(true)),

  new SlashCommandBuilder()
    .setName("obfuscate")
    .setDescription("Lua/Luauコードを難読化します")
    .addStringOption(o => o.setName("code").setDescription("難読化するLuaコード").setRequired(true)),

  new SlashCommandBuilder()
    .setName("deobfuscate")
    .setDescription("難読化されたLuaコードを解読します")
    .addStringOption(o => o.setName("code").setDescription("解読するLuaコード").setRequired(true)),

  new SlashCommandBuilder()
    .setName("explain")
    .setDescription("Luaスクリプトの機能を日本語で解説します")
    .addStringOption(o => o.setName("code").setDescription("解説するLuaコード").setRequired(true)),

  new SlashCommandBuilder()
    .setName("fix")
    .setDescription("Luaスクリプトのバグを修正します")
    .addStringOption(o => o.setName("code").setDescription("修正するLuaコード").setRequired(true)),

  // ── ユーティリティ ──────────────────────────────
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Botの応答速度（Ping）を確認します"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Botのリアルタイムステータスを表示します（5秒ごとに自動更新）"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("利用可能なコマンド一覧を表示します"),
].map(c => c.toJSON());

// ─────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────

export async function registerSlashCommands(clientId: string): Promise<void> {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) return;
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commandDefinitions });
    logger.info("Slash commands registered (global)");
  } catch (err) {
    logger.error({ err }, "Slash command registration failed");
    logger.info(
      `Re-invite URL: https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot%20applications.commands`,
    );
  }
}

// ─────────────────────────────────────────────────
// Session helper
// ─────────────────────────────────────────────────

function makeSession(
  all: import("./scriptblox.js").ScriptResult[],
  filtered: import("./scriptblox.js").ScriptResult[],
  query: string,
  filters: SearchSession["filters"],
): SearchSession {
  return { allResults: all, filtered, index: 0, query, filters };
}

async function sendScriptSession(
  interaction: ChatInputCommandInteraction,
  all: import("./scriptblox.js").ScriptResult[],
  filters: SearchSession["filters"],
  emptyMsg: string,
): Promise<void> {
  const filtered = applyFilters(all, filters);
  if (filtered.length === 0) { await interaction.editReply(emptyMsg); return; }

  filtered[0] = await enrichScript(filtered[0]);
  const embed = await buildScriptEmbed(filtered[0], 0, filtered.length);
  const reply = await interaction.editReply({ embeds: [embed] });

  const session = makeSession(all, filtered, "", filters);
  searchSessions.set(reply.id, session);
  const components = filtered.length > 1
    ? [buildNavRow(reply.id, 0, filtered.length), buildFilterRow(reply.id, filters)]
    : [buildFilterRow(reply.id, filters)];
  await interaction.editReply({ embeds: [embed], components });
  setTimeout(() => searchSessions.delete(reply.id), 10 * 60 * 1000);
}

// ─────────────────────────────────────────────────
// Help embed
// ─────────────────────────────────────────────────

function buildHelpEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("📖 コマンド一覧")
    .setDescription("スラッシュコマンド一覧です。`/コマンド名` で実行してください。")
    .addFields(
      {
        name: "⚙️ 管理者設定コマンド",
        value: [
          "`/setsearch [channel]` — 検索チャンネルを設定",
          "`/setai [channel]` — AI自動応答チャンネルを設定",
          "`/setnotify [channel]` — 新着通知チャンネルを設定",
          "`/unsetnotify` — 新着通知を停止",
          "`/config` — 現在の設定を確認",
        ].join("\n"),
      },
      {
        name: "🔍 スクリプト検索コマンド",
        value: [
          "`/search [query]` — スクリプト名・ゲーム名で検索",
          "`/latest` — 最新スクリプト一覧",
          "`/hub [query]` — Script Hub専用検索",
          "`/keyinfo [slug]` — Keyシステム情報確認",
        ].join("\n"),
      },
      {
        name: "🤖 AI・コード操作コマンド",
        value: [
          "`/aichat [question]` — AIにRoblox Luaを質問",
          "`/obfuscate [code]` — Luaコードを難読化",
          "`/deobfuscate [code]` — 難読化コードを解読",
          "`/explain [code]` — スクリプトの機能を解説",
          "`/fix [code]` — バグを自動修正",
        ].join("\n"),
      },
      {
        name: "🛠️ ユーティリティコマンド",
        value: [
          "`/ping` — Botの応答速度を確認",
          "`/status` — リアルタイムステータス表示（5秒更新）",
          "`/help` — このコマンド一覧を表示",
        ].join("\n"),
      },
      {
        name: "💬 テキストコマンド（プレフィックス）",
        value: [
          "`!search_{スクリプト名}` — スクリプト検索（設定チャンネルのみ）",
        ].join("\n"),
      },
    )
    .setFooter({ text: "管理者コマンドはManageGuild権限が必要です" })
    .setTimestamp();
}

// ─────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const { commandName, guildId, channelId } = interaction;
  const cfg = guildId ? getGuildConfig(guildId) : {};

  // ── /ping ──────────────────────────────────────
  if (commandName === "ping") {
    const ping = client.ws.ping;
    const emoji = ping < 0 ? "⚙️" : ping < 100 ? "🟩" : ping < 300 ? "🟨" : "🟥";
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`${emoji} Pong!`)
          .setDescription(`WebSocket Ping: **${ping < 0 ? "計測中…" : ping + "ms"}**`)
          .setTimestamp(),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ── /help ──────────────────────────────────────
  if (commandName === "help") {
    await interaction.reply({ embeds: [buildHelpEmbed()], flags: MessageFlags.Ephemeral });
    return;
  }

  // ── /status ────────────────────────────────────
  if (commandName === "status") {
    const embed = buildStatusEmbed();
    const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
    statusTrackers.set(msg.id, { channelId, guildId });
    setTimeout(() => {
      statusTrackers.delete(msg.id);
      interaction.editReply({ embeds: [buildStatusEmbed()], components: [] }).catch(() => {});
    }, 10 * 60 * 1000);
    return;
  }

  // ── Guild-only commands ────────────────────────
  if (!guildId) {
    await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", flags: MessageFlags.Ephemeral });
    return;
  }

  // ── /config ────────────────────────────────────
  if (commandName === "config") {
    const c = getGuildConfig(guildId);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Blurple)
          .setTitle("⚙️ サーバー設定")
          .addFields(
            { name: "🔍 検索チャンネル",   value: c.searchChannelId  ? `<#${c.searchChannelId}>` : "未設定（全チャンネル有効）", inline: false },
            { name: "🤖 AIチャンネル",     value: c.aiChannelId      ? `<#${c.aiChannelId}>` : "未設定（全チャンネル有効）",     inline: false },
            { name: "🔔 通知チャンネル",   value: c.notifyChannelId  ? `<#${c.notifyChannelId}>` : "未設定（通知オフ）",          inline: false },
          )
          .setFooter({ text: "設定変更は管理者コマンドで行えます" })
          .setTimestamp(),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ── Admin commands ─────────────────────────────
  if (["setsearch", "setai", "setnotify", "unsetnotify"].includes(commandName)) {
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはManageGuild権限が必要です。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (commandName === "setsearch") {
      const ch = interaction.options.getChannel("channel", true);
      patchGuildConfig(guildId, { searchChannelId: ch.id });
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ 検索チャンネル設定済み").setDescription(`<#${ch.id}> を検索チャンネルとして設定しました。`).setTimestamp()],
      });
    } else if (commandName === "setai") {
      const ch = interaction.options.getChannel("channel", true);
      patchGuildConfig(guildId, { aiChannelId: ch.id });
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ AIチャンネル設定済み").setDescription(`<#${ch.id}> をAI自動応答チャンネルとして設定しました。`).setTimestamp()],
      });
    } else if (commandName === "setnotify") {
      const ch = interaction.options.getChannel("channel", true);
      patchGuildConfig(guildId, { notifyChannelId: ch.id });
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ 通知チャンネル設定済み").setDescription(`<#${ch.id}> への新着スクリプト通知を開始しました。`).setTimestamp()],
      });
    } else {
      patchGuildConfig(guildId, { notifyChannelId: undefined });
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("🔕 通知停止").setDescription("新着スクリプト通知を停止しました。").setTimestamp()],
      });
    }
    return;
  }

  // ── Search channel guard (if set) ─────────────
  const searchRestricted = !!cfg.searchChannelId && channelId !== cfg.searchChannelId;
  const aiRestricted     = !!cfg.aiChannelId     && channelId !== cfg.aiChannelId;

  // ── /search ────────────────────────────────────
  if (commandName === "search") {
    if (searchRestricted) {
      await interaction.reply({ content: `検索コマンドは <#${cfg.searchChannelId}> でのみ使用できます。`, flags: MessageFlags.Ephemeral });
      return;
    }
    const query = interaction.options.getString("query", true);
    const filters: SearchSession["filters"] = {
      verified:  interaction.options.getBoolean("verified") ?? false,
      keySystem: interaction.options.getBoolean("key")      ?? false,
      universal: interaction.options.getBoolean("universal") ?? false,
      hub:       interaction.options.getBoolean("hub")      ?? false,
    };
    await interaction.deferReply();
    const all = await searchScript(query, 20);
    if (all.length === 0) { await interaction.editReply(`"${query}" に関するスクリプトが見つかりませんでした。`); return; }
    await sendScriptSession(interaction, all, filters, "フィルター条件に一致するスクリプトが見つかりませんでした。");
    return;
  }

  // ── /latest ────────────────────────────────────
  if (commandName === "latest") {
    if (searchRestricted) {
      await interaction.reply({ content: `このコマンドは <#${cfg.searchChannelId}> でのみ使用できます。`, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();
    const scripts = await fetchLatestScripts(1);
    if (scripts.length === 0) { await interaction.editReply("最新スクリプトの取得に失敗しました。"); return; }
    const noFilter: SearchSession["filters"] = { verified: false, keySystem: false, universal: false, hub: false };
    await sendScriptSession(interaction, scripts, noFilter, "スクリプトが見つかりませんでした。");
    return;
  }

  // ── /hub ───────────────────────────────────────
  if (commandName === "hub") {
    if (searchRestricted) {
      await interaction.reply({ content: `このコマンドは <#${cfg.searchChannelId}> でのみ使用できます。`, flags: MessageFlags.Ephemeral });
      return;
    }
    const query = interaction.options.getString("query") ?? "script hub";
    await interaction.deferReply();
    const all = await searchScript(query, 20);
    const hubOnly = all.filter(s => s.isHub);
    if (hubOnly.length === 0) { await interaction.editReply("Script Hubが見つかりませんでした。"); return; }
    const hubFilter: SearchSession["filters"] = { verified: false, keySystem: false, universal: false, hub: true };
    await sendScriptSession(interaction, hubOnly, hubFilter, "Script Hubが見つかりませんでした。");
    return;
  }

  // ── /keyinfo ───────────────────────────────────
  if (commandName === "keyinfo") {
    await interaction.deferReply();
    const slug = interaction.options.getString("slug", true);
    const detail = await fetchScriptDetail(slug);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(detail.keyLink ? Colors.Yellow : Colors.Green)
          .setTitle(detail.keyLink ? "🔑 Keyシステム あり" : "✅ Keyシステム なし")
          .addFields(
            { name: "作者",          value: detail.creator ?? "不明", inline: true },
            { name: "Keyシステム",   value: detail.keyLink ? "あり" : "なし", inline: true },
            ...(detail.keyLink ? [{ name: "Key取得リンク", value: detail.keyLink }] : []),
          )
          .setTimestamp(),
      ],
    });
    return;
  }

  // ── AI / code commands ─────────────────────────
  if (["aichat", "obfuscate", "deobfuscate", "explain", "fix"].includes(commandName)) {
    if (commandName === "aichat" && aiRestricted) {
      await interaction.reply({ content: `AIコマンドは <#${cfg.aiChannelId}> でのみ使用できます。`, flags: MessageFlags.Ephemeral });
      return;
    }
    const input = interaction.options.getString(commandName === "aichat" ? "question" : "code", true);
    await interaction.deferReply();
    let result: string;
    let title: string;
    let color: number;
    switch (commandName) {
      case "aichat":      result = await getAIResponse(input, []);  title = "💬 AI回答";          color = Colors.Blurple; break;
      case "obfuscate":   result = await obfuscateLua(input);       title = "🔒 難読化結果";       color = Colors.Orange;  break;
      case "deobfuscate": result = await deobfuscateLua(input);     title = "🔓 解読結果";         color = Colors.Purple;  break;
      case "explain":     result = await explainLua(input);         title = "📖 スクリプト解説";   color = Colors.Blue;    break;
      default:            result = await fixLua(input);             title = "🔧 バグ修正結果";     color = Colors.Green;   break;
    }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setTitle(title)
          .setDescription(result.slice(0, 4096))
          .setTimestamp(),
      ],
    });
    return;
  }
}
