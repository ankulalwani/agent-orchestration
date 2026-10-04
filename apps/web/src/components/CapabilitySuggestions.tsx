import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PackageDto } from '@ao/contracts';
import { getCategory, getTechnology } from '@ao/core/shared';
import { Alert, Badge, Button, Spinner } from '@ao/ui';
import { ApiError, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';

export interface Suggestion {
  package: PackageDto;
  score: number;
  reasons: string[];
  installed: boolean;
}
export interface SuggestionsResult {
  items: Suggestion[];
  signals: { technologies: string[]; categories: string[] };
}
export interface SuggestInput {
  text?: string;
  projectId?: string;
  taskId?: string;
  type?: string;
  limit?: number;
}

/** The value, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 600): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useSuggestions(input: SuggestInput, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['suggestions', orgId, input],
    queryFn: () => post<SuggestionsResult>(`/orgs/${orgId}/registry/suggest`, { text: '', ...input }),
    enabled,
    staleTime: 60_000,
  });
}

export const categoryLabel = (slug: string) => getCategory(slug)?.label ?? slug;
export const technologyLabel = (slug: string) => getTechnology(slug)?.label ?? slug;

/** Category and technology chips for a package. */
export function ClassificationChips({ pkg }: { pkg: Pick<PackageDto, 'categories' | 'technologies'> }) {
  if (!pkg.categories.length && !pkg.technologies.length) return null;
  return (
    <div className="row small" style={{ flexWrap: 'wrap', gap: 4 }}>
      {pkg.categories.filter((c) => c !== 'other').map((c) => <Badge key={c} tone="neutral">{categoryLabel(c)}</Badge>)}
      {pkg.technologies.slice(0, 6).map((t) => <code key={t}>{technologyLabel(t)}</code>)}
    </div>
  );
}

/** What the text was understood to be about. */
export function SignalsLine({ signals }: { signals: SuggestionsResult['signals'] }) {
  const parts = [...signals.technologies.map(technologyLabel), ...signals.categories.map(categoryLabel)];
  if (!parts.length) return null;
  return <div className="small muted">Understood as: {parts.slice(0, 8).join(', ')}</div>;
}

/**
 * Compact suggestions for a task being written: installed ones can be requested for the task (they are
 * then always given to the agent), others installed just for me in one click.
 */
export function TaskCapabilitySuggestions({ text, projectId, selected, onToggle }: { text: string; projectId?: string; selected: string[]; onToggle: (ref: string) => void }) {
  const { can } = useSession();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const debounced = useDebounced({ text, projectId });
  const enough = debounced.text.trim().length >= 12;
  const q = useSuggestions({ text: debounced.text, projectId: debounced.projectId, limit: 6 }, enough);
  const install = useMutation({
    mutationFn: (ref: string) => post(`/orgs/${orgId}/capability-installations`, { capabilityId: ref, scope: 'USER', enabled: true, config: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['suggestions', orgId] });
      void qc.invalidateQueries({ queryKey: ['installations', orgId] });
    },
  });
  if (!enough) return null;
  if (q.isLoading) return <Spinner />;
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-line bg-surface-2/50 p-3">
      <strong className="small">Suggested capabilities</strong>
      {install.error && <Alert tone="danger">{install.error instanceof ApiError ? install.error.message : 'Could not install'}</Alert>}
      {items.map((s) => (
        <div key={s.package.id} className="row small" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <span>
            {s.package.curated && <Badge tone="accent">curated</Badge>} <strong>{s.package.displayName}</strong> <span className="muted">{s.reasons[0] ?? ''}</span>
          </span>
          {s.installed ? (
            <label className="row small">
              <input type="checkbox" checked={selected.includes(s.package.ref)} onChange={() => onToggle(s.package.ref)} /> Use for this task
            </label>
          ) : (
            can('capability.personal') && (
              <Button size="sm" loading={install.isPending && install.variables === s.package.ref} onClick={() => install.mutate(s.package.ref)}>
                Install for me
              </Button>
            )
          )}
        </div>
      ))}
    </div>
  );
}
