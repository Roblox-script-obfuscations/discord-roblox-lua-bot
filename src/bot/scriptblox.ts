import axios from "axios";

export interface ScriptResult {
  title: string;
  game: string;
  gamePlaceId: string | null;
  description: string;
  script: string;
  keySystem: boolean;
  keyLink: string | null;
  views: number;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
  slug: string;
  imageUrl: string | null;
  creator: string;
  scriptId: string;
}

function parseScript(s: Record<string, unknown>): ScriptResult {
  const game = s.game as Record<string, unknown> | null;
  const owner = s.owner as Record<string, unknown> | null;
  return {
    title: (s.title as string) || "No title",
    game: (game?.name as string) || (game?.title as string) || "Unknown",
    gamePlaceId: (game?.placeId as string) ?? null,
    description: (s.description as string) ?? "",
    script: (s.script as string) ?? "",
    keySystem: !!(s.isKeySystem),
    keyLink: (s.keyLink as string) || null,
    views: (s.views as number) ?? 0,
    verified: !!(s.verified),
    createdAt: (s.createdAt as string) ?? "",
    updatedAt: (s.updatedAt as string) ?? "",
    slug: (s.slug as string) ?? "",
    imageUrl: game?.imageUrl
      ? `https://scriptblox.com${game.imageUrl as string}`
      : null,
    creator: (owner?.username as string) || (owner?.name as string) || "Anonymous",
    scriptId: (s._id as string) ?? (s.id as string) ?? "",
  };
}

export async function searchScript(query: string, max = 20): Promise<ScriptResult[]> {
  const url = `https://scriptblox.com/api/script/search?q=${encodeURIComponent(query)}&max=${max}&mode=free`;
  const res = await axios.get(url, { timeout: 10000 });
  const scripts: Record<string, unknown>[] = res.data?.result?.scripts ?? [];
  return scripts.map(parseScript);
}

export async function fetchLatestScripts(page = 1): Promise<ScriptResult[]> {
  const url = `https://scriptblox.com/api/script/fetch?page=${page}&max=10`;
  const res = await axios.get(url, { timeout: 10000 });
  const scripts: Record<string, unknown>[] = res.data?.result?.scripts ?? [];
  return scripts.map(parseScript);
}
