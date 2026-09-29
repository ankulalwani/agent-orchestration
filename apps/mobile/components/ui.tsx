import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, useColorScheme, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { TaskStatus } from '@ao/core/shared';

/** Native UI primitives (spec §111): no WebView, system light/dark themes, accessible roles and labels. */

const light = { bg: '#f7f8fa', surface: '#ffffff', border: '#e3e6eb', text: '#111827', text2: '#4b5563', text3: '#6b7280', accent: '#2563eb', ok: '#15803d', okSoft: '#e7f6ec', warn: '#b45309', warnSoft: '#fdf3e2', danger: '#b91c1c', dangerSoft: '#fdecec', neutralSoft: '#eef0f3', accentSoft: '#e8efff' };
const dark = { bg: '#0d1117', surface: '#151b23', border: '#2a323d', text: '#e6edf3', text2: '#aab4c0', text3: '#8b96a3', accent: '#4f8cff', ok: '#3fb950', okSoft: '#13291a', warn: '#d29922', warnSoft: '#2e2410', danger: '#f85149', dangerSoft: '#3a1618', neutralSoft: '#222a34', accentSoft: '#1a2a4a' };
export type Theme = typeof light;
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export function Screen({ children, refreshing, onRefresh, scroll = true }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void; scroll?: boolean }) {
  const t = useTheme();
  const body = scroll ? (
    <ScrollView contentContainerStyle={styles.screen} refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} /> : undefined}>
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.screen, { flex: 1 }]}>{children}</View>
  );
  return <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: t.bg }}>{body}</SafeAreaView>;
}

export function Card({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
      {(title || right) && (
        <View style={styles.cardHeader}>
          {title ? <Text style={[styles.h2, { color: t.text }]} accessibilityRole="header">{title}</Text> : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function T({ children, muted, small, bold, style }: { children: ReactNode; muted?: boolean; small?: boolean; bold?: boolean; style?: object }) {
  const t = useTheme();
  return <Text style={[{ color: muted ? t.text3 : t.text, fontSize: small ? 13 : 15, fontWeight: bold ? '600' : '400' }, style]}>{children}</Text>;
}

export function Button({ label, onPress, variant = 'default', loading, disabled }: { label: string; onPress: () => void; variant?: 'default' | 'primary' | 'danger'; loading?: boolean; disabled?: boolean }) {
  const t = useTheme();
  const bg = variant === 'primary' ? t.accent : t.surface;
  const fg = variant === 'primary' ? '#fff' : variant === 'danger' ? t.danger : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, borderColor: variant === 'primary' ? t.accent : t.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '600', fontSize: 15 }}>{label}</Text>}
    </Pressable>
  );
}

export function Input(props: TextInputProps & { label: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: t.text, fontWeight: '600', fontSize: 13 }}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        placeholderTextColor={t.text3}
        {...props}
        style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.surface }, props.style]}
      />
    </View>
  );
}

const TONE: Record<TaskStatus, 'ok' | 'warn' | 'danger' | 'accent' | 'neutral'> = {
  QUEUED: 'neutral', CLAIMING: 'accent', PREPARING: 'accent', RUNNING: 'accent', PAUSED: 'neutral', WAITING_FOR_LIMIT: 'warn',
  WAITING_FOR_INPUT: 'warn', WAITING_FOR_APPROVAL: 'warn', RECOVERY_REQUIRED: 'danger', CRASHED: 'danger', VERIFYING: 'accent',
  COMPLETED: 'ok', FAILED: 'danger', CANCELLED: 'neutral',
};
export const humanize = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'ok' | 'warn' | 'danger' | 'accent' | 'neutral' }) {
  const t = useTheme();
  const map = { ok: [t.okSoft, t.ok], warn: [t.warnSoft, t.warn], danger: [t.dangerSoft, t.danger], accent: [t.accentSoft, t.accent], neutral: [t.neutralSoft, t.text2] } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]} accessibilityLabel={label}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}
export const StatusBadge = ({ status }: { status: TaskStatus }) => <Badge label={humanize(status)} tone={TONE[status]} />;

export function Loading() {
  return <ActivityIndicator style={{ marginTop: 32 }} accessibilityLabel="Loading" />;
}

export function Row({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, style]}>{children}</View>;
}

export function Empty({ text }: { text: string }) {
  return <T muted style={{ textAlign: 'center', paddingVertical: 24 }}>{text}</T>;
}

export function ErrorText({ error }: { error: unknown }) {
  const t = useTheme();
  if (!error) return null;
  return <Text accessibilityRole="alert" style={{ color: t.danger }}>{error instanceof Error ? error.message : String(error)}</Text>;
}

export const styles = StyleSheet.create({
  screen: { padding: 16, gap: 12 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 8 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  h2: { fontSize: 16, fontWeight: '700' },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 15 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, alignSelf: 'flex-start' },
});
