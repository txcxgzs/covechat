import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BellOff, CheckCheck, CircleHelp, FileText, FlaskConical, Image,
  LockKeyhole, Menu, MessageCircle, Paperclip, Plus, Search, Send,
  Languages, Settings, ShieldCheck, Smile, Trash2, UserRound, UsersRound, X
} from "lucide-react";
import { getConversations, getSeedMessages, type Message } from "./data";
import { copy, detectLocale, type Locale, type Translate } from "./i18n";
import { SecurityGate } from "./security/SecurityGate";
import type { SecureProfile } from "./security/vault";
import type { AttachmentReference, AuthSession, DeviceRecord } from "@covechat/protocol";
import { listOwnDevices, revokeOwnDevice } from "./security/api";
import {
  downloadAndDecryptAttachment,
  encryptAndUploadAttachment,
} from "./security/attachments";
import {
  addGroupMember,
  createEncryptedGroup,
  listEncryptedGroups,
  receiveEncryptedGroupMessages,
  sendEncryptedGroupText,
} from "./security/groups";
import {
  receiveEncryptedTexts,
  sendEncryptedText,
  subscribeEncryptedMailbox,
} from "./security/signal";

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

function ConversationList({ locale, t }: { locale: Locale; t: Translate }) {
  const [query, setQuery] = useState("");
  const conversations = useMemo(() => getConversations(locale), [locale]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? conversations.filter((item) => `${item.name} ${item.preview}`.toLowerCase().includes(normalized))
      : conversations;
  }, [query]);

  return (
    <aside className="conversations">
      <div className="section-heading">
        <div><span className="eyeline">{t("privateWorkspace")}</span><h1>{t("messages")}</h1></div>
        <button className="icon-button" aria-label={t("newConversation")}><Plus /></button>
      </div>
      <button className="new-button"><Plus />{t("newConversation")}</button>
      <label className="search">
        <Search aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchConversations")} />
      </label>
      <div className="conversation-scroll">
        {filtered.map((item) => (
          <button className={item.id === "maya" ? "conversation selected" : "conversation"} key={item.id}>
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

function Chat({ locale, onDetails, profile, session, t }: {
  locale: Locale;
  onDetails: () => void;
  profile: SecureProfile;
  session: AuthSession;
  t: Translate;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [recipient, setRecipient] = useState("");
  const [attachments, setAttachments] = useState<AttachmentReference[]>([]);
  const [attachmentStatus, setAttachmentStatus] = useState("");
  useEffect(() => {
    let active = true;
    async function refresh() {
      const received = await receiveEncryptedTexts(profile, session);
      if (!active || received.length === 0) return;
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [
          ...current,
          ...received.filter((message) => !known.has(message.envelopeId)).map((message) => ({
            id: message.envelopeId,
            from: "them" as const,
            text: message.body,
            time: new Intl.DateTimeFormat(locale, {
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(message.createdAt)),
            delivered: true,
          })),
        ];
      });
    }
    void refresh();
    const unsubscribe = subscribeEncryptedMailbox(session, () => void refresh());
    return () => {
      active = false;
      unsubscribe();
    };
  }, [locale, profile, session]);

  async function sendText(text: string) {
    if (!/^[a-z0-9_]{3,32}$/u.test(recipient)) {
      setAttachmentStatus(t("vaultError"));
      return;
    }
    try {
      await sendEncryptedText(profile, session, recipient, text);
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        from: "me",
        text,
        time: new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date()),
        delivered: true,
      }]);
      setAttachmentStatus("");
    } catch (error) {
      setAttachmentStatus(
        error instanceof Error ? error.message : t("vaultError"),
      );
    }
  }
  async function uploadAttachment(file: File) {
    setAttachmentStatus(t("attachmentUploading"));
    try {
      const reference = await encryptAndUploadAttachment(file, session);
      setAttachments((current) => [...current, reference]);
      setAttachmentStatus("");
    } catch {
      setAttachmentStatus(t("attachmentFailed"));
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
        onRecipientChange={setRecipient}
        recipient={recipient}
        t={t}
      />
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
      const created = await createEncryptedGroup(profile, groupName);
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
                <span><LockKeyhole /> {t("mlsProtocol")} · {selected.memberDeviceIds.length} {t("groupMembers")}</span>
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

function SecurityPanel({ open, onClose, locale, profile, session, t }: {
  open: boolean;
  onClose: () => void;
  locale: Locale;
  profile: SecureProfile;
  session: AuthSession;
  t: Translate;
}) {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [deviceError, setDeviceError] = useState("");
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
    if (open) void refreshDevices();
  }, [open, session.accessToken]);
  const revoke = async (deviceId: string) => {
    if (!window.confirm(zh ? "确认撤销这台设备？撤销后它将无法登录或接收新消息。" : "Revoke this device? It will no longer sign in or receive new messages.")) return;
    try {
      await revokeOwnDevice(deviceId, session);
      await refreshDevices();
    } catch {
      setDeviceError(zh ? "设备撤销失败" : "Device revocation failed");
    }
  };
  return (
    <aside className={open ? "security-panel open" : "security-panel"} aria-label="Conversation security">
      <button className="close-details icon-button" onClick={onClose} aria-label={t("closeSecurityDetails")}><X /></button>
      <div className="security-person">
        <span className="avatar avatar-large">{profile.username.slice(0, 2).toUpperCase()}</span>
        <h2>{profile.username}</h2>
        <span><LockKeyhole /> {t("endToEndEncrypted")}</span>
      </div>
      <section className="security-section">
        <h3><ShieldCheck />{t("securityOverview")}</h3>
        <p>{t("securityOverviewBody")}</p>
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
  const [activeView, setActiveView] = useState<"messages" | "groups">("messages");
  useEffect(() => {
    localStorage.setItem("covechat.locale", locale);
    document.documentElement.lang = locale;
    document.title = locale === "zh-CN"
      ? "CoveChat — 实验性安全软件"
      : "CoveChat — Experimental security software";
  }, [locale]);
  return (
    <div className="app">
      <div className="workspace">
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
            <ConversationList key={`conversations-${locale}`} locale={locale} t={t} />
            <Chat
              key={`chat-${locale}`}
              locale={locale}
              profile={profile}
              session={session}
              onDetails={() => setDetailsOpen(true)}
              t={t}
            />
            <SecurityPanel open={detailsOpen} onClose={() => setDetailsOpen(false)} locale={locale} profile={profile} session={session} t={t} />
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
    </div>
  );
}

export function App() {
  return <SecurityGate>{({ profile, session }) => <ChatApp profile={profile} session={session} />}</SecurityGate>;
}
