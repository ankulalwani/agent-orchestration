import { useState } from 'react';
import { Pressable } from 'react-native';
import { getServer, signOut } from '../../lib/api';
import { pushUnavailableReason, registerForPush } from '../../lib/push';
import { useSession } from '../../lib/session';
import { Badge, Button, Card, Row, Screen, T, humanize, useTheme } from '../../components/ui';

export default function Settings() {
  const { session, org, setOrg } = useSession();
  const t = useTheme();
  const [push, setPush] = useState<string | null>(null);
  return (
    <Screen>
      <Card title="Account">
        <T>{session?.user.name}</T>
        <T muted small>{session?.user.email}</T>
        <T muted small>Server: {getServer()}</T>
      </Card>
      {session && session.memberships.length > 1 && (
        <Card title="Organization">
          {session.memberships.map((m) => (
            <Pressable key={m.organizationId} accessibilityRole="radio" accessibilityState={{ checked: m.organizationId === org?.organizationId }} onPress={() => setOrg(m.organizationId)} style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: t.border }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T bold={m.organizationId === org?.organizationId}>{m.organizationName}</T>
                <Badge label={humanize(m.role)} />
              </Row>
            </Pressable>
          ))}
        </Card>
      )}
      <Card title="Notifications">
        <T muted small>Task completed or failed, approvals, input requests, provider limits, recovery required and workers going offline. Your server administrator must enable push delivery.</T>
        {pushUnavailableReason() ? (
          <T small>{pushUnavailableReason()}</T>
        ) : (
          <Button label="Enable push notifications" onPress={() => void registerForPush().then((r) => setPush(r.ok ? 'Push notifications enabled' : (r.reason ?? 'Not enabled')))} />
        )}
        {push ? <T small>{push}</T> : null}
      </Card>
      <Button label="Sign out" variant="danger" onPress={() => void signOut()} />
    </Screen>
  );
}
