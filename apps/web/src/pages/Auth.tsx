import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Field, Input, Spinner } from '@ao/ui';
import { BrandMark } from '../Layout';
import type { InvitationPreviewDto, OAuthProviderDto } from '@ao/contracts';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApiError, api, completeOAuth, login, oauthStartUrl, refreshSession, register, type SecondFactor } from '../lib/api';
import { useSession } from '../lib/session';

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="center-screen">
      <div className="auth-card flex flex-col gap-5">
        <div className="flex items-center justify-center gap-2.5 text-[15px] font-semibold">
          <BrandMark className="size-7" /> Agent Orchestration
        </div>
        <section className="card p-5">
          <h1 className="mb-4 text-base">{title}</h1>
          {children}
        </section>
      </div>
    </div>
  );
}

const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Check your connection and try again.');

/** Messages for the error codes the OAuth callback sends back (never the provider's own text). */
export const OAUTH_ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  expired: 'That sign-in attempt expired. Please try again.',
  no_account: 'There is no account for that email on this server. Ask an administrator for an invitation.',
  email_unverified: 'The provider did not confirm your email address, so it cannot be used to sign in here.',
  identity_in_use: 'That account is already connected to a different user here.',
  disabled: 'This account is disabled.',
  invitation_invalid: 'The invitation is invalid, expired, or was sent to a different email address.',
  provider_error: 'The sign-in provider returned an error. Please try again.',
};

export function useOAuthProviders() {
  const [providers, setProviders] = useState<OAuthProviderDto[]>([]);
  useEffect(() => {
    api<OAuthProviderDto[]>('GET', '/auth/oauth/providers')
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);
  return providers;
}

function ProviderButtons({ next, invitation, verb = 'Continue' }: { next?: string; invitation?: string; verb?: string }) {
  const providers = useOAuthProviders();
  if (!providers.length) return null;
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs text-fg-3 before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">or</div>
      {providers.map((p) => (
        <a key={p.id} className="btn" href={oauthStartUrl(p.id, { next, invitation })}>
          {verb} with {p.name}
        </a>
      ))}
    </div>
  );
}

/** True when the server offered a security key with `MFA_REQUIRED`. */
const offersSecurityKey = (e: unknown) => e instanceof ApiError && e.code === 'MFA_REQUIRED' && Boolean(e.context?.securityKey);

/**
 * Signs in with a security key: a sign-in without a second step gets a fresh challenge (each is used
 * once), the browser's authenticator answers it, and the sign-in is repeated with the answer.
 */
async function signInWithSecurityKey(attempt: (second?: SecondFactor) => Promise<unknown>) {
  let options: unknown;
  try {
    await attempt();
    return;
  } catch (e) {
    if (!offersSecurityKey(e)) throw e;
    options = (e as ApiError).context!.securityKey;
  }
  let answer;
  try {
    answer = await startAuthentication({ optionsJSON: options as never });
  } catch {
    throw new ApiError(0, 'CANCELLED', 'The security key was not used. Try again, or enter a code.');
  }
  await attempt({ securityKey: answer });
}

function MfaCodeForm({ busy, error, code, setCode, onSubmit, onBack, onSecurityKey }: { busy: boolean; error: string | null; code: string; setCode: (v: string) => void; onSubmit: (e: FormEvent) => void; onBack: () => void; /** Set when the account has a security key. */ onSecurityKey?: () => void }) {
  return (
    <AuthShell title="Two-factor authentication">
      <form className="stack" onSubmit={onSubmit}>
        {error && <Alert tone="danger">{error}</Alert>}
        {onSecurityKey && (
          <>
            <Button type="button" variant="primary" loading={busy} onClick={onSecurityKey}>Use a security key</Button>
            <div className="flex items-center gap-3 text-xs text-fg-3 before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">or enter a code</div>
          </>
        )}
        <Field label="Authentication code" hint="The 6-digit code from your authenticator app, or one of your recovery codes">
          {(id) => <Input id={id} autoFocus={!onSecurityKey} inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Button variant={onSecurityKey ? 'default' : 'primary'} type="submit" loading={busy}>Verify</Button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          Back
        </button>
      </form>
    </AuthShell>
  );
}

/** `/oauth/complete#ticket=…&next=…`: exchanges the ticket from the provider callback for a session. */
export function OAuthCompletePage() {
  const nav = useNavigate();
  const [{ ticket, next }] = useState(() => {
    const f = new URLSearchParams(window.location.hash.slice(1));
    // Take the ticket out of the address bar and history right away.
    window.history.replaceState(null, '', window.location.pathname);
    const n = f.get('next') ?? '/';
    return { ticket: f.get('ticket') ?? '', next: n.startsWith('/') && !n.startsWith('//') ? n : '/' };
  });
  const [mfaStep, setMfaStep] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [hasKey, setHasKey] = useState(false);
  async function finish(mfaCode?: string, withKey = false) {
    setBusy(true);
    setError(null);
    try {
      if (withKey) await signInWithSecurityKey((second) => completeOAuth(ticket, second));
      else await completeOAuth(ticket, mfaCode);
      nav(next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') {
        setMfaStep(true);
        setHasKey(offersSecurityKey(err));
      } else {
        setError(message(err));
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (ticket) void finish();
    else setError('This sign-in link is invalid. Start again.');
    // Runs once for the ticket in the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (mfaStep) {
    return (
      <MfaCodeForm
        busy={busy}
        error={error}
        code={code}
        setCode={setCode}
        onSubmit={(e) => {
          e.preventDefault();
          void finish(code);
        }}
        onBack={() => nav('/login', { replace: true })}
        onSecurityKey={hasKey ? () => void finish(undefined, true) : undefined}
      />
    );
  }
  return (
    <AuthShell title="Signing in">
      {error ? (
        <div className="stack">
          <Alert tone="danger">{error}</Alert>
          <Link to="/login">Back to sign in</Link>
        </div>
      ) : (
        <Spinner label="Signing you in…" />
      )}
    </AuthShell>
  );
}

export function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [mfaStep, setMfaStep] = useState(false);
  const [mfaCode, setMfaCode] = useState('');

  const [hasKey, setHasKey] = useState(false);
  async function submit(e: FormEvent | null, withKey = false) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (withKey) await signInWithSecurityKey((second) => login(email, password, second));
      else await login(email, password, mfaStep ? mfaCode : undefined);
      nav(params.get('next') ?? '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') {
        setMfaStep(true);
        setHasKey(offersSecurityKey(err));
      } else {
        setError(message(err));
        setMfaCode('');
      }
    } finally {
      setBusy(false);
    }
  }

  if (mfaStep) {
    return (
      <MfaCodeForm
        busy={busy}
        error={error}
        code={mfaCode}
        setCode={setMfaCode}
        onSubmit={submit}
        onSecurityKey={hasKey ? () => void submit(null, true) : undefined}
        onBack={() => {
          setMfaStep(false);
          setMfaCode('');
          setPassword('');
          setError(null);
        }}
      />
    );
  }

  const oauthError = params.get('oauthError');
  return (
    <AuthShell title="Sign in">
      <form className="stack" onSubmit={submit}>
        {oauthError && !error && <Alert tone="danger">{OAUTH_ERRORS[oauthError] ?? OAUTH_ERRORS.provider_error}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        {resetSent && <Alert>If an account exists for that email, a reset link has been sent.</Alert>}
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button variant="primary" type="submit" loading={busy}>Sign in</Button>
        <div className="spread small">
          <Link to="/register">Create an account</Link>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!email}
            onClick={() => void api('POST', '/auth/password-reset', { email }).then(() => setResetSent(true))}
          >
            Forgot password?
          </button>
        </div>
      </form>
      <ProviderButtons next={params.get('next') ?? undefined} />
    </AuthShell>
  );
}

export function RegisterPage() {
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', organizationName: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({ ...form, organizationName: form.organizationName || undefined });
      nav('/welcome', { replace: true });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account">
      <form className="stack" onSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Your name">{(id) => <Input id={id} autoComplete="name" required value={form.name} onChange={set('name')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" required value={form.email} onChange={set('email')} />}</Field>
        <Field label="Password" hint="At least 10 characters">{(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} required value={form.password} onChange={set('password')} />}</Field>
        <Field label="Organization name" hint="Optional — you can rename it later">{(id) => <Input id={id} value={form.organizationName} onChange={set('organizationName')} />}</Field>
        <Button variant="primary" type="submit" loading={busy}>Create account</Button>
        <div className="small">
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </form>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return (
    <AuthShell title="Choose a new password">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          api('POST', '/auth/password-reset/confirm', { token: params.get('token'), password })
            .then(() => setDone(true))
            .catch((err) => setError(message(err)));
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {done ? (
          <>
            <Alert>Your password was changed. You have been signed out of all sessions.</Alert>
            <Button variant="primary" onClick={() => nav('/login')}>Sign in</Button>
          </>
        ) : (
          <>
            <Field label="New password" hint="At least 10 characters">{(id) => <Input id={id} type="password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
            <Button variant="primary" type="submit">Set password</Button>
          </>
        )}
      </form>
    </AuthShell>
  );
}

/** Invitation link landing page (`/invite?token=…`): join as the signed-in user, or create an account. */
export function InvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const { session, loading, setOrgId } = useSession();
  const [invite, setInvite] = useState<InvitationPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', password: '' });

  useEffect(() => {
    api<InvitationPreviewDto>('POST', '/invitations/preview', { token })
      .then(setInvite)
      .catch((err) => setError(message(err)));
  }, [token]);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      setOrgId(await fn());
      nav('/', { replace: true });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const accept = () =>
    run(async () => {
      const { organizationId } = await api<{ organizationId: string }>('POST', '/invitations/accept', { token });
      await refreshSession(); // picks up the new membership
      return organizationId;
    });
  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => (await register({ email: invite!.email, ...form, invitationToken: token })).memberships[0]!.organizationId);
  };

  if (!invite || loading) {
    return <AuthShell title="Invitation">{error ? <Alert tone="danger">{error}</Alert> : <Spinner label="Loading invitation…" />}</AuthShell>;
  }
  const next = `/login?next=${encodeURIComponent(`/invite?token=${token}`)}`;
  const wrongAccount = session && session.user.email.toLowerCase() !== invite.email;
  return (
    <AuthShell title={`Join ${invite.organizationName}`}>
      <div className="stack">
        <p>
          {invite.invitedByName || 'A member'} invited <strong>{invite.email}</strong> to join <strong>{invite.organizationName}</strong> as {invite.role.toLowerCase()}.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        {session && !wrongAccount ? (
          <Button variant="primary" loading={busy} onClick={() => void accept()}>Join {invite.organizationName}</Button>
        ) : wrongAccount ? (
          <Alert>You are signed in as {session!.user.email}. Sign out and sign in as {invite.email} to accept.</Alert>
        ) : invite.accountExists ? (
          <Link className="btn btn-primary" to={next}>Sign in to accept</Link>
        ) : (
          <form className="stack" onSubmit={create}>
            <Field label="Your name">{(id) => <Input id={id} autoComplete="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Password" hint="At least 10 characters">{(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}</Field>
            <Button variant="primary" type="submit" loading={busy}>Create account and join</Button>
            <div className="small">
              Already have an account? <Link to={next}>Sign in</Link>
            </div>
            <ProviderButtons invitation={token} />
          </form>
        )}
      </div>
    </AuthShell>
  );
}
