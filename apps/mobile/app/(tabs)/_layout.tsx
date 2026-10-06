import { Tabs } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import { useOrgId } from '../../lib/session';
import { useLive } from '../../lib/live';
import { useTheme } from '../../components/ui';

export default function TabsLayout() {
  const orgId = useOrgId();
  const t = useTheme();
  useLive(orgId);
  const unread = useQuery({ queryKey: ['notifications', orgId, 'count'], queryFn: () => get<{ unread: number }>(`/orgs/${orgId}/notifications?limit=1`), enabled: Boolean(orgId), refetchInterval: 60_000 });
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.accent, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, tabBarStyle: { backgroundColor: t.surface } }}>
      <Tabs.Screen name="index" options={{ title: 'Dashboard', tabBarLabel: 'Dashboard' }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks' }} />
      <Tabs.Screen name="workers" options={{ title: 'Workers' }} />
      <Tabs.Screen name="insights" options={{ title: 'Insights' }} />
      <Tabs.Screen name="activity" options={{ title: 'Activity', tabBarBadge: unread.data?.unread ? unread.data.unread : undefined }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
