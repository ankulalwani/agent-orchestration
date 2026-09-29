import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@ao/ui';
import { ApiError, post } from '../lib/api';

/**
 * Confirms turning off someone's two-factor authentication. `path` is the organization route for
 * owners/admins, or the server route for platform administrators.
 */
export function ResetMfaDialog({ person, path, onClose, onDone }: { person: { name: string; email: string }; path: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const reset = useMutation({ mutationFn: () => post(path, { reason }), onSuccess: onDone });
  return (
    <Dialog
      open
      title="Turn off two-factor authentication"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={reason.trim().length < 5} loading={reset.isPending} onClick={() => reset.mutate()}>
            Turn off
          </Button>
        </>
      }
    >
      <div className="stack">
        {reset.error && <Alert tone="danger">{(reset.error as ApiError).message}</Alert>}
        <p style={{ margin: 0 }}>
          For <strong>{person.name}</strong> ({person.email}), when they lost their authenticator app and recovery codes. They are signed out everywhere and get an email.
          They sign in with their password and should turn two-factor authentication on again.
        </p>
        <Alert tone="warn">Make sure you are talking to the real person (for example by phone or in person) before doing this.</Alert>
        <Field label="Reason" hint="Recorded in the audit log and included in the email">
          {(id) => <Input id={id} value={reason} maxLength={500} placeholder="Lost phone; identity confirmed by phone call" onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
