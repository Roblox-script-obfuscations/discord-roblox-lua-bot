import axios from "axios";
import { logger } from "../lib/logger.js";

const GITHUB_API = "https://api.github.com";
const REPO_NAME = "discord-roblox-lua-bot";
const OWNER_LOGIN_CACHE: { login: string | null } = { login: null };

async function getOwner(): Promise<string> {
  if (OWNER_LOGIN_CACHE.login) return OWNER_LOGIN_CACHE.login;
  const token = process.env["GITHUB_TOKEN"];
  const res = await axios.get(`${GITHUB_API}/user`, {
    headers: { Authorization: `token ${token}`, "User-Agent": "discord-bot" },
  });
  OWNER_LOGIN_CACHE.login = res.data.login as string;
  return OWNER_LOGIN_CACHE.login!;
}

export async function createGitHubRepo(): Promise<string | null> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) return null;

  try {
    const owner = await getOwner();

    try {
      const check = await axios.get(`${GITHUB_API}/repos/${owner}/${REPO_NAME}`, {
        headers: { Authorization: `token ${token}`, "User-Agent": "discord-bot" },
      });
      logger.info({ url: check.data.html_url }, "GitHub repo already exists");
      return check.data.html_url as string;
    } catch {
      // repo doesn't exist yet, create it
    }

    const res = await axios.post(
      `${GITHUB_API}/user/repos`,
      {
        name: REPO_NAME,
        description: "Discord bot for Roblox Lua script search and AI assistance",
        private: false,
        auto_init: true,
      },
      {
        headers: { Authorization: `token ${token}`, "User-Agent": "discord-bot" },
      },
    );
    logger.info({ url: res.data.html_url }, "GitHub repo created");
    return res.data.html_url as string;
  } catch (err) {
    logger.error({ err }, "Failed to create GitHub repo");
    return null;
  }
}

export async function pushFileToGitHub(
  path: string,
  content: string,
  message: string,
): Promise<void> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) return;

  try {
    const owner = await getOwner();
    const encoded = Buffer.from(content, "utf-8").toString("base64");

    let sha: string | undefined;
    try {
      const existing = await axios.get(
        `${GITHUB_API}/repos/${owner}/${REPO_NAME}/contents/${path}`,
        { headers: { Authorization: `token ${token}`, "User-Agent": "discord-bot" } },
      );
      sha = (existing.data as { sha: string }).sha;
    } catch {
      // file doesn't exist yet
    }

    await axios.put(
      `${GITHUB_API}/repos/${owner}/${REPO_NAME}/contents/${path}`,
      { message, content: encoded, ...(sha ? { sha } : {}) },
      { headers: { Authorization: `token ${token}`, "User-Agent": "discord-bot" } },
    );
  } catch (err) {
    logger.error({ err, path }, "Failed to push file to GitHub");
  }
}
