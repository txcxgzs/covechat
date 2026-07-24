import { FormEvent, type CSSProperties, type ReactNode, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BellOff, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Copy as CopyIcon, FileText, FileWarning, FlaskConical, Image,
  LockKeyhole, Menu, MessageCircle, Palette, PanelLeft, PanelLeftClose, Paperclip, Plus, Search, Send,
  Languages, Reply, Settings, ShieldCheck, Smile, Sparkles, Trash2, UserRound, UsersRound, Volume2, VolumeX, X
} from "lucide-react";
import type { Conversation, Message } from "./data";
import { copy, detectLocale, type Locale, type Translate } from "./i18n";
import { PWA_APPLY_UPDATE_EVENT, PWA_UPDATE_READY_EVENT } from "./pwa-updates";
import { SecurityGate } from "./security/SecurityGate";
import { DeploymentGate } from "./deployment/DeploymentGate";
import { type SecureProfile } from "./security/vault";
import type { AttachmentReference, AuthSession, DeviceRecord } from "@covechat/protocol";
import {
  listBlockedUsers,
  listOwnDevices,
  lookupDirectory,
  revokeOwnDevice,
  selfHealDeviceSignature,
  setUserBlocked,
  submitAbuseReport,
} from "./security/api";
import { identityVerification, markIdentityVerified } from "./security/trust";
import {
  appendConversationHistory,
  listConversationHistories,
  loadConversationHistory,
  markConversationRead,
  markMessageDelivered,
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
  groupMemberUsername,
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
  sendDeliveryReceipt,
  sendEncryptedAttachment,
  sendEncryptedText,
  subscribeEncryptedMailbox,
} from "./security/signal";
import { playUiSound, setUiSoundsEnabled, uiSoundsEnabled } from "./ui-feedback";
import { createReplyReference, type ReplyReference } from "./security/message-content";
import { installUiRipple } from "./ui-ripple";
import { Button, IconButton } from "./ui-controls";
import { ContactsWorkspace } from "./ContactsWorkspace";
import { ProfileWorkspace } from "./ProfileWorkspace";
import { isConversationMuted, setConversationMuted } from "./conversation-preferences";

/// 将字节数格式化为人类可读的 KB/MB 字符串。
/// 用于附件上传进度显示。1024 进制，保留 1 位小数（< 1KB 时显示整数）。
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type AppView = "messages" | "contacts" | "groups" | "settings" | "profile";
type WallpaperStyle = "cove" | "plain" | "midnight";
const NOOP_SELECT_MESSAGE = () => undefined;

function Navigation({ collapsed, locale, t, onLocaleChange, onToggleCollapse, profileName, activeView, onViewChange, soundEnabled, onSoundToggle }: {
  collapsed: boolean;
  locale: Locale;
  t: Translate;
  onLocaleChange: () => void;
  onToggleCollapse: () => void;
  profileName?: string;
  activeView: AppView;
  onViewChange: (view: AppView) => void;
  soundEnabled: boolean;
  onSoundToggle: () => void;
}) {
  const nav = [
    { id: "messages" as const, label: t("messages"), icon: MessageCircle },
    { id: "contacts" as const, label: t("contacts"), icon: UserRound },
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
      <button className="nav-item nav-collapse-toggle" onClick={onToggleCollapse} aria-label={collapsed ? (locale === "zh-CN" ? "展开侧栏" : "Expand sidebar") : (locale === "zh-CN" ? "收起侧栏" : "Collapse sidebar")} title={collapsed ? (locale === "zh-CN" ? "展开侧栏" : "Expand sidebar") : (locale === "zh-CN" ? "收起侧栏" : "Collapse sidebar")}>
        {collapsed ? <PanelLeft aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        <span>{collapsed ? (locale === "zh-CN" ? "展开" : "Expand") : (locale === "zh-CN" ? "收起" : "Collapse")}</span>
      </button>
    </nav>
  );
}

function MobileBottomNavigation({ activeView, onViewChange, t }: {
  activeView: AppView;
  onViewChange: (view: AppView) => void;
  t: Translate;
}) {
  const items: Array<{ view: AppView; label: string; icon: ReactNode }> = [
    { view: "messages", label: t("messages"), icon: <MessageCircle /> },
    { view: "contacts", label: t("contacts"), icon: <UserRound /> },
    { view: "groups", label: t("groups"), icon: <UsersRound /> },
    { view: "settings", label: t("settings"), icon: <Settings /> },
    { view: "profile", label: t("profile"), icon: <ShieldCheck /> },
  ];
  return <nav className="mobile-bottom-navigation" aria-label={t("mobileNavigation")}>
    {items.map((item) => <button key={item.view} className={activeView === item.view ? "active" : ""} aria-current={activeView === item.view ? "page" : undefined} onClick={() => { playUiSound("navigate"); onViewChange(item.view); }}>{item.icon}<span>{item.label}</span></button>)}
  </nav>;
}

function ConversationList({ historyRevision, locale, navCollapsed, onExpandNav, onNew, onSelect, profile, recipient, t }: {
  historyRevision: number;
  locale: Locale;
  navCollapsed: boolean;
  onExpandNav: () => void;
  onNew: () => void;
  onSelect: (username: string) => void;
  profile: SecureProfile;
  recipient: string;
  t: Translate;
}) {
  const [query, setQuery] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  useEffect(() => {
    void listConversationHistories(profile).then((items) => setConversations(items.map(({ username, latest, unread }) => ({
      id: username,
      name: username,
      initials: username.slice(0, 2).toUpperCase(),
      preview: latest?.body ?? (latest?.attachment ? `🔒 ${latest.attachment.fileName}` : ""),
      time: latest ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(latest.createdAt)) : "",
      unread,
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
        {navCollapsed ? <IconButton className="nav-expand-trigger" aria-label={locale === "zh-CN" ? "展开侧栏" : "Expand sidebar"} onClick={onExpandNav}><Menu /></IconButton> : null}
        <h1>{t("messages")}</h1>
        <IconButton className="new-conversation-trigger" aria-label={t("newConversation")} onClick={onNew}><Plus /></IconButton>
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

function ChatHeader({ muted, onDetails, onMenu, onMuteToggle, onNewConversation, onSearchToggle, recipient, searchOpen, t }: {
  muted: boolean;
  onDetails: () => void;
  onMenu: () => void;
  onMuteToggle: () => void;
  onNewConversation: () => void;
  onSearchToggle: () => void;
  recipient: string;
  searchOpen: boolean;
  t: Translate;
}) {
  return (
    <header className="chat-header">
      <IconButton className="mobile-menu" aria-label={t("openNavigation")} onClick={onMenu}><Menu /></IconButton>
      <span className="avatar">{recipient.slice(0, 2).toUpperCase() || "CC"}</span>
      <div className="chat-title">
        <strong>{recipient ? `@${recipient}` : t("messages")}</strong>
        <span>{recipient ? <><LockKeyhole /> {t("endToEndEncrypted")}</> : t("newConversation")}</span>
      </div>
      <div className="header-actions">
        {recipient ? <>
          <IconButton className={searchOpen ? "active" : ""} aria-label={t("searchConversation")} aria-pressed={searchOpen} onClick={onSearchToggle}><Search /></IconButton>
          <IconButton className={muted ? "active" : ""} aria-label={muted ? t("unmuteConversation") : t("muteConversation")} aria-pressed={muted} onClick={onMuteToggle}>{muted ? <VolumeX /> : <BellOff />}</IconButton>
          <IconButton aria-label={t("showSecurityDetails")} onClick={onDetails}><CircleHelp /></IconButton>
        </> : <Button size="small" icon={<Plus />} onClick={onNewConversation}>{t("newConversation")}</Button>}
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

function InteractiveMessage({ activeSearchMatch = false, locale, message, onDownloadAttachment, onReply, onReport, onSelect = NOOP_SELECT_MESSAGE, searchMatch = false, selected = false, selectionMode = false }: {
  activeSearchMatch?: boolean;
  locale: Locale;
  message: Message;
  onReply: (message: Message) => void;
  onReport?: (message: Message) => void;
  onSelect?: (messageId: string) => void;
  onDownloadAttachment?: (attachment: import("@covechat/protocol").AttachmentReference) => void;
  searchMatch?: boolean;
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
      className={`message-row ${message.from} interactive-message ${selected ? "message-selected" : ""} ${searchMatch ? "message-search-match" : ""} ${activeSearchMatch ? "message-search-active" : ""}`}
      data-message-id={message.id}
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
      {message.text || message.replyTo ? (
        <div className="bubble">
          {message.replyTo ? <blockquote data-reply-id={message.replyTo.messageId}>{message.replyTo.excerpt}</blockquote> : null}
          {message.text ? <p>{message.text}</p> : null}
          <footer><time>{message.time}</time>{message.from === "me" ? (message.delivered ? <Check aria-label={isChinese ? "已发送" : "Sent"} /> : <LockKeyhole aria-label={isChinese ? "已加密" : "Encrypted"} />) : null}</footer>
        </div>
      ) : null}
      {message.attachment ? (
        <div className="bubble attachment-bubble">
          <strong><LockKeyhole /> {isChinese ? "加密附件" : "Encrypted attachment"}</strong>
          <p>{message.attachment.fileName}</p>
          <small>{new Intl.NumberFormat(locale).format(message.attachment.plaintextSize)} bytes</small>
          {onDownloadAttachment ? (
            <button type="button" onClick={() => onDownloadAttachment(message.attachment!)}>
              {isChinese ? "下载并解密" : "Download & Decrypt"}
            </button>
          ) : null}
          {!(message.text || message.replyTo) ? (
            <footer><time>{message.time}</time>{message.from === "me" ? (message.delivered ? <Check aria-label={isChinese ? "已发送" : "Sent"} /> : <LockKeyhole aria-label={isChinese ? "已加密" : "Encrypted"} />) : null}</footer>
          ) : null}
        </div>
      ) : null}
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

function Chat({ locale, onDetails, onHistoryChange, onMenu, onNewConversation, onReceivedText, profile, recipient, session, t }: {
  locale: Locale;
  onDetails: () => void;
  onMenu: () => void;
  onNewConversation: () => void;
  profile: SecureProfile;
  session: AuthSession;
  t: Translate;
  recipient: string;
  onReceivedText: (text: string) => void;
  onHistoryChange: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyTo, setReplyTo] = useState<Message>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const [disappearAfter, setDisappearAfter] = useState(0);
  const [disappearDropdownOpen, setDisappearDropdownOpen] = useState(false);
  const disappearRef = useRef<HTMLDivElement>(null);
  // 附件上传进度（null=无上传进行中）。上传完成或失败后清空。
  const [uploadProgress, setUploadProgress] = useState<{
    uploadedChunks: number;
    chunkCount: number;
    uploadedBytes: number;
    totalBytes: number;
  } | null>(null);
  // 上传失败时保留待重试的文件；重试成功或取消后清空。
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [reportCandidate, setReportCandidate] = useState<Message>();
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery.trim().toLocaleLowerCase(locale));
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [muted, setMuted] = useState(() => isConversationMuted(profile.username, recipient));
  const mutedRef = useRef(muted);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchMatches = useMemo(() => deferredSearchQuery
    ? messages.filter((message) => message.text.toLocaleLowerCase(locale).includes(deferredSearchQuery)).map((message) => message.id)
    : [], [deferredSearchQuery, locale, messages]);
  const activeSearchId = searchMatches[Math.min(activeSearchIndex, Math.max(0, searchMatches.length - 1))];

  useEffect(() => {
    setMuted(isConversationMuted(profile.username, recipient));
    setSearchOpen(false); setSearchQuery(""); setActiveSearchIndex(0);
  }, [profile.username, recipient]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => searchInput.current?.focus());
  }, [searchOpen]);

  function navigateSearch(direction: -1 | 1) {
    if (searchMatches.length === 0) return;
    const next = (activeSearchIndex + direction + searchMatches.length) % searchMatches.length;
    setActiveSearchIndex(next);
    document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(searchMatches[next])}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function toggleMute() {
    if (!recipient) return;
    const next = !muted;
    setConversationMuted(profile.username, recipient, next);
    setMuted(next);
    setAttachmentStatus(next ? t("conversationMuted") : t("conversationUnmuted"));
    playUiSound("success");
  }
  useEffect(() => {
    setSelectedIds(new Set());
    setReplyTo(undefined);
    if (!/^[a-z0-9_]{3,32}$/u.test(recipient)) {
      setMessages([]);
      return;
    }
    void loadConversationHistory(profile, recipient).then(async (history) => {
      setMessages(history.filter((item) => item.body || item.attachment).map((item) => ({
        id: item.id,
        from: item.from,
        text: item.body || "",
        time: new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(item.createdAt)),
        delivered: item.delivered ?? false,
        expiresAt: item.expiresAt,
        replyTo: item.reply,
        attachment: item.attachment,
      })));
      const latestIncoming = history.filter((item) => item.from === "them").at(-1)?.createdAt;
      if (latestIncoming) {
        await markConversationRead(profile, recipient, latestIncoming);
        onHistoryChange();
      }
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
    };
    const timer = window.setInterval(prune, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    async function refresh() {
      const received = await receiveEncryptedTexts(profile, session);
      if (!active || received.length === 0) return;
      const newlyDeliveredIds = new Set<string>();
      for (const message of received) {
        if (message.receiptMessageId) {
          const updated = await markMessageDelivered(profile, message.senderUsername, message.receiptMessageId);
          if (updated && message.senderUsername === recipient) {
            newlyDeliveredIds.add(message.receiptMessageId);
          }
          continue;
        }

        if (message.messageId) {
          sendDeliveryReceipt(profile, session, message.senderUsername, message.messageId).catch(() => undefined);
        }

        await appendConversationHistory(profile, message.senderUsername, {
          id: message.envelopeId,
          from: "them",
          body: message.body,
          attachment: message.attachment,
          createdAt: message.createdAt,
          expiresAt: message.expiresAt,
          reply: message.reply,
          delivered: true, // we received it
        });
      }

      if (newlyDeliveredIds.size > 0) {
        setMessages((current) => current.map((m) => newlyDeliveredIds.has(m.id) ? { ...m, delivered: true } : m));
      }

      const visible = received.filter((message) => !message.receiptMessageId && message.senderUsername === recipient);
      const latestVisible = visible.at(-1)?.createdAt;
      if (latestVisible) await markConversationRead(profile, recipient, latestVisible);
      onHistoryChange();
      void syncEncryptedBackup(profile, session).catch(() => undefined);
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [
          ...current,
          ...visible.filter((message) => (message.body || message.attachment) && !known.has(message.envelopeId)).map((message) => ({
            id: message.envelopeId,
            from: "them" as const,
            text: message.body || "",
            time: new Intl.DateTimeFormat(locale, {
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(message.createdAt)),
            delivered: true,
            expiresAt: message.expiresAt,
            replyTo: message.reply,
            attachment: message.attachment,
          })),
        ];
      });
      const lastText = [...visible].reverse().find((message) => message.body)?.body;
      if (lastText) {
        onReceivedText(lastText);
        if (!mutedRef.current) playUiSound("receive");
      }
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
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      const expiresAt = disappearAfter ? createdAt + disappearAfter * 1000 : undefined;
      await sendEncryptedText(profile, session, recipient, id, text, disappearAfter || undefined, reply);
      
      await appendConversationHistory(profile, recipient, {
        id,
        from: "me",
        body: text,
        createdAt,
        expiresAt,
        reply,
        delivered: false,
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
        delivered: false,
        expiresAt,
        replyTo: reply,
      }]);
      playUiSound("send");
      setAttachmentStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : t("vaultError");
      // 签名损坏错误包含用户名信息，提取并给出中文/英文提示
      if (message.includes("invalid authorization signature")) {
        const zh = locale === "zh-CN";
        setAttachmentStatus(
          zh
            ? `对方设备签名损坏，无法发送。请对方升级并解锁一次以自动修复。 (${message})`
            : `Peer device signature is invalid, cannot send. The peer must upgrade and unlock once to self-heal. (${message})`,
        );
      } else {
        setAttachmentStatus(message);
      }
    }
  }
  async function reportMessage(message: Message) {
    setReportCandidate(message);
  }
  async function submitReport() {
    if (!reportCandidate) return;
    try {
      await submitAbuseReport(profile, session, recipient, JSON.stringify({ message: reportCandidate.text, messageId: reportCandidate.id }), "user-selected message");
      setAttachmentStatus(locale === "zh-CN" ? "举报已提交" : "Report submitted");
    } catch { setAttachmentStatus(locale === "zh-CN" ? "举报提交失败" : "Report submission failed"); }
    finally { setReportCandidate(undefined); }
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
      const id = crypto.randomUUID();
      const attachmentExpiry = Math.floor(Date.now() / 1000) + (disappearAfter || 30 * 24 * 60 * 60);
      const reference = await encryptAndUploadAttachment(file, profile, session, attachmentExpiry, (progress) => {
        setUploadProgress(progress);
      });
      await sendEncryptedAttachment(profile, session, recipient, id, reference, disappearAfter || undefined);
      await appendConversationHistory(profile, recipient, {
        id,
        from: "me",
        attachment: reference,
        createdAt: Date.now(),
        expiresAt: disappearAfter ? Date.now() + disappearAfter * 1000 : undefined,
        delivered: false,
      });
      onHistoryChange();
      void syncEncryptedBackup(profile, session).catch(() => undefined);
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
        muted={muted}
        onDetails={onDetails}
        onMenu={onMenu}
        onMuteToggle={toggleMute}
        onNewConversation={onNewConversation}
        onSearchToggle={() => setSearchOpen((open) => !open)}
        recipient={recipient}
        searchOpen={searchOpen}
        t={t}
      />
      {searchOpen ? <div className="conversation-search-bar" role="search"><Search /><input ref={searchInput} aria-label={t("searchConversation")} value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setActiveSearchIndex(0); }} placeholder={t("searchMessagesPlaceholder")} /><span>{searchQuery ? (searchMatches.length ? t("searchResultCount").replace("{current}", String(Math.min(activeSearchIndex + 1, searchMatches.length))).replace("{total}", String(searchMatches.length)) : t("noSearchResults")) : ""}</span><IconButton aria-label={t("previousSearchResult")} disabled={searchMatches.length === 0} onClick={() => navigateSearch(-1)}><ChevronRight className="search-previous" /></IconButton><IconButton aria-label={t("nextSearchResult")} disabled={searchMatches.length === 0} onClick={() => navigateSearch(1)}><ChevronRight /></IconButton><IconButton aria-label={t("closeSearch")} onClick={() => { setSearchOpen(false); setSearchQuery(""); }}><X /></IconButton></div> : null}
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
      {recipient ? <div className="disappearing-control">
        <LockKeyhole />
        <span className="disappearing-label">{locale === "zh-CN" ? "定时消失" : "Disappearing messages"}</span>
        <div className="disappear-dropdown" ref={disappearRef}>
          <button className="disappear-trigger" onClick={() => setDisappearDropdownOpen((prev) => !prev)} aria-expanded={disappearDropdownOpen} aria-haspopup="listbox">
            <span>{disappearAfter === 0 ? (locale === "zh-CN" ? "关闭" : "Off") : disappearAfter === 3600 ? (locale === "zh-CN" ? "1 小时" : "1 hour") : disappearAfter === 86400 ? (locale === "zh-CN" ? "1 天" : "1 day") : (locale === "zh-CN" ? "7 天" : "7 days")}</span>
            <ChevronDown aria-hidden="true" />
          </button>
          {disappearDropdownOpen ? <>
            <div className="disappear-dropdown-backdrop" onClick={() => setDisappearDropdownOpen(false)} />
            <div className="disappear-dropdown-menu" role="listbox">
              {([{ value: 0, label: locale === "zh-CN" ? "关闭" : "Off" }, { value: 3600, label: locale === "zh-CN" ? "1 小时" : "1 hour" }, { value: 86400, label: locale === "zh-CN" ? "1 天" : "1 day" }, { value: 604800, label: locale === "zh-CN" ? "7 天" : "7 days" }] as const).map((opt) => (
                <button key={opt.value} className={disappearAfter === opt.value ? "active" : ""} role="option" aria-selected={disappearAfter === opt.value} onClick={() => { playUiSound("navigate"); setDisappearAfter(opt.value); setDisappearDropdownOpen(false); }}>
                  {opt.label}
                  {disappearAfter === opt.value ? <Check aria-hidden="true" /> : null}
                </button>
              ))}
            </div>
          </> : null}
        </div>
      </div> : null}
      <section className="messages" aria-label="Encrypted conversation" aria-live="polite">
        {recipient ? <div className="date-rule"><span>{t("today")}</span></div> : (
          <div className="conversation-empty-state">
            <span className="conversation-empty-icon"><MessageCircle /></span>
            <h2>{locale === "zh-CN" ? "开始一段私密对话" : "Start a private conversation"}</h2>
            <p>{locale === "zh-CN" ? "通过对方的用户名查找联系人。用户名只用于发现，消息内容仍保持端到端加密。" : "Find someone by username. Usernames are only for discovery; message content remains end-to-end encrypted."}</p>
            <Button icon={<Plus />} onClick={onNewConversation}>{t("newConversation")}</Button>
          </div>
        )}
        {messages.map((message) => <InteractiveMessage
          key={message.id}
          locale={locale}
          message={message}
          searchMatch={searchMatches.includes(message.id)}
          activeSearchMatch={message.id === activeSearchId}
          onReply={setReplyTo}
          onReport={reportMessage}
          onSelect={toggleMessageSelection}
          onDownloadAttachment={downloadAttachment}
          selected={selectedIds.has(message.id)}
          selectionMode={selectedIds.size > 0}
        />)}
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
      {recipient ? <Composer
        t={t}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(undefined)}
        onAttachment={(file) => void uploadAttachment(file)}
        onSend={(text, reply) => void sendText(text, reply)}
      /> : null}
      {reportCandidate ? <div className="account-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReportCandidate(undefined); }}><section className="account-dialog compact-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="report-message-title"><IconButton className="account-dialog-close" aria-label={locale === "zh-CN" ? "关闭" : "Close"} onClick={() => setReportCandidate(undefined)}><X /></IconButton><span className="dialog-symbol danger-symbol"><FileWarning /></span><h2 id="report-message-title">{locale === "zh-CN" ? "举报这条消息？" : "Report this message?"}</h2><p>{locale === "zh-CN" ? "只有你主动确认后，这条消息的明文才会提交给管理员审核。其他聊天内容不会被附带。" : "Only this message plaintext is disclosed to administrators after you confirm. No other conversation content is included."}</p><blockquote className="report-message-preview">{reportCandidate.text}</blockquote><footer><Button variant="secondary" onClick={() => setReportCandidate(undefined)}>{locale === "zh-CN" ? "取消" : "Cancel"}</Button><Button variant="danger" icon={<FileWarning />} onClick={() => void submitReport()}>{locale === "zh-CN" ? "确认举报" : "Submit report"}</Button></footer></section></div> : null}
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
  const [mobileGroupsOpen, setMobileGroupsOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message>();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pendingGroupAction, setPendingGroupAction] = useState<{ kind: "remove" | "transfer" | "leave"; memberDeviceId?: string }>();
  const groupTextInput = useRef<HTMLTextAreaElement>(null);
  const groupNameInput = useRef<HTMLInputElement>(null);
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
      setMobileGroupsOpen(false);
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
              delivered: false,
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
    if (!selected) return;
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
    try {
      await requestEncryptedGroupLeave(profile, session, selected.groupId);
      setStatus(t("leaveRequestSent"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("vaultError"));
    }
  }

  return (
    <main className={`group-workspace ${detailsOpen ? "group-details-open" : ""} ${mobileGroupsOpen ? "mobile-groups-open" : ""}`}>
      <aside className="group-sidebar">
        <header className="group-sidebar-heading">
          <div><h1>{t("groups")}</h1><span>{t("mlsProtocol")}</span></div>
          <span className="group-sidebar-actions"><span className="group-count">{availableGroups.length}</span><IconButton className="group-list-close" aria-label={t("closeGroupList")} onClick={() => setMobileGroupsOpen(false)}><X /></IconButton></span>
        </header>
        <form className="group-create" onSubmit={(event) => void createGroup(event)}>
          <input
            ref={groupNameInput}
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
              onClick={() => { playUiSound("navigate"); setSelectedGroupId(group.groupId); setDetailsOpen(false); setMobileGroupsOpen(false); }}
            >
              <span className="group-list-avatar"><UsersRound /></span>
              <span>
                <strong>{group.name}</strong>
                <small><LockKeyhole /> {t("groupEpoch")} {group.epoch} · {group.memberDeviceIds.length} {t("groupMembers")}</small>
              </span>
            </button>
          ))}
          {availableGroups.length === 0 ? <p className="group-list-empty">{locale === "zh-CN" ? "创建后，群组会显示在这里" : "Your groups will appear here after creation"}</p> : null}
        </div>
      </aside>
      {mobileGroupsOpen ? <button className="group-mobile-scrim" aria-label={t("closeGroupList")} onClick={() => setMobileGroupsOpen(false)} /> : null}
      <section className="group-chat">
        {selected ? (
          <>
            <header className="chat-header">
              <button className="mobile-menu icon-button" aria-label={t("openGroupList")} onClick={() => setMobileGroupsOpen(true)}><Menu /></button>
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
        ) : (
          <div className="group-empty">
            <span className="group-empty-icon"><UsersRound /></span>
            <span className="eyeline">{t("mlsProtocol")}</span>
            <h2>{locale === "zh-CN" ? "创建你的第一个加密群组" : "Create your first encrypted group"}</h2>
            <p>{locale === "zh-CN" ? "群组消息使用 MLS 端到端加密。先为群组命名，创建后即可邀请成员并开始聊天。" : "Group messages use MLS end-to-end encryption. Name the group, then invite members and start chatting."}</p>
            <ol>
              <li>{locale === "zh-CN" ? "输入群组名称" : "Enter a group name"}</li>
              <li>{locale === "zh-CN" ? "创建并邀请成员" : "Create it and invite members"}</li>
              <li>{locale === "zh-CN" ? "核对成员后开始聊天" : "Verify members and start chatting"}</li>
            </ol>
            <Button icon={<Plus />} onClick={() => { setMobileGroupsOpen(true); requestAnimationFrame(() => groupNameInput.current?.focus()); }}>{t("createGroup")}</Button>
          </div>
        )}
      </section>
      {selected ? (
        <aside className={`group-details ${detailsOpen ? "open" : ""}`} aria-hidden={!detailsOpen}>
          <header className="group-details-header">
            <strong>{t("groupAdmin")}</strong>
            <button className="icon-button" aria-label={t("closeGroupDetails")} onClick={() => setDetailsOpen(false)}><X /></button>
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
                  const username = groupMemberUsername(selected, memberDeviceId) ?? (isSelf ? profile.username : undefined);
                  return (
                    <li key={memberDeviceId} className="member-item">
                      <span className="member-avatar"><UserRound /></span>
                      <span className="member-copy"><strong>{username ? `@${username}` : t("unknownGroupMember")}</strong><small>{isSelf ? t("currentGroupMember") : t("encryptedGroupMember")}</small></span>
                      {memberIsAdmin ? <em className="admin-tag">{t("youAreAdmin")}</em> : null}
                       {isAdmin && !isSelf ? <span className="member-actions"><button className="transfer-admin-btn" onClick={() => setPendingGroupAction({ kind: "transfer", memberDeviceId })}>{t("transferAdmin")}</button><button className="remove-member-btn" onClick={() => setPendingGroupAction({ kind: "remove", memberDeviceId })}><Trash2 /></button></span> : null}
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
            <section className="leave-group-section"><button className="leave-group-btn" onClick={() => {
              if (isAdmin) setStatus(t("adminTransferBeforeLeave"));
              else setPendingGroupAction({ kind: "leave" });
            }}>{t("leaveGroup")}</button></section>
          </div>
        </aside>
      ) : null}
      {pendingGroupAction ? <div className="account-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingGroupAction(undefined); }}><section className="account-dialog compact-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="group-action-title"><IconButton className="account-dialog-close" aria-label={locale === "zh-CN" ? "关闭" : "Close"} onClick={() => setPendingGroupAction(undefined)}><X /></IconButton><span className="dialog-symbol danger-symbol">{pendingGroupAction.kind === "transfer" ? <ShieldCheck /> : <Trash2 />}</span><h2 id="group-action-title">{pendingGroupAction.kind === "remove" ? t("removeMemberConfirm") : pendingGroupAction.kind === "transfer" ? t("transferAdminConfirm") : t("leaveGroupConfirm")}</h2><p>{locale === "zh-CN" ? (pendingGroupAction.kind === "remove" ? "移除后，该成员将无法解密群组的新消息；已有设备上的历史内容不会被远程擦除。" : pendingGroupAction.kind === "transfer" ? "转让后，对方将获得成员管理权限，你仍保留普通群成员身份。" : "离开后，你将不再接收群组的新消息。此操作不会删除其他成员的会话。") : (pendingGroupAction.kind === "remove" ? "The member will no longer decrypt new group messages. Existing local history is not remotely erased." : pendingGroupAction.kind === "transfer" ? "The member receives administration privileges and you remain a regular member." : "You will stop receiving new group messages. Other members keep the conversation.")}</p><footer><Button variant="secondary" onClick={() => setPendingGroupAction(undefined)}>{locale === "zh-CN" ? "取消" : "Cancel"}</Button><Button variant={pendingGroupAction.kind === "transfer" ? "primary" : "danger"} onClick={() => {
        const action = pendingGroupAction;
        setPendingGroupAction(undefined);
        if (action.kind === "remove" && action.memberDeviceId) void removeMember(action.memberDeviceId);
        else if (action.kind === "transfer" && action.memberDeviceId) void transferAdministration(action.memberDeviceId);
        else void leaveGroup();
      }}>{locale === "zh-CN" ? "确认操作" : "Confirm"}</Button></footer></section></div> : null}
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
  const [pendingSafetyAction, setPendingSafetyAction] = useState<{ kind: "revoke" | "report"; deviceId?: string }>();
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
    if (!lastReceivedText) return;
    try {
      await submitAbuseReport(profile, session, recipient, JSON.stringify({ message: lastReceivedText }), "user-selected latest received message");
      setActionStatus(zh ? "举报已提交" : "Report submitted");
    } catch {
      setActionStatus(zh ? "举报提交失败" : "Report submission failed");
    }
  };
  return <>
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
              <button className="icon-button" onClick={() => setPendingSafetyAction({ kind: "revoke", deviceId: device.deviceId })} title={zh ? "撤销设备" : "Revoke device"}><Trash2 /></button>
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
            <button className="verify danger" disabled={!lastReceivedText} onClick={() => setPendingSafetyAction({ kind: "report" })}>{zh ? "举报最近收到的消息" : "Report latest received message"}</button>
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
    {pendingSafetyAction ? createPortal(<div className="account-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingSafetyAction(undefined); }}><section className="account-dialog compact-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="safety-action-title"><IconButton className="account-dialog-close" aria-label={zh ? "关闭" : "Close"} onClick={() => setPendingSafetyAction(undefined)}><X /></IconButton><span className="dialog-symbol danger-symbol">{pendingSafetyAction.kind === "revoke" ? <Trash2 /> : <FileWarning />}</span><h2 id="safety-action-title">{pendingSafetyAction.kind === "revoke" ? (zh ? "撤销这台设备？" : "Revoke this device?") : (zh ? "举报最近收到的消息？" : "Report the latest received message?")}</h2><p>{pendingSafetyAction.kind === "revoke" ? (zh ? "撤销后，该设备将立即失去登录和接收新消息的能力。当前设备不受影响。" : "The device immediately loses sign-in and new-message access. This device is unaffected.") : (zh ? "只有最近收到的这条消息明文会主动提交给管理员审核，其他会话内容不会被附带。" : "Only the latest received message plaintext is disclosed to administrators. No other conversation content is included.")}</p><footer><Button variant="secondary" onClick={() => setPendingSafetyAction(undefined)}>{zh ? "取消" : "Cancel"}</Button><Button variant="danger" icon={pendingSafetyAction.kind === "revoke" ? <Trash2 /> : <FileWarning />} onClick={() => {
      const action = pendingSafetyAction;
      setPendingSafetyAction(undefined);
      if (action.kind === "revoke" && action.deviceId) void revoke(action.deviceId);
      else void report();
    }}>{zh ? "确认操作" : "Confirm"}</Button></footer></section></div>, document.body) : null}
  </>;
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

function NewConversationDialog({ locale, onClose, onSelect, session }: {
  locale: Locale;
  onClose: () => void;
  onSelect: (username: string) => void;
  session: AuthSession;
}) {
  const zh = locale === "zh-CN";
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/u.test(normalized)) {
      setError(zh ? "请输入 3–32 位小写字母、数字或下划线" : "Use 3–32 lowercase letters, numbers, or underscores");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await lookupDirectory(normalized, session);
      onSelect(normalized);
    } catch {
      setError(zh ? "没有找到这个用户名，请核对后重试" : "Username not found. Check it and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="account-dialog-backdrop new-conversation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="account-dialog new-conversation-dialog" role="dialog" aria-modal="true" aria-labelledby="new-conversation-title">
        <IconButton className="account-dialog-close" aria-label={zh ? "关闭" : "Close"} onClick={onClose}><X /></IconButton>
        <span className="dialog-symbol"><MessageCircle /></span>
        <h2 id="new-conversation-title">{zh ? "新建私密会话" : "New private conversation"}</h2>
        <p>{zh ? "输入对方注册时设置的用户名。我们会先确认用户存在，再打开端到端加密会话。" : "Enter their registered username. CoveChat verifies the account before opening an encrypted conversation."}</p>
        <form onSubmit={submit}>
          <label className={`designed-field ${error ? "has-error" : ""}`}>
            <span>{zh ? "用户名" : "Username"}</span>
            <span className="designed-field-control"><span className="field-prefix">@</span><input autoFocus autoComplete="off" spellCheck={false} value={username} onChange={(event) => { setUsername(event.target.value.toLowerCase()); setError(""); }} placeholder="alice_01" /></span>
            <small>{error || (zh ? "用户名由小写字母、数字和下划线组成" : "Lowercase letters, numbers, and underscores")}</small>
          </label>
          <footer><Button type="button" variant="secondary" onClick={onClose}>{zh ? "取消" : "Cancel"}</Button><Button type="submit" loading={loading} disabled={!username.trim()}>{zh ? "查找并开始" : "Find and start"}</Button></footer>
        </form>
      </section>
    </div>
  );
}

function ChatApp({ profile, session }: { profile: SecureProfile; session: AuthSession }) {
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const t: Translate = (key) => copy[locale][key];
  const [detailsOpen, setDetailsOpen] = useState(
    false,
  );
  const [noticeOpen, setNoticeOpen] = useState(true);
  const [securityModelOpen, setSecurityModelOpen] = useState(false);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("messages");
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [lastReceivedText, setLastReceivedText] = useState<string>();
  const [historyRevision, setHistoryRevision] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(uiSoundsEnabled);
  const [motionEnabled, setMotionEnabled] = useState(() => localStorage.getItem("covechat-motion") !== "off");
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem("covechat-nav-collapsed") === "true");
  const [wallpaper, setWallpaper] = useState<WallpaperStyle>(() => {
    const stored = localStorage.getItem("covechat-wallpaper");
    return stored === "plain" || stored === "midnight" ? stored : "cove";
  });
  useEffect(() => installUiRipple(), []);
  // 运行时自愈：用户可能在旧版前端已经解锁过，SecurityGate 的 unlock 自愈没有执行。
  // ChatApp mount 时主动检查自己的设备签名，损坏则自动修复。
  // 这是升级历史脏数据的最后防线——不需要用户重新解锁。
  useEffect(() => {
    void selfHealDeviceSignature(profile, session).catch((error) => {
      console.warn("runtime self-heal failed", error);
    });
  }, [profile, session]);
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
      <div className={`${detailsOpen ? "workspace security-open" : "workspace"} ${mobilePanelOpen ? "mobile-panel-open" : ""} ${navCollapsed ? "nav-collapsed" : ""}`}>
        <Navigation
          collapsed={navCollapsed}
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
          onViewChange={(view) => { setActiveView(view); setMobilePanelOpen(false); }}
          onToggleCollapse={() => { playUiSound("navigate"); setNavCollapsed((prev) => { const next = !prev; localStorage.setItem("covechat-nav-collapsed", String(next)); return next; }); }}
        />
        {activeView === "messages" ? (
          <>
            <ConversationList historyRevision={historyRevision} key={`conversations-${locale}`} locale={locale} navCollapsed={navCollapsed} onExpandNav={() => { playUiSound("navigate"); setNavCollapsed(false); localStorage.setItem("covechat-nav-collapsed", "false"); }} onNew={() => setNewConversationOpen(true)} onSelect={(username) => {
              playUiSound("navigate");
              setRecipient(username);
              setMobilePanelOpen(false);
            }} profile={profile} recipient={recipient} t={t} />
            <Chat
              key={`chat-${locale}`}
              locale={locale}
              profile={profile}
              recipient={recipient}
              session={session}
              onNewConversation={() => setNewConversationOpen(true)}
              onReceivedText={setLastReceivedText}
              onHistoryChange={handleHistoryChange}
              onMenu={() => { playUiSound("open"); setMobilePanelOpen(true); }}
              onDetails={() => { playUiSound("open"); setDetailsOpen(true); }}
              t={t}
            />
            {mobilePanelOpen ? <button className="mobile-panel-scrim" aria-label={locale === "zh-CN" ? "关闭菜单" : "Close menu"} onClick={() => setMobilePanelOpen(false)} /> : null}
            <SecurityPanel lastReceivedText={lastReceivedText} open={detailsOpen} onClose={() => { playUiSound("open"); setDetailsOpen(false); }} locale={locale} profile={profile} recipient={recipient} session={session} t={t} />
          </>
        ) : activeView === "contacts" ? (
          <ContactsWorkspace locale={locale} session={session} username={profile.username} onChat={(username) => { setRecipient(username); setActiveView("messages"); }} />
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
        <MobileBottomNavigation activeView={activeView} onViewChange={(view) => { setActiveView(view); setMobilePanelOpen(false); setDetailsOpen(false); }} t={t} />
      </div>
      {newConversationOpen ? <NewConversationDialog locale={locale} session={session} onClose={() => setNewConversationOpen(false)} onSelect={(username) => {
        setRecipient(username);
        setActiveView("messages");
        setMobilePanelOpen(false);
        setNewConversationOpen(false);
      }} /> : null}
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
