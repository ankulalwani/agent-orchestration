import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthResponse, MembershipDto } from '@ao/contracts';
import { can, type Permission } from '@ao/core/shared';
import { onSession, refreshSession } from './api';

interface SessionValue {
  session: AuthResponse | null;
  loading: boolean;
  org: MembershipDto | null;
  setOrgId: (id: string) => void;
  /** UI-level permission hint only; the API enforces permissions (spec §57). */
  can: (p: Permission) => boolean;
}

const Ctx = createContext<SessionValue | null>(null);
const ORG_KEY = 'ao.orgId';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ORG_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const off = onSession(setSession);
    void refreshSession().finally(() => setLoading(false));
    return () => {
      off();
    };
  }, []);

  const value = useMemo<SessionValue>(() => {
    const memberships = session?.memberships ?? [];
    const org = memberships.find((m) => m.organizationId === orgId) ?? memberships[0] ?? null;
    return {
      session,
      loading,
      org,
      setOrgId: (id) => {
        setOrgIdState(id);
        try {
          localStorage.setItem(ORG_KEY, id);
        } catch {
          /* storage unavailable */
        }
      },
      can: (p) => (org ? can(org.role, p) : false),
    };
  }, [session, loading, orgId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** The current organization id; pages under the authenticated layout can rely on it. */
export function useOrgId(): string {
  const { org } = useSession();
  if (!org) throw new Error('No organization');
  return org.organizationId;
}
