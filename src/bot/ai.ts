import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const groq = new Groq({ apiKey: process.env["GROQ_API_KEY"] });
const genAI = new GoogleGenerativeAI(process.env["GEMINI_API_KEY"] ?? "");

const CHAT_SYSTEM = `あなたはRoblox Luaスクリプトの専門AIアシスタントです。
- Roblox Luaスクリプトの説明・解説
- スクリプトの難読化（obfuscation）
- 難読化されたスクリプトのリバースエンジニアリング（解読）
- スクリプトのバグ修正・改善提案
- Roblox APIやサービスに関する質問への回答
難読化を要求された場合は変数名をランダムな文字列に変換し文字列をエンコードし制御フローを複雑にしてください。
リバースエンジニアリングを要求された場合は難読化されたコードを読みやすい形に変換してください。
常に日本語で回答してください。`;

async function callGroq(system: string, user: string, maxTokens = 2048): Promise<string> {
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: maxTokens,
    temperature: 0.7,
  });
  return res.choices[0]?.message?.content ?? "応答を生成できませんでした。";
}

async function callGemini(system: string, user: string): Promise<string> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const chat = model.startChat({
    history: [
      { role: "user", parts: [{ text: system }] },
      { role: "model", parts: [{ text: "了解しました。" }] },
    ],
  });
  const result = await chat.sendMessage(user);
  return result.response.text() ?? "応答を生成できませんでした。";
}

async function callAI(system: string, user: string, maxTokens = 2048): Promise<string> {
  try {
    return await callGroq(system, user, maxTokens);
  } catch {
    try {
      return await callGemini(system, user);
    } catch {
      return "AIサービスに接続できませんでした。しばらくしてから再試行してください。";
    }
  }
}

export async function getAIResponse(
  userMessage: string,
  history: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  try {
    const messages: Groq.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: CHAT_SYSTEM },
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: userMessage },
    ];
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: 2048,
      temperature: 0.7,
    });
    return res.choices[0]?.message?.content ?? "応答を生成できませんでした。";
  } catch {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const chat = model.startChat({
        history: [
          { role: "user", parts: [{ text: CHAT_SYSTEM }] },
          { role: "model", parts: [{ text: "了解しました。" }] },
          ...history.map(h => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] })),
        ],
      });
      const r = await chat.sendMessage(userMessage);
      return r.response.text() ?? "応答を生成できませんでした。";
    } catch {
      return "AIサービスに接続できませんでした。しばらくしてから再試行してください。";
    }
  }
}

export async function obfuscateLua(code: string): Promise<string> {
  return callAI(
    "あなたはRoblox Luaスクリプトの難読化専門家です。与えられたLuaコードを難読化してください。変数名をランダムな文字列に変換し、文字列をエンコードし、制御フローを複雑にしてください。難読化されたコードのみを出力してください。説明は不要です。",
    code,
    4096,
  );
}

export async function deobfuscateLua(code: string): Promise<string> {
  return callAI(
    "あなたはRoblox Luaスクリプトのリバースエンジニアリング専門家です。与えられた難読化されたLuaコードを読みやすい形式に変換してください。変数名を意味のある名前に変換し、コードの構造を明確にしてください。解読されたコードと簡単な説明を日本語で出力してください。",
    code,
    4096,
  );
}

export async function explainLua(code: string): Promise<string> {
  return callAI(
    "あなたはRoblox Luaスクリプトの解説専門家です。与えられたLuaスクリプトの機能・仕組みを日本語でわかりやすく解説してください。主要な機能、使用しているRoblox API、潜在的なリスクがあれば指摘してください。",
    code,
    2048,
  );
}

export async function fixLua(code: string): Promise<string> {
  return callAI(
    "あなたはRoblox Luaスクリプトのデバッグ専門家です。与えられたLuaコードのバグを特定し修正してください。修正後のコードと変更点の説明を日本語で出力してください。",
    code,
    4096,
  );
}
