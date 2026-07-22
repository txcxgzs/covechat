export type Conversation = {
  id: string;
  name: string;
  initials: string;
  preview: string;
  time: string;
  group?: boolean;
  unread?: number;
};

export type Message = {
  id: string;
  from: "me" | "them";
  text: string;
  time: string;
  delivered?: boolean;
  expiresAt?: number;
  replyTo?: import("./security/message-content").ReplyReference;
};
