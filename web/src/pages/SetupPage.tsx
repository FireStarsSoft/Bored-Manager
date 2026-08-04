import { useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, Container, Copy, Eye, EyeOff, LockKeyhole, Network, ShieldCheck, UserRound } from "lucide-react";
import { ApiError } from "../api/client";
import { useApi } from "../api/context";
import type { Session, SetupInput, SetupStatus } from "../types";
import { Brand, Button } from "../components/ui";

const steps = ["Administrator", "Network", "Docker", "Confirm"];

export function SetupPage({ status, onComplete }: { status: SetupStatus; onComplete(session: Session): void }) {
  const api = useApi();
  const [step, setStep] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmPassword, setConfirmPassword] = useState("");
  const [completedSession, setCompletedSession] = useState<Session>();
  const [input, setInput] = useState<SetupInput>({
    username: "admin", password: "", displayName: "", bindAddress: status.bindAddress ?? "127.0.0.1", webPort: status.webPort ?? 8443, agentPort: status.agentPort ?? 9443,
    registerLocalDocker: status.localDocker === "available", dockerRiskAccepted: false,
  });
  const passwordStrong = useMemo(() => input.password.length >= 14 && /[A-Z]/.test(input.password) && /\d/.test(input.password), [input.password]);
  const restartRequired = input.bindAddress !== status.bindAddress || input.webPort !== status.webPort || input.agentPort !== status.agentPort;

  function update<K extends keyof SetupInput>(key: K, value: SetupInput[K]) { setInput((current) => ({ ...current, [key]: value })); }

  function next(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (step === 0 && (!passwordStrong || input.password !== confirmPassword)) { setError("Use at least 14 characters with an uppercase letter and number, and make sure both passwords match."); return; }
    if (step === 2 && input.registerLocalDocker && !input.dockerRiskAccepted) { setError("Acknowledge the Docker socket privilege before continuing."); return; }
    setStep((value) => Math.min(3, value + 1));
  }

  async function complete() {
    setBusy(true); setError(undefined);
    try {
      const session = await api.completeSetup(input);
      setInput((current) => ({ ...current, password: "" }));
      setConfirmPassword("");
      if (restartRequired) setCompletedSession(session);
      else onComplete(session);
    }
    catch (cause) { setError(cause instanceof ApiError || cause instanceof Error ? cause.message : "Setup could not be completed."); }
    finally { setBusy(false); }
  }

  if (completedSession) {
    const destination = input.bindAddress === "0.0.0.0" ? `<manager-LAN-address>:${input.webPort}` : `${input.bindAddress}:${input.webPort}`;
    return (
      <div className="setup-layout">
        <header className="setup-header"><Brand /><span>First-run setup / restart required</span></header>
        <main className="setup-card">
          <aside className="setup-steps">
            <p className="eyebrow">Administrator created</p><h1>Apply the listener change.</h1><p>The requested bind address and ports are stored. Restart the service once to activate them.</p>
            <div className="setup-trust"><ShieldCheck size={18} /><p><strong>Setup is single-use</strong>The administrator and settings were committed atomically. Do not submit setup again.</p></div>
          </aside>
          <section className="setup-form">
            <span className="form-icon"><Check size={22} /></span><p className="eyebrow">Manual host action</p><h2>Restart, verify, then sign in again</h2>
            <p>Bored Manager is unprivileged and cannot restart its own systemd unit. Run these commands on the manager host:</p>
            <pre className="console-output"><code>sudo systemctl restart bored-managerd.service{"\n"}sudo bmctl health</code></pre>
            <p>Then open <code>https://{destination}</code>. Replace the placeholder with the manager&apos;s real LAN or VPN address. The session cookie for this loopback origin is not reused on the new origin.</p>
            <div className="completion-note"><ShieldCheck size={18} /><span><strong>Verify before trusting the new origin</strong>Compare its certificate fingerprint with <code>sudo bmctl diagnostics</code>.</span></div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="setup-layout">
      <header className="setup-header"><Brand /><span>First-run setup / {status.version}</span></header>
      <main className="setup-card">
        <aside className="setup-steps">
          <p className="eyebrow">Secure setup</p><h1>Make this manager yours.</h1><p>Four quick steps create your private control plane. Nothing leaves this host.</p>
          <ol>{steps.map((label, index) => <li className={index === step ? "active" : index < step ? "complete" : ""} key={label}><span>{index < step ? <Check size={14} /> : index + 1}</span><div><strong>{label}</strong><small>{index === 0 ? "Owner account" : index === 1 ? "Bind & TLS" : index === 2 ? "Local engine" : "Review settings"}</small></div></li>)}</ol>
          <div className="setup-trust"><ShieldCheck size={18} /><p><strong>Your trust anchor</strong>Keys are generated locally and stored with root-only permissions.</p></div>
        </aside>
        <form className="setup-form" onSubmit={next}>
          {step === 0 && <>
            <span className="form-icon"><UserRound size={22} /></span><p className="eyebrow">Step 1 of 4</p><h2>Create the administrator</h2><p>This account can approve agents, open root terminals and install signed updates.</p>
            <div className="field-grid"><label>Display name<input autoFocus value={input.displayName} onChange={(e) => update("displayName", e.target.value)} placeholder="Morgan Lee" required /></label><label>Username<input value={input.username} onChange={(e) => update("username", e.target.value)} autoComplete="username" required /></label></div>
            <label>Password<div className="input-action"><input type={showPassword ? "text" : "password"} value={input.password} onChange={(e) => update("password", e.target.value)} autoComplete="new-password" placeholder="14+ characters" required /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((v) => !v)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
            <div className="password-meter"><i className={input.password.length >= 14 ? "met" : ""} /><i className={/[A-Z]/.test(input.password) ? "met" : ""} /><i className={/\d/.test(input.password) ? "met" : ""} /><span>{passwordStrong ? "Strong password" : "14+ chars / uppercase / number"}</span></div>
            <label>Confirm password<input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required /></label>
          </>}
          {step === 1 && <>
            <span className="form-icon"><Network size={22} /></span><p className="eyebrow">Step 2 of 4</p><h2>Choose network access</h2><p>Initial setup is loopback-only. You can safely expose the console to your LAN after the administrator is created.</p>
            <label>Bind address<select value={input.bindAddress} onChange={(e) => update("bindAddress", e.target.value)}><option value="127.0.0.1">127.0.0.1 - This computer only</option><option value="0.0.0.0">0.0.0.0 - LAN interfaces</option></select></label>
            <div className="field-grid"><label>Web console port<input type="number" min="1024" max="65535" value={input.webPort} onChange={(e) => update("webPort", Number(e.target.value))} required /></label><label>Agent mTLS port<input type="number" min="1024" max="65535" value={input.agentPort} onChange={(e) => update("agentPort", Number(e.target.value))} required /></label></div>
            <div className="fingerprint-box"><LockKeyhole size={17} /><div><small>Server certificate fingerprint</small><code>{status.serverFingerprint}</code></div><button type="button" aria-label="Copy fingerprint" onClick={() => navigator.clipboard?.writeText(status.serverFingerprint)}><Copy size={16} /></button></div>
          </>}
          {step === 2 && <>
            <span className="form-icon"><Container size={22} /></span><p className="eyebrow">Step 3 of 4</p><h2>Connect local Docker</h2><p>{status.localDocker === "available" ? "The manager found a rootful Docker Engine socket on this host." : "The manager can safely probe the local Docker socket during setup."}</p>
            <button type="button" disabled={status.localDocker !== "available"} className={`docker-choice ${input.registerLocalDocker ? "selected" : ""}`} onClick={() => update("registerLocalDocker", true)}><span><Container size={19} /></span><div><strong>Register accessible local engine</strong><small>/var/run/docker.sock / {status.localDocker === "available" ? "Available to bored-managerd" : "Unavailable; use the reviewed host workflow after setup"}</small></div><i>{input.registerLocalDocker && <Check size={15} />}</i></button>
            <button type="button" className={`docker-choice ${!input.registerLocalDocker ? "selected" : ""}`} onClick={() => { update("registerLocalDocker", false); update("dockerRiskAccepted", false); }}><span><ArrowRight size={19} /></span><div><strong>Skip for now</strong><small>Add a local or SSH host later</small></div><i>{!input.registerLocalDocker && <Check size={15} />}</i></button>
            {input.registerLocalDocker && <label className="risk-confirm"><input type="checkbox" checked={input.dockerRiskAccepted} onChange={(e) => update("dockerRiskAccepted", e.target.checked)} /><span><strong>I understand this grants root-equivalent control.</strong>The Docker socket can control the host. Only trusted administrators should access Bored Manager.</span></label>}
          </>}
          {step === 3 && <>
            <span className="form-icon"><ShieldCheck size={22} /></span><p className="eyebrow">Step 4 of 4</p><h2>Review and create</h2><p>Bored Manager will atomically create the administrator and store these network settings. A manual systemd restart is required only when the listener changes.</p>
            <dl className="review-list"><div><dt>Administrator</dt><dd>{input.displayName} / @{input.username}</dd></div><div><dt>Console</dt><dd>https://{input.bindAddress === "0.0.0.0" ? "<manager-LAN-address>" : input.bindAddress}:{input.webPort}</dd></div><div><dt>Agent endpoint</dt><dd>{input.bindAddress}:{input.agentPort}</dd></div><div><dt>Local Docker</dt><dd>{input.registerLocalDocker ? "Register during setup" : "Not registered"}</dd></div><div><dt>Certificate</dt><dd><code>{status.serverFingerprint.slice(0, 31)}...</code></dd></div></dl>
            <div className="completion-note"><ShieldCheck size={18} /><span><strong>Ready to secure this manager</strong>Setup is single-use and no private key leaves this host.</span></div>
          </>}
          {error && <div className="inline-error" role="alert">{error}</div>}
          <footer className="setup-actions">{step > 0 ? <Button variant="ghost" type="button" onClick={() => setStep((v) => v - 1)}><ArrowLeft size={17} /> Back</Button> : <span />}{step < 3 ? <Button type="submit">Continue <ArrowRight size={17} /></Button> : <Button type="button" busy={busy} onClick={complete}>Create manager <ShieldCheck size={17} /></Button>}</footer>
        </form>
      </main>
      <footer className="setup-footer">Bored Manager stores all state on this computer / Apache-2.0</footer>
    </div>
  );
}
