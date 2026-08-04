import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { ApiError } from "../api/client";
import { useApi } from "../api/context";
import type { Session, SetupStatus } from "../types";
import { Brand, Button } from "../components/ui";

export function LoginPage({ status, onAuthenticated }: { status: SetupStatus; onAuthenticated(session: Session): void }) {
  const api = useApi();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onAuthenticated(await api.login(username, password));
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function enterDemo() {
    setBusy(true);
    try { onAuthenticated(await api.login("demo", "demo")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Demo workspace is unavailable."); }
    finally { setBusy(false); }
  }

  return (
    <div className="auth-layout">
      <section className="auth-story">
        <Brand />
        <div className="auth-story-copy">
          <p className="eyebrow">Operations, without the noise</p>
          <h1>One clear view across every supported Linux service.</h1>
          <p>Monitor health, act across your fleet and keep every change accountable from a single, private control plane.</p>
          <div className="auth-proof">
            <span><ShieldCheck size={18} /> mTLS agent identity</span>
            <span><KeyRound size={18} /> Signed operations</span>
          </div>
        </div>
        <div className="auth-orbit" aria-hidden="true"><i /><i /><i /><b>24</b><span>agents<br />observed</span></div>
        <footer>Built for Ubuntu 24.04 LTS and Kali Rolling / Private by default</footer>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <span className="form-icon"><LockKeyhole size={22} /></span>
          <p className="eyebrow">Welcome back</p>
          <h2>Sign in to your manager</h2>
          <p>Use the administrator or operator account created during setup.</p>
          {error && <div className="inline-error" role="alert">{error}</div>}
          <label>Username<input autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} placeholder="morgan" required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="************" required /></label>
          <div className="form-row"><label className="checkbox"><input type="checkbox" /> <span>Keep me signed in on this device</span></label><button className="link-button" type="button">Recovery help</button></div>
          <Button type="submit" busy={busy}>Sign in <ArrowRight size={17} /></Button>
          {import.meta.env.DEV && <button className="demo-button" type="button" onClick={enterDemo} disabled={busy}>Open demo workspace</button>}
          <div className="fingerprint-note"><ShieldCheck size={15} /><span>Server identity verified<br /><code>{status.serverFingerprint.slice(0, 27)}...</code></span></div>
        </form>
      </section>
    </div>
  );
}
