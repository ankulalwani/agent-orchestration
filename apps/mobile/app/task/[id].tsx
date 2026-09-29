import { useState } from 'react';
import { Alert, Linking, Pressable, Text } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskDto, TaskEventDto } from '@ao/contracts';
import { ApiError, get, post } from '../../lib/api';
import { useOrgId, useSession } from '../../lib/session';
import { Badge, Button, Card, ErrorText, Input, Loading, Row, Screen, StatusBadge, T, humanize, useTheme } from '../../components/ui';

/** Task detail with the mobile actions of spec §53: view, pause, resume, cancel, retry, approve, input, logs, verification, Git. */
export default function TaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const theme = useTheme();
  const [input, setInput] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const task = useQuery({ queryKey: ['task', orgId, id], queryFn: () => get<TaskDto>(`/orgs/${orgId}/tasks/${id}`), enabled: Boolean(orgId && id), refetchInterval: 20_000 });
  const output = useQuery({ queryKey: ['events', orgId, id, 'output'], queryFn: () => get<{ items: TaskEventDto[] }>(`/orgs/${orgId}/tasks/${id}/events?limit=300&includeOutput=true`), enabled: showLogs });
  const applyPlan = useMutation({
    mutationFn: () => post<{ taskIds: string[] }>(`/orgs/${orgId}/tasks/${id}/apply-plan`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['task', orgId, id] });
      void qc.invalidateQueries({ queryKey: ['tasks', orgId] });
    },
  });
  const action = useMutation({
    mutationFn: (body: { action: string; input?: string }) => post<TaskDto>(`/orgs/${orgId}/tasks/${id}/actions`, body),
    onSuccess: (t) => {
      qc.setQueryData(['task', orgId, id], t);
      setInput('');
    },
  });
  if (!task.data) return <Loading />;
  const t = task.data;
  const act = (a: string) => action.mutate({ action: a });
  const confirmCancel = () => Alert.alert('Cancel task?', 'Work done so far stays in the project directory.', [{ text: 'Keep running', style: 'cancel' }, { text: 'Cancel task', style: 'destructive', onPress: () => act('cancel') }]);
  const lines = (output.data?.items ?? []).filter((e) => e.type === 'AgentOutput').flatMap((e) => (e.payload.lines as string[] | undefined) ?? []);
  const review = t.completionReport?.review;
  const plan = t.completionReport?.plan;
  const confirmApply = () =>
    Alert.alert(`Create ${plan!.tasks.length} tasks?`, 'They run in the order of their dependencies.', [
      { text: 'Not now', style: 'cancel' },
      { text: 'Create', onPress: () => applyPlan.mutate() },
    ]);

  return (
    <Screen refreshing={task.isFetching} onRefresh={() => void task.refetch()}>
      <Stack.Screen options={{ title: t.title }} />
      <Card>
        <T bold style={{ fontSize: 18 }}>{t.title}</T>
        <Row>
          <StatusBadge status={t.status} />
          <Badge label={humanize(t.priority)} />
          {t.kind && t.kind !== 'code' ? <Badge label={t.kind === 'review' ? 'Review' : 'Plan'} tone="accent" /> : null}
        </Row>
        {t.source ? (
          <Pressable disabled={!t.source.url} onPress={() => t.source?.url && void Linking.openURL(t.source.url)} accessibilityRole={t.source.url ? 'link' : undefined}>
            <T muted small>From {t.source.name}{t.source.ref ? ` (${t.source.ref})` : ''}</T>
          </Pressable>
        ) : null}
        {t.parentTaskId ? (
          <Pressable onPress={() => router.push(`/task/${t.parentTaskId}`)} accessibilityRole="link">
            <T muted small>Part of a plan ›</T>
          </Pressable>
        ) : null}
        {t.review ? <T muted small>Reviews {t.review.head} against {t.review.base}</T> : null}
        {t.statusReason ? <T muted small>{t.statusReason}</T> : null}
        {t.status === 'WAITING_FOR_LIMIT' && <T small>Provider limit reached — paused, not failed. {t.waitingUntil ? `Resumes after ${new Date(t.waitingUntil).toLocaleString()}.` : 'Reset time unknown.'}</T>}
        {t.agentId ? <T muted small>{t.agentId} · {t.providerId} · {t.modelId}</T> : null}
        {t.progress.currentStep ? <T small>Now: {t.progress.currentStep}</T> : null}
      </Card>

      {t.pendingInteraction && (
        <Card title={t.pendingInteraction.kind === 'approval' ? 'Approval required' : 'Agent needs input'}>
          <T>{t.pendingInteraction.question}</T>
          {t.pendingInteraction.kind === 'input' && can('task.control') && (
            <>
              <Input label="Your response" value={input} onChangeText={setInput} multiline style={{ minHeight: 80, textAlignVertical: 'top', paddingTop: 10 }} />
              <Button label="Send" variant="primary" disabled={!input.trim()} loading={action.isPending} onPress={() => action.mutate({ action: 'input', input })} />
            </>
          )}
          {t.pendingInteraction.kind === 'approval' && can('task.approve') && (
            <Row>
              <Button label="Approve" variant="primary" loading={action.isPending} onPress={() => act('approve')} />
              <Button label="Deny" variant="danger" onPress={() => act('deny')} />
            </Row>
          )}
        </Card>
      )}

      {can('task.control') && (
        <Row>
          {['RUNNING', 'WAITING_FOR_LIMIT'].includes(t.status) && <Button label="Pause" onPress={() => act('pause')} />}
          {['PAUSED', 'WAITING_FOR_LIMIT'].includes(t.status) && <Button label="Resume" onPress={() => act('resume')} />}
          {['FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(t.status) && <Button label="Retry" variant="primary" onPress={() => act('retry')} />}
          {!['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status) && <Button label="Cancel" variant="danger" onPress={confirmCancel} />}
        </Row>
      )}
      {action.error ? <ErrorText error={action.error instanceof ApiError ? action.error : new Error('Action failed')} /> : null}

      <Card title="Verification" right={<Badge label={humanize(t.verificationStatus)} tone={t.verificationStatus === 'PASSED' ? 'ok' : t.verificationStatus === 'FAILED' ? 'danger' : 'neutral'} />}>
        {t.verificationRuns.length ? (
          t.verificationRuns[t.verificationRuns.length - 1]!.steps.map((s, i) => (
            <Row key={i} style={{ justifyContent: 'space-between' }}>
              <T small style={{ flexShrink: 1 }}>{s.name}</T>
              <Badge label={s.status} tone={s.status === 'passed' ? 'ok' : s.status === 'skipped' ? 'neutral' : 'danger'} />
            </Row>
          ))
        ) : (
          <T muted small>Not run yet</T>
        )}
      </Card>

      <Card title="Git" right={<Badge label={humanize(t.gitStatus)} tone={t.gitStatus === 'NONE' ? 'neutral' : ['BLOCKED', 'FAILED'].includes(t.gitStatus) ? 'warn' : 'ok'} />}>
        {t.gitResult ? (
          <>
            <T small>{t.gitResult.commit ? `Commit ${t.gitResult.commit.slice(0, 10)} on ${t.gitResult.branch}` : 'No commit'}</T>
            <T muted small>{t.gitResult.filesChanged.length} files changed{t.gitResult.pushed ? ' · pushed' : ''}</T>
            {t.gitResult.blocked.map((b, i) => <T key={i} small>{b}</T>)}
          </>
        ) : (
          <T muted small>No Git operations yet</T>
        )}
      </Card>

      {review && (
        <Card title="Review" right={<Badge label={humanize(review.verdict)} tone={review.verdict === 'approve' ? 'ok' : review.verdict === 'request_changes' ? 'danger' : 'accent'} />}>
          <T>{review.summary}</T>
          {review.comments.map((c, i) => (
            <T key={i} small>
              [{c.severity}] {c.path}
              {c.line ? `:${c.line}` : ''} — {c.body}
            </T>
          ))}
        </Card>
      )}

      {plan && (
        <Card title={`Plan: ${plan.tasks.length} tasks`} right={t.planApplied ? <Badge label="created" tone="ok" /> : undefined}>
          <T>{plan.summary}</T>
          {plan.tasks.map((x, i) => {
            const createdId = t.planApplied?.taskIds[i];
            const after = x.dependsOn.map((d) => plan.tasks.find((y) => y.key === d)?.title ?? d).join(', ');
            return (
              <Pressable key={x.key} disabled={!createdId} onPress={() => createdId && router.push(`/task/${createdId}`)}>
                <T small bold={Boolean(createdId)}>
                  {i + 1}. {x.title}
                  {createdId ? ' ›' : ''}
                </T>
                {after ? <T muted small>after {after}</T> : null}
              </Pressable>
            );
          })}
          {!t.planApplied && can('task.create') && <Button label={`Create ${plan.tasks.length} tasks`} variant="primary" loading={applyPlan.isPending} onPress={confirmApply} />}
          {applyPlan.error ? <ErrorText error={applyPlan.error} /> : null}
        </Card>
      )}

      {t.completionReport && (
        <Card title="Report">
          <T>{t.completionReport.summary}</T>
          {t.completionReport.remainingWork.length > 0 && <T small>Remaining: {t.completionReport.remainingWork.join('; ')}</T>}
          {t.completionReport.warnings.map((w, i) => <T key={i} muted small>⚠ {w}</T>)}
        </Card>
      )}

      <Card title="Logs" right={<Button label={showLogs ? 'Hide' : 'Show'} onPress={() => setShowLogs((v) => !v)} />}>
        {showLogs &&
          (output.isLoading ? (
            <Loading />
          ) : (
            <Text selectable style={{ fontFamily: 'monospace', fontSize: 12, color: theme.text2 }}>{lines.slice(-200).join('\n') || 'No output yet'}</Text>
          ))}
      </Card>
    </Screen>
  );
}
