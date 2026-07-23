const STORAGE_PREFIX = "covechat:conversation-preferences:v1:";

type ConversationPreferences = {
  muted: string[];
};

function storageKey(username: string): string {
  return `${STORAGE_PREFIX}${username.trim().toLowerCase()}`;
}

function readPreferences(username: string): ConversationPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(username)) ?? "{}") as Partial<ConversationPreferences>;
    return { muted: Array.isArray(parsed.muted) ? parsed.muted.filter((item): item is string => typeof item === "string") : [] };
  } catch {
    return { muted: [] };
  }
}

export function isConversationMuted(username: string, recipient: string): boolean {
  return readPreferences(username).muted.includes(recipient.trim().toLowerCase());
}

export function setConversationMuted(username: string, recipient: string, muted: boolean): void {
  const normalized = recipient.trim().toLowerCase();
  if (!normalized) return;
  const preferences = readPreferences(username);
  const next = new Set(preferences.muted);
  if (muted) next.add(normalized);
  else next.delete(normalized);
  localStorage.setItem(storageKey(username), JSON.stringify({ muted: [...next].sort() } satisfies ConversationPreferences));
}
