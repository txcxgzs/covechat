import {
  loadTrustState,
  saveTrustState,
  type LocalHistoryItem,
  type SecureProfile,
} from "./vault";

export const MAX_HISTORY_ITEMS_PER_CONVERSATION = 1_000;

export function compactConversationHistory(
  history: LocalHistoryItem[],
  now = Date.now(),
): LocalHistoryItem[] {
  return history
    .filter((item) => !item.expiresAt || item.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_HISTORY_ITEMS_PER_CONVERSATION);
}

function normalizedUsername(username: string): string {
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/u.test(normalized)) throw new Error("invalid history username");
  return normalized;
}

export async function loadConversationHistory(
  profile: SecureProfile,
  username: string,
): Promise<LocalHistoryItem[]> {
  const state = await loadTrustState(profile);
  const key = normalizedUsername(username);
  const history = state.history?.[key] ?? [];
  const now = Date.now();
  const active = compactConversationHistory(history, now);
  if (active.length !== history.length && state.history) {
    state.history[key] = active;
    await saveTrustState(profile, state);
  }
  return active;
}

export async function appendConversationHistory(
  profile: SecureProfile,
  username: string,
  item: LocalHistoryItem,
): Promise<void> {
  const state = await loadTrustState(profile);
  state.history ??= {};
  const key = normalizedUsername(username);
  const history = state.history[key] ?? [];
  if (!history.some((existing) => existing.id === item.id)) {
    if (!item.expiresAt || item.expiresAt > Date.now()) history.push(item);
    state.history[key] = compactConversationHistory(history);
    await saveTrustState(profile, state);
  }
}

export async function removeConversationHistoryItems(
  profile: SecureProfile,
  username: string,
  messageIds: Iterable<string>,
): Promise<void> {
  const ids = new Set(messageIds);
  if (ids.size === 0) return;
  const state = await loadTrustState(profile);
  const key = normalizedUsername(username);
  const history = state.history?.[key];
  if (!history) return;
  const next = history.filter((item) => !ids.has(item.id));
  if (next.length === history.length) return;
  state.history![key] = next;
  await saveTrustState(profile, state);
}

export async function listConversationHistories(
  profile: SecureProfile,
): Promise<Array<{ username: string; latest?: LocalHistoryItem }>> {
  const state = await loadTrustState(profile);
  return Object.entries(state.history ?? {})
    .map(([username, items]) => ({
      username,
      latest: items.filter((item) => !item.expiresAt || item.expiresAt > Date.now()).at(-1),
    }))
    .filter((conversation) => conversation.latest)
    .sort((a, b) => (b.latest?.createdAt ?? 0) - (a.latest?.createdAt ?? 0));
}
