import { FormEvent, type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BellOff, Check, CheckCheck, CheckCircle2, CircleHelp, Copy as CopyIcon, FileText, FileWarning, FlaskConical, Image,
  LockKeyhole, Menu, MessageCircle, Palette, Paperclip, Plus, Search, Send,
  Languages, Reply, Settings, ShieldCheck, Smile, Sparkles, Trash2, UserRound, UsersRound, Volume2, VolumeX, X
} from "lucide-react";
import type { Conversation, Message } from "./data";
import { copy, detectLocale, type Locale, type Translate } from "./i18n";
import { PWA_APPLY_UPDATE_EVENT, PWA_UPDATE_READY_EVENT } from "./pwa-updates";
import { SecurityGate } from "./security/SecurityGate";
import { DeploymentGate } from "./deployment/DeploymentGate";
import { type SecureProfile } from "./security/vault";
import { deleteLocalVault, saveSecureProfile, unlockSecureProfile } from "./security/vault";
import type { AttachmentReference, AuthSession, DeviceRecord } from "@covechat/protocol";
import {
  listBlockedUsers,
  deleteOwnAccount,
  listOwnDevices,
  lookupDirectory,
  revokeOwnDevice,
  setUserBlocked,
  submitAbuseReport,
} from "./security/api";
import { identityVerification, markIdentityVerified } from "./security/trust";
import {
  appendConversationHistory,
  listConversationHistories,
  loadConversationHistory,
  removeConversationHistoryItems,
} from "./security/history";
import { syncEncryptedBackup } from "./security/backup";
import {
  downloadAndDecryptAttachment,
  encryptAndUploadAttachment,
  MAX_ATTACHMENT_SIZE,
} from "./security/attachments";
import {
  addGroupMember,
  createEncryptedGroup,
  isGroupAdmin,
  listEncryptedGroups,
  receiveEncryptedGroupMessages,
  removeGroupMember,
  requestEncryptedGroupLeave,
  sendEncryptedGroupText,
  setGroupInvitePolicy,
  transferEncryptedGroupAdministration,
} from "./security/groups";
import {
  receiveEncryptedTexts,
  sendEncryptedAttachment,
  sendEncryptedText,
  subscribeEncryptedMailbox,
} from "./security/signal";
import { playUiSound, setUiSoundsEnabled, uiSoundsEnabled } from "./ui-feedback";
import { createReplyReference, type ReplyReference } from "./security/message-content";
import { installUiRipple } from "./ui-ripple";
import { Button, IconButton } from "./ui-controls";

/// 将字节数格式化为人类可读的 KB/MB 字符串。
/// 用于附件上传进度显示。1024 进制，保留 1 位小数（< 1KB 时显示整数）。
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type AppView = "messages" | "groups" | "settings" | "profile";
type WallpaperStyle = "cove" | "plain" | "midnight";
const NOOP_SELECT_MESSAGE = () => undefined;

function withViewTransition(update: () => void) {
  const transitionDocument = document as Document & {
    startViewTransition?: (callback: () => void) => { finished: Promise<void> };
  };
  if (transitionDocument.startViewTransition && !document.querySelector(".motion-disabled")) {
    transitionDocument.startViewTransition(update);
  } else {
    update();
  }
}

function Navigation({ locale, t, onLocaleChange, profileName, activeView, onViewChange, soundEnabled, onSoundToggle }: {
  locale: Locale;
  t: Translate;
  onLocaleChange: () => void;
  profileName?: string;
  activeView: AppView;
  onViewChange: (view: AppView) => void;
  soundEnabled: boolean;
  onSoundToggle: () => void;
}) {
  const nav = [
    { id: "messages" as const, label: t("messages"), icon: MessageCircle },
    { id: "groups" as const, label: t("groups"), icon: UsersRound },
    { id: "settings" as const, label: t("settings"), icon: Settings },
  ];
  return (
    <nav className="navigation" aria-label="Primary">
      <div className="brand"><ShieldCheck aria-hidden="true" /><span>CoveChat</span></div>
      <div className="nav-items">
        {nav.map(({ id, label, icon: Icon }) => (
          <button
            className={activeView === id ? "nav-item active" : "nav-item"}
            key={id}
            title={label}
            onClick={() => { playUiSound("navigate"); onViewChange(id); }}
          >
            <Icon aria-hidden="true" /><span>{label}</span>
          </button>
        ))}
      </div>
      <button className="nav-item sound-toggle" onClick={onSoundToggle} aria-label={soundEnabled ? "关闭界面音效" : "开启界面音效"} title={soundEnabled ? "关闭界面音效" : "开启界面音效"}>
        {soundEnabled ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}<span>{soundEnabled ? "音效开启" : "音效关闭"}</span>
      </button>
      <button className="nav-item language" onClick={onLocaleChange} aria-label={t("switchLanguage")}>
        <Languages aria-hidden="true" /><span>{locale === "zh-CN" ? "English" : "中文"}</span>
      </button>
      <button className={activeView === "profile" ? "profile active" : "profile"} aria-label={t("openProfile")} onClick={() => onViewChange("profile")}>
        <span className="avatar avatar-small">AK</span>
        <span>{profileName ?? t("alexKim")}</span>
        <span className="presence" />
      </button>
    </nav>
  );
}

function ConversationList({ historyRevision, locale, onSelect, profile, recipient, t }: {
  historyRevision: number;
  locale: Locale;
  onSelect: (username: string) => void;
  profile: SecureProfile;
  recipient: string;
  t: Translate;
}) {
  const [query, setQuery] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  useEffect(() => {
    void listConversationHistories(profile).then((items) => setConversations(items.map(({ username, latest }) => ({
      id: username,
      name: username,
      initials: username.slice(0, 2).toUpperCase(),
      preview: latest?.body ?? (latest?.attachment ? `🔒 ${latest.attachment.fileName}` : ""),
      time: latest ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(latest.createdAt)) : "",
    }))));
  }, [historyRevision, locale, profile, recipient]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? conversations.filter((item) => `${item.name} ${item.preview}`.toLowerCase().includes(normalized))
      : conversations;
  }, [conversations, query]);

  return (
    <aside className="conversations">
      <div className="section-heading">
        <h1>{t("messages")}</h1>
        <IconButton aria-label={t("newConversation")} onClick={() => onSelect("")}><Plus /></IconButton>
      </div>
      <label className="search">
        <Search aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchConversations")} />
      </label>
      <div className="conversation-scroll">
        {filtered.map((item) => (
          <button className={item.id === recipient ? "conversation selected" : "conversation"} key={item.id} onClick={() => onSelect(item.id)}>
            <span className="avatar">{item.initials}</span>
            <span className="conversation-copy">
              <span className="conversation-line"><strong>{item.name}</strong><time>{item.time}</time></span>
              <span className="conversation-line preview"><span>{item.preview}</span>{item.unread ? <b>{item.unread}</b> : <LockKeyhole />}</span>
            </span>
          </button>
        ))}
        {filtered.length === 0 ? <p className="empty">{t("noConversations")}</p> : null}
      </div>
    </aside>
  );
}

function ChatHeader({ onDetails, onMenu, recipient, onRecipientChange, t }: {
  onDetails: () => void;
  onMenu: () => void;
  recipient: string;
  onRecipientChange: (value: string) => void;
  t: Translate;
}) {
  return (
    <header className="chat-header">
      <IconButton className="mobile-menu" aria-label={t("openNavigation")} onClick={onMenu}><Menu /></IconButton>
      <span className="avatar">{recipient.slice(0, 2).toUpperCase() || "@"}</span>
      <div className="chat-title">
        <input
          aria-label={t("username")}
          placeholder={t("username")}
          value={recipient}
          onChange={(event) => onRecipientChange(event.target.value.toLowerCase())}
        />
        <span><LockKeyhole /> {t("endToEndEncrypted")}</span>
      </div>
      <div className="header-actions">
        <IconButton aria-label={t("searchConversation")}><Search /></IconButton>
        <IconButton aria-label={t("muteConversation")}><BellOff /></IconButton>
        <IconButton aria-label={t("showSecurityDetails")} onClick={onDetails}><CircleHelp /></IconButton>
      </div>
    </header>
  );
}

const CHAT_EMOJI = [
  "😀", "😂", "🥹", "😊", "😍", "🥰", "😎", "🤔",
  "👍", "👎", "👏", "🙏", "💪", "🤝", "👌", "✌️",
  "❤️", "💙", "💚", "🔥", "✨", "🎉", "💯", "🚀",
  "🔒", "🛡️", "📎", "📷", "✅", "⚠️", "👀", "💬",
] as const;

function EmojiPicker({ label, onPick }: { label: string; onPick: (emoji: string) => void }) {
  return (
    <div className="emoji-picker" role="dialog" aria-label={label} onPointerDown={(event) => event.stopPropagation()}>
      <header><strong>{label}</strong><Smile /></header>
      <div className="emoji-grid">
        {CHAT_EMOJI.map((emoji) => <button type="button" key={emoji} onClick={() => onPick(emoji)}>{emoji}</button>)}
      </div>
    </div>
  );
}

function Composer({ onSend, onAttachment, replyTo, onCancelReply, t }: {
  onSend: (message: string, reply?: ReplyReference) => void;
  onAttachment: (file: File) => void;
  replyTo?: Message;
  onCancelReply: () => void;
  t: Translate;
}) {
  const [draft, setDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!emojiOpen) return;
    const close = () => setEmojiOpen(false);
    window.addEventListener("pointerdown", close, { once: true });
    return () => window.removeEventListener("pointerdown", close);
  }, [emojiOpen]);
  function insertEmoji(emoji: string) {
    const input = textInput.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    setDraft(`${draft.slice(0, start)}${emoji}${draft.slice(end)}`);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
    playUiSound("open");
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    onSend(value, replyTo ? createReplyReference(replyTo.id, replyTo.text) : undefined);
    onCancelReply();
    setDraft("");
  }
  return (
    <form className="composer" onSubmit={submit}>
      {replyTo ? (
        <div className="reply-preview">
          <Reply />
          <span><strong>{t("reply")}</strong><small>{replyTo.text}</small></span>
          <IconButton type="button" onClick={onCancelReply}><X /></IconButton>
        </div>
      ) : null}
      <textarea ref={textInput} aria-label={t("messageMaya")} placeholder={t("messageMaya")} value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className="composer-actions">
        <div>
          <input ref={fileInput} hidden type="file" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onAttachment(file);
            event.target.value = "";
          }} />
          <input ref={imageInput} hidden type="file" accept="image/*" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onAttachment(file);
            event.target.value = "";
          }} />
          <IconButton type="button" aria-label={t("attachFile")} onClick={() => fileInput.current?.click()}><Paperclip /></IconButton>
          <IconButton type="button" aria-label={t("attachImage")} onClick={() => imageInput.current?.click()}><Image /></IconButton>
          <IconButton type="button" aria-label={t("insertDocument")} onClick={() => fileInput.current?.click()}><FileText /></IconButton>
        </div>
        <div>
          <IconButton type="button" className={emojiOpen ? "active" : ""} aria-label={t("chooseEmoji")} aria-expanded={emojiOpen} onPointerDown={(event) => event.stopPropagation()} onClick={() => { playUiSound("open"); setEmojiOpen((open) => !open); }}><Smile /></IconButton>
          <Button className="send" aria-label={t("sendMessage")} disabled={!draft.trim()} icon={<Send />} />
        </div>
      </div>
      {emojiOpen ? <EmojiPicker label={t("chooseEmoji")} onPick={insertEmoji} /> : null}
    </form>
  );
}

function InteractiveMessage({ locale, message, onReply, onReport, onSelect = NOOP_SELECT_MESSAGE, selected = false, selectionMode = false }: {
  locale: Locale;
  message: Message;
  onReply: (message: Message) => void;
  onReport?: (message: Message) => void;
  onSelect?: (messageId: string) => void;
  selected?: boolean;
  selectionMode?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>(undefined);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const swipeOffsetRef = useRef(0);
  const pointerStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const isChinese = locale === "zh-CN";

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    window.addEventListener("pointerdown", close, { once: true });
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  return (
    <article
      className={`message-row ${message.from} interactive-message ${selected ? "message-selected" : ""}`}
      style={{
        "--swipe-offset": `${swipeOffset}px`,
        "--swipe-progress": Math.min(1, Math.abs(swipeOffset) / 52),
        "--swipe-scale": 0.55 + Math.min(1, Math.abs(swipeOffset) / 52) * 0.45,
      } as CSSProperties}
      onContextMenu={(event) => {
        event.preventDefault();
        playUiSound("open");
        setMenu({ x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 170) });
      }}
      onClick={() => {
        if (selectionMode) onSelect(message.id);
      }}
      onPointerDown={(event) => {
        if (selectionMode) return;
        pointerStart.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = pointerStart.current;
        if (!start) return;
        const horizontal = event.clientX - start.x;
        const vertical = event.clientY - start.y;
        if (horizontal < 0 && Math.abs(horizontal) > Math.abs(vertical)) {
          const nextOffset = Math.max(-76, horizontal);
          swipeOffsetRef.current = nextOffset;
          setSwipeOffset(nextOffset);
        }
      }}
      onPointerUp={() => {
        pointerStart.current = undefined;
        if (swipeOffsetRef.current <= -52) {
          playUiSound("open");
          onReply(message);
        }
        swipeOffsetRef.current = 0;
        setSwipeOffset(0);
      }}
      onPointerCancel={() => { pointerStart.current = undefined; swipeOffsetRef.current = 0; setSwipeOffset(0); }}
    >
      {selectionMode ? (
        <span className={`message-selection-check ${selected ? "selected" : ""}`} aria-hidden="true"><Check /></span>
      ) : null}
      {message.from === "them" ? <span className="avatar avatar-small">MC</span> : null}
      <div className="bubble">
        {message.replyTo ? <blockquote data-reply-id={message.replyTo.messageId}>{message.replyTo.excerpt}</blockquote> : null}
        <p>{message.text}</p>
        <footer><time>{message.time}</time>{message.delivered ? <CheckCheck aria-label={isChinese ? "已送达" : "Delivered"} /> : <LockKeyhole aria-label={isChinese ? "已加密" : "Encrypted"} />}</footer>
      </div>
      <span className="swipe-reply-indicator" aria-hidden="true"><Reply /></span>
      {menu ? (
        <div className="message-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <button onClick={() => { onReply(message); setMenu(undefined); }}><Reply />{isChinese ? "回复" : "Reply"}</button>
          <button onClick={() => { void navigator.clipboard.writeText(message.text); playUiSound("success"); setMenu(undefined); }}><CopyIcon />{isChinese ? "复制" : "Copy"}</button>
          <button onClick={() => { onSelect(message.id); setMenu(undefined); }}><CheckCircle2 />{selected ? (isChinese ? "取消选择" : "Unselect") : (isChinese ? "选择" : "Select")}</button>
          {message.from === "them" && onReport ? <button className="danger" onClick={() => { onReport(message); setMenu(undefined); }}><FileWarning />{isChinese ? "举报这条消息" : "Report message"}</button> : null}
        </div>
      ) : null}
    </article>
  );
}

function Chat({ locale, onDetails, onHistoryChange, onMenu, onReceivedText, onRecipientChange, profile, recipient, session, t }: {
  locale: Locale;
  onDetails: () => void;
  onMenu: () => void;
  profile: SecureProfile;
  session: AuthSession;
  t: Translate;
  recipient: string;
  onRecipientChange: (recipient: string) => void;
  onReceivedText: (text: string) => void;
  onHistoryChange: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyTo, setReplyTo] = useState<Message>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [attachments, setAttachments] = useState<AttachmentReference[]>([]);
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const [disappearAfter, setDisappearAfter] = useState(0);
  // 附件上传进度（null=无上传进行中）。上传完成或失败后清空。
  const [uploadProgress, setUploadProgress] = useState<{
    uploadedChunks: number;
    chunkCount: number;
    uploadedBytes: number;
    totalBytes: number;
  } | null>(null);
  // 上传失败时保留待重试的文件；重试成功或取消后清空。
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  useEffect(() => {
    setSelectedIds(new Set());
    setReplyTo(undefined);
    if (!/^[a-z0-9_]{3,32}$/u.test(recipient)) {
      setMessages([]);
      setAttachments([]);
      return;
    }
    void loadConversationHistory(profile, recipient).then((history) => {
      setMessages(history.filter((item) => item.body).map((item) => ({
        id: item.id,
        from: item.from,
        text: item.body!,
        time: new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(item.createdAt)),
        delivered: true,
        expiresAt: item.expiresAt,
        replyTo: item.reply,
      })));
      setAttachments(history.flatMap((item) => item.attachment ? [item.attachment] : []));
    });
  }, [locale, profile, recipient]);

  function toggleMessageSelection(messageId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }

  async function copySelectedMessages() {
    const text = messages.filter((message) => selectedIds.has(message.id)).map((message) => message.text).join("\n\n");
    if (!text) return;
    await navigator.clipboard.writeText(text);
    playUiSound("success");
    setSelectedIds(new Set());
  }

  async function deleteSelectedMessages() {
    if (selectedIds.size === 0) return;
    await removeConversationHistoryItems(profile, recipient, selectedIds);
    setMessages((current) => current.filter((message) => !selectedIds.has(message.id)));
    setSelectedIds(new Set());
    onHistoryChange();
    playUiSound("success");
  }
  useEffect(() => {
    const prune = () => {
      const now = Date.now();
      setMessages((current) => current.filter((message) => !message.expiresAt || message.expiresAt > now));
      setAttachments((current) => current.filter((attachment) => attachment.expiresAt * 1000 > now));
    };
    const timer = window.setInterval(prune, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    async function refresh() {
      const received = await receiveEncryptedTexts(profile, session);
      if (!active || received.length === 0) return;
      for (const message of received) {
        await appendConversationHistory(profile, message.senderUsername, {
          id: message.envelopeId,
          from: "them",
          body: message.body,
          attachment: message.attachment,
          createdAt: message.createdAt,
          expiresAt: message.expiresAt,
          reply: message.reply,
        });
      }
      onHistoryChange();
      void syncEncryptedBackup(profile, session).catch(() => undefined);
      const visible = received.filter((message) => message.senderUsername === recipient);
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [
          ...current,
          ...visible.filter((message) => message.body && !known.has(message.envelopeId)).map((message) => ({
            id: message.envelopeId,
            from: "them" as const,
            text: message.body!,
            time: new Intl.DateTimeFormat(locale, {
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(message.createdAt)),
            delivered: true,
            expiresAt: message.expiresAt,
            replyTo: message.reply,
          })),
        ];
      });
      const lastText = [...visible].reverse().find((message) => message.body)?.body;
      if (lastText) {
        onReceivedText(lastText);
        playUiSound("receive");
      }
      setAttachments((current) => {
        const known = new Set(current.map((attachment) => attachment.objectId));
        return [
          ...current,
          ...visible
            .flatMap((message) => message.attachment ? [message.attachment] : [])
            .filter((attachment) => !known.has(attachment.objectId)),
        ];
      });
    }
    void refresh();
    const unsubscribe = subscribeEncryptedMailbox(session, () => void refresh());
    return () => {
      active = false;
      unsubscribe();
    };
  }, [locale, profile, recipient, session]);

  async function sendText(text: string, reply?: ReplyReference) {
    if (!/^[a-z0-9_]{3,32}$/u.test(recipient)) {
      setAttachmentStatus(t("vaultError"));
      return;
    }
    try {
      await sendEncryptedText(profile, session, recipient, text, disappearAfter || undefined, reply);
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      const expiresAt = disappearAfter ? createdAt + disappearAfter * 1000 : undefined;
      await appendConversationHistory(profile, recipient, {
        id,
        from: "me",
        body: text,
        createdAt,
        expiresAt,
        reply,
      });
      onHistoryChange();
      void syncEncryptedBackup(profile, session).catch(() => undefined);
      setMessages((current) => [...current, {
        id,
        from: "me",
        text,
        time: new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(createdAt)),
        delivered: true,
        expiresAt,
        replyTo: reply,
      }]);
      playUiSound("send");
      setAttachmentStatus("");
    } catch (error) {
      setAttachmentStatus(
        error instanceof Error ? error.message : t("vaultError"),
      );
    }
  }
  async function reportMessage(message: Message) {
    if (!window.confirm(locale === "zh-CN" ? "举报会把这条消息的明文主动提交给管理员审核。确认继续？" : "Reporting explicitly discloses this message to administrators. Continue?")) return;
    try {
      await submitAbuseReport(profile, session, recipient, JSON.stringify({ message: message.text, messageId: message.id }), "user-selected message");
      setAttachmentStatus(locale === "zh-CN" ? "举报已提交" : "Report submitted");
    } catch { setAttachmentStatus(locale === "zh-CN" ? "举报提交失败" : "Report submission failed"); }
  }
  async function uploadAttachment(file: File) {
    if (!/^[a-z0-9_]{3,32}$/u.test(recipient)) {
      setAttachmentStatus(t("vaultError"));
      return;
    }
    // 配额前置校验：避免大文件进入加密流程后才发现超限。
    if (file.size > MAX_ATTACHMENT_SIZE) {
      setPendingFile(null);
      setAttachmentStatus(t("quotaExceeded"));
      return;
    }
    setPendingFile(null);
    setAttachmentStatus(t("attachmentUploading"));
    setUploadProgress({ uploadedChunks: 0, chunkCount: Math.ceil(file.size / (1024 * 1024)), uploadedBytes: 0, totalBytes: file.size });
    try {
      const attachmentExpiry = Math.floor(Date.now() / 1000) + (disappearAfter || 30 * 24 * 60 * 60);
      const reference = await encryptAndUploadAttachment(file, profile, session, attachmentExpiry, (progress) => {
        setUploadProgress(progress);
      });
      await sendEncryptedAttachment(profile, session, recipient, reference, disappearAfter || undefined);
      await appendConversationHistory(profile, recipient, {
        id: crypto.randomUUID(),
        from: "me",
        attachment: reference,
        createdAt: Date.now(),
        expiresAt: disappearAfter ? Date.now() + disappearAfter * 1000 : undefined,
      });
      onHistoryChange();
      void syncEncryptedBackup(profile, session).catch(() => undefined);
      setAttachments((current) => [...current, reference]);
      setAttachmentStatus("");
      setUploadProgress(null);
    } catch {
      // 失败后保留 pendingFile 供重试，清空进度。
      setPendingFile(file);
      setUploadProgress(null);
      setAttachmentStatus(t("uploadFailed"));
    }
  }
  async function downloadAttachment(reference: AttachmentReference) {
    try {
      const blob = await downloadAndDecryptAttachment(reference, session);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = reference.fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setAttachmentStatus(t("attachmentFailed"));
    }
  }
  return (
    <main className="chat">
      <ChatHeader
        onDetails={onDetails}
        onMenu={onMenu}
        onRecipientChange={onRecipientChange}
        recipient={recipient}
        t={t}
      />
      {selectedIds.size > 0 ? (
        <div className="selection-toolbar" role="toolbar" aria-label={locale === "zh-CN" ? "消息批量操作" : "Message actions"}>
          <IconButton aria-label={locale === "zh-CN" ? "取消选择" : "Cancel selection"} onClick={() => setSelectedIds(new Set())}><X /></IconButton>
          <strong>{locale === "zh-CN" ? `已选择 ${selectedIds.size} 条` : `${selectedIds.size} selected`}</strong>
          <span />
          {selectedIds.size === 1 ? <IconButton aria-label={locale === "zh-CN" ? "回复" : "Reply"} onClick={() => {
            const selectedMessage = messages.find((message) => selectedIds.has(message.id));
            if (selectedMessage) setReplyTo(selectedMessage);
            setSelectedIds(new Set());
          }}><Reply /></IconButton> : null}
          <IconButton aria-label={locale === "zh-CN" ? "复制" : "Copy"} onClick={() => void copySelectedMessages()}><CopyIcon /></IconButton>
          <IconButton className="danger" aria-label={locale === "zh-CN" ? "从本设备删除" : "Delete from this device"} onClick={() => void deleteSelectedMessages()}><Trash2 /></IconButton>
        </div>
      ) : null}
      <div className="disappearing-control">
        <LockKeyhole />
        <label>
          {locale === "zh-CN" ? "定时消失" : "Disappearing messages"}
          <select value={disappearAfter} onChange={(event) => setDisappearAfter(Number(event.target.value))}>
            <option value={0}>{locale === "zh-CN" ? "关闭" : "Off"}</option>
            <option value={3600}>{locale === "zh-CN" ? "1 小时" : "1 hour"}</option>
            <option value={86400}>{locale === "zh-CN" ? "1 天" : "1 day"}</option>
            <option value={604800}>{locale === "zh-CN" ? "7 天" : "7 days"}</option>
          </select>
        </label>
      </div>
      <section className="messages" aria-label="Encrypted conversation" aria-live="polite">
        <div className="date-rule"><span>{t("today")}</span></div>
        {messages.map((message) => <InteractiveMessage
          key={message.id}
          locale={locale}
          message={message}
          onReply={setReplyTo}
          onReport={reportMessage}
          onSelect={toggleMessageSelection}
          selected={selectedIds.has(message.id)}
          selectionMode={selectedIds.size > 0}
        />)}
        {attachments.map((attachment) => (
          <article className="message-row me" key={attachment.objectId}>
            <div className="bubble attachment-bubble">
              <strong><LockKeyhole /> {t("attachmentReady")}</strong>
              <p>{attachment.fileName}</p>
              <small>{new Intl.NumberFormat(locale).format(attachment.plaintextSize)} bytes</small>
              <button type="button" onClick={() => void downloadAttachment(attachment)}>
                {t("downloadAttachment")}
              </button>
            </div>
          </article>
        ))}
        {attachmentStatus ? <p className="attachment-status" role="status">{attachmentStatus}</p> : null}
        {/* 上传进度条：百分比 + 已上传/总字节 */}
        {uploadProgress ? (
          <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={uploadProgress.totalBytes} aria-valuenow={uploadProgress.uploadedBytes}>
            <div className="upload-progress-label">
              {t("uploadProgress")} {Math.round((uploadProgress.uploadedBytes / uploadProgress.totalBytes) * 100)}%
            </div>
            <div className="upload-progress-bar">
              <div
                className="upload-progress-fill"
                style={{ width: `${(uploadProgress.uploadedBytes / uploadProgress.totalBytes) * 100}%` }}
              />
            </div>
            <div className="upload-progress-detail">
              {formatBytes(uploadProgress.uploadedBytes)} / {formatBytes(uploadProgress.totalBytes)}
              {" · "}{uploadProgress.uploadedChunks}/{uploadProgress.chunkCount}
            </div>
          </div>
        ) : null}
        {/* 失败重试 + 取消按钮 */}
        {pendingFile ? (
          <div className="upload-retry-bar">
            <span className="upload-retry-name">{pendingFile.name}</span>
            <button type="button" onClick={() => void uploadAttachment(pendingFile)}>
              {t("retryUpload")}
            </button>
            <button type="button" onClick={() => { setPendingFile(null); setAttachmentStatus(""); }}>
              {t("cancelUpload")}
            </button>
          </div>
        ) : null}
      </section>
      <Composer
        t={t}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(undefined)}
        onAttachment={(file) => void uploadAttachment(file)}
        onSend={(text, reply) => void sendText(text, reply)}
      />
    </main>
  );
}

function GroupWorkspace({ locale, profile, session, t }: {
  locale: Locale;
  profile: SecureProfile;
  session: AuthSession;
  t: Translate;
}) {
  const [availableGroups, setAvailableGroups] = useState(
    () => [...listEncryptedGroups(profile)],
  );
  const [selectedGroupId, setSelectedGroupId] = useState(
    () => availableGroups[0]?.groupId ?? "",
  );
  const [groupName, setGroupName] = useState("");
  const [inviteUsername, setInviteUsername] = useState("");
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const [messagesByGroup, setMessagesByGroup] = useState<Record<string, Message[]>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message>();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const groupTextInput = useRef<HTMLTextAreaElement>(null);
  const selected = availableGroups.find((group) => group.groupId === selectedGroupId);
  const messages = selected ? messagesByGroup[selected.groupId] || [] : [];
  // 当前设备是否为该群管理员（控制移除成员、邀请策略等管理 UI 的可见性）
  const isAdmin = selected ? isGroupAdmin(profile, selected.groupId) : false;

  useEffect(() => {
    if (!emojiOpen) return;
    const close = () => setEmojiOpen(false);
    window.addEventListener("pointerdown", close, { once: true });
    return () => window.removeEventListener("pointerdown", close);
  }, [emojiOpen]);

  function insertGroupEmoji(emoji: string) {
    const input = groupTextInput.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    setDraft(`${draft.slice(0, start)}${emoji}${draft.slice(end)}`);
    setEmojiOpen(false);
    requestAnimationFrame(() => input?.focus());
    playUiSound("open");
  }

  function refreshGroups() {
    const next = [...listEncryptedGroups(profile)];
    setAvailableGroups(next);
    setSelectedGroupId((current) => current || next[0]?.groupId || "");
  }

  useEffect(() => {
    let active = true;
    async function refresh() {
      const received = await receiveEncryptedGroupMessages(profile, session);
      if (!active) return;
      refreshGroups();
      setMessagesByGroup((current) => {
        const next = { ...current };
        for (const message of received) {
          const groupMessages = next[message.groupId] || [];
          next[message.groupId] = [
            ...groupMessages,
            {
              id: message.envelopeId,
              from: "them" as const,
              text: message.body,
              time: new Intl.DateTimeFormat(locale, {
                hour: "2-digit",
                minute: "2-digit",
              }).format(new Date(message.createdAt)),
              delivered: true,
              replyTo: message.reply,
            }
          ];
        }
        return next;
      });
      if (received.length) playUiSound("receive");
    }
    void refresh();
    const unsubscribe = subscribeEncryptedMailbox(session, () => void refresh());
    return () => {
      active = false;
      unsubscribe();
    };
  }, [locale, profile, session]);

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    try {
      const created = await createEncryptedGroup(profile, session, groupName);
      refreshGroups();
      setSelectedGroupId(created.groupId);
      setGroupName("");
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("vaultError"));
    }
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    try {
      await addGroupMember(profile, session, selected.groupId, inviteUsername);
      refreshGroups();
      setInviteUsername("");
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("vaultError"));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selected || !draft.trim()) return;
    const text = draft.trim();
    const reply = replyTo ? createReplyReference(replyTo.id, replyTo.text) : undefined;
    try {
      await sendEncryptedGroupText(profile, session, selected.groupId, text, reply);
      setMessagesByGroup((current) => {
        const groupMessages = current[selected.groupId] || [];
        return {
          ...current,
          [selected.groupId]: [
            ...groupMessages,
            {
              id: crypto.randomUUID(),
              from: "me",
              text,
              time: new Intl.DateTimeFormat(locale, {
                hour: "2-digit",
                minute: "2-digit",
              }).format(new Date()),
              delivered: true,
              replyTo: reply,
            }
          ]
        };
      });
      playUiSound("send");
      setDraft("");
      setReplyTo(undefined);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("vaultError"));
    }
  }

  // 移除群成员：仅管理员可操作；触发 MLS epoch 更新，被移除者无法再解密新消息。
  async function removeMember(memberDeviceId: string) {
    if (!selected) return;
    if (memberDeviceId === profile.deviceId) {
      setStatus(t("cannotRemoveSelf"));
      return;
    }
    if (!window.confirm(t("removeMemberConfirm"))) return;
    try {
      await removeGroupMember(profile, session, selected.groupId, memberDeviceId);
      refreshGroups();
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("vaultError"));
    }
  }

  // 切换邀请策略：仅管理员可操作；anyone=所有成员可邀请，admins=仅管理员可邀请。
  async function changeInvitePolicy(policy: "anyone" | "admins") {
    if (!selected) return;
    try {
      await setGroupInvitePolicy(profile, session, selected.groupId, policy);
      refreshGroups();
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("vaultError"));
    }
  }

  async function transferAdministration(memberDeviceId: string) {
    if (!selected || !window.confirm(t("transferAdminConfirm"))) return;
    try {
      await transferEncryptedGroupAdministration(
        profile,
        session,
        selected.groupId,
        memberDeviceId,
      );
      refreshGroups();
      setStatus(t("adminTransferred"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("vaultError"));
    }
  }

  async function leaveGroup() {
    if (!selected) return;
    if (isAdmin) {
      setStatus(t("adminTransferBeforeLeave"));
      return;
    }
    if (!window.confirm(t("leaveGroupConfirm"))) return;
    try {
      await requestEncryptedGroupLeave(profile, session, selected.groupId);
      setStatus(t("leaveRequestSent"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("vaultError"));
    }
  }

  return (
    <main className={`group-workspace ${detailsOpen ? "group-details-open" : ""}`}>
      <aside className="group-sidebar">
        <header className="group-sidebar-heading">
          <div><h1>{t("groups")}</h1><span>{t("mlsProtocol")}</span></div>
          <span className="group-count">{availableGroups.length}</span>
        </header>
        <form className="group-create" onSubmit={(event) => void createGroup(event)}>
          <input
            aria-label={t("groupName")}
            placeholder={t("groupName")}
            required
            maxLength={80}
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
          />
          <button aria-label={t("createGroup")} title={t("createGroup")}><Plus /></button>
        </form>
        <div className="group-list">
          {availableGroups.map((group) => (
            <button
              className={group.groupId === selectedGroupId ? "selected" : ""}
              key={group.groupId}
              onClick={() => { playUiSound("navigate"); setSelectedGroupId(group.groupId); setDetailsOpen(false); }}
            >
              <span className="group-list-avatar"><UsersRound /></span>
              <span>
                <strong>{group.name}</strong>
                <small><LockKeyhole /> {t("groupEpoch")} {group.epoch} · {group.memberDeviceIds.length} {t("groupMembers")}</small>
              </span>
            </button>
          ))}
          {availableGroups.length === 0 ? <p>{t("noGroups")}</p> : null}
        </div>
      </aside>
      <section className="group-chat">
        {selected ? (
          <>
            <header className="chat-header">
              <button className="mobile-menu icon-button" aria-label={t("groups")}><Menu /></button>
              <span className="avatar group-chat-avatar"><UsersRound /></span>
              <div className="chat-title">
                <strong>{selected.name}</strong>
                <span>
                  <LockKeyhole /> {t("mlsProtocol")} · {selected.memberDeviceIds.length} {t("groupMembers")}
                  {isAdmin ? <em className="admin-badge"> · {t("youAreAdmin")}</em> : null}
                </span>
              </div>
              <button
                className={`icon-button group-details-toggle ${detailsOpen ? "active" : ""}`}
                aria-label={t("groupAdmin")}
                title={t("groupAdmin")}
                aria-expanded={detailsOpen}
                onClick={() => { playUiSound("open"); setDetailsOpen((open) => !open); }}
              ><CircleHelp /></button>
            </header>
            <section className="messages" aria-live="polite">
              {messages.length === 0 ? (
                <div className="group-message-empty">
                  <span><ShieldCheck /></span>
                  <strong>{selected.name}</strong>
                  <p>{t("mlsProtocol")} · {selected.memberDeviceIds.length} {t("groupMembers")}</p>
                </div>
              ) : null}
              {messages.map((message) => <InteractiveMessage key={message.id} locale={locale} message={message} onReply={setReplyTo} />)}
              {status ? <p className="attachment-status" role="status">{status}</p> : null}
            </section>
            <form className="composer group-composer" onSubmit={(event) => void send(event)}>
              {replyTo ? (
                <div className="reply-preview">
                  <Reply />
                  <span><strong>{t("reply")}</strong><small>{replyTo.text}</small></span>
                  <button type="button" className="icon-button" onClick={() => setReplyTo(undefined)}><X /></button>
                </div>
              ) : null}
              <textarea
                ref={groupTextInput}
                aria-label={t("messageMaya")}
                placeholder={t("messageMaya")}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="button" className={`icon-button group-emoji ${emojiOpen ? "active" : ""}`} aria-label={t("chooseEmoji")} aria-expanded={emojiOpen} onPointerDown={(event) => event.stopPropagation()} onClick={() => { playUiSound("open"); setEmojiOpen((open) => !open); }}><Smile /></button>
              <button className="send" aria-label={t("sendMessage")} disabled={!draft.trim()}><Send /></button>
              {emojiOpen ? <EmojiPicker label={t("chooseEmoji")} onPick={insertGroupEmoji} /> : null}
            </form>
          </>
        ) : <div className="group-empty"><UsersRound /><p>{t("selectGroup")}</p></div>}
      </section>
      {selected ? (
        <aside className={`group-details ${detailsOpen ? "open" : ""}`} aria-hidden={!detailsOpen}>
          <header className="group-details-header">
            <strong>{t("groupAdmin")}</strong>
            <button className="icon-button" aria-label={t("groupAdmin")} onClick={() => setDetailsOpen(false)}><X /></button>
          </header>
          <section className="group-details-hero">
            <span className="avatar"><UsersRound /></span>
            <strong>{selected.name}</strong>
            <small><LockKeyhole /> {t("mlsProtocol")} · Epoch {selected.epoch}</small>
          </section>
          <div className="group-details-scroll">
            {isAdmin ? (
              <section className="group-details-section">
                <h3>{t("addMember")}</h3>
                <form className="group-invite" onSubmit={(event) => void invite(event)}>
                  <input aria-label={t("groupMemberUsername")} placeholder={t("groupMemberUsername")} pattern="[a-z0-9_]{3,32}" required value={inviteUsername} onChange={(event) => setInviteUsername(event.target.value.toLowerCase())} />
                  <button aria-label={t("addMember")} title={t("addMember")}><Plus /></button>
                </form>
              </section>
            ) : null}
            <section className="group-details-section">
              <h3>{t("memberList")} <span>{selected.memberDeviceIds.length}</span></h3>
              <ul className="member-list">
                {selected.memberDeviceIds.map((memberDeviceId) => {
                  const memberIsAdmin = (selected.adminDeviceIds ?? []).includes(memberDeviceId);
                  const isSelf = memberDeviceId === profile.deviceId;
                  return (
                    <li key={memberDeviceId} className="member-item">
                      <span className="member-avatar"><UserRound /></span>
                      <span className="member-copy"><strong>{memberDeviceId.slice(0, 8)}</strong><small>{isSelf ? profile.username : t("groupMembers")}</small></span>
                      {memberIsAdmin ? <em className="admin-tag">{t("youAreAdmin")}</em> : null}
                      {isAdmin && !isSelf ? <span className="member-actions"><button className="transfer-admin-btn" onClick={() => void transferAdministration(memberDeviceId)}>{t("transferAdmin")}</button><button className="remove-member-btn" onClick={() => void removeMember(memberDeviceId)}><Trash2 /></button></span> : null}
                    </li>
                  );
                })}
              </ul>
            </section>
            {isAdmin ? (
              <section className="group-details-section invite-policy-section">
                <h3>{t("invitePolicy")}</h3>
                <label><input type="radio" name={`invite-policy-${selected.groupId}`} checked={(selected.invitePolicy ?? "admins") === "admins"} onChange={() => void changeInvitePolicy("admins")} />{t("invitePolicyAdmins")}</label>
                <label className="disabled"><input type="radio" name={`invite-policy-${selected.groupId}`} checked={(selected.invitePolicy ?? "admins") === "anyone"} disabled onChange={() => void changeInvitePolicy("anyone")} />{t("invitePolicyAnyone")}</label>
              </section>
            ) : null}
            <section className="leave-group-section"><button className="leave-group-btn" onClick={() => void leaveGroup()}>{t("leaveGroup")}</button></section>
          </div>
        </aside>
      ) : null}
    </main>
  );
}

function SecurityPanel({ lastReceivedText, open, onClose, locale, profile, recipient, session, t }: {
  lastReceivedText?: string;
  open: boolean;
  onClose: () => void;
  locale: Locale;
  profile: SecureProfile;
  recipient: string;
  session: AuthSession;
  t: Translate;
}) {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [deviceError, setDeviceError] = useState("");
  const [verification, setVerification] = useState<{ safetyNumber: string; verified: boolean }>();
  const [blocked, setBlocked] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const zh = locale === "zh-CN";
  const refreshDevices = async () => {
    try {
      setDevices(await listOwnDevices(session));
      setDeviceError("");
    } catch {
      setDeviceError(zh ? "无法读取设备列表" : "Unable to load devices");
    }
  };
  useEffect(() => {
    if (!open) return;
    void refreshDevices();
    void listBlockedUsers(session).then((users) => setBlocked(users.includes(recipient)));
    if (/^[a-z0-9_]{3,32}$/u.test(recipient)) {
      void lookupDirectory(recipient, session)
        .then((directory) => identityVerification(profile, directory))
        .then(setVerification)
        .catch(() => setVerification(undefined));
    } else {
      setVerification(undefined);
    }
  }, [open, recipient, session.accessToken]);
  const revoke = async (deviceId: string) => {
    if (!window.confirm(zh ? "确认撤销这台设备？撤销后它将无法登录或接收新消息。" : "Revoke this device? It will no longer sign in or receive new messages.")) return;
    try {
      await revokeOwnDevice(deviceId, session);
      await refreshDevices();
    } catch {
      setDeviceError(zh ? "设备撤销失败" : "Device revocation failed");
    }
  };
  const toggleBlocked = async () => {
    try {
      await setUserBlocked(recipient, !blocked, session);
      setBlocked(!blocked);
      setActionStatus(zh ? (!blocked ? "已拉黑该用户" : "已解除拉黑") : (!blocked ? "User blocked" : "User unblocked"));
    } catch {
      setActionStatus(zh ? "拉黑设置失败" : "Block setting failed");
    }
  };
  const report = async () => {
    if (!lastReceivedText || !window.confirm(zh ? "这会把所选消息明文主动提交给服务端审核。确认举报？" : "This explicitly discloses the selected message to moderators. Submit report?")) return;
    try {
      await submitAbuseReport(profile, session, recipient, JSON.stringify({ message: lastReceivedText }), "user-selected latest received message");
      setActionStatus(zh ? "举报已提交" : "Report submitted");
    } catch {
      setActionStatus(zh ? "举报提交失败" : "Report submission failed");
    }
  };
  return (
    <aside className={open ? "security-panel open" : "security-panel"} aria-label="Conversation security">
      <button className="close-details icon-button" onClick={onClose} aria-label={t("closeSecurityDetails")}><X /></button>
      <div className="security-person">
        <span className="avatar avatar-large">{(recipient || "@").slice(0, 2).toUpperCase()}</span>
        <h2>{recipient || t("newConversation")}</h2>
        <span><LockKeyhole /> {t("endToEndEncrypted")}</span>
      </div>
      <section className="security-section">
        <h3><ShieldCheck />{t("securityOverview")}</h3>
        <p>{t("securityOverviewBody")}</p>
      </section>
      <section className="security-section">
        <h3><ShieldCheck />{t("verifySafetyNumber")}</h3>
        {verification ? (
          <>
            <p>{t("verifySafetyNumberBody")}</p>
            <code className="safety-number">{verification.safetyNumber}</code>
            <button
              className={verification.verified ? "verify verified" : "verify"}
              disabled={verification.verified}
              onClick={() => void lookupDirectory(recipient, session)
                .then((directory) => markIdentityVerified(profile, directory))
                .then(() => setVerification((current) => current ? { ...current, verified: true } : current))}
            >
              {verification.verified ? <><CheckCheck /> {t("safetyNumberVerified")}</> : t("verifySafetyNumber")}
            </button>
          </>
        ) : <p>{t("unavailablePreview")}</p>}
      </section>
      <section className="security-section">
        <h3><ShieldCheck />{zh ? "我的设备" : "My devices"}</h3>
        <p>{zh ? "撤销丢失或不再使用的设备。当前设备不能在这里自我撤销。" : "Revoke lost or unused devices. The current device cannot revoke itself here."}</p>
        {devices.map((device) => (
          <div className="device-row" key={device.deviceId}>
            <div>
              <strong>{device.deviceId === profile.deviceId ? (zh ? "当前设备" : "Current device") : device.deviceId.slice(0, 8)}</strong>
              <small>{new Date(device.createdAt * 1000).toLocaleString(locale)}</small>
              {device.revokedAt ? <small>{zh ? "已撤销" : "Revoked"}</small> : null}
            </div>
            {device.deviceId !== profile.deviceId && !device.revokedAt ? (
              <button className="icon-button" onClick={() => void revoke(device.deviceId)} title={zh ? "撤销设备" : "Revoke device"}><Trash2 /></button>
            ) : null}
          </div>
        ))}
        {deviceError ? <p className="fail-closed">{deviceError}</p> : null}
      </section>
      {/^[a-z0-9_]{3,32}$/u.test(recipient) ? (
        <section className="security-section">
          <h3><ShieldCheck />{zh ? "隐私与安全操作" : "Privacy and safety actions"}</h3>
          <div className="security-actions">
            <button className="verify" onClick={() => void toggleBlocked()}>{blocked ? (zh ? "解除拉黑" : "Unblock") : (zh ? "拉黑用户" : "Block user")}</button>
            <button className="verify danger" disabled={!lastReceivedText} onClick={() => void report()}>{zh ? "举报最近收到的消息" : "Report latest received message"}</button>
          </div>
          {actionStatus ? <p role="status">{actionStatus}</p> : null}
        </section>
      ) : null}
      <section className="security-section details">
        <h3><LockKeyhole />{t("encryptionDetails")}</h3>
        <dl><dt>{t("protocol")}</dt><dd>Signal PQXDH + Triple Ratchet / RFC 9420 MLS</dd><dt>{t("identityKey")}</dt><dd>{profile.accountKeys.publicKey.slice(0, 24)}…</dd></dl>
        <p className="fail-closed">{t("failClosed")}</p>
      </section>
    </aside>
  );
}

function SettingsWorkspace({ locale, motionEnabled, onMotionChange, onSoundChange, onWallpaperChange, soundEnabled, wallpaper }: {
  locale: Locale;
  motionEnabled: boolean;
  onMotionChange: (enabled: boolean) => void;
  onSoundChange: (enabled: boolean) => void;
  onWallpaperChange: (wallpaper: WallpaperStyle) => void;
  soundEnabled: boolean;
  wallpaper: WallpaperStyle;
}) {
  const zh = locale === "zh-CN";
  return (
    <main className="settings-workspace">
      <header className="settings-heading"><span><Settings /></span><div><h1>{zh ? "界面与体验" : "Appearance & experience"}</h1><p>{zh ? "调整 CoveChat 在此设备上的外观、动画和声音。" : "Tune CoveChat's appearance, motion and sound on this device."}</p></div></header>
      <div className="settings-content">
        <section className="settings-card">
          <div className="settings-card-title"><Palette /><div><h2>{zh ? "聊天壁纸" : "Chat wallpaper"}</h2><p>{zh ? "选择消息区域的背景氛围" : "Choose the atmosphere behind your messages"}</p></div></div>
          <div className="wallpaper-options">
            {(["cove", "plain", "midnight"] as const).map((option) => (
              <button className={`wallpaper-option wallpaper-preview-${option} ${wallpaper === option ? "selected" : ""}`} key={option} onClick={() => { playUiSound("navigate"); onWallpaperChange(option); }}>
                <span className="wallpaper-swatch" />
                <strong>{option === "cove" ? (zh ? "海湾纹理" : "Cove pattern") : option === "plain" ? (zh ? "纯净浅色" : "Clean light") : (zh ? "深海蓝" : "Deep ocean")}</strong>
                {wallpaper === option ? <CheckCircle2 /> : null}
              </button>
            ))}
          </div>
        </section>
        <section className="settings-card">
          <div className="settings-card-title"><Sparkles /><div><h2>{zh ? "动态效果" : "Motion"}</h2><p>{zh ? "弹性抽屉、消息入场和页面转场" : "Spring drawers, message entrances and page transitions"}</p></div></div>
          <label className="settings-switch"><span><strong>{zh ? "灵动动画" : "Expressive motion"}</strong><small>{zh ? "关闭后保留必要的状态变化" : "Essential state changes remain visible when disabled"}</small></span><input type="checkbox" checked={motionEnabled} onChange={(event) => onMotionChange(event.target.checked)} /><i /></label>
          <label className="settings-switch"><span><strong>{zh ? "界面音效" : "Interface sounds"}</strong><small>{zh ? "发送、接收和导航的轻量反馈" : "Subtle feedback for sending, receiving and navigation"}</small></span><input type="checkbox" checked={soundEnabled} onChange={(event) => onSoundChange(event.target.checked)} /><i /></label>
        </section>
        <section className="settings-note"><ShieldCheck /><p>{zh ? "这些设置仅保存在当前设备，不会进入加密消息或云备份。" : "These preferences stay on this device and are never included in encrypted messages or cloud backups."}</p></section>
      </div>
    </main>
  );
}

function ProfileWorkspace({ locale, profile, session }: { locale: Locale; profile: SecureProfile; session: AuthSession }) {
  const zh = locale === "zh-CN";
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [showRecovery, setShowRecovery] = useState(false);
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [status, setStatus] = useState("");
  const backupVersion = localStorage.getItem(`covechat:backup_version:${profile.username}`) ?? "0";
  const refreshDevices = useCallback(() => void listOwnDevices(session).then(setDevices).catch(() => setStatus(zh ? "设备列表读取失败" : "Unable to load devices")), [session.accessToken, zh]);
  useEffect(refreshDevices, [refreshDevices]);
  async function changePassphrase(event: FormEvent) {
    event.preventDefault();
    if (newPassphrase.length < 12) { setStatus(zh ? "新口令至少需要 12 个字符" : "New passphrase must be at least 12 characters"); return; }
    try {
      const unlocked = await unlockSecureProfile(currentPassphrase);
      if (unlocked.deviceId !== profile.deviceId) throw new Error("profile mismatch");
      await saveSecureProfile(profile, newPassphrase);
      setCurrentPassphrase(""); setNewPassphrase(""); setStatus(zh ? "本地解锁口令已更新" : "Local passphrase updated");
    } catch { setStatus(zh ? "当前口令错误，未作更改" : "Current passphrase is incorrect"); }
  }
  async function removeDevice(deviceId: string) {
    if (!window.confirm(zh ? "确认撤销这台设备？撤销后它无法登录或接收新消息。" : "Revoke this device?")) return;
    await revokeOwnDevice(deviceId, session); refreshDevices();
  }
  async function clearLocalData() {
    if (!window.confirm(zh ? "这会删除当前浏览器中的密钥、消息和设置。确认已经保存恢复码？" : "This deletes local keys, messages and settings. Continue?")) return;
    await deleteLocalVault(); localStorage.clear(); window.location.assign("/");
  }
  async function deleteAccount() {
    const confirmation = window.prompt(zh ? `这是永久操作。输入用户名 ${profile.username} 确认删除服务器账户和所有设备：` : `Permanent action. Type ${profile.username} to delete the server account:`);
    if (confirmation !== profile.username) return;
    try { await deleteOwnAccount(profile, session); await deleteLocalVault(); localStorage.clear(); window.location.assign("/"); }
    catch { setStatus(zh ? "账户删除失败，未清除本机数据" : "Account deletion failed; local data was kept"); }
  }
  return <main className="profile-workspace">
    <header className="settings-heading"><span><UserRound /></span><div><h1>{zh ? "个人与安全" : "Profile & security"}</h1><p>{profile.username} · {profile.deviceId}</p></div></header>
    <div className="profile-grid">
      <section className="settings-card"><h2>{zh ? "账户恢复" : "Account recovery"}</h2><p>{zh ? `加密云备份版本：${backupVersion}` : `Encrypted cloud backup version: ${backupVersion}`}</p><Button variant="secondary" onClick={() => setShowRecovery((value) => !value)}>{showRecovery ? (zh ? "隐藏恢复码" : "Hide recovery code") : (zh ? "显示恢复码" : "Show recovery code")}</Button>{showRecovery ? <><code className="recovery-code">{profile.recoverySecret}</code><Button size="small" onClick={() => void navigator.clipboard.writeText(profile.recoverySecret)}>{zh ? "复制恢复码" : "Copy recovery code"}</Button></> : null}</section>
      <section className="settings-card"><h2>{zh ? "我的设备" : "My devices"}</h2>{devices.map((device) => <div className="profile-device" key={device.deviceId}><div><strong>{device.deviceId === profile.deviceId ? (zh ? "当前设备" : "Current device") : device.deviceId}</strong><small>{new Date(device.createdAt * 1000).toLocaleString(locale)}{device.revokedAt ? ` · ${zh ? "已撤销" : "Revoked"}` : ""}</small></div>{device.deviceId !== profile.deviceId && !device.revokedAt ? <Button size="small" variant="danger" onClick={() => void removeDevice(device.deviceId)}>{zh ? "撤销" : "Revoke"}</Button> : null}</div>)}</section>
      <section className="settings-card"><h2>{zh ? "修改本地解锁口令" : "Change local passphrase"}</h2><form className="profile-form" onSubmit={changePassphrase}><label>{zh ? "当前口令" : "Current passphrase"}<input type="password" value={currentPassphrase} onChange={(event) => setCurrentPassphrase(event.target.value)} required /></label><label>{zh ? "新口令" : "New passphrase"}<input type="password" minLength={12} value={newPassphrase} onChange={(event) => setNewPassphrase(event.target.value)} required /></label><Button type="submit">{zh ? "更新口令" : "Update passphrase"}</Button></form></section>
      <section className="settings-card danger-zone"><h2>{zh ? "会话与数据" : "Session & data"}</h2><div><Button variant="secondary" onClick={() => window.location.reload()}>{zh ? "锁定并退出" : "Lock and sign out"}</Button><Button variant="danger" onClick={() => void clearLocalData()}>{zh ? "清除此设备数据" : "Clear this device"}</Button><Button variant="danger" onClick={() => void deleteAccount()}>{zh ? "永久删除账户" : "Permanently delete account"}</Button></div></section>
      {status ? <p className="profile-status" role="status">{status}</p> : null}
    </div>
  </main>;
}

function ChatApp({ profile, session }: { profile: SecureProfile; session: AuthSession }) {
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const t: Translate = (key) => copy[locale][key];
  const [detailsOpen, setDetailsOpen] = useState(
    false,
  );
  const [noticeOpen, setNoticeOpen] = useState(true);
  const [securityModelOpen, setSecurityModelOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("messages");
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [lastReceivedText, setLastReceivedText] = useState<string>();
  const [historyRevision, setHistoryRevision] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(uiSoundsEnabled);
  const [motionEnabled, setMotionEnabled] = useState(() => localStorage.getItem("covechat-motion") !== "off");
  const [wallpaper, setWallpaper] = useState<WallpaperStyle>(() => {
    const stored = localStorage.getItem("covechat-wallpaper");
    return stored === "plain" || stored === "midnight" ? stored : "cove";
  });
  useEffect(() => installUiRipple(), []);
  const handleHistoryChange = useCallback(() => {
    setHistoryRevision((current) => current + 1);
  }, []);
  useEffect(() => {
    setLastReceivedText(undefined);
  }, [recipient]);
  useEffect(() => {
    localStorage.setItem("covechat.locale", locale);
    document.documentElement.lang = locale;
    document.title = locale === "zh-CN"
      ? "CoveChat — 实验性安全软件"
      : "CoveChat — Experimental security software";
  }, [locale]);
  useEffect(() => {
    const showUpdate = () => setUpdateReady(true);
    window.addEventListener(PWA_UPDATE_READY_EVENT, showUpdate);
    return () => window.removeEventListener(PWA_UPDATE_READY_EVENT, showUpdate);
  }, []);
  useEffect(() => {
    if (!securityModelOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSecurityModelOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [securityModelOpen]);
  return (
    <div className={`app wallpaper-${wallpaper} ${motionEnabled ? "" : "motion-disabled"}`}>
      <div className={`${detailsOpen ? "workspace security-open" : "workspace"} ${mobilePanelOpen ? "mobile-panel-open" : ""}`}>
        <Navigation
          activeView={activeView}
          locale={locale}
          t={t}
          profileName={profile.username}
          soundEnabled={soundEnabled}
          onSoundToggle={() => {
            const next = !soundEnabled;
            setSoundEnabled(next);
            setUiSoundsEnabled(next);
          }}
          onLocaleChange={() => { playUiSound("navigate"); setLocale((current) => current === "zh-CN" ? "en" : "zh-CN"); }}
          onViewChange={(view) => withViewTransition(() => { setActiveView(view); setMobilePanelOpen(false); })}
        />
        {activeView === "messages" ? (
          <>
            <ConversationList historyRevision={historyRevision} key={`conversations-${locale}`} locale={locale} onSelect={(username) => {
              playUiSound("navigate");
              withViewTransition(() => { setRecipient(username); setMobilePanelOpen(false); });
            }} profile={profile} recipient={recipient} t={t} />
            <Chat
              key={`chat-${locale}`}
              locale={locale}
              profile={profile}
              recipient={recipient}
              session={session}
              onRecipientChange={setRecipient}
              onReceivedText={setLastReceivedText}
              onHistoryChange={handleHistoryChange}
              onMenu={() => { playUiSound("open"); setMobilePanelOpen(true); }}
              onDetails={() => { playUiSound("open"); setDetailsOpen(true); }}
              t={t}
            />
            {mobilePanelOpen ? <button className="mobile-panel-scrim" aria-label={locale === "zh-CN" ? "关闭菜单" : "Close menu"} onClick={() => setMobilePanelOpen(false)} /> : null}
            <SecurityPanel lastReceivedText={lastReceivedText} open={detailsOpen} onClose={() => { playUiSound("open"); setDetailsOpen(false); }} locale={locale} profile={profile} recipient={recipient} session={session} t={t} />
          </>
        ) : activeView === "groups" ? (
          <GroupWorkspace locale={locale} profile={profile} session={session} t={t} />
        ) : activeView === "settings" ? (
          <SettingsWorkspace
            locale={locale}
            motionEnabled={motionEnabled}
            soundEnabled={soundEnabled}
            wallpaper={wallpaper}
            onMotionChange={(enabled) => { setMotionEnabled(enabled); localStorage.setItem("covechat-motion", enabled ? "on" : "off"); }}
            onSoundChange={(enabled) => { setSoundEnabled(enabled); setUiSoundsEnabled(enabled); }}
            onWallpaperChange={(next) => { setWallpaper(next); localStorage.setItem("covechat-wallpaper", next); }}
          />
        ) : (
          <ProfileWorkspace locale={locale} profile={profile} session={session} />
        )}
      </div>
      {noticeOpen ? (
        <aside className="preview-notice">
          <FlaskConical />
          <div><strong>{t("experimentalPreview")}</strong><span>{t("notAudited")}</span></div>
          <button className="notice-action" onClick={() => setSecurityModelOpen(true)}>{t("readSecurityModel")}</button>
          <button className="icon-button" onClick={() => setNoticeOpen(false)} aria-label={t("dismissNotice")}><X /></button>
        </aside>
      ) : null}
      {securityModelOpen ? (
        <div className="security-model-backdrop" role="presentation" onMouseDown={() => setSecurityModelOpen(false)}>
          <section className="security-model-dialog" role="dialog" aria-modal="true" aria-labelledby="security-model-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div className="security-model-icon"><ShieldCheck aria-hidden="true" /></div>
              <div><span>{t("experimentalPreview")}</span><h2 id="security-model-title">{t("securityModelTitle")}</h2></div>
              <IconButton aria-label={t("closeSecurityModel")} onClick={() => setSecurityModelOpen(false)}><X /></IconButton>
            </header>
            <p className="security-model-lead">{t("securityModelLead")}</p>
            <div className="security-model-grid">
              <article><LockKeyhole /><div><strong>{t("securityModelProtects")}</strong><p>{t("securityModelProtectsBody")}</p></div></article>
              <article><ShieldCheck /><div><strong>{t("securityModelLimits")}</strong><p>{t("securityModelLimitsBody")}</p></div></article>
              <article><CheckCircle2 /><div><strong>{t("safetyNumberMeaning")}</strong><p>{t("safetyNumberMeaningBody")}</p></div></article>
            </div>
            <aside className="security-model-warning"><FlaskConical /><span>{t("notAudited")}</span></aside>
            <Button onClick={() => setSecurityModelOpen(false)}>{t("understood")}</Button>
          </section>
        </div>
      ) : null}
      {updateReady ? (
        <aside className="preview-notice update-notice" role="status">
          <ShieldCheck />
          <div><strong>{t("securityUpdateReady")}</strong><span>{t("securityUpdateBody")}</span></div>
          <button className="update-action" onClick={() => window.dispatchEvent(new Event(PWA_APPLY_UPDATE_EVENT))}>{t("reloadNow")}</button>
          <button className="icon-button" onClick={() => setUpdateReady(false)} aria-label={t("later")}><X /></button>
        </aside>
      ) : null}
    </div>
  );
}

export function App() {
  return (
    <DeploymentGate>
      <SecurityGate>{({ profile, session }) => <ChatApp profile={profile} session={session} />}</SecurityGate>
    </DeploymentGate>
  );
}
