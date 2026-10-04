import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Field, Input, KeyValue, Spinner } from '@ao/ui';
import { ApiError, get, post } from '../lib/api';
import { useSession } from '../lib/session';
import { PageHeader } from '../Layout';

/**
 * Approve signing in the CLI or the mobile app with this web session (whatever it used: password, Google,
 * GitHub, SSO, two-factor). The code comes from the CLI/app, usually through the link it opened.
 */
export function DeviceLoginPage() {
  const [params] = useSearchParams();
  const { session } = useSession();
  const [code, setCode] = useState((params.get('code') ?? '').toUpperCase());
  const valid = /^[A-Z]{4}-\d{4}$/.test(code.trim());
  const pending = useQuery({
    queryKey: ['device-login', code],
    queryFn: () => get<{ clientName: string; ip: string | null; userAgent: string | null; requestedAt: string }>(`/auth/device/${encodeURIComponent(code.trim())}`),
    enabled: valid,
    retry: false,
  });
  const decide = useMutation({ mutationFn: (approve: boolean) => post(`/auth/device/${encodeURIComponent(code.trim())}/decision`, { approve }).then(() => approve) });
  return (
    <div className="flex max-w-[620px] flex-col gap-4">
      <PageHeader title="Sign in a device" description="Approve signing in agentctl or the mobile app with your account." />
      <Card>
        <div className="stack">
          {decide.isSuccess ? (
            <Alert>{decide.data ? 'Approved. Go back to the CLI or the app: it is signed in now.' : 'Denied. The CLI or app was not signed in.'}</Alert>
          ) : (
            <>
              <Field label="Code" hint="Shown by the CLI or the app, e.g. ABCD-1234">
                {(id) => <Input id={id} className="code-block" value={code} maxLength={9} autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value.toUpperCase())} />}
              </Field>
              {valid && pending.isLoading && <Spinner label="Looking up the code…" />}
              {valid && pending.error && <Alert tone="danger">{(pending.error as ApiError).message}</Alert>}
              {pending.data && (
                <>
                  <KeyValue
                    items={[
                      ['Requested by', pending.data.clientName],
                      ['From', pending.data.ip ?? 'unknown address'],
                      ['At', new Date(pending.data.requestedAt).toLocaleString()],
                      ['Signs in as', session?.user.email ?? ''],
                    ]}
                  />
                  <Alert tone="warn">Only approve if you started this yourself, just now. Never approve a code someone sent you.</Alert>
                  {decide.error && <Alert tone="danger">{(decide.error as ApiError).message}</Alert>}
                  <div className="row">
                    <Button variant="primary" loading={decide.isPending} onClick={() => decide.mutate(true)}>Approve</Button>
                    <Button onClick={() => decide.mutate(false)}>Deny</Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
