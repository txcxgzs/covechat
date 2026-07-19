import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BellOff, CheckCheck, CircleHelp, FileText, FlaskConical, Image,
  LockKeyhole, Menu, MessageCircle, Paperclip, Plus, Search, Send,
  Languages, Settings, ShieldCheck, Smile, Trash2, UserRound, UsersRound, X
} from "lucide-react";
import type { Conversation, Message } from "./data";
import { copy, detectLocale, type Locale, type Translate } from "./i18n";
import { PWA_APPLY_UPDATE_EVENT, PWA_UPDATE_READY_EVENT } from "./pwa-updates";
import { SecurityGate } from "./security/SecurityGate";
import { type SecureProfile } from "./security/vault";
import type { AttachmentReference, AuthSession, DeviceRecord } from "@covechat/protocol";
import {
  listBlockedUsers,
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

/// 将字节数格式化为人类可读的 KB/MB 字符串。
/// 用于附件上传进度显示。1024 进制，保留 1 位小数（< 1KB 时显示整数）。
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Navigation({ locale, t, onLocaleChange, profileName, activeView, onViewChange }: {
  locale: Locale;
  t: Translate;
  onLocaleChange: () => void;
  profileName?: string;
  activeView: "messages" | "groups";
  onViewChange: (view: "messages" | "groups") => void;
}) {
  const nav = [
    { id: "messages" as const, label: t("messages"), icon: MessageCircle },
    { id: "groups" as const, label: t("groups"), icon: UsersRound },
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
            onClick={() => onViewChange(id)}
          >
            <Icon aria-hidden="true" /><span>{label}</span>
          </button>
        ))}
      </div>
      <button className="nav-item language" onClick={onLocaleChange} aria-label={t("switchLanguage")}>
        <Languages aria-hidden="true" /><span>{locale === "zh-CN" ? "English" : "中文"}</span>
      </button>
      <button className="profile" aria-label={t("openProfile")}>
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
        <div><span className="eyeline">{t("privateWorkspace")}</span><h1>{t("messages")}</h1></div>
        <button className="icon-button" aria-label={t("newConversation")} onClick={() => onSelect("")}><Plus /></button>
      </div>
      <button className="new-button" onClick={() => onSelect("")}><Plus />{t("newConversation")}</button>
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

function ChatHeader({ onDetails, recipient, onRecipientChange, t }: {
  onDetails: () => void;
  recipient: string;
  onRecipientChange: (value: string) => void;
  t: Translate;
}) {
  return (
    <header className="chat-header">
      <button className="mobile-menu icon-button" aria-label={t("openNavigation")}><Menu /></button>
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
        <button className="icon-button" aria-label={t("searchConversation")}><Search /></button>
        <button className="icon-button" aria-label={t("muteConversation")}><BellOff /></button>
        <button className="icon-button" aria-label={t("showSecurityDetails")} onClick={onDetails}><CircleHelp /></button>
      </div>
    </header>
  );
}

function Composer({ onSend, onAttachment, t }: {
  onSend: (message: string) => void;
  onAttachment: (file: File) => void;
  t: Translate;
}) {
  const [draft, setDraft] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    onSend(value);
    setDraft("");
  }
  return (
    <form className="composer" onSubmit={submit}>
      <textarea aria-label={t("messageMaya")} placeholder={t("messageMaya")} value={draft}
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
          <button type="button" className="icon-button" aria-label={t("attachFile")} onClick={() => fileInput.current?.click()}><Paperclip /></button>
          <button type="button" className="icon-button" aria-label={t("attachImage")} onClick={() => imageInput.current?.click()}><Image /></button>
          <button type="button" className="icon-button" aria-label={t("insertDocument")} onClick={() => fileInput.current?.click()}><FileText /></button>
        </div>
        <div>
          <button type="button" className="icon-button" aria-label={t("chooseEmoji")}><Smile /></button>
          <button className="send" aria-label={t("sendMessage")} disabled={!draft.trim()}><Send /></button>
        </div>
      </div>
    </form>
  );
}

function Chat({ locale, onDetails, onHistoryChange, onReceivedText, onRecipientChange, profile, recipient, session, t }: {
  locale: Locale;
  onDetails: () => void;
  profile: SecureProfile;
  session: AuthSession;
  t: Translate;
  recipient: string;
  onRecipientChange: (recipient: string) => void;
  onReceivedText: (text: string) => void;
  onHistoryChange: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
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
      })));
      setAttachments(history.flatMap((item) => item.attachment ? [item.attachment] : []));
    });
  }, [locale, profile, recipient]);
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
          })),
        ];
      });
      const lastText = [...visible].reverse().find((message) => message.body)?.body;
      if (lastText) onReceivedText(lastText);
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

  async function sendText(text: string) {
    if (!/^[a-z0-9_]{3,32}$/u.test(recipient)) {
      setAttachmentStatus(t("vaultError"));
      return;
    }
    try {
      await sendEncryptedText(profile, session, recipient, text, disappearAfter || undefined);
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      const expiresAt = disappearAfter ? createdAt + disappearAfter * 1000 : undefined;
      await appendConversationHistory(profile, recipient, {
        id,
        from: "me",
        body: text,
        createdAt,
        expiresAt,
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
      }]);
      setAttachmentStatus("");
    } catch (error) {
      setAttachmentStatus(
        error instanceof Error ? error.message : t("vaultError"),
      );
    }
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
        onRecipientChange={onRecipientChange}
        recipient={recipient}
        t={t}
      />
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
        {messages.map((message) => (
          <article className={`message-row ${message.from}`} key={message.id}>
            {message.from === "them" ? <span className="avatar avatar-small">MC</span> : null}
            <div className="bubble">
              <p>{message.text}</p>
              <footer><time>{message.time}</time>{message.delivered ? <CheckCheck aria-label={t("delivered")} /> : <LockKeyhole aria-label={t("encrypted")} />}</footer>
            </div>
          </article>
        ))}
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
        onAttachment={(file) => void uploadAttachment(file)}
        onSend={(text) => void sendText(text)}
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
  const [messages, setMessages] = useState<Message[]>([]);
  const selected = availableGroups.find((group) => group.groupId === selectedGroupId);
  // 当前设备是否为该群管理员（控制移除成员、邀请策略等管理 UI 的可见性）
  const isAdmin = selected ? isGroupAdmin(profile, selected.groupId) : false;

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
      setMessages((current) => [
        ...current,
        ...received.map((message) => ({
          id: message.envelopeId,
          from: "them" as const,
          text: message.body,
          time: new Intl.DateTimeFormat(locale, {
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(message.createdAt)),
          delivered: true,
        })),
      ]);
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
    const body = draft.trim();
    try {
      await sendEncryptedGroupText(profile, session, selected.groupId, body);
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        from: "me",
        text: body,
        time: new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date()),
        delivered: true,
      }]);
      setDraft("");
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
    <main className="group-workspace">
      <aside className="group-sidebar">
        <header><h1>{t("groups")}</h1><span>{t("mlsProtocol")}</span></header>
        <form onSubmit={(event) => void createGroup(event)}>
          <input
            aria-label={t("groupName")}
            placeholder={t("groupName")}
            required
            maxLength={80}
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
          />
          <button><Plus /> {t("createGroup")}</button>
        </form>
        <div className="group-list">
          {availableGroups.map((group) => (
            <button
              className={group.groupId === selectedGroupId ? "selected" : ""}
              key={group.groupId}
              onClick={() => setSelectedGroupId(group.groupId)}
            >
              <UsersRound />
              <span>
                <strong>{group.name}</strong>
                <small>{t("groupEpoch")} {group.epoch}</small>
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
              <span className="avatar"><UsersRound /></span>
              <div className="chat-title">
                <strong>{selected.name}</strong>
                <span>
                  <LockKeyhole /> {t("mlsProtocol")} · {selected.memberDeviceIds.length} {t("groupMembers")}
                  {isAdmin ? <em className="admin-badge"> · {t("youAreAdmin")}</em> : null}
                </span>
              </div>
              <form className="group-invite" onSubmit={(event) => void invite(event)}>
                <input
                  aria-label={t("groupMemberUsername")}
                  placeholder={t("groupMemberUsername")}
                  pattern="[a-z0-9_]{3,32}"
                  required
                  value={inviteUsername}
                  onChange={(event) => setInviteUsername(event.target.value.toLowerCase())}
                />
                <button>{t("addMember")}</button>
              </form>
            </header>
            {/* 群管理面板：成员列表 + 邀请策略 + 退出群组 */}
            <details className="group-admin-panel">
              <summary>{t("groupAdmin")}</summary>
              <div className="group-admin-body">
                <section className="member-list-section">
                  <h3>{t("memberList")}</h3>
                  <ul className="member-list">
                    {selected.memberDeviceIds.map((memberDeviceId) => {
                      const memberIsAdmin = (selected.adminDeviceIds ?? []).includes(memberDeviceId);
                      const isSelf = memberDeviceId === profile.deviceId;
                      return (
                        <li key={memberDeviceId} className="member-item">
                          <span className="member-id">{memberDeviceId.slice(0, 8)}</span>
                          {memberIsAdmin ? <em className="admin-tag">{t("youAreAdmin")}</em> : null}
                          {isSelf ? <em className="self-tag">·</em> : null}
                          {/* 管理员可移除其他成员；不能移除自己 */}
                          {isAdmin && !isSelf ? (
                            <span className="member-actions">
                              <button
                                className="transfer-admin-btn"
                                onClick={() => void transferAdministration(memberDeviceId)}
                              >
                                {t("transferAdmin")}
                              </button>
                              <button
                                className="remove-member-btn"
                                onClick={() => void removeMember(memberDeviceId)}
                              >
                                {t("removeMember")}
                              </button>
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
                {/* 邀请策略切换：仅管理员可见 */}
                {isAdmin ? (
                  <section className="invite-policy-section">
                    <h3>{t("invitePolicy")}</h3>
                    <label>
                      <input
                        type="radio"
                        name={`invite-policy-${selected.groupId}`}
                        checked={(selected.invitePolicy ?? "admins") === "anyone"}
                        disabled
                        onChange={() => void changeInvitePolicy("anyone")}
                      />
                      {t("invitePolicyAnyone")}
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`invite-policy-${selected.groupId}`}
                        checked={(selected.invitePolicy ?? "admins") === "admins"}
                        onChange={() => void changeInvitePolicy("admins")}
                      />
                      {t("invitePolicyAdmins")}
                    </label>
                  </section>
                ) : null}
                <section className="leave-group-section">
                  <button className="leave-group-btn" onClick={() => void leaveGroup()}>
                    {t("leaveGroup")}
                  </button>
                </section>
              </div>
            </details>
            <section className="messages" aria-live="polite">
              {messages.map((message) => (
                <article className={`message-row ${message.from}`} key={message.id}>
                  <div className="bubble">
                    <p>{message.text}</p>
                    <footer><time>{message.time}</time><CheckCheck /></footer>
                  </div>
                </article>
              ))}
              {status ? <p className="attachment-status" role="status">{status}</p> : null}
            </section>
            <form className="composer group-composer" onSubmit={(event) => void send(event)}>
              <textarea
                aria-label={t("messageMaya")}
                placeholder={t("messageMaya")}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button className="send" aria-label={t("sendMessage")} disabled={!draft.trim()}><Send /></button>
            </form>
          </>
        ) : <div className="group-empty"><UsersRound /><p>{t("selectGroup")}</p></div>}
      </section>
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

function ChatApp({ profile, session }: { profile: SecureProfile; session: AuthSession }) {
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const t: Translate = (key) => copy[locale][key];
  const [detailsOpen, setDetailsOpen] = useState(
    () => window.matchMedia("(min-width: 1161px)").matches,
  );
  const [noticeOpen, setNoticeOpen] = useState(true);
  const [updateReady, setUpdateReady] = useState(false);
  const [activeView, setActiveView] = useState<"messages" | "groups">("messages");
  const [recipient, setRecipient] = useState("");
  const [lastReceivedText, setLastReceivedText] = useState<string>();
  const [historyRevision, setHistoryRevision] = useState(0);
  const handleHistoryChange = useCallback(() => {
    setHistoryRevision((current) => current + 1);
  }, []);
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
  return (
    <div className="app">
      <div className={detailsOpen ? "workspace security-open" : "workspace"}>
        <Navigation
          activeView={activeView}
          locale={locale}
          t={t}
          profileName={profile.username}
          onLocaleChange={() => setLocale((current) => current === "zh-CN" ? "en" : "zh-CN")}
          onViewChange={setActiveView}
        />
        {activeView === "messages" ? (
          <>
            <ConversationList historyRevision={historyRevision} key={`conversations-${locale}`} locale={locale} onSelect={setRecipient} profile={profile} recipient={recipient} t={t} />
            <Chat
              key={`chat-${locale}`}
              locale={locale}
              profile={profile}
              recipient={recipient}
              session={session}
              onRecipientChange={setRecipient}
              onReceivedText={setLastReceivedText}
              onHistoryChange={handleHistoryChange}
              onDetails={() => setDetailsOpen(true)}
              t={t}
            />
            <SecurityPanel lastReceivedText={lastReceivedText} open={detailsOpen} onClose={() => setDetailsOpen(false)} locale={locale} profile={profile} recipient={recipient} session={session} t={t} />
          </>
        ) : (
          <GroupWorkspace locale={locale} profile={profile} session={session} t={t} />
        )}
      </div>
      {noticeOpen ? (
        <aside className="preview-notice">
          <FlaskConical />
          <div><strong>{t("experimentalPreview")}</strong><span>{t("notAudited")}</span></div>
          <a href="/security">{t("readSecurityModel")}</a>
          <button className="icon-button" onClick={() => setNoticeOpen(false)} aria-label={t("dismissNotice")}><X /></button>
        </aside>
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
  return <SecurityGate>{({ profile, session }) => <ChatApp profile={profile} session={session} />}</SecurityGate>;
}
