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

import type { Locale } from "./i18n";

export function getConversations(locale: Locale): Conversation[] {
  const zh = locale === "zh-CN";
  return [
    { id: "maya", name: "Maya Chen", initials: "MC", preview: zh ? "好的，到时见。" : "Sounds good. See you then.", time: "10:24", unread: 0 },
    { id: "jonas", name: "Jonas Weber", initials: "JW", preview: zh ? "谢谢你的更新。" : "Thanks for the update.", time: zh ? "昨天" : "Yesterday", unread: 2 },
    { id: "sofia", name: "Sofia Lopez", initials: "SL", preview: zh ? "可以把文件发给我吗？" : "Can you send the file?", time: zh ? "昨天" : "Yesterday" },
    { id: "team", name: zh ? "运营团队" : "Team Ops", initials: "TO", preview: zh ? "Maya：文档已上传" : "Maya: Document uploaded", time: zh ? "周二" : "Tue", group: true },
    { id: "ravi", name: "Ravi Patel", initials: "RP", preview: zh ? "我们明天同步一下。" : "Let's sync tomorrow.", time: zh ? "周一" : "Mon" },
    { id: "design", name: zh ? "设计同步" : "Design Sync", initials: "DS", preview: zh ? "你：大家做得很棒" : "You: Great work everyone", time: zh ? "周一" : "Mon", group: true },
  ];
}

export function getSeedMessages(locale: Locale): Message[] {
  const zh = locale === "zh-CN";
  return [
    { id: "1", from: "them", text: zh ? "嗨 Alex，我想确认一下你分享的那份文档。" : "Hi Alex, just checking in about the document you shared.", time: "10:15" },
    { id: "2", from: "me", text: zh ? "嗨 Maya，整体看起来很好，我在文档里留了几条意见。" : "Hey Maya, everything looks good. I left a few comments inline.", time: "10:16", delivered: true },
    { id: "3", from: "them", text: zh ? "太好了，谢谢！我看完后尽快回复你。" : "Great, thanks! I’ll review and get back to you shortly.", time: "10:18" },
    { id: "4", from: "me", text: zh ? "好的，如果还需要什么就告诉我。" : "Sounds good. Let me know if you need anything else.", time: "10:20", delivered: true },
    { id: "5", from: "them", text: zh ? "没问题。另外，我们明天上午 10 点的通话照常吗？" : "Will do. Also, are we still on for our call tomorrow at 10am?", time: "10:22" },
    { id: "6", from: "me", text: zh ? "可以，这个时间没问题。" : "Yes, works for me.", time: "10:23", delivered: true },
    { id: "7", from: "them", text: zh ? "好的，到时见。" : "Sounds good. See you then.", time: "10:24" },
  ];
}
