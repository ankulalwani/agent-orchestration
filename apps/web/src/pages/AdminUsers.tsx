import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Input, Spinner } from '@ao/ui';
import { ApiError, get } from '../lib/api';
import { useSession } from '../lib/session';
import { PageHeader } from '../Layout';
import { ResetMfaDialog } from '../components/ResetMfaDialog';

interface UserRow {
  id: string;
  email: string;
  name: string;
  mfaEnabled: boolean;
  platformAdmin: boolean;
  disabled: boolean;
  organizations: number;
}

/** People on this server, for platform administrators: find someone and reset their two-factor authentication. */
export function AdminUsersPage() {
  const { session } = useSession();
  const [q, setQ] = useState('');
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const users = useQuery({ queryKey: ['admin-users', q], queryFn: () => get<UserRow[]>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  return (
    <div className="stack">
      <PageHeader title="Users" description="Everyone with an account on this server." />
      <Input aria-label="Search users" placeholder="Search by email or name" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
      {users.error && <Alert tone="danger">{(users.error as ApiError).message}</Alert>}
      <Card padded={false}>
        {users.isLoading ? (
          <div className="card-body"><Spinner /></div>
        ) : (
          <table className="table" aria-label="Users">
            <thead>
              <tr><th>Person</th><th>Organizations</th><th>Two-factor</th><th /></tr>
            </thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.name} {u.platformAdmin && <Badge tone="accent">server admin</Badge>} {u.disabled && <Badge tone="danger">disabled</Badge>}
                    <div className="small muted">{u.email}</div>
                  </td>
                  <td>{u.organizations}</td>
                  <td>{u.mfaEnabled ? <Badge tone="ok">on</Badge> : <span className="muted small">off</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {u.mfaEnabled && u.id !== session?.user.id && <Button size="sm" onClick={() => setResetting(u)}>Reset two-factor</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {resetting && (
        <ResetMfaDialog
          person={resetting}
          path={`/admin/users/${resetting.id}/reset-mfa`}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            void users.refetch();
          }}
        />
      )}
    </div>
  );
}
