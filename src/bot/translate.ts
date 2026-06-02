import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env["GROQ_API_KEY"] });

export async function translateToJapanese(text: string): Promise<string> {
  if (!text || text.trim() === "") return "";

  const isAlreadyJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(text);
  if (isAlreadyJapanese) return text;

  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are a translator. Translate the given text to Japanese. Output only the translated text with no explanation or extra formatting.",
        },
        { role: "user", content: text },
      ],
      max_tokens: 512,
      temperature: 0.2,
    });
    return res.choices[0]?.message?.content?.trim() ?? text;
  } catch {
    return text;
  }
}
