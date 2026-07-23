import { FormEvent, ReactNode, useEffect, useState } from "react";
import { KeyRound, Languages, ShieldCheck } from "lucide-react";
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
  loadBackupForRecovery,
  publishSignalPreKeys,
  provisionProfile,
  registerRecoveredDevice,
  selfHealDeviceSignature,
  uploadBackup,
  type AuthenticatedProfile,
} from "./api";
import { createEncryptedBackup, decryptBackup } from "./backup";

type GateState = "checking" | "setup" | "recover" | "unlock" | "recovery" | "ready";

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
  const [error, setError] = useState("");
  const t: Translate = (key) => copy[locale][key];

  useEffect(() => {
    void hasLocalVault()
      .then((exists) => setState(exists ? "unlock" : "setup"))
      .catch(() => {
        setError(t("vaultError"));
        setState("setup");
      });
  }, []);

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

  if (state === "ready" && authenticated) return children(authenticated);

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
          </>
        ) : null}
        {state === "recover" ? (
          <>
            <KeyRound className="gate-symbol" />
            <h1>{t("recoverAccountTitle")}</h1>
            <p>{t("recoverAccountBody")}</p>
            <form onSubmit={recover}>
              <label>{t("username")}<input required minLength={3} maxLength={32} pattern="[a-z0-9_]+" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
              <label>{t("recoveryCode")}<input required autoComplete="off" value={recoverySecret} onChange={(event) => setRecoverySecret(event.target.value)} /></label>
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
