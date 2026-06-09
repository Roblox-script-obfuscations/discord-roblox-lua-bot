import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "../lib/logger.js";

function parseKeys(env: string | undefined): string[] {
  return (env ?? "").split(",").map(k => k.trim()).filter(k => k.length > 0);
}

const groqKeys   = parseKeys(process.env["GROQ_API_KEY"]);
const geminiKeys = parseKeys(process.env["GEMINI_API_KEY"]);

// ─── Groq: try each key, fallback on rate-limit ────────────────────────────

async function callGroqWithKeys(
  system: string,
  messages: Groq.Chat.Completions.ChatCompletionMessageParam[],
  maxTokens = 2048,
): Promise<string> {
  let lastErr: unknown;
  for (const key of groqKeys) {
    try {
      const groq = new Groq({ apiKey: key });
      const res = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: system
          ? [{ role: "system", content: system }, ...messages]
          : messages,
        max_tokens: maxTokens,
        temperature: 0.7,
      });
      return res.choices[0]?.message?.content ?? "応答を生成できませんでした。";
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 429 || status === 503) {
        logger.warn({ keyIndex: groqKeys.indexOf(key), status }, "Groq key rate-limited");
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("Groq keys exhausted");
}

// ─── Gemini: try each key, fallback on rate-limit ─────────────────────────

async function callGeminiWithKeys(
  system: string,
  userText: string,
  history: { role: "user" | "model"; parts: { text: string }[] }[] = [],
): Promise<string> {
  let lastErr: unknown;
  for (const key of geminiKeys) {
    try {
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const chat = model.startChat({
        history: [
          { role: "user", parts: [{ text: system }] },
          { role: "model", parts: [{ text: "了解しました。" }] },
          ...history,
        ],
      });
      const result = await chat.sendMessage(userText);
      return result.response.text() ?? "応答を生成できませんでした。";
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 429 || status === 503) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("Gemini keys exhausted");
}

// ─── Unified fallback ──────────────────────────────────────────────────────

async function callAI(
  system: string,
  messages: Groq.Chat.Completions.ChatCompletionMessageParam[],
  maxTokens = 2048,
): Promise<string> {
  try {
    return await callGroqWithKeys(system, messages, maxTokens);
  } catch {
    try {
      const userText = messages.map(m => m.content as string).join("\n");
      return await callGeminiWithKeys(system, userText);
    } catch {
      return "AIサービスに接続できませんでした。しばらくしてから再試行してください。";
    }
  }
}

// ─── System prompts ────────────────────────────────────────────────────────

const CHAT_SYSTEM = `あなたはRoblox Luaスクリプトの専門AIアシスタントです。
- Roblox Luaスクリプトの説明・解説
- スクリプトの難読化（obfuscation）と解読（reverse engineering）
- バグ修正・改善提案
- Roblox APIやサービスに関する質問への回答
常に日本語で回答してください。`;

// ─── Public API ────────────────────────────────────────────────────────────

export async function getAIResponse(
  question: string,
  history: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const messages: Groq.Chat.Completions.ChatCompletionMessageParam[] = [
    ...history.map(h => ({ role: h.role as "user" | "assistant", content: h.content })),
    { role: "user", content: question },
  ];
  return callAI(CHAT_SYSTEM, messages);
}

export async function obfuscateLua(code: string): Promise<string> {
  return callAI(
    "あなたはLuaコード難読化の専門家です。変数名をランダムな文字列に変換し、文字列をエンコードし、制御フローを複雑にして難読化してください。難読化後のコードのみを出力してください。",
    [{ role: "user", content: code }],
    4096,
  );
}

export async function deobfuscateLua(code: string): Promise<string> {
  return callAI(
    "あなたはLuaコード解読の専門家です。難読化されたLuaコードを読みやすい形に変換してください。解読後のコードと説明を日本語で出力してください。",
    [{ role: "user", content: code }],
    4096,
  );
}

export async function explainLua(code: string): Promise<string> {
  return callAI(
    "あなたはRoblox Lua解説の専門家です。提供されたLuaスクリプトの機能・仕組みを詳しく日本語で解説してください。",
    [{ role: "user", content: code }],
    2048,
  );
}

export async function fixLua(code: string): Promise<string> {
  return callAI(
    "あなたはRoblox Luaデバッグの専門家です。提供されたLuaスクリプトのバグを特定して修正し、修正後のコードと変更点の説明を日本語で出力してください。",
    [{ role: "user", content: code }],
    4096,
  );
}
