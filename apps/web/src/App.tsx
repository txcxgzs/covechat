import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BellOff, CheckCheck, CircleHelp, FileText, FlaskConical, Image,
  LockKeyhole, Menu, MessageCircle, Paperclip, Plus, Search, Send,
  Languages, Settings, ShieldCheck, Smile, UserRound, UsersRound, X
} from "lucide-react";
import { getConversations, getSeedMessages, type Message } from "./data";
import { copy, detectLocale, type Locale, type Translate } from "./i18n";
import { SecurityGate } from "./security/SecurityGate";
import type { SecureProfile } from "./security/vault";
import type { AttachmentReference, AuthSession } from "@covechat/protocol";
import {
  downloadAndDecryptAttachment,
  encryptAndUploadAttachment,
} from "./security/attachments";
import {
  receiveEncryptedTexts,
  sendEncryptedText,
  subscribeEncryptedMailbox,
} from "./security/signal";

function Navigation({ locale, t, onLocaleChange, profileName }: {
  locale: Locale;
  t: Translate;
  onLocaleChange: () => void;
  profileName?: string;
}) {
  const nav = [
    { label: t("messages"), icon: MessageCircle, active: true },
    { label: t("contacts"), icon: UserRound },
    { label: t("groups"), icon: UsersRound },
    { label: t("settings"), icon: Settings },
  ];
  return (
    <nav className="navigation" aria-label="Primary">
      <div className="brand"><ShieldCheck aria-hidden="true" /><span>CoveChat</span></div>
      <div className="nav-items">
        {nav.map(({ label, icon: Icon, active }) => (
          <button className={active ? "nav-item active" : "nav-item"} key={label} title={label}>
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

function SecurityPanel({ open, onClose, t }: { open: boolean; onClose: () => void; t: Translate }) {
  const [verified, setVerified] = useState(false);
  return (
    <aside className={open ? "security-panel open" : "security-panel"} aria-label="Conversation security">
      <button className="close-details icon-button" onClick={onClose} aria-label={t("closeSecurityDetails")}><X /></button>
      <div className="security-person">
        <span className="avatar avatar-large">MC</span>
        <h2>Maya Chen</h2>
        <span><LockKeyhole /> {t("endToEndEncrypted")}</span>
      </div>
      <section className="security-section">
        <h3><ShieldCheck />{t("securityOverview")}</h3>
        <p>{t("securityOverviewBody")}</p>
      </section>
      <section className="security-section">
        <h3><ShieldCheck />{t("verifySafetyNumber")}</h3>
        <p>{t("verifySafetyNumberBody")}</p>
        <code className="safety-number">7421 9286 3195 8204<br />1127 6654 9910 5733</code>
        <button className={verified ? "verify verified" : "verify"} onClick={() => setVerified(true)}>
          {verified ? <><CheckCheck /> {t("safetyNumberVerified")}</> : t("verifySafetyNumber")}
        </button>
      </section>
      <section className="security-section details">
        <h3><LockKeyhole />{t("encryptionDetails")}</h3>
        <dl><dt>{t("protocol")}</dt><dd>{t("unavailablePreview")}</dd><dt>{t("identityKey")}</dt><dd>3A:7F:2B:9C:41:0E:7D:6A</dd></dl>
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
  useEffect(() => {
    localStorage.setItem("covechat.locale", locale);
    document.documentElement.lang = locale;
    document.title = locale === "zh-CN"
      ? "CoveChat — 实验性安全预览"
      : "CoveChat — Experimental security preview";
  }, [locale]);
  return (
    <div className="app">
      <div className="workspace">
        <Navigation locale={locale} t={t} profileName={profile.username} onLocaleChange={() => setLocale((current) => current === "zh-CN" ? "en" : "zh-CN")} />
        <ConversationList key={`conversations-${locale}`} locale={locale} t={t} />
        <Chat
          key={`chat-${locale}`}
          locale={locale}
          profile={profile}
          session={session}
          onDetails={() => setDetailsOpen(true)}
          t={t}
        />
        <SecurityPanel open={detailsOpen} onClose={() => setDetailsOpen(false)} t={t} />
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
