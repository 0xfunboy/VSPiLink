export const CHATGPT_DESTINATIONS = ["security", "plugins", "chat"] as const;
export type ChatGptDestination = (typeof CHATGPT_DESTINATIONS)[number];

export const CHATGPT_LINKS: Readonly<Record<ChatGptDestination, string>> = Object.freeze({
  security: "https://chatgpt.com/#settings/Security",
  plugins: "https://chatgpt.com/plugins",
  chat: "https://chatgpt.com/?surface=chat",
});

export interface ChatGptNavigation {
  url: string;
  reuseUrlFilter?: string;
}

const ALLOWED_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com"]);

export function chatGptUrl(destination: ChatGptDestination): string {
  const value = CHATGPT_LINKS[destination];
  if (!isAllowedChatGptUrl(value)) throw new Error("This ChatGPT destination is not allowed.");
  return value;
}

/**
 * Normal Chat gets its own integrated-browser editor. Setup pages can safely
 * share their existing ChatGPT browser editor.
 */
export function chatGptNavigation(destination: ChatGptDestination): ChatGptNavigation {
  const url = chatGptUrl(destination);
  return destination === "chat"
    ? { url }
    : { url, reuseUrlFilter: "https://chatgpt.com/**" };
}

export function isAllowedChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
