import type { CapabilityManifest } from './capabilities.js';

/**
 * Marketplace taxonomy and suggestions. Every package is classified automatically from what it says
 * about itself (name, description, readme, skill instructions, triggers, MCP command and environment)
 * into a fixed set of categories and a vocabulary of technologies, so listings can be filtered without
 * trusting publishers to tag things well. The same vocabulary reads a task prompt, a project description
 * or a repository's stack, which is how packages are suggested. Pure and deterministic: bump
 * CLASSIFIER_VERSION whenever the rules change so stored classifications are recomputed.
 */

export const CLASSIFIER_VERSION = 1;

export interface CategoryDef {
  slug: string;
  label: string;
  description: string;
  /** Words and phrases that point at the category. */
  keywords: string[];
}

export const CATEGORIES: readonly CategoryDef[] = [
  { slug: 'frontend', label: 'Frontend & UI', description: 'Build and review user interfaces, components, styling and accessibility.', keywords: ['frontend', 'front-end', 'ui', 'ux', 'component', 'components', 'css', 'html', 'accessibility', 'a11y', 'responsive', 'layout', 'styling', 'web app', 'single page'] },
  { slug: 'backend', label: 'Backend & APIs', description: 'Design, build and document servers, REST and GraphQL APIs and microservices.', keywords: ['backend', 'back-end', 'api', 'apis', 'rest', 'endpoint', 'endpoints', 'server-side', 'microservice', 'microservices', 'openapi', 'swagger', 'webhook', 'webhooks', 'grpc'] },
  { slug: 'databases', label: 'Databases', description: 'Query, model and migrate SQL and NoSQL databases.', keywords: ['database', 'databases', 'sql', 'nosql', 'query', 'queries', 'schema', 'migration', 'migrations', 'orm'] },
  { slug: 'devops', label: 'DevOps & CI/CD', description: 'Containers, pipelines, infrastructure as code and deployments.', keywords: ['devops', 'ci', 'cd', 'ci/cd', 'pipeline', 'pipelines', 'deploy', 'deployment', 'deployments', 'container', 'containers', 'infrastructure', 'infrastructure as code', 'iac', 'release'] },
  { slug: 'cloud', label: 'Cloud platforms', description: 'Manage resources and services on AWS, Google Cloud, Azure and edge platforms.', keywords: ['cloud', 'serverless', 'bucket', 'buckets', 'lambda', 'hosting', 'cdn'] },
  { slug: 'testing', label: 'Testing & QA', description: 'Write, run and fix unit, integration and end-to-end tests.', keywords: ['test', 'tests', 'testing', 'unit test', 'unit tests', 'e2e', 'end-to-end', 'integration test', 'coverage', 'qa', 'regression', 'tdd', 'mock', 'mocks', 'fixture', 'fixtures', 'flaky'] },
  { slug: 'security', label: 'Security', description: 'Find vulnerabilities, audit dependencies, handle secrets and authentication.', keywords: ['security', 'secure', 'vulnerability', 'vulnerabilities', 'cve', 'owasp', 'audit', 'sast', 'dast', 'secrets', 'authentication', 'authorization', 'auth', 'oauth', 'xss', 'csrf', 'injection', 'pentest', 'threat model', 'compliance'] },
  { slug: 'code-quality', label: 'Code quality & review', description: 'Code review, linting, formatting, refactoring and conventions.', keywords: ['code review', 'review', 'reviews', 'lint', 'linting', 'linter', 'formatting', 'refactor', 'refactoring', 'clean code', 'conventions', 'style guide', 'best practices', 'code smell', 'technical debt', 'static analysis', 'type safety'] },
  { slug: 'documentation', label: 'Documentation', description: 'Write and maintain docs, READMEs, changelogs and API references.', keywords: ['documentation', 'docs', 'readme', 'docstring', 'docstrings', 'jsdoc', 'changelog', 'release notes', 'technical writing', 'api reference', 'adr'] },
  { slug: 'version-control', label: 'Git & code hosting', description: 'Commits, branches, pull requests, issues and repositories.', keywords: ['git', 'commit', 'commits', 'branch', 'branches', 'pull request', 'pull requests', 'merge request', 'repository', 'repositories', 'repo', 'rebase', 'diff', 'conventional commits'] },
  { slug: 'project-management', label: 'Project management', description: 'Issues, tickets, sprints, roadmaps and planning tools.', keywords: ['ticket', 'tickets', 'sprint', 'sprints', 'backlog', 'roadmap', 'project management', 'issue tracker', 'issue tracking', 'kanban', 'task tracking', 'epic', 'user story', 'user stories'] },
  { slug: 'communication', label: 'Communication', description: 'Chat, email and notifications.', keywords: ['chat', 'messaging', 'email', 'emails', 'notification', 'notifications', 'channel', 'channels', 'inbox', 'sms'] },
  { slug: 'ai-ml', label: 'AI & machine learning', description: 'LLMs, prompts, embeddings, RAG, model training and evaluation.', keywords: ['ai', 'llm', 'llms', 'machine learning', 'ml', 'prompt engineering', 'embedding', 'embeddings', 'rag', 'vector', 'vectors', 'inference', 'fine-tuning', 'evals', 'neural'] },
  { slug: 'data', label: 'Data & analytics', description: 'Data pipelines, warehouses, notebooks, spreadsheets and analytics.', keywords: ['analytics', 'etl', 'elt', 'warehouse', 'data pipeline', 'data pipelines', 'data warehouse', 'dataset', 'datasets', 'csv', 'spreadsheet', 'spreadsheets', 'notebook', 'notebooks', 'dashboard', 'dashboards', 'metrics', 'bi'] },
  { slug: 'web-automation', label: 'Browser & web', description: 'Browser automation, web search, scraping and fetching pages.', keywords: ['browser', 'browsers', 'scrape', 'scraping', 'scraper', 'crawl', 'crawler', 'crawling', 'web search', 'search engine', 'web fetch', 'screenshot', 'screenshots', 'headless', 'web page', 'web pages'] },
  { slug: 'files', label: 'Files & storage', description: 'Read and write files, documents, PDFs and cloud drives.', keywords: ['filesystem', 'local files', 'file system', 'directory', 'directories', 'folder', 'folders', 'storage', 'upload', 'download', 'pdf', 'pdfs'] },
  { slug: 'observability', label: 'Monitoring & observability', description: 'Logs, metrics, traces, errors, alerts and incidents.', keywords: ['monitoring', 'observability', 'logs', 'logging', 'tracing', 'traces', 'alert', 'alerts', 'alerting', 'incident', 'incidents', 'error tracking', 'apm', 'uptime', 'on-call'] },
  { slug: 'mobile', label: 'Mobile', description: 'iOS, Android and cross-platform mobile apps.', keywords: ['mobile', 'ios', 'android', 'mobile app', 'mobile apps', 'app store', 'play store', 'xcode', 'cross-platform'] },
  { slug: 'design', label: 'Design', description: 'Design files, design systems, mockups and assets.', keywords: ['designs', 'design system', 'design systems', 'ui design', 'design files', 'mockup', 'mockups', 'wireframe', 'wireframes', 'prototype', 'icons', 'illustration', 'typography', 'color palette'] },
  { slug: 'commerce', label: 'Payments & commerce', description: 'Payments, billing, subscriptions and online stores.', keywords: ['payment', 'payments', 'billing', 'invoice', 'invoices', 'subscription', 'subscriptions', 'checkout', 'ecommerce', 'e-commerce', 'shop', 'orders', 'crm', 'sales'] },
  { slug: 'productivity', label: 'Knowledge & productivity', description: 'Notes, wikis, calendars, office documents and personal workflows.', keywords: ['notes', 'wiki', 'knowledge base', 'calendar', 'calendars', 'meeting', 'meetings', 'productivity', 'todo', 'reminders'] },
  { slug: 'other', label: 'Other', description: 'Packages that do not fit another category.', keywords: [] },
];

export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug) as [string, ...string[]];
const CATEGORY_BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));
export const getCategory = (slug: string) => CATEGORY_BY_SLUG.get(slug) ?? null;

export interface TechnologyDef {
  slug: string;
  label: string;
  /** Words and phrases that name it in prose. Ambiguous words ("go", "next", "linear") are left out. */
  aliases: string[];
  /** Package names (npm, PyPI, Composer, Go modules) whose presence in a repository means it is used. */
  packages?: string[];
  categories: string[];
}

const T = (slug: string, label: string, categories: string[], aliases: string[] = [], packages: string[] = []): TechnologyDef => ({ slug, label, categories, aliases: [slug, ...aliases], packages });

export const TECHNOLOGIES: readonly TechnologyDef[] = [
  // Languages
  T('typescript', 'TypeScript', [], ['ts'], ['typescript']),
  T('javascript', 'JavaScript', [], ['js', 'ecmascript']),
  T('python', 'Python', [], ['py', 'pip', 'pypi']),
  T('golang', 'Go', [], ['go.mod', 'go module', 'go modules']),
  T('rust', 'Rust', [], ['cargo', 'crates.io']),
  T('java', 'Java', [], ['jvm', 'maven', 'gradle']),
  T('kotlin', 'Kotlin', ['mobile']),
  T('swift', 'Swift', ['mobile'], ['swiftui']),
  T('csharp', 'C#', [], ['c#', '.net', 'dotnet', 'asp.net']),
  T('php', 'PHP', ['backend'], ['composer']),
  T('ruby', 'Ruby', [], ['rubygems']),
  T('elixir', 'Elixir', ['backend'], ['phoenix']),
  T('bash', 'Shell', [], ['shell script', 'shell scripts', 'zsh']),
  // Frontend
  T('react', 'React', ['frontend'], ['reactjs', 'react.js', 'jsx', 'tsx', 'react hooks'], ['react', 'react-dom']),
  T('nextjs', 'Next.js', ['frontend', 'backend'], ['next.js', 'app router'], ['next']),
  T('vue', 'Vue', ['frontend'], ['vuejs', 'vue.js', 'nuxt', 'nuxt.js'], ['vue', 'nuxt']),
  T('angular', 'Angular', ['frontend'], ['angularjs'], ['@angular/core']),
  T('svelte', 'Svelte', ['frontend'], ['sveltekit'], ['svelte', '@sveltejs/kit']),
  T('tailwind', 'Tailwind CSS', ['frontend'], ['tailwindcss', 'tailwind css'], ['tailwindcss']),
  T('storybook', 'Storybook', ['frontend', 'design'], [], ['storybook']),
  // Mobile
  T('react-native', 'React Native', ['mobile'], ['react native', 'expo'], ['react-native', 'expo']),
  T('flutter', 'Flutter', ['mobile'], ['dart']),
  // Backend
  T('nodejs', 'Node.js', ['backend'], ['node.js', 'npm']),
  T('expressjs', 'Express', ['backend'], ['express.js'], ['express']),
  T('fastify', 'Fastify', ['backend'], [], ['fastify']),
  T('nestjs', 'NestJS', ['backend'], ['nest.js'], ['@nestjs/core']),
  T('django', 'Django', ['backend'], [], ['django']),
  T('flask', 'Flask', ['backend'], [], ['flask']),
  T('fastapi', 'FastAPI', ['backend'], [], ['fastapi']),
  T('rails', 'Ruby on Rails', ['backend'], ['ruby on rails'], ['rails']),
  T('laravel', 'Laravel', ['backend'], [], ['laravel/framework']),
  T('spring-boot', 'Spring Boot', ['backend'], ['spring boot', 'springboot', 'spring framework']),
  T('graphql', 'GraphQL', ['backend'], ['apollo'], ['graphql', '@apollo/server', '@apollo/client']),
  // Databases
  T('postgres', 'PostgreSQL', ['databases'], ['postgresql', 'psql', 'pg'], ['pg', 'postgres', 'psycopg2', 'psycopg']),
  T('mysql', 'MySQL', ['databases'], ['mariadb'], ['mysql', 'mysql2']),
  T('mongodb', 'MongoDB', ['databases'], ['mongo', 'mongoose'], ['mongodb', 'mongoose', 'pymongo']),
  T('redis', 'Redis', ['databases'], ['valkey'], ['redis', 'ioredis']),
  T('sqlite', 'SQLite', ['databases'], [], ['sqlite3', 'better-sqlite3']),
  T('prisma', 'Prisma', ['databases'], [], ['prisma', '@prisma/client']),
  T('supabase', 'Supabase', ['databases', 'cloud'], [], ['@supabase/supabase-js']),
  T('firebase', 'Firebase', ['cloud', 'databases', 'mobile'], ['firestore'], ['firebase', 'firebase-admin']),
  T('elasticsearch', 'Elasticsearch', ['databases', 'observability'], ['opensearch', 'elastic'], ['@elastic/elasticsearch']),
  T('snowflake', 'Snowflake', ['data', 'databases']),
  T('bigquery', 'BigQuery', ['data', 'databases']),
  T('pinecone', 'Pinecone', ['ai-ml', 'databases']),
  T('kafka', 'Kafka', ['backend', 'data'], ['apache kafka'], ['kafkajs']),
  // DevOps and cloud
  T('docker', 'Docker', ['devops'], ['dockerfile', 'docker compose', 'docker-compose', 'containers']),
  T('kubernetes', 'Kubernetes', ['devops', 'cloud'], ['k8s', 'kubectl', 'helm']),
  T('terraform', 'Terraform', ['devops', 'cloud'], ['opentofu', 'hcl']),
  T('ansible', 'Ansible', ['devops']),
  T('github-actions', 'GitHub Actions', ['devops'], ['github actions', 'github workflow', 'github workflows', '.github/workflows']),
  T('aws', 'AWS', ['cloud'], ['amazon web services', 's3', 'ec2', 'dynamodb', 'cloudformation', 'aws lambda'], ['aws-sdk', 'boto3']),
  T('gcp', 'Google Cloud', ['cloud'], ['google cloud', 'gcloud', 'cloud run'], ['@google-cloud/storage']),
  T('azure', 'Azure', ['cloud'], ['microsoft azure']),
  T('cloudflare', 'Cloudflare', ['cloud'], ['cloudflare workers', 'wrangler'], ['wrangler']),
  T('vercel', 'Vercel', ['cloud', 'devops']),
  // Testing
  T('jest', 'Jest', ['testing'], [], ['jest']),
  T('vitest', 'Vitest', ['testing'], [], ['vitest']),
  T('playwright', 'Playwright', ['testing', 'web-automation'], [], ['playwright', '@playwright/test']),
  T('cypress', 'Cypress', ['testing'], [], ['cypress']),
  T('pytest', 'pytest', ['testing'], [], ['pytest']),
  T('selenium', 'Selenium', ['testing', 'web-automation'], ['webdriver'], ['selenium', 'selenium-webdriver']),
  T('puppeteer', 'Puppeteer', ['web-automation'], [], ['puppeteer']),
  // Code quality
  T('eslint', 'ESLint', ['code-quality'], [], ['eslint']),
  T('prettier', 'Prettier', ['code-quality'], [], ['prettier']),
  T('sonarqube', 'SonarQube', ['code-quality', 'security'], ['sonarcloud', 'sonar']),
  // Hosting and project tools
  T('github', 'GitHub', ['version-control'], ['gh cli', 'github api', 'github_token', 'github_personal_access_token'], ['@octokit/rest']),
  T('gitlab', 'GitLab', ['version-control', 'devops'], ['gitlab_token']),
  T('bitbucket', 'Bitbucket', ['version-control']),
  T('jira', 'Jira', ['project-management'], ['atlassian']),
  T('linear-app', 'Linear', ['project-management'], ['linear.app', 'linear issues', 'linear_api_key'], ['@linear/sdk']),
  T('asana', 'Asana', ['project-management']),
  T('trello', 'Trello', ['project-management']),
  T('confluence', 'Confluence', ['documentation', 'productivity']),
  T('notion', 'Notion', ['productivity', 'documentation'], ['notion_api_key', 'notion_token'], ['@notionhq/client']),
  // Communication
  T('slack', 'Slack', ['communication'], ['slack_bot_token'], ['@slack/web-api', '@slack/bolt']),
  T('discord', 'Discord', ['communication'], [], ['discord.js']),
  T('microsoft-teams', 'Microsoft Teams', ['communication'], ['microsoft teams']),
  T('gmail', 'Gmail', ['communication'], []),
  T('twilio', 'Twilio', ['communication'], [], ['twilio']),
  // Observability
  T('sentry', 'Sentry', ['observability'], ['sentry_auth_token'], ['@sentry/node', '@sentry/react', 'sentry-sdk']),
  T('datadog', 'Datadog', ['observability']),
  T('grafana', 'Grafana', ['observability'], ['loki']),
  T('prometheus', 'Prometheus', ['observability'], ['promql']),
  T('opentelemetry', 'OpenTelemetry', ['observability'], ['otel'], ['@opentelemetry/api']),
  // AI and data
  T('openai', 'OpenAI', ['ai-ml'], ['gpt', 'chatgpt', 'openai_api_key'], ['openai']),
  T('anthropic', 'Anthropic', ['ai-ml'], ['anthropic api', 'claude api', 'anthropic_api_key'], ['@anthropic-ai/sdk', 'anthropic']),
  T('langchain', 'LangChain', ['ai-ml'], ['langgraph'], ['langchain', '@langchain/core']),
  T('huggingface', 'Hugging Face', ['ai-ml'], ['hugging face', 'transformers'], ['transformers']),
  T('pytorch', 'PyTorch', ['ai-ml'], ['torch'], ['torch']),
  T('pandas', 'pandas', ['data'], ['dataframe', 'dataframes'], ['pandas']),
  T('jupyter', 'Jupyter', ['data', 'ai-ml'], ['ipynb', 'jupyter notebook'], ['jupyter', 'notebook']),
  T('dbt', 'dbt', ['data']),
  T('airflow', 'Airflow', ['data'], ['apache airflow']),
  T('apache-spark', 'Apache Spark', ['data'], ['apache spark', 'pyspark'], ['pyspark']),
  // Files, design, commerce, productivity
  T('google-drive', 'Google Drive', ['files', 'productivity'], ['google drive', 'google docs', 'google sheets']),
  T('dropbox', 'Dropbox', ['files']),
  T('figma', 'Figma', ['design'], ['figma_access_token']),
  T('stripe', 'Stripe', ['commerce'], ['stripe_secret_key'], ['stripe']),
  T('shopify', 'Shopify', ['commerce']),
  T('salesforce', 'Salesforce', ['commerce']),
  T('hubspot', 'HubSpot', ['commerce', 'communication']),
  T('google-calendar', 'Google Calendar', ['productivity'], ['google calendar']),
  T('obsidian', 'Obsidian', ['productivity']),
];

const TECH_BY_SLUG = new Map(TECHNOLOGIES.map((t) => [t.slug, t]));
export const getTechnology = (slug: string) => TECH_BY_SLUG.get(slug) ?? null;

// ── Text handling ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  'a an and are as at be but by can do does for from has have how i if in into is it its make me my of on or our please should so that the their them then there these this to use using via we what when where which while who why will with without you your add adds allow allows also any all get gets help helps new need needs run runs set sets want work works server mcp skill skills plugin plugins tool tools agent code coding'.split(' '),
);

/** Lowercased words; keeps "+", "#" and "." inside words so "c#", "c++", "next.js" and ".net" survive. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#./_-]+/)
    .flatMap((w) => (/[/_-]/.test(w) ? [w, ...w.split(/[/_-]+/)] : [w]))
    .map((w) => w.replace(/^[-.]+(?!net$)|[-.]+$/g, ''))
    .filter((w) => w.length > 1 || w === 'c');
}

/** Distinct meaningful words, for matching and for the stored keyword index. */
export function significantTokens(text: string): string[] {
  return [...new Set(tokenize(text))].filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/** A tokenized text that phrase lookups run against: " word word word ". */
function haystack(text: string): string {
  return ` ${tokenize(text).join(' ')} `;
}

function normalizePhrase(p: string): string {
  return ` ${tokenize(p).join(' ')} `;
}

function occurrences(hay: string, phrase: string): number {
  const needle = normalizePhrase(phrase);
  if (needle.trim() === '') return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length - 1)) n++;
  return n;
}

// ── Classification ────────────────────────────────────────────────────────────

export interface ClassifiableText {
  /** Name, display name, tags, trigger keywords: say what the package is. */
  title?: string;
  /** One-paragraph description. */
  description?: string;
  /** Readme, skill instructions, MCP command and environment: long text, mentions count less. */
  body?: string;
  /** Categories the publisher chose; a strong hint, not the final word. */
  declaredCategories?: string[];
  /** Dependencies whose names map directly to technologies. */
  dependencies?: string[];
}

export interface Classification {
  categories: string[];
  technologies: string[];
  /** Words a search for this package would use: name parts, tags, triggers, technologies. */
  keywords: string[];
  scores: Record<string, number>;
  version: number;
}

const WEIGHT = { title: 3, description: 2, body: 1 };

/** Technologies mentioned in a text, with a weight: name 3, description 2, body 1 (2 when repeated). */
function detectTechnologies(fields: { title: string; description: string; body: string }, dependencies: string[] = []): Map<string, number> {
  const found = new Map<string, number>();
  const bump = (slug: string, w: number) => found.set(slug, Math.max(found.get(slug) ?? 0, w));
  const deps = new Set(dependencies.map((d) => d.toLowerCase()));
  for (const t of TECHNOLOGIES) {
    for (const a of t.aliases) {
      if (occurrences(fields.title, a)) bump(t.slug, WEIGHT.title);
      else if (occurrences(fields.description, a)) bump(t.slug, WEIGHT.description);
      else {
        const n = occurrences(fields.body, a);
        if (n) bump(t.slug, n >= 3 ? 2 : WEIGHT.body);
      }
    }
    if (t.packages?.some((p) => deps.has(p))) bump(t.slug, 3);
  }
  return found;
}

/**
 * Categories and technologies for a package. A category needs a score of at least 3 (one mention in the
 * name, or a description mention backed by a related technology); at most three are kept, and those
 * well below the best one are dropped. Packages that match nothing are "other".
 */
export function classify(input: ClassifiableText): Classification {
  const fields = { title: haystack(input.title ?? ''), description: haystack(input.description ?? ''), body: haystack(input.body ?? '') };
  const techs = detectTechnologies(fields, input.dependencies);
  const scores: Record<string, number> = {};
  const add = (slug: string, w: number) => (scores[slug] = (scores[slug] ?? 0) + w);
  for (const c of CATEGORIES) {
    for (const k of c.keywords) {
      const w = occurrences(fields.title, k) ? WEIGHT.title : occurrences(fields.description, k) ? WEIGHT.description : Math.min(occurrences(fields.body, k), 2) * WEIGHT.body;
      if (w) add(c.slug, w);
    }
  }
  for (const [slug, w] of techs) for (const c of getTechnology(slug)!.categories) add(c, w);
  for (const c of input.declaredCategories ?? []) if (CATEGORY_BY_SLUG.has(c) && c !== 'other') add(c, 3);

  const ranked = Object.entries(scores)
    .filter(([, s]) => s >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const best = ranked[0]?.[1] ?? 0;
  const categories = ranked.filter(([, s]) => s >= best / 2).slice(0, 3).map(([slug]) => slug);
  const technologies = [...techs].filter(([, w]) => w >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([slug]) => slug);
  const keywords = [...new Set([...significantTokens(input.title ?? ''), ...technologies])].slice(0, 48);
  return { categories: categories.length ? categories : ['other'], technologies, keywords, scores, version: CLASSIFIER_VERSION };
}

/** What a package says about itself, as classifier input. */
export function packageText(p: { name: string; displayName?: string; description?: string; readme?: string | null; tags?: string[]; categories?: string[]; manifest?: CapabilityManifest | null }): ClassifiableText {
  const m = p.manifest;
  return {
    title: [p.name, p.displayName ?? '', ...(p.tags ?? []), ...(m?.triggers.keywords ?? [])].join(' \n '),
    description: p.description ?? m?.description ?? '',
    body: [
      p.readme ?? '',
      m?.skill?.instructions ?? '',
      ...(m?.mcp?.command ?? []),
      m?.mcp?.url ?? '',
      ...Object.keys(m?.mcp?.env ?? {}),
      ...(m?.configuration ?? []).map((c) => `${c.key} ${c.description}`),
      ...(m?.triggers.files ?? []),
    ].join(' \n '),
    declaredCategories: p.categories,
    dependencies: m?.triggers.dependencies,
  };
}

// ── Reading a task, a prompt or a project ─────────────────────────────────────

export interface SignalInput {
  /** Prompt, task title and description, project name and description. */
  text?: string;
  /** Known from the repository: languages and dependency names. */
  languages?: string[];
  dependencies?: string[];
  files?: string[];
}

export interface Signals {
  tokens: Set<string>;
  technologies: Map<string, number>;
  categories: Map<string, number>;
}

const LANGUAGE_TECH: Record<string, string> = { go: 'golang', 'c#': 'csharp', typescript: 'typescript', javascript: 'javascript', python: 'python', rust: 'rust', java: 'java', php: 'php', ruby: 'ruby', kotlin: 'kotlin', swift: 'swift' };

/** What a piece of work is about, in the same vocabulary packages are classified in. */
export function extractSignals(input: SignalInput): Signals {
  const text = [input.text ?? '', ...(input.files ?? [])].join('\n');
  const cls = classify({ description: text, dependencies: input.dependencies });
  const technologies = new Map<string, number>();
  // A mention in a prompt is deliberate: one is enough.
  for (const slug of cls.technologies) technologies.set(slug, 2);
  for (const l of input.languages ?? []) {
    const slug = LANGUAGE_TECH[l.toLowerCase()];
    if (slug) technologies.set(slug, Math.max(technologies.get(slug) ?? 0, 1));
  }
  const deps = new Set((input.dependencies ?? []).map((d) => d.toLowerCase()));
  for (const t of TECHNOLOGIES) if (t.packages?.some((p) => deps.has(p))) technologies.set(t.slug, Math.max(technologies.get(t.slug) ?? 0, 1));
  const categories = new Map<string, number>();
  for (const [slug, s] of Object.entries(cls.scores)) if (s >= 2) categories.set(slug, s);
  return { tokens: new Set(significantTokens(text)), technologies, categories };
}

// ── Suggestions ───────────────────────────────────────────────────────────────

export interface SuggestCandidate {
  name: string;
  displayName: string;
  description: string;
  categories: string[];
  technologies: string[];
  keywords: string[];
  curated: boolean;
  trust: string;
  installs?: number;
}

export interface Suggestion<T> {
  item: T;
  /** Relevance to the work; quality only breaks ties. */
  score: number;
  reasons: string[];
}

/** The minimum relevance for a suggestion: one shared technology or trigger keyword, or a strong category match. */
export const SUGGESTION_THRESHOLD = 3;

const TRUST_WEIGHT: Record<string, number> = { OFFICIAL: 1, VERIFIED: 0.75, COMMUNITY: 0.5, LOCAL: 0.25, UNVERIFIED: 0 };

/**
 * How well a package fits the work. Explicitly requested technologies weigh most, then the package's
 * own keywords, then categories; words in the description add a little. Curation, trust and installs
 * add at most about 2, so they order equally relevant packages but never make an irrelevant one relevant.
 */
export function suggestionScore(c: SuggestCandidate, s: Signals): { relevance: number; score: number; reasons: string[] } {
  let relevance = 0;
  const reasons: string[] = [];
  const techHits = c.technologies.filter((t) => s.technologies.has(t));
  for (const t of techHits) relevance += s.technologies.get(t)! >= 2 ? 5 : 3;
  if (techHits.length) reasons.push(`Works with ${techHits.map((t) => getTechnology(t)?.label ?? t).join(', ')}`);
  const techWords = new Set(techHits.flatMap((t) => getTechnology(t)?.aliases ?? []));
  const keywordHits = c.keywords.filter((k) => s.tokens.has(k) && !techWords.has(k) && !TECH_BY_SLUG.has(k));
  relevance += Math.min(keywordHits.length * 3, 9);
  if (keywordHits.length) reasons.push(`Matches “${keywordHits.slice(0, 3).join('”, “')}”`);
  const catHits = c.categories.filter((k) => (s.categories.get(k) ?? 0) >= 2);
  // A shared category alone never reaches the threshold: it says what kind of work, not which tools.
  for (const k of catHits) relevance += Math.min(s.categories.get(k)! / 3, 2);
  if (catHits.length) reasons.push(catHits.map((k) => getCategory(k)?.label ?? k).join(', '));
  const descHits = significantTokens(c.description).filter((w) => s.tokens.has(w) && !keywordHits.includes(w)).length;
  relevance += Math.min(descHits * 0.5, 2);
  const quality = (c.curated ? 1 : 0) + (TRUST_WEIGHT[c.trust] ?? 0) + Math.min(Math.log10((c.installs ?? 0) + 1) / 3, 1);
  return { relevance, score: relevance + quality, reasons };
}

/**
 * Relevant packages for the work, curated ones first (the marketplace's rule everywhere), each group by
 * score. Packages below the threshold are never suggested.
 */
export function rankSuggestions<T extends SuggestCandidate>(items: T[], signals: Signals, limit = 10, threshold = SUGGESTION_THRESHOLD): Suggestion<T>[] {
  return items
    .map((item) => ({ item, ...suggestionScore(item, signals) }))
    .filter((r) => r.relevance >= threshold)
    .sort((a, b) => Number(b.item.curated) - Number(a.item.curated) || b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, limit)
    .map(({ item, score, reasons }) => ({ item, score: Math.round(score * 10) / 10, reasons }));
}

/** The signals of a package itself, to find related packages for its page (rank with RELATED_THRESHOLD: a shared category is enough). */
export const RELATED_THRESHOLD = 2;

export function signalsOfPackage(p: { categories: string[]; technologies: string[]; keywords: string[] }): Signals {
  return {
    tokens: new Set(p.keywords),
    technologies: new Map(p.technologies.map((t) => [t, 2])),
    categories: new Map(p.categories.filter((c) => c !== 'other').map((c) => [c, 6])),
  };
}

export interface ClassifiablePackage {
  name: string;
  displayName?: string;
  description?: string;
  readme?: string | null;
  tags?: string[];
  declaredCategories?: string[];
  categoryOverride?: string[] | null;
}

/** The stored classification fields of a package, from its listing and latest manifest. */
export function classificationFields(p: ClassifiablePackage, manifest?: CapabilityManifest | null) {
  const c = classify(packageText({ ...p, categories: p.declaredCategories, manifest }));
  return {
    categories: p.categoryOverride?.length ? p.categoryOverride : c.categories,
    technologies: c.technologies,
    keywords: c.keywords,
    classifierVersion: CLASSIFIER_VERSION,
  };
}
