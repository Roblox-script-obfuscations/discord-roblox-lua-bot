import axios from "axios";

export interface ScriptResult {
  title: string;
  game: string;
  description: string;
  script: string;
  keySystem: boolean;
  keyLink: string | null;
  views: number;
  verified: boolean;
  createdAt: string;
  slug: string;
  imageUrl: string | null;
  creator: string;
}

export async function searchScript(query: string): Promise<ScriptResult[]> {
  const url = `https://scriptblox.com/api/script/search?q=${encodeURIComponent(query)}&max=5&mode=free`;
  const res = await axios.get(url, { timeout: 10000 });
  const scripts = res.data?.result?.scripts ?? [];

  return scripts.map((s: Record<string, unknown>) => {
    const game = s.game as Record<string, unknown> | null;
    return {
      title: (s.title as string) ?? "No title",
      game: (game?.name as string) ?? "Unknown Game",
      description: (s.description as string) ?? "",
      script: (s.script as string) ?? "",
      keySystem: !!(s.isKeySystem),
      keyLink: (s.keyLink as string) ?? null,
      views: (s.views as number) ?? 0,
      verified: !!(s.verified),
      createdAt: (s.createdAt as string) ?? "",
      slug: (s.slug as string) ?? "",
      imageUrl: game?.imageUrl
        ? `https://scriptblox.com${game.imageUrl as string}`
        : null,
      creator: (s.owner as Record<string, unknown>)?.username as string ?? "unknown",
    };
  });
}
