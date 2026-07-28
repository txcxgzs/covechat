import { FormEvent, ReactNode, useEffect, useState } from "react";
import type { AuthSession } from "@covechat/protocol";
import { CheckCircle2, KeyRound, Languages, RefreshCw, ShieldCheck, Smartphone, X } from "lucide-react";
import { copy, detectLocale, type Locale, type Translate } from "../i18n";
import {
  createSecureProfile,
  hasLocalVault,
  rotateRecoveredDevice,
  saveSecureProfile,
  saveTrustState,
  unlockSecureProfile,
  type SecureProfile,
} from "./vault";
import {
  authenticateProfile,
  authenticateRecovery,
  approveDeviceLink,
  consumeDeviceLink,
  loadBackupForRecovery,
  publishSignalPreKeys,
  provisionProfile,
  registerRecoveredDevice,
  registerSessionRef,
  selfHealDeviceSignature,
  startDeviceLink,
  pollDeviceLink,
  unregisterSessionRef,
  uploadBackup,
  type AuthenticatedProfile,
} from "./api";
import { createEncryptedBackup, decryptBackup } from "./backup";
import {
  buildDeviceApprovalUrl,
  createDeviceLinkKeyPair,
  decryptDeviceLinkPayload,
  encryptDeviceLinkPayload,
  parseDeviceApprovalHash,
  parseDeviceRecoveryHash,
  type DeviceLinkApproval,
} from "./device-transfer";

type GateState = "checking" | "setup" | "pair" | "recover" | "unlock" | "recovery" | "ready";

type PairRequest = DeviceLinkApproval & {
  requesterPrivateKey: string;
  expiresAt: number;
  qrDataUrl: string;
  approvalUrl: string;
};

export function SecurityGate({ children }: {
  children: (authenticated: AuthenticatedProfile) => ReactNode;
}) {
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const [state, setState] = useState<GateState>("checking");
  const [profile, setProfile] = useState<SecureProfile>();
  const [authenticated, setAuthenticated] = useState<AuthenticatedProfile>();
  const [username, setUsername] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [recoverySecret, setRecoverySecret] = useState("");
  const [recoveryFromQr, setRecoveryFromQr] = useState(false);
  const [error, setError] = useState("");
  const [pairRequest, setPairRequest] = useState<PairRequest>();
  const [pendingApproval, setPendingApproval] = useState<DeviceLinkApproval>();
  const [linkedSession, setLinkedSession] = useState<{ linkId: string; linkSecret: string }>();
  const [pairLinkCopied, setPairLinkCopied] = useState(false);
  const t: Translate = (key) => copy[locale][key];

  useEffect(() => {
    const transfer = parseDeviceRecoveryHash(window.location.hash);
    const approval = parseDeviceApprovalHash(window.location.hash);
    if (transfer || approval) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    void hasLocalVault()
      .then((exists) => {
        if (transfer && !exists) {
          setUsername(transfer.username);
          setRecoverySecret(transfer.recoverySecret);
          setRecoveryFromQr(true);
        }
        if (approval && exists) setPendingApproval(approval);
        setState(transfer && !exists ? "recover" : exists ? "unlock" : "setup");
      })
      .catch(() => {
        setError(t("vaultError"));
        setState("setup");
      });
  }, []);

  useEffect(() => {
    if (state !== "pair" || !pairRequest) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling || !active) return;
      polling = true;
      try {
        const result = await pollDeviceLink(pairRequest.linkId, pairRequest.linkSecret);
        if (
          result.status === "approved"
          && result.approverPublicKey
          && result.encryptedPayload
        ) {
          const transfer = await decryptDeviceLinkPayload(
            pairRequest.requesterPrivateKey,
            result.approverPublicKey,
            pairRequest.linkId,
            result.encryptedPayload,
          );
          if (result.approvedUsername && result.approvedUsername !== transfer.username) {
            throw new Error("device link account mismatch");
          }
          if (!active) return;
          setUsername(transfer.username);
          setRecoverySecret(transfer.recoverySecret);
          setRecoveryFromQr(true);
          setLinkedSession({ linkId: pairRequest.linkId, linkSecret: pairRequest.linkSecret });
          setPairRequest(undefined);
          setState("recover");
        }
      } catch {
        if (active && Date.now() / 1000 >= pairRequest.expiresAt) {
          setError(locale === "zh-CN" ? "配对已过期，请重新生成。" : "Pairing expired. Create a new request.");
          setPairRequest(undefined);
          setState("setup");
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [locale, pairRequest, state]);

  function toggleLocale() {
    setLocale((current) => {
      const next = current === "zh-CN" ? "en" : "zh-CN";
      localStorage.setItem("covechat.locale", next);
      return next;
    });
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (passphrase !== confirmation) {
      setError(t("passphraseMismatch"));
      return;
    }
    try {
      const created = await createSecureProfile(username, passphrase);
      const session = await provisionProfile(created);
      const registered = {
        ...created,
        serverRegistered: true,
        signalPublished: true,
      };
      await saveSecureProfile(registered, passphrase);
      await uploadBackup(await createEncryptedBackup(registered), session);
      setProfile(registered);
      setAuthenticated({ profile: registered, session });
      setPassphrase("");
      setConfirmation("");
      setState("recovery");
    } catch {
      setError(t("vaultCreateFailed"));
      setPassphrase("");
      setConfirmation("");
    }
  }

  async function beginDevicePairing() {
    setError("");
    setPairLinkCopied(false);
    try {
      const keys = await createDeviceLinkKeyPair();
      const link = await startDeviceLink(keys.publicKey);
      const approval: DeviceLinkApproval = {
        version: 1,
        linkId: link.linkId,
        linkSecret: link.linkSecret,
        requesterPublicKey: keys.publicKey,
      };
      const approvalUrl = buildDeviceApprovalUrl(window.location.origin, approval);
      const qrDataUrl = await (await import("qrcode")).toDataURL(
        approvalUrl,
        { width: 320, margin: 2, errorCorrectionLevel: "M", color: { dark: "#0a2a42", light: "#ffffff" } },
      );
      setPairRequest({ ...approval, requesterPrivateKey: keys.privateKey, expiresAt: link.expiresAt, qrDataUrl, approvalUrl });
      setState("pair");
    } catch {
      setError(locale === "zh-CN" ? "无法创建配对请求，请检查网络后重试。" : "Could not start pairing. Check the network and retry.");
    }
  }

  async function recover(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (passphrase !== confirmation) {
      setError(t("passphraseMismatch"));
      return;
    }
    try {
      const normalized = username.trim().toLowerCase();
      const recoverySession = await authenticateRecovery(normalized, recoverySecret.trim());
      const recoveryBackup = await loadBackupForRecovery(recoverySession);
      const restoredBackup = await decryptBackup(
        recoveryBackup.backup,
        recoverySecret.trim(),
        recoveryBackup.account.signingPublicKey,
      );
      const restored = restoredBackup.profile;
      if (
        restored.username !== normalized
        || restored.accountKeys.publicKey !== recoveryBackup.account.signingPublicKey
        || restored.recoveryKeys.publicKey !== recoveryBackup.account.recoveryPublicKey
      ) {
        throw new Error("recovery identity mismatch");
      }
      const rotated = await rotateRecoveredDevice(restored);
      const session = await registerRecoveredDevice(rotated, recoverySession);
      const activeProfile = {
        ...rotated,
        serverRegistered: true,
        signalPublished: true,
      };
      await saveSecureProfile(activeProfile, passphrase);
      await saveTrustState(activeProfile, restoredBackup.trustState);
      await uploadBackup(
        await createEncryptedBackup(activeProfile, recoveryBackup.backup),
        session,
      );
      if (linkedSession) {
        await consumeDeviceLink(linkedSession.linkId, linkedSession.linkSecret).catch(() => undefined);
        setLinkedSession(undefined);
      }
      setProfile(activeProfile);
      setAuthenticated({ profile: activeProfile, session });
      setPassphrase("");
      setConfirmation("");
      setRecoverySecret("");
      setState("ready");
    } catch {
      setError(t("vaultRecoveryFailed"));
    }
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setError("");
    let unlocked: SecureProfile;
    try {
      unlocked = await unlockSecureProfile(passphrase);
    } catch {
      setError(t("vaultUnlockFailed"));
      return;
    }
    try {
      const wasUnregistered = !unlocked.serverRegistered;
      const needsPreKeyPublish = !wasUnregistered && !unlocked.signalPublished;
      const session = wasUnregistered
        ? await provisionProfile(unlocked)
        : await authenticateProfile(unlocked);
      if (needsPreKeyPublish) {
        await publishSignalPreKeys(unlocked, session);
      }
      // 已注册设备：自愈检查 authorization_signature。
      // 升级前 prekey 轮换未同步签名，服务端历史记录可能已损坏；
      // 解锁时主动验证并修复，避免对端发消息时 observeAndCheckIdentity 拒绝。
      let selfHealed = false;
      if (!wasUnregistered) {
        try {
          selfHealed = await selfHealDeviceSignature(unlocked, session);
        } catch (error) {
          // 自愈失败有两种情况：
          // 1. 设备已 revoke / directory 查询失败：不阻塞解锁，用户进入后可能需 recovery
          // 2. 服务端未升级（二次验证签名仍损坏）：必须明确提示，否则用户反复尝试无效
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("server did not persist authorization_signature")) {
            setError(t("vaultServerOutdated"));
            return;
          }
          // 其他错误不阻塞解锁
        }
      }
      const activeProfile = wasUnregistered
        ? { ...unlocked, serverRegistered: true, signalPublished: true }
        : unlocked;
      if (wasUnregistered || needsPreKeyPublish || selfHealed) {
        await saveSecureProfile(activeProfile, passphrase);
      }
      setProfile(activeProfile);
      setAuthenticated({ profile: activeProfile, session });
      setPassphrase("");
      setState(wasUnregistered ? "recovery" : "ready");
    } catch {
      setError(t("vaultServerAuthFailed"));
    }
  }

  if (state === "ready" && authenticated) {
    return <SessionRegistrar authenticated={authenticated} onSessionRefresh={setAuthenticated}>
      {children(authenticated)}
      {pendingApproval ? <DeviceLinkApprovalDialog
        approval={pendingApproval}
        profile={authenticated.profile}
        session={authenticated.session}
        locale={locale}
        onClose={() => setPendingApproval(undefined)}
      /> : null}
    </SessionRegistrar>;
  }

  return (
    <main className="gate">
      <button className="gate-language" onClick={toggleLocale} aria-label={t("switchLanguage")}>
        <Languages /> {locale === "zh-CN" ? "English" : "中文"}
      </button>
      <section className="gate-panel">
        <div className="gate-brand"><ShieldCheck /><span>CoveChat</span></div>
        {state === "checking" ? <p>{t("vaultChecking")}</p> : null}
        {state === "setup" ? (
          <>
            <KeyRound className="gate-symbol" />
            <h1>{t("createVaultTitle")}</h1>
            <p>{t("createVaultBody")}</p>
            <form onSubmit={create}>
              <label>{t("username")}<input required minLength={3} maxLength={32} pattern="[a-z0-9_]+" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
              <label>{t("localPassphrase")}<input required minLength={12} type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
              <label>{t("confirmPassphrase")}<input required minLength={12} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
              {error ? <p className="gate-error" role="alert">{error}</p> : null}
              <button className="gate-submit">{t("createSecureProfile")}</button>
            </form>
            <button className="gate-secondary" onClick={() => setState("recover")}>
              {t("recoverExistingAccount")}
            </button>
            <button className="gate-secondary gate-pair-button" onClick={() => void beginDevicePairing()}>
              <Smartphone /> {locale === "zh-CN" ? "从已登录设备安全配对" : "Pair from a signed-in device"}
            </button>
          </>
        ) : null}
        {state === "pair" && pairRequest ? (
          <div className="gate-pair-state">
            <Smartphone className="gate-symbol" />
            <h1>{locale === "zh-CN" ? "连接这台新设备" : "Connect this new device"}</h1>
            <p>{locale === "zh-CN" ? "使用已经登录 CoveChat 的设备扫描二维码并确认。恢复密钥不会出现在二维码中，请保持此页面打开。" : "Scan with a device already signed in to CoveChat and approve. The recovery key is not in this QR; keep this page open."}</p>
            <img className="device-recovery-qr" src={pairRequest.qrDataUrl} alt={locale === "zh-CN" ? "一次性设备配对二维码" : "One-time device pairing QR"} />
            <div className="gate-pair-waiting"><RefreshCw />{locale === "zh-CN" ? "等待另一台设备确认…" : "Waiting for approval…"}</div>
            <button className="gate-secondary gate-copy-link" onClick={() => void navigator.clipboard.writeText(pairRequest.approvalUrl).then(() => setPairLinkCopied(true))}>{pairLinkCopied ? (locale === "zh-CN" ? "一次性链接已复制" : "One-time link copied") : (locale === "zh-CN" ? "无法扫码？复制一次性链接" : "Can't scan? Copy one-time link")}</button>
            <button className="gate-secondary" onClick={() => { setPairRequest(undefined); setState("setup"); }}>{locale === "zh-CN" ? "取消配对" : "Cancel pairing"}</button>
          </div>
        ) : null}
        {state === "recover" ? (
          <>
            <KeyRound className="gate-symbol" />
            <h1>{t("recoverAccountTitle")}</h1>
            <p>{t("recoverAccountBody")}</p>
            <form onSubmit={recover}>
              {!recoveryFromQr ? <label>{t("username")}<input required minLength={3} maxLength={32} pattern="[a-z0-9_]+" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label> : null}
              {recoveryFromQr ? <div className="gate-qr-received"><CheckCircle2 /><span><strong>{locale === "zh-CN" ? "恢复信息已安全读取" : "Recovery details received"}</strong><small>{locale === "zh-CN" ? `账户 @${username} · 密钥不会显示在页面中` : `Account @${username} · the key stays hidden`}</small></span><button type="button" onClick={() => { setRecoveryFromQr(false); setRecoverySecret(""); }}>{locale === "zh-CN" ? "改为手动输入" : "Enter manually"}</button></div> : <label>{t("recoveryCode")}<input required autoComplete="off" value={recoverySecret} onChange={(event) => setRecoverySecret(event.target.value)} /></label>}
              <label>{t("localPassphrase")}<input required minLength={12} type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
              <label>{t("confirmPassphrase")}<input required minLength={12} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
              {error ? <p className="gate-error" role="alert">{error}</p> : null}
              <button className="gate-submit">{t("recoverAccount")}</button>
            </form>
            <button className="gate-secondary" onClick={() => setState("setup")}>
              {t("backToCreate")}
            </button>
          </>
        ) : null}
        {state === "unlock" ? (
          <>
            <KeyRound className="gate-symbol" />
            <h1>{t("unlockVaultTitle")}</h1>
            <p>{t("unlockVaultBody")}</p>
            <form onSubmit={unlock}>
              <label>{t("localPassphrase")}<input required type="password" autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
              {error ? <p className="gate-error" role="alert">{error}</p> : null}
              <button className="gate-submit">{t("unlock")}</button>
            </form>
            <button className="gate-secondary" onClick={() => { setError(""); setPassphrase(""); setState("recover"); }}>
              {t("recoverExistingAccount")}
            </button>
          </>
        ) : null}
        {state === "recovery" && profile ? (
          <>
            <KeyRound className="gate-symbol" />
            <h1>{t("recoveryTitle")}</h1>
            <p>{t("recoveryBody")}</p>
            <code className="recovery-code">{profile.recoverySecret}</code>
            <button className="gate-submit" onClick={() => setState("ready")}>{t("recoveryConfirmed")}</button>
          </>
        ) : null}
      </section>
    </main>
  );
}

function DeviceLinkApprovalDialog({ approval, profile, session, locale, onClose }: {
  approval: DeviceLinkApproval;
  profile: SecureProfile;
  session: AuthSession;
  locale: Locale;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<"confirm" | "sending" | "done" | "error">("confirm");
  const zh = locale === "zh-CN";

  async function approve() {
    setStatus("sending");
    try {
      const encrypted = await encryptDeviceLinkPayload(
        approval.requesterPublicKey,
        approval.linkId,
        { version: 1, username: profile.username, recoverySecret: profile.recoverySecret },
      );
      await approveDeviceLink(
        approval.linkId,
        approval.linkSecret,
        encrypted.approverPublicKey,
        encrypted.encryptedPayload,
        session,
      );
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  return <div className="account-dialog-backdrop"><section className="account-dialog device-link-approval" role="dialog" aria-modal="true" aria-labelledby="device-link-title">
    <button className="account-dialog-close" onClick={onClose} aria-label={zh ? "关闭" : "Close"}><X /></button>
    <span className={`dialog-symbol ${status === "done" ? "success-symbol" : ""}`}>{status === "done" ? <CheckCircle2 /> : <Smartphone />}</span>
    <h2 id="device-link-title">{status === "done" ? (zh ? "新设备已获授权" : "New device approved") : (zh ? "授权一台新设备？" : "Approve a new device?")}</h2>
    <p>{status === "done"
      ? (zh ? "加密恢复资料已发送。新设备完成恢复后，这个一次性配对会自动销毁。" : "Encrypted recovery details were sent. This one-time link is destroyed after recovery.")
      : (zh ? "只有当二维码正显示在你手边的新设备上时才确认。服务器只能中转密文，无法读取恢复密钥。" : "Approve only if the QR is visible on a new device in your possession. The server relays ciphertext and cannot read the recovery key.")}</p>
    {status === "error" ? <p className="gate-error" role="alert">{zh ? "授权失败或配对已过期，请在新设备重新生成。" : "Approval failed or expired. Create a new request on the new device."}</p> : null}
    <footer>
      {status === "done" ? <button className="gate-submit" onClick={onClose}>{zh ? "完成" : "Done"}</button> : <><button className="gate-secondary" onClick={onClose}>{zh ? "拒绝" : "Deny"}</button><button className="gate-submit" disabled={status === "sending"} onClick={() => void approve()}>{status === "sending" ? (zh ? "正在加密发送…" : "Encrypting…") : (zh ? "确认授权" : "Approve device")}</button></>}
    </footer>
  </section></div>;
}

/**
 * 在已认证状态挂载时注册 session holder，
 * 让 api.ts 的 authenticatedFetch 能在 401 时自动重新认证。
 * 卸载或 profile 变化时清理，避免旧 session 残留。
 */
function SessionRegistrar({ authenticated, onSessionRefresh, children }: {
  authenticated: AuthenticatedProfile;
  onSessionRefresh: (next: AuthenticatedProfile) => void;
  children: ReactNode;
}) {
  useEffect(() => {
    registerSessionRef(authenticated.profile, authenticated.session, (fresh) => {
      // 401 自动重认证后同步 React state，保证后续 UI 用新 token
      onSessionRefresh({ profile: authenticated.profile, session: fresh });
    });
    return () => unregisterSessionRef();
  }, [authenticated, onSessionRefresh]);
  return <>{children}</>;
}
