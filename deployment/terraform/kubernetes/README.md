# Terraform: Agent Orchestrator on Kubernetes

Deploys the control plane with the [Helm chart](../../helm/agent-orchestrator) into any Kubernetes cluster:
Amazon EKS, Google GKE, Azure AKS or your own. MongoDB (and Redis, for more than one replica) are external,
for example MongoDB Atlas and a managed Redis.

It creates the namespace and the application secret, generating the JWT secret and the encryption key, then
installs the chart. Nightly MongoDB backups are on by default: on a volume, or in S3 with `backup_s3_bucket`.
Optionally it adds autoscaling (`autoscaling_max_replicas`) and Prometheus Operator monitoring and alerts
(`prometheus_operator`).

```hcl
# terraform.tfvars
kubeconfig_context       = "prod"             # after aws eks / gcloud / az get-credentials
image_repository         = "registry.example.com/agent-orchestrator"
image_tag                = "0.1.1"
public_url               = "https://orchestrator.example.com"
mongodb_uri              = "mongodb+srv://…/agent_orchestrator"
redis_url                = "rediss://…"
replicas                 = 2
autoscaling_max_replicas = 6
ingress_host             = "orchestrator.example.com"
ingress_class_name       = "nginx"
ingress_tls_secret       = "orchestrator-tls"
backup_s3_bucket         = "my-backups"
s3_access_key_id         = "…"
s3_secret_access_key     = "…"
```

```bash
terraform init && terraform apply
terraform output -raw encryption_key   # store it safely, outside the cluster
```

**State holds secrets** (the generated keys and the URLs you pass). Use an encrypted remote backend with
restricted access. To move an existing installation, pass its key as `encryption_key`.

Checked with `terraform fmt` and `terraform validate` (Terraform 1.9, providers hashicorp/kubernetes 2.x,
hashicorp/helm 2.x), and applied and destroyed on Docker Desktop's Kubernetes (v1.36); not yet on a managed
cloud cluster.
