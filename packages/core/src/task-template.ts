/**
 * Task templates: reusable task text with `{{variable}}` placeholders (letters, digits, `_` and `-`).
 * Pure functions, shared by the server (which creates the task) and the dashboard (which previews it).
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z][\w-]{0,39})\s*\}\}/g;

/** The variables a template's texts use, in order of first appearance. */
export function templateVariables(...texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const text of texts) for (const m of (text ?? '').matchAll(PLACEHOLDER)) seen.add(m[1]!);
  return [...seen];
}

/** Replaces each `{{variable}}` with its value; a variable without a value becomes empty. */
export function fillTaskTemplate(text: string, values: Record<string, string | undefined>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => values[name] ?? '');
}
