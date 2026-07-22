import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { ChevronRight, Copy, Database, Eye, EyeOff, KeyRound, LockKeyhole, Monitor, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import type { AuthSession, DeviceRecord } from "@covechat/protocol";
import type { Locale } from "./i18n";
import type { SecureProfile } from "./security/vault";
import { deleteLocalVault, saveSecureProfile, unlockSecureProfile } from "./security/vault";
import { deleteOwnAccount, listOwnDevices, revokeOwnDevice } from "./security/api";
import { Button } from "./ui-controls";

type Dialog = "password" | "recovery" | "devices" | "clear" | "delete" | null;

export function ProfileWorkspace({ locale, profile, session }: { locale: Locale; profile: SecureProfile; session: AuthSession }) {
  const zh = locale === "zh-CN";
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [pendingDevice, setPendingDevice] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const backupVersion = localStorage.getItem(`covechat:backup_version:${profile.username}`) ?? "0";
  const refreshDevices = useCallback(() => void listOwnDevices(session).then(setDevices).catch(() => setStatus(zh ? "设备列表读取失败" : "Unable to load devices")), [session.accessToken, zh]);

  useEffect(refreshDevices, [refreshDevices]);

  function closeDialog() {
    setDialog(null); setCurrentPassphrase(""); setNewPassphrase(""); setConfirmPassphrase("");
    setDeleteConfirmation(""); setPendingDevice(null); setShowPasswords(false);
  }

  async function changePassphrase(event: FormEvent) {
    event.preventDefault();
    if (newPassphrase.length < 12) return setStatus(zh ? "新口令至少需要 12 个字符" : "New passphrase must be at least 12 characters");
    if (newPassphrase !== confirmPassphrase) return setStatus(zh ? "两次输入的新口令不一致" : "The new passphrases do not match");
    try {
      const unlocked = await unlockSecureProfile(currentPassphrase);
      if (unlocked.deviceId !== profile.deviceId) throw new Error("profile mismatch");
      await saveSecureProfile(profile, newPassphrase);
      closeDialog(); setStatus(zh ? "本地解锁口令已更新" : "Local passphrase updated");
    } catch { setStatus(zh ? "当前口令错误，未作更改" : "Current passphrase is incorrect"); }
  }

  async function removeDevice() {
    if (!pendingDevice) return;
    await revokeOwnDevice(pendingDevice, session);
    setPendingDevice(null); refreshDevices();
  }

  async function clearLocalData() {
    await deleteLocalVault(); localStorage.clear(); window.location.assign("/");
  }

  async function deleteAccount() {
    if (deleteConfirmation !== profile.username) return;
    try { await deleteOwnAccount(profile, session); await deleteLocalVault(); localStorage.clear(); window.location.assign("/"); }
    catch { closeDialog(); setStatus(zh ? "账户删除失败，本机数据已保留" : "Account deletion failed; local data was kept"); }
  }

  const activeDevices = devices.filter((device) => !device.revokedAt);
  const otherDevices = activeDevices.filter((device) => device.deviceId !== profile.deviceId);
  const initials = profile.username.slice(0, 2).toUpperCase();
  const row = (icon: ReactNode, title: string, description: string, action: ReactNode) => (
    <div className="account-row"><span className="account-row-icon">{icon}</span><div className="account-row-copy"><strong>{title}</strong><small>{description}</small></div><div className="account-row-action">{action}</div></div>
  );

  return <main className="profile-workspace">
    <div className="account-page">
      <header className="account-hero"><span className="account-avatar">{initials}</span><div><h1>{zh ? "个人与安全" : "Profile & security"}</h1><div className="account-identity"><strong>@{profile.username}</strong><button type="button" onClick={() => void navigator.clipboard.writeText(profile.username)}><Copy />{zh ? "复制用户名" : "Copy username"}</button></div><p><ShieldCheck />{zh ? "账户已受本地加密保护" : "Your account is protected with local encryption"}</p></div></header>
      {status ? <p className="profile-status" role="status">{status}<button onClick={() => setStatus("")}><X /></button></p> : null}
      <section className="account-section"><h2>{zh ? "账户" : "Account"}</h2><div className="account-list">
        {row(<UserRound />, zh ? "用户名" : "Username", zh ? "这是他人添加你时看到的公开用户名。" : "The public username others use to find you.", <><strong>@{profile.username}</strong><ChevronRight /></>)}
        {row(<KeyRound />, zh ? "账户恢复" : "Account recovery", zh ? `恢复密钥已创建 · 备份版本 ${backupVersion}` : `Recovery key created · Backup version ${backupVersion}`, <Button size="small" variant="secondary" onClick={() => setDialog("recovery")}>{zh ? "管理恢复密钥" : "Manage recovery key"}</Button>)}
      </div></section>
      <section className="account-section"><h2>{zh ? "安全" : "Security"}</h2><div className="account-list">
        {row(<LockKeyhole />, zh ? "本地解锁口令" : "Local passphrase", zh ? "用于解锁此设备上的加密数据。" : "Unlocks encrypted data on this device.", <><span className="masked-value">••••••••••••</span><Button size="small" variant="secondary" onClick={() => setDialog("password")}>{zh ? "修改" : "Change"}</Button></>)}
        {row(<ShieldCheck />, zh ? "锁定当前会话" : "Lock current session", zh ? "立即锁定此设备上的会话。" : "Immediately lock this device session.", <Button size="small" variant="secondary" onClick={() => window.location.reload()}>{zh ? "立即锁定" : "Lock now"}</Button>)}
      </div></section>
      <section className="account-section"><h2>{zh ? "已授权设备" : "Authorized devices"}</h2><div className="account-list">
        {row(<Monitor />, zh ? "当前浏览器" : "Current browser", zh ? "本设备 · 当前会话" : "This device · Current session", <span className="current-device-badge">{zh ? "当前设备" : "Current"}</span>)}
        {row(<Monitor />, zh ? "其他已授权设备" : "Other authorized devices", zh ? `${otherDevices.length} 台设备可以访问你的加密账户。` : `${otherDevices.length} devices can access your encrypted account.`, <Button size="small" variant="secondary" onClick={() => setDialog("devices")}>{zh ? "查看设备" : "View devices"}</Button>)}
      </div></section>
      <section className="account-section account-danger"><h2>{zh ? "数据与账户" : "Data & account"}</h2><div className="account-list">
        {row(<Database />, zh ? "清除此设备的数据" : "Clear this device's data", zh ? "清除本地密钥、消息和设置，不影响其他设备。" : "Remove local keys, messages and settings.", <Button size="small" variant="secondary" onClick={() => setDialog("clear")}>{zh ? "清除数据" : "Clear data"}</Button>)}
        {row(<Trash2 />, zh ? "永久删除账户" : "Permanently delete account", zh ? "删除服务器账户及所有设备数据，无法恢复。" : "Delete the server account and all device data.", <Button size="small" variant="danger" onClick={() => setDialog("delete")}>{zh ? "永久删除账户" : "Delete account"}</Button>)}
      </div></section>
    </div>
    {dialog ? <div className="account-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}><section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title"><button className="account-dialog-close" onClick={closeDialog} aria-label={zh ? "关闭" : "Close"}><X /></button>
      {dialog === "password" ? <form onSubmit={changePassphrase}><h2 id="account-dialog-title">{zh ? "修改本地解锁口令" : "Change local passphrase"}</h2><p>{zh ? "更新后，下次解锁此设备时请使用新口令。" : "Use the new passphrase next time you unlock this device."}</p><div className="dialog-fields"><PasswordField label={zh ? "当前口令" : "Current passphrase"} value={currentPassphrase} onChange={setCurrentPassphrase} visible={showPasswords} onToggle={() => setShowPasswords((value) => !value)} /><PasswordField label={zh ? "新口令" : "New passphrase"} value={newPassphrase} onChange={setNewPassphrase} visible={showPasswords} onToggle={() => setShowPasswords((value) => !value)} minLength={12} /><PasswordField label={zh ? "确认新口令" : "Confirm new passphrase"} value={confirmPassphrase} onChange={setConfirmPassphrase} visible={showPasswords} onToggle={() => setShowPasswords((value) => !value)} minLength={12} /><small>{zh ? "至少 12 个字符，建议使用不重复的长口令" : "At least 12 characters; use a unique long passphrase"}</small></div><footer><Button type="button" variant="secondary" onClick={closeDialog}>{zh ? "取消" : "Cancel"}</Button><Button type="submit">{zh ? "更新口令" : "Update passphrase"}</Button></footer></form> : null}
      {dialog === "recovery" ? <div><h2 id="account-dialog-title">{zh ? "管理恢复密钥" : "Manage recovery key"}</h2><p>{zh ? "恢复密钥可以在更换设备后恢复账户。请离线保存，不要发送给任何人。" : "This key can recover your account on a new device. Store it offline."}</p><code className="recovery-code">{profile.recoverySecret}</code><footer><Button variant="secondary" onClick={closeDialog}>{zh ? "完成" : "Done"}</Button><Button onClick={() => void navigator.clipboard.writeText(profile.recoverySecret)}><Copy />{zh ? "复制恢复密钥" : "Copy recovery key"}</Button></footer></div> : null}
      {dialog === "devices" ? <div><h2 id="account-dialog-title">{zh ? "已授权设备" : "Authorized devices"}</h2><p>{zh ? "撤销不再使用或不认识的设备。设备内部标识默认隐藏。" : "Revoke devices you no longer use or recognize."}</p><div className="dialog-device-list">{activeDevices.map((device) => <div key={device.deviceId}><span><Monitor /></span><div><strong>{device.deviceId === profile.deviceId ? (zh ? "当前浏览器" : "Current browser") : (zh ? "其他授权设备" : "Authorized device")}</strong><small>{zh ? "授权于" : "Authorized"} {new Date(device.createdAt * 1000).toLocaleString(locale)}</small></div>{device.deviceId === profile.deviceId ? <span className="current-device-badge">{zh ? "当前" : "Current"}</span> : pendingDevice === device.deviceId ? <span className="device-confirm"><Button size="small" variant="secondary" onClick={() => setPendingDevice(null)}>{zh ? "取消" : "Cancel"}</Button><Button size="small" variant="danger" onClick={() => void removeDevice()}>{zh ? "确认撤销" : "Confirm"}</Button></span> : <Button size="small" variant="danger" onClick={() => setPendingDevice(device.deviceId)}>{zh ? "撤销" : "Revoke"}</Button>}</div>)}</div><footer><Button variant="secondary" onClick={closeDialog}>{zh ? "完成" : "Done"}</Button></footer></div> : null}
      {dialog === "clear" ? <div><h2 id="account-dialog-title">{zh ? "清除此设备的数据？" : "Clear this device's data?"}</h2><p>{zh ? "本浏览器中的密钥、消息和设置将被删除。请先确认恢复密钥已安全保存。" : "Local keys, messages and settings will be removed. Save your recovery key first."}</p><div className="dialog-warning"><Database />{zh ? "此操作仅影响当前浏览器，但无法撤销。" : "This only affects the current browser and cannot be undone."}</div><footer><Button variant="secondary" onClick={closeDialog}>{zh ? "取消" : "Cancel"}</Button><Button variant="danger" onClick={() => void clearLocalData()}>{zh ? "清除此设备" : "Clear this device"}</Button></footer></div> : null}
      {dialog === "delete" ? <div><h2 id="account-dialog-title">{zh ? "永久删除账户？" : "Permanently delete account?"}</h2><p>{zh ? "服务器账户、所有设备和加密数据都会永久删除，且无法恢复。" : "Your server account, devices and encrypted data will be permanently deleted."}</p><label className="delete-confirm">{zh ? <>输入用户名 <strong>{profile.username}</strong> 以确认</> : <>Type <strong>{profile.username}</strong> to confirm</>}<input autoFocus value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} /></label><footer><Button variant="secondary" onClick={closeDialog}>{zh ? "取消" : "Cancel"}</Button><Button variant="danger" disabled={deleteConfirmation !== profile.username} onClick={() => void deleteAccount()}>{zh ? "永久删除账户" : "Delete account"}</Button></footer></div> : null}
    </section></div> : null}
  </main>;
}

function PasswordField({ label, value, onChange, visible, onToggle, minLength }: { label: string; value: string; onChange: (value: string) => void; visible: boolean; onToggle: () => void; minLength?: number }) {
  return <label>{label}<span><input type={visible ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} required minLength={minLength} /><button type="button" onClick={onToggle} aria-label="Show or hide passphrase">{visible ? <EyeOff /> : <Eye />}</button></span></label>;
}
