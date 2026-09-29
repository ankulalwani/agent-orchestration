/**
 * Static checks of deployment assets that don't need Docker or a cluster (DEPLOY-001/002, WORKER-013).
 * Each runs when its tool is available in `.tools/` (or on PATH via the env override) and is skipped otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const tool = (env: string, rel: string) => process.env[env] ?? path.resolve('.tools', rel);
const HELM = tool('AO_TEST_HELM', 'helm/windows-amd64/helm.exe');
const KUBECONFORM = tool('AO_TEST_KUBECONFORM', 'kubeconform/kubeconform.exe');
const HADOLINT = tool('AO_TEST_HADOLINT', 'hadolint.exe');
const SHELLCHECK = tool('AO_TEST_SHELLCHECK', 'shellcheck/shellcheck.exe');
const CHART = 'deployment/helm/agent-orchestration';

const run = (bin: string, args: string[], input?: string) => execFileSync(bin, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

describe.runIf(fs.existsSync(HELM))('Helm chart', () => {
  it('passes helm lint --strict', () => {
    expect(run(HELM, ['lint', '--strict', CHART])).toContain('0 chart(s) failed');
  });

  it.runIf(fs.existsSync(KUBECONFORM))('renders valid Kubernetes objects, with and without the optional parts', () => {
    const variants: Array<[string, string[]]> = [
      ['defaults', []],
      ['ingress+tls+replicas', ['--set', 'ingress.enabled=true', '--set', 'ingress.className=nginx', '--set', 'ingress.tls[0].secretName=tls', '--set', 'ingress.tls[0].hosts[0]=orchestration.example.com', '--set', 'replicaCount=3', '--set', 'service.type=LoadBalancer']],
      ['autoscaling+volume backups', ['--set', 'autoscaling.enabled=true', '--set', 'backup.enabled=true']],
      ['S3 backups', ['--set', 'backup.enabled=true', '--set', 'backup.s3.bucket=backups', '--set', 'backup.s3.endpoint=https://s3.example.com']],
    ];
    for (const [name, args] of variants) {
      const rendered = run(HELM, ['template', 'ao', CHART, ...args]);
      const out = run(KUBECONFORM, ['-strict', '-summary', '-kubernetes-version', '1.31.0', '-'], rendered);
      expect(out, name).toMatch(/Invalid: 0, Errors: 0/);
      // The pod must run as a non-root numeric user, matching the image.
      expect(rendered).toMatch(/runAsNonRoot: true/);
    }
    // Operations (CLOUD-006): what each switch adds.
    const kinds = (args: string[]) => [...run(HELM, ['template', 'ao', CHART, ...args]).matchAll(/^kind: (\w+)/gm)].map((m) => m[1]).sort();
    expect(kinds([])).toEqual(['Deployment', 'Service']);
    expect(kinds(['--set', 'autoscaling.enabled=true', '--set', 'backup.enabled=true'])).toEqual(['CronJob', 'Deployment', 'HorizontalPodAutoscaler', 'PersistentVolumeClaim', 'PodDisruptionBudget', 'Service']);
    expect(run(HELM, ['template', 'ao', CHART, '--set', 'autoscaling.enabled=true'])).not.toMatch(/^\s+replicas:/m); // the autoscaler owns the replica count
    const s3 = run(HELM, ['template', 'ao', CHART, '--set', 'backup.enabled=true', '--set', 'backup.s3.bucket=backups']);
    expect(s3).toContain('s3://backups/agent-orchestration/');
    expect(s3).not.toContain('PersistentVolumeClaim');
    // Prometheus Operator objects: CRDs, so only structure is checked offline.
    const monitoring = run(HELM, ['template', 'ao', CHART, '--set', 'monitoring.serviceMonitor.enabled=true', '--set', 'monitoring.prometheusRule.enabled=true']);
    expect(run(KUBECONFORM, ['-strict', '-summary', '-ignore-missing-schemas', '-kubernetes-version', '1.31.0', '-'], monitoring)).toMatch(/Invalid: 0, Errors: 0/);
    expect(monitoring).toMatch(/kind: ServiceMonitor[\s\S]*kind: PrometheusRule|kind: PrometheusRule[\s\S]*kind: ServiceMonitor/);
  });
});

describe.runIf(fs.existsSync(HADOLINT))('Dockerfiles', () => {
  it('have no hadolint findings', () => {
    for (const f of fs.readdirSync('deployment/docker').filter((n) => n.includes('Dockerfile'))) {
      expect(run(HADOLINT, [path.join('deployment/docker', f)]), f).toBe('');
    }
  });
});

describe.runIf(fs.existsSync(SHELLCHECK))('installer shell scripts', () => {
  it('have no shellcheck findings', () => {
    const scripts = ['linux', 'macos'].flatMap((os) => fs.readdirSync(path.join('installers', os)).filter((f) => f.endsWith('.sh')).map((f) => path.join('installers', os, f)));
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(run(SHELLCHECK, [s]), s).toBe('');
  });
});

const TERRAFORM = tool('AO_TEST_TERRAFORM', 'terraform/terraform.exe');
const TF_DIR = 'deployment/terraform/kubernetes';
describe.runIf(fs.existsSync(TERRAFORM) && fs.existsSync(path.join(TF_DIR, '.terraform')))('Terraform (Kubernetes + Helm chart)', () => {
  it('is formatted and valid', () => {
    run(TERRAFORM, [`-chdir=${TF_DIR}`, 'fmt', '-check', '-recursive']);
    expect(run(TERRAFORM, [`-chdir=${TF_DIR}`, 'validate', '-no-color'])).toContain('The configuration is valid');
  });
});
