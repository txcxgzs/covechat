import { FormEvent, useCallback, useEffect, useState } from "react";
import { Activity, FileWarning, LogOut, RefreshCw, ShieldCheck, Trash2, UsersRound, X } from "lucide-react";
import { Button, IconButton } from "./ui-controls";

type Overview = { accounts: number; activeDevices: number; pendingReports: number; suspendedAccounts: number };
type Account = { username: string; createdAt: number; deviceCount: number; activeDevices: number; suspended: boolean; suspensionReason?: string };
type Device = { deviceId: string; username: string; createdAt: number; revokedAt?: number; prekeyVersion: number };
type Report = { reportId: string; reportedUsername: string; payload: { disclosedMessageBundle?: string; context?: string }; status: string; resolutionNote?: string; createdAt: number };
type Audit = { auditId: string; action: string; target: string; detail: unknown; createdAt: number };
type Tab = "overview" | "accounts" | "reports" | "audit";
type AdminAction =
  | { kind: "suspend"; account: Account }
  | { kind: "resolve"; report: Report; status: "resolved" | "dismissed" }
  | { kind: "revoke"; device: Device }
  | null;

async function managementFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/management${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init?.headers },
  });
  if (!response.ok) throw new Error(response.status === 401 ? "管理员令牌错误" : `请求失败（${response.status}）`);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function AdminApp() {
  const [token, setToken] = useState(() => sessionStorage.getItem("covechat-admin-token") ?? "");
  const [draftToken, setDraftToken] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Overview>();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<AdminAction>(null);
  const [actionNote, setActionNote] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const refresh = useCallback(async (activeToken = token) => {
    if (!activeToken) return;
    setLoading(true);
    try {
      const [nextOverview, nextAccounts, nextDevices, nextReports, nextAudit] = await Promise.all([
        managementFetch<Overview>("/overview", activeToken), managementFetch<Account[]>("/accounts", activeToken),
        managementFetch<Device[]>("/devices", activeToken), managementFetch<Report[]>("/reports", activeToken), managementFetch<Audit[]>("/audit", activeToken),
      ]);
      setOverview(nextOverview); setAccounts(nextAccounts); setDevices(nextDevices); setReports(nextReports); setAudit(nextAudit); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取后台数据"); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function login(event: FormEvent) {
    event.preventDefault();
    sessionStorage.setItem("covechat-admin-token", draftToken);
    setToken(draftToken);
    await refresh(draftToken);
  }
  function logout() { sessionStorage.removeItem("covechat-admin-token"); setToken(""); setDraftToken(""); }
  async function performAction() {
    if (!action) return;
    setActionLoading(true);
    try {
      if (action.kind === "suspend") {
        if (!action.account.suspended && !actionNote.trim()) return;
        await managementFetch(`/accounts/${encodeURIComponent(action.account.username)}/suspension`, token, action.account.suspended ? { method: "DELETE" } : { method: "POST", body: JSON.stringify({ reason: actionNote.trim() }) });
      } else if (action.kind === "resolve") {
        await managementFetch(`/reports/${action.report.reportId}/resolve`, token, { method: "POST", body: JSON.stringify({ status: action.status, note: actionNote.trim() }) });
      } else {
        await managementFetch(`/devices/${action.device.deviceId}/revoke`, token, { method: "POST" });
      }
      setAction(null); setActionNote(""); await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试");
    } finally {
      setActionLoading(false);
    }
  }

  if (!token || (error && !overview)) return <main className="admin-login"><form onSubmit={login}><ShieldCheck /><h1>CoveChat 管理控制台</h1><p>后台地址只是额外隐藏层，管理员令牌才是实际访问凭证。</p><label>管理员令牌<input type="password" autoComplete="current-password" value={draftToken} onChange={(event) => setDraftToken(event.target.value)} minLength={32} required /></label>{error ? <p role="alert">{error}</p> : null}<Button type="submit" loading={loading}>安全登录</Button><a href="/">返回聊天系统</a></form></main>;

  return <div className="admin-shell">
    <aside><div className="admin-brand"><ShieldCheck />CoveChat</div>{(["overview", "accounts", "reports", "audit"] as Tab[]).map((item) => <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{item === "overview" ? <Activity /> : item === "accounts" ? <UsersRound /> : item === "reports" ? <FileWarning /> : <ShieldCheck />}{({ overview: "运行概览", accounts: "用户与设备", reports: "举报审核", audit: "审计日志" } as const)[item]}</button>)}<button onClick={logout}><LogOut />退出后台</button></aside>
    <main><header><div><span>ADMINISTRATION</span><h1>{({ overview: "运行概览", accounts: "用户与设备", reports: "举报审核", audit: "审计日志" } as const)[tab]}</h1></div><Button variant="secondary" icon={<RefreshCw />} loading={loading} onClick={() => void refresh()}>刷新</Button></header>{error ? <p className="admin-error" role="alert">{error}</p> : null}
      {tab === "overview" && overview ? <div className="admin-metrics"><article><span>账户</span><strong>{overview.accounts}</strong></article><article><span>活跃设备</span><strong>{overview.activeDevices}</strong></article><article><span>待处理举报</span><strong>{overview.pendingReports}</strong></article><article><span>停用账户</span><strong>{overview.suspendedAccounts}</strong></article></div> : null}
      {tab === "accounts" ? <div className="admin-stack"><div className="admin-table"><table><thead><tr><th>用户</th><th>设备</th><th>注册时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.username}><td><strong>{account.username}</strong></td><td>{account.activeDevices}/{account.deviceCount}</td><td>{new Date(account.createdAt * 1000).toLocaleString()}</td><td>{account.suspended ? `已停用：${account.suspensionReason}` : "正常"}</td><td><Button size="small" variant={account.suspended ? "secondary" : "danger"} onClick={() => { setAction({ kind: "suspend", account }); setActionNote(account.suspended ? "" : "违反服务规则"); }}>{account.suspended ? "恢复" : "停用"}</Button></td></tr>)}</tbody></table></div><h2>设备明细</h2><div className="admin-table"><table><thead><tr><th>用户</th><th>设备 ID</th><th>预密钥版本</th><th>状态</th><th>操作</th></tr></thead><tbody>{devices.map((device) => <tr key={device.deviceId}><td>{device.username}</td><td><code>{device.deviceId}</code></td><td>{device.prekeyVersion}</td><td>{device.revokedAt ? "已撤销" : "活跃"}</td><td>{!device.revokedAt ? <Button size="small" variant="danger" onClick={() => { setAction({ kind: "revoke", device }); setActionNote(""); }}>撤销</Button> : null}</td></tr>)}</tbody></table></div></div> : null}
      {tab === "reports" ? <div className="admin-cards">{reports.length ? reports.map((report) => <article key={report.reportId}><header><strong>举报 {report.reportedUsername}</strong><time>{new Date(report.createdAt * 1000).toLocaleString()}</time></header><pre>{report.payload.disclosedMessageBundle ?? "无披露内容"}</pre><p>{report.payload.context}</p><footer><span className={`admin-status ${report.status}`}>{report.status}</span>{report.status === "pending" ? <><Button size="small" onClick={() => { setAction({ kind: "resolve", report, status: "resolved" }); setActionNote("已审核并处理"); }}>标记已处理</Button><Button size="small" variant="ghost" onClick={() => { setAction({ kind: "resolve", report, status: "dismissed" }); setActionNote("证据不足，予以驳回"); }}>驳回</Button></> : <span>{report.resolutionNote}</span>}</footer></article>) : <p className="admin-empty">暂无举报</p>}</div> : null}
      {tab === "audit" ? <div className="admin-table"><table><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>详情</th></tr></thead><tbody>{audit.map((entry) => <tr key={entry.auditId}><td>{new Date(entry.createdAt * 1000).toLocaleString()}</td><td>{entry.action}</td><td>{entry.target}</td><td><code>{JSON.stringify(entry.detail)}</code></td></tr>)}</tbody></table></div> : null}
    </main>
    {action ? <div className="account-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !actionLoading) setAction(null); }}><section className="account-dialog admin-action-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-action-title"><IconButton className="account-dialog-close" aria-label="关闭" disabled={actionLoading} onClick={() => setAction(null)}><X /></IconButton><span className={`dialog-symbol ${action.kind === "resolve" && action.status === "resolved" ? "" : "danger-symbol"}`}>{action.kind === "resolve" ? <FileWarning /> : <Trash2 />}</span><h2 id="admin-action-title">{action.kind === "suspend" ? (action.account.suspended ? `恢复账户 ${action.account.username}` : `停用账户 ${action.account.username}`) : action.kind === "resolve" ? (action.status === "resolved" ? "完成举报处理" : "驳回举报") : `撤销 ${action.device.username} 的设备`}</h2><p>{action.kind === "revoke" ? "撤销后，该设备将无法登录或接收新消息。设备内部标识只在此管理员确认步骤中显示。" : "本次操作会写入审计日志，请提供清晰、可追溯的处理说明。"}</p>{action.kind !== "revoke" ? <label className="designed-field"><span>{action.kind === "suspend" ? "操作原因" : "处理说明"}</span><span className="designed-field-control"><textarea autoFocus value={actionNote} onChange={(event) => setActionNote(event.target.value)} rows={3} /></span><small>请勿填写消息明文、令牌或其他无关敏感信息</small></label> : <code className="admin-device-confirmation">{action.device.deviceId}</code>}<footer><Button variant="secondary" disabled={actionLoading} onClick={() => setAction(null)}>取消</Button><Button variant={action.kind === "resolve" && action.status === "resolved" ? "primary" : "danger"} loading={actionLoading} disabled={action.kind !== "revoke" && !actionNote.trim()} onClick={() => void performAction()}>确认操作</Button></footer></section></div> : null}
  </div>;
}
