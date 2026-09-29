/**
 * Feature flags (spec §124). Every flag the code checks is declared here, so the admin UI can list
 * them with a description. A flag is off unless its default says otherwise; platform administrators
 * turn flags on for everyone or for single organizations (Server → Feature flags), and the
 * `FEATURE_FLAGS` environment variable forces flags on regardless of what the UI says.
 */
export interface FeatureDefinition {
  key: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
  /** Shown as a warning next to the toggle. */
  stage: 'stable' | 'beta' | 'experimental';
}

export const FEATURES: readonly FeatureDefinition[] = [
  {
    key: 'plugins.execution',
    name: 'Plugin code execution',
    description: 'Workers run the code of approved plugins in a restricted Node.js process (file system, network and child processes limited to what the plugin declares).',
    defaultEnabled: false,
    stage: 'beta',
  },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);

export function featureDefinition(key: string): FeatureDefinition | undefined {
  return FEATURES.find((f) => f.key === key);
}
