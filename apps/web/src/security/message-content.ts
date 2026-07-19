export type ReplyReference = {
  messageId: string;
  excerpt: string;
};

export function createReplyReference(messageId: string, text: string): ReplyReference {
  return {
    messageId,
    excerpt: text.replace(/\s+/gu, " ").trim().slice(0, 160),
  };
}

export function isReplyReference(value: unknown): value is ReplyReference {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReplyReference>;
  return typeof candidate.messageId === "string"
    && candidate.messageId.length > 0
    && candidate.messageId.length <= 128
    && typeof candidate.excerpt === "string"
    && candidate.excerpt.length <= 160;
}
