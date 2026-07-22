import { FormEvent, ReactNode, useEffect, useState } from "react";
import { CheckCircle2, ServerCog } from "lucide-react";

type SetupStatus = {
  configured: boolean;
  publicOrigin?: string;
};

export function DeploymentGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SetupStatus>();
  const [origin, setOrigin] = useState(window.location.origin);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/v1/setup/status")
      .then(async (response) => {
        if (!response.ok) throw new Error("status unavailable");
        setStatus(await response.json() as SetupStatus);
      })
      .catch(() => setError("无法连接部署配置接口，请检查 API 容器和反向代理。"));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/v1/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupToken: token, publicOrigin: origin }),
      });
      if (response.status === 401) throw new Error("安装令牌不正确，请复制部署终端显示的令牌。");
      if (response.status === 400) throw new Error("域名格式不正确，请填写完整的 http:// 或 https:// 地址。 ");
      if (!response.ok) throw new Error("保存失败，请检查数据库连接和 API 日志。");
      setStatus({ configured: true, publicOrigin: origin.replace(/\/$/u, "") });
      setToken("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (status?.configured) return children;

  return (
    <main className="gate deployment-gate">
      <section className="gate-panel deployment-panel">
        <div className="gate-brand"><ServerCog /><span>CoveChat 部署向导</span></div>
        <ServerCog className="gate-symbol" />
        <h1>完成站点配置</h1>
        <p>确认浏览器访问域名并输入部署终端生成的一次性安装令牌。完成前不会开放账号注册和聊天功能。</p>
        {status ? (
          <form onSubmit={submit}>
            <label>公网访问地址
              <input required type="url" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://chat.example.com" />
            </label>
            <label>安装令牌
              <input required minLength={24} autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="从服务器部署输出中复制" />
            </label>
            {error ? <p className="gate-error" role="alert">{error}</p> : null}
            <button className="gate-submit" disabled={saving}>{saving ? "正在保存…" : "保存并进入 CoveChat"}</button>
            <p className="deployment-hint"><CheckCircle2 />数据库迁移、Redis 和对象存储由一键部署自动配置，无需在网页填写密码。</p>
          </form>
        ) : <p>{error || "正在检查部署状态…"}</p>}
      </section>
    </main>
  );
}
