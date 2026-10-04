import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { Permission } from '@ao/core/shared';

/**
 * Web dashboard extension point (docs/PUBLIC_PRIVATE_BOUNDARY.md), the counterpart of the API's `extend`.
 * A distribution renders the same dashboard with `renderWebApp(extension)` and adds its own pages,
 * navigation and notices; the core dashboard never depends on an extension.
 */
export interface WebNavContext {
  can: (p: Permission) => boolean;
  platformAdmin: boolean;
}

export interface WebNavItem {
  to: string;
  label: string;
  /** Shown before the label in the sidebar (an icon component taking className). */
  icon?: ComponentType<{ className?: string }>;
  /** `organization`: with the organization's pages; `server`: with the platform administrators' pages. */
  section: 'organization' | 'server';
  /** Hide the item unless this returns true (UI hint only; the API enforces access). */
  visible?: (ctx: WebNavContext) => boolean;
}

export interface WebExtension {
  /** Extra pages inside the signed-in layout. */
  routes?: Array<{ path: string; element: ReactNode }>;
  nav?: WebNavItem[];
  /** Rendered above every signed-in page, for example account notices. */
  Banner?: ComponentType;
}

const Ctx = createContext<WebExtension>({});
export const WebExtensionProvider = Ctx.Provider;
export const useWebExtension = () => useContext(Ctx);
