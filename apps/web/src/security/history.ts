import {
  loadTrustState,
  saveTrustState,
  type LocalHistoryItem,
  type SecureProfile,
} from "./vault";

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
  return state.history?.[normalizedUsername(username)] ?? [];
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
    history.push(item);
    history.sort((a, b) => a.createdAt - b.createdAt);
    state.history[key] = history;
    await saveTrustState(profile, state);
  }
}
