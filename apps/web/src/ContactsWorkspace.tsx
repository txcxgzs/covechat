import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Check, Clock3, Copy, MessageCircle, RefreshCw, Search, Trash2, UserPlus, UserRound, UsersRound, X } from "lucide-react";
import type { AuthSession } from "@covechat/protocol";
import type { Locale } from "./i18n";
import { Button, IconButton } from "./ui-controls";
import {
  acceptContactRequest, listContactRequests, listContacts, lookupDirectory, removeContact,
  removeContactRequest, sendContactRequest, type ContactRequests, type ContactSummary,
} from "./security/api";

const EMPTY_REQUESTS: ContactRequests = { incoming: [], outgoing: [] };

export function ContactsWorkspace({ locale, onChat, session, username }: {
  locale: Locale; onChat: (username: string) => void; session: AuthSession; username: string;
}) {
  const zh = locale === "zh-CN";
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [requests, setRequests] = useState<ContactRequests>(EMPTY_REQUESTS);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState("");
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [pendingRemoval, setPendingRemoval] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextContacts, nextRequests] = await Promise.all([listContacts(session), listContactRequests(session)]);
      setContacts(nextContacts); setRequests(nextRequests);
    } catch { setStatus(zh ? "无法读取联系人，请稍后重试" : "Unable to load contacts. Try again."); }
    finally { setLoading(false); }
  }, [session.accessToken, zh]);
  useEffect(() => { void refresh(); }, [refresh]);

  const visibleContacts = useMemo(() => {
    const normalized = filter.trim().toLowerCase();
    return normalized ? contacts.filter((contact) => contact.username.includes(normalized)) : contacts;
  }, [contacts, filter]);

  async function searchUser(event: FormEvent) {
    event.preventDefault();
    const normalized = query.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/u.test(normalized)) { setStatus(zh ? "用户名只能包含小写字母、数字和下划线，长度 3–32" : "Use 3–32 lowercase letters, numbers, or underscores"); return; }
    if (normalized === username) { setStatus(zh ? "这是你自己的用户名" : "That is your own username"); return; }
    try { await lookupDirectory(normalized, session); setSearchResult(normalized); setStatus(""); }
    catch { setSearchResult(""); setStatus(zh ? "没有找到这个用户名" : "Username not found"); }
  }

  async function add(usernameToAdd: string) {
    try {
      const result = await sendContactRequest(usernameToAdd, session);
      setStatus(result.status === "accepted" ? (zh ? "对方也申请过你，已自动成为好友" : "Mutual request accepted") : result.status === "contact" ? (zh ? "你们已经是好友" : "Already a contact") : (zh ? "好友申请已发送" : "Friend request sent"));
      setSearchResult(""); setQuery(""); await refresh();
    } catch (reason) { setStatus(reason instanceof Error && reason.message === "contact-forbidden" ? (zh ? "无法向该用户发送申请" : "Cannot send a request to this user") : (zh ? "好友申请发送失败" : "Friend request failed")); }
  }

  async function accept(other: string) { await acceptContactRequest(other, session); await refresh(); }
  async function dismiss(other: string) { await removeContactRequest(other, session); await refresh(); }
  async function remove(other: string) {
    await removeContact(other, session); await refresh();
    setPendingRemoval("");
  }

  return <main className="contacts-workspace">
    <header className="contacts-hero">
      <div><span className="eyeline">CONTACTS</span><h1>{zh ? "联系人" : "Contacts"}</h1><p>{zh ? "通过唯一用户名建立联系，再开始端到端加密聊天。" : "Connect by unique username, then start an end-to-end encrypted chat."}</p></div>
      <div className="contacts-hero-actions"><Button variant="secondary" icon={<RefreshCw />} loading={loading} onClick={() => void refresh()}>{zh ? "刷新" : "Refresh"}</Button><div className="my-username"><span>{zh ? "我的用户名" : "My username"}</span><strong>@{username}</strong><IconButton aria-label={zh ? "复制用户名" : "Copy username"} onClick={() => void navigator.clipboard.writeText(username)}><Copy /></IconButton></div></div>
    </header>
    <div className="contacts-layout">
      <section className="contact-discovery">
        <div className="contact-card-heading"><span><UserPlus /></span><div><h2>{zh ? "添加好友" : "Add a friend"}</h2><p>{zh ? "输入对方注册时选择的完整用户名" : "Enter their exact registered username"}</p></div></div>
        <form className="contact-search" onSubmit={searchUser}><Search /><input aria-label={zh ? "搜索用户名" : "Search username"} value={query} onChange={(event) => setQuery(event.target.value.toLowerCase())} placeholder="alice_01" /><Button type="submit">{zh ? "查找" : "Find"}</Button></form>
        {searchResult ? <div className="contact-result"><span className="avatar">{searchResult.slice(0, 2).toUpperCase()}</span><div><strong>@{searchResult}</strong><small>{zh ? "已注册 CoveChat" : "Registered on CoveChat"}</small></div><Button icon={<UserPlus />} onClick={() => void add(searchResult)}>{zh ? "发送申请" : "Send request"}</Button></div> : null}
        {status ? <p className="contact-status" role="status">{status}</p> : null}
      </section>

      <section className="contact-requests-card">
        <div className="contact-card-heading"><span><Clock3 /></span><div><h2>{zh ? "好友申请" : "Friend requests"}</h2><p>{requests.incoming.length ? (zh ? `${requests.incoming.length} 个申请等待处理` : `${requests.incoming.length} waiting`) : (zh ? "没有待处理申请" : "Nothing pending")}</p></div></div>
        <div className="request-columns"><div><h3>{zh ? "收到的" : "Incoming"}</h3>{requests.incoming.map((request) => <div className="request-row" key={request.username}><span className="avatar avatar-small">{request.username.slice(0, 2).toUpperCase()}</span><strong>@{request.username}</strong><IconButton aria-label={zh ? "接受" : "Accept"} onClick={() => void accept(request.username)}><Check /></IconButton><IconButton aria-label={zh ? "拒绝" : "Decline"} onClick={() => void dismiss(request.username)}><X /></IconButton></div>)}{!requests.incoming.length ? <p>{zh ? "收到申请后会显示在这里" : "Incoming requests appear here"}</p> : null}</div><div><h3>{zh ? "已发出的" : "Outgoing"}</h3>{requests.outgoing.map((request) => <div className="request-row" key={request.username}><span className="avatar avatar-small">{request.username.slice(0, 2).toUpperCase()}</span><strong>@{request.username}</strong><span>{zh ? "等待中" : "Pending"}</span><IconButton aria-label={zh ? "取消申请" : "Cancel request"} onClick={() => void dismiss(request.username)}><X /></IconButton></div>)}{!requests.outgoing.length ? <p>{zh ? "没有等待中的申请" : "No outgoing requests"}</p> : null}</div></div>
      </section>

      <section className="contacts-list-card">
        <div className="contacts-list-heading"><div className="contact-card-heading"><span><UsersRound /></span><div><h2>{zh ? "我的好友" : "My friends"}</h2><p>{contacts.length} {zh ? "位联系人" : "contacts"}</p></div></div><label><Search /><input aria-label={zh ? "筛选好友" : "Filter contacts"} value={filter} onChange={(event) => setFilter(event.target.value.toLowerCase())} placeholder={zh ? "筛选好友" : "Filter contacts"} /></label></div>
        <div className="contacts-grid">{visibleContacts.map((contact) => <article key={contact.username}><span className="avatar">{contact.username.slice(0, 2).toUpperCase()}</span><div><strong>@{contact.username}</strong><small>{zh ? "端到端加密联系人" : "End-to-end encrypted contact"}</small></div><Button size="small" icon={<MessageCircle />} onClick={() => onChat(contact.username)}>{zh ? "发消息" : "Message"}</Button><IconButton aria-label={zh ? "删除好友" : "Remove friend"} onClick={() => setPendingRemoval(contact.username)}><Trash2 /></IconButton></article>)}{!loading && !visibleContacts.length ? <div className="contacts-empty"><UserRound /><strong>{filter ? (zh ? "没有匹配的好友" : "No matching contacts") : (zh ? "还没有好友" : "No contacts yet")}</strong><p>{zh ? "在上方输入对方的用户名，发送第一个好友申请。" : "Search for a username above to send your first request."}</p></div> : null}</div>
      </section>
    </div>
    {pendingRemoval ? <div className="account-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingRemoval(""); }}><section className="account-dialog compact-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-contact-title"><IconButton className="account-dialog-close" aria-label={zh ? "关闭" : "Close"} onClick={() => setPendingRemoval("")}><X /></IconButton><span className="dialog-symbol danger-symbol"><Trash2 /></span><h2 id="remove-contact-title">{zh ? `删除好友 @${pendingRemoval}？` : `Remove @${pendingRemoval}?`}</h2><p>{zh ? "这会从联系人列表中移除对方，但不会删除本设备已有的历史消息。以后仍可重新发送好友申请。" : "This removes the person from contacts without deleting message history on this device. You can send another request later."}</p><footer><Button variant="secondary" onClick={() => setPendingRemoval("")}>{zh ? "取消" : "Cancel"}</Button><Button variant="danger" icon={<Trash2 />} onClick={() => void remove(pendingRemoval)}>{zh ? "删除好友" : "Remove friend"}</Button></footer></section></div> : null}
  </main>;
}
