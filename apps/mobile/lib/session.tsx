import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthResponse, MembershipDto } from '@ao/contracts';
import { can, type Permission } from '@ao/core/shared';
import { onSession, restore, savedOrg, saveOrg } from './api';

interface SessionValue {
  session: AuthResponse | null;
  loading: boolean;
  org: MembershipDto | null;
  setOrg: (id: string) => void;
  /** UI hint only; the API enforces RBAC (spec §57). */
  can: (p: Permission) => boolean;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgId] = useState<string | null>(null);

  useEffect(() => {
    const off = onSession(setSession);
    void (async () => {
      setOrgId(await savedOrg());
      await restore();
      setLoading(false);
    })();
    return off;
  }, []);

  const value = useMemo<SessionValue>(() => {
    const ms = session?.memberships ?? [];
    const org = ms.find((m) => m.organizationId === orgId) ?? ms[0] ?? null;
    return {
      session,
      loading,
      org,
      setOrg: (id) => {
        setOrgId(id);
        void saveOrg(id);
      },
      can: (p) => (org ? can(org.role, p) : false),
    };
  }, [session, loading, orgId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside provider');
  return v;
}

export function useOrgId() {
  const { org } = useSession();
  return org?.organizationId ?? '';
}
