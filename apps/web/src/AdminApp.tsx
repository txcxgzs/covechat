import { FormEvent, useCallback, useEffect, useState } from "react";
import { Activity, FileWarning, LogOut, RefreshCw, ShieldCheck, UsersRound } from "lucide-react";
import { Button } from "./ui-controls";

type Overview = { accounts: number; activeDevices: number; pendingReports: number; suspendedAccounts: number };
type Account = { username: string; createdAt: number; deviceCount: number; activeDevices: number; suspended: boolean; suspensionReason?: string };
type Device = { deviceId: string; username: string; createdAt: number; revokedAt?: number; prekeyVersion: number };
type Report = { reportId: string; reportedUsername: string; payload: { disclosedMessageBundle?: string; context?: string }; status: string; resolutionNote?: string; createdAt: number };
type Audit = { auditId: string; action: string; target: string; detail: unknown; createdAt: number };
type Tab = "overview" | "accounts" | "reports" | "audit";

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
  async function suspend(account: Account) {
    const reason = account.suspended ? "" : window.prompt("请输入停用原因（会写入审计日志）", "违反服务规则");
    if (!account.suspended && !reason) return;
    await managementFetch(`/accounts/${encodeURIComponent(account.username)}/suspension`, token, account.suspended ? { method: "DELETE" } : { method: "POST", body: JSON.stringify({ reason }) });
    await refresh();
  }
  async function resolve(report: Report, status: "resolved" | "dismissed") {
    const note = window.prompt(status === "resolved" ? "处理说明" : "驳回说明", "已审核");
    if (note === null) return;
    await managementFetch(`/reports/${report.reportId}/resolve`, token, { method: "POST", body: JSON.stringify({ status, note }) });
    await refresh();
  }
  async function revokeDevice(device: Device) {
    if (!window.confirm(`确认撤销 ${device.username} 的设备 ${device.deviceId}？`)) return;
    await managementFetch(`/devices/${device.deviceId}/revoke`, token, { method: "POST" }); await refresh();
  }

  if (!token || (error && !overview)) return <main className="admin-login"><form onSubmit={login}><ShieldCheck /><h1>CoveChat 管理控制台</h1><p>后台地址只是额外隐藏层，管理员令牌才是实际访问凭证。</p><label>管理员令牌<input type="password" autoComplete="current-password" value={draftToken} onChange={(event) => setDraftToken(event.target.value)} minLength={32} required /></label>{error ? <p role="alert">{error}</p> : null}<Button type="submit" loading={loading}>安全登录</Button><a href="/">返回聊天系统</a></form></main>;

  return <div className="admin-shell">
    <aside><div className="admin-brand"><ShieldCheck />CoveChat</div>{(["overview", "accounts", "reports", "audit"] as Tab[]).map((item) => <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{item === "overview" ? <Activity /> : item === "accounts" ? <UsersRound /> : item === "reports" ? <FileWarning /> : <ShieldCheck />}{({ overview: "运行概览", accounts: "用户与设备", reports: "举报审核", audit: "审计日志" } as const)[item]}</button>)}<button onClick={logout}><LogOut />退出后台</button></aside>
    <main><header><div><span>ADMINISTRATION</span><h1>{({ overview: "运行概览", accounts: "用户与设备", reports: "举报审核", audit: "审计日志" } as const)[tab]}</h1></div><Button variant="secondary" icon={<RefreshCw />} loading={loading} onClick={() => void refresh()}>刷新</Button></header>{error ? <p className="admin-error" role="alert">{error}</p> : null}
      {tab === "overview" && overview ? <div className="admin-metrics"><article><span>账户</span><strong>{overview.accounts}</strong></article><article><span>活跃设备</span><strong>{overview.activeDevices}</strong></article><article><span>待处理举报</span><strong>{overview.pendingReports}</strong></article><article><span>停用账户</span><strong>{overview.suspendedAccounts}</strong></article></div> : null}
      {tab === "accounts" ? <div className="admin-stack"><div className="admin-table"><table><thead><tr><th>用户</th><th>设备</th><th>注册时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.username}><td><strong>{account.username}</strong></td><td>{account.activeDevices}/{account.deviceCount}</td><td>{new Date(account.createdAt * 1000).toLocaleString()}</td><td>{account.suspended ? `已停用：${account.suspensionReason}` : "正常"}</td><td><Button size="small" variant={account.suspended ? "secondary" : "danger"} onClick={() => void suspend(account)}>{account.suspended ? "恢复" : "停用"}</Button></td></tr>)}</tbody></table></div><h2>设备明细</h2><div className="admin-table"><table><thead><tr><th>用户</th><th>设备 ID</th><th>预密钥版本</th><th>状态</th><th>操作</th></tr></thead><tbody>{devices.map((device) => <tr key={device.deviceId}><td>{device.username}</td><td><code>{device.deviceId}</code></td><td>{device.prekeyVersion}</td><td>{device.revokedAt ? "已撤销" : "活跃"}</td><td>{!device.revokedAt ? <Button size="small" variant="danger" onClick={() => void revokeDevice(device)}>撤销</Button> : null}</td></tr>)}</tbody></table></div></div> : null}
      {tab === "reports" ? <div className="admin-cards">{reports.length ? reports.map((report) => <article key={report.reportId}><header><strong>举报 {report.reportedUsername}</strong><time>{new Date(report.createdAt * 1000).toLocaleString()}</time></header><pre>{report.payload.disclosedMessageBundle ?? "无披露内容"}</pre><p>{report.payload.context}</p><footer><span className={`admin-status ${report.status}`}>{report.status}</span>{report.status === "pending" ? <><Button size="small" onClick={() => void resolve(report, "resolved")}>标记已处理</Button><Button size="small" variant="ghost" onClick={() => void resolve(report, "dismissed")}>驳回</Button></> : <span>{report.resolutionNote}</span>}</footer></article>) : <p className="admin-empty">暂无举报</p>}</div> : null}
      {tab === "audit" ? <div className="admin-table"><table><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>详情</th></tr></thead><tbody>{audit.map((entry) => <tr key={entry.auditId}><td>{new Date(entry.createdAt * 1000).toLocaleString()}</td><td>{entry.action}</td><td>{entry.target}</td><td><code>{JSON.stringify(entry.detail)}</code></td></tr>)}</tbody></table></div> : null}
    </main>
  </div>;
}
