import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const groq = new Groq({ apiKey: process.env["GROQ_API_KEY"] });
const genAI = new GoogleGenerativeAI(process.env["GEMINI_API_KEY"] ?? "");

const SYSTEM_PROMPT = `あなたはRoblox Luaスクリプトの専門AIアシスタントです。
以下の機能を持っています:
- Roblox Luaスクリプトの説明・解説
- スクリプトの難読化（obfuscation）
- 難読化されたスクリプトのリバースエンジニアリング（解読）
- スクリプトのバグ修正・改善提案
- Roblox APIやサービスに関する質問への回答

難読化を要求された場合は、変数名をランダムな文字列に変換し、文字列をエンコードし、制御フローを複雑にしてください。
リバースエンジニアリングを要求された場合は、難読化されたコードを読みやすい形に変換してください。

常に日本語で回答してください。`;

export async function askGroq(userMessage: string, history: { role: "user" | "assistant"; content: string }[]): Promise<string> {
  const messages: Groq.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages,
    max_tokens: 2048,
    temperature: 0.7,
  });

  return response.choices[0]?.message?.content ?? "応答を生成できませんでした。";
}

export async function askGemini(userMessage: string, history: { role: "user" | "assistant"; content: string }[]): Promise<string> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const chat = model.startChat({
    history: [
      { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
      { role: "model", parts: [{ text: "了解しました。Roblox Luaスクリプトの専門AIとして対応します。" }] },
      ...history.map(h => ({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.content }],
      })),
    ],
  });

  const result = await chat.sendMessage(userMessage);
  return result.response.text() ?? "応答を生成できませんでした。";
}

export async function getAIResponse(
  userMessage: string,
  history: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  try {
    return await askGroq(userMessage, history);
  } catch {
    try {
      return await askGemini(userMessage, history);
    } catch (err2) {
      console.error("Both AI APIs failed:", err2);
      return "AIサービスに接続できませんでした。しばらくしてから再試行してください。";
    }
  }
}
