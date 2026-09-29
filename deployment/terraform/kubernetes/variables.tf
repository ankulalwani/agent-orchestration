variable "kubeconfig_path" {
  description = "kubeconfig with access to the cluster (e.g. after `aws eks update-kubeconfig`, `gcloud container clusters get-credentials` or `az aks get-credentials`)."
  type        = string
  default     = "~/.kube/config"
}

variable "kubeconfig_context" {
  description = "kubeconfig context to use (empty: the current one)."
  type        = string
  default     = null
}

variable "namespace" {
  type    = string
  default = "agent-orchestrator"
}

variable "create_namespace" {
  type    = bool
  default = true
}

variable "release_name" {
  type    = string
  default = "ao"
}

variable "image_repository" {
  description = "Control plane image (build deployment/docker/control-plane.Dockerfile and push it to your registry)."
  type        = string
}

variable "image_tag" {
  type    = string
  default = "0.1.1"
}

variable "public_url" {
  description = "Public HTTPS URL of the control plane, e.g. https://orchestrator.example.com"
  type        = string
  validation {
    condition     = can(regex("^https?://", var.public_url))
    error_message = "public_url must start with https:// (or http:// for tests)."
  }
}

variable "mongodb_uri" {
  description = "MongoDB connection string (MongoDB Atlas, a managed MongoDB, or your own replica set)."
  type        = string
  sensitive   = true
}

variable "redis_url" {
  description = "Redis URL; required for more than one replica or autoscaling."
  type        = string
  default     = ""
  sensitive   = true
}

variable "smtp_url" {
  type      = string
  default   = ""
  sensitive = true
}

variable "encryption_key" {
  description = "Existing ENCRYPTION_KEY (64 hex characters) when migrating an installation; empty: generate one."
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = var.encryption_key == "" || can(regex("^[0-9a-fA-F]{64}$", var.encryption_key))
    error_message = "encryption_key must be 64 hexadecimal characters."
  }
}

variable "s3_access_key_id" {
  description = "For S3 artifact storage and S3 backups (set S3_BUCKET etc. in extra_env for artifacts)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "s3_secret_access_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "replicas" {
  type    = number
  default = 1
}

variable "autoscaling_max_replicas" {
  description = "0: no autoscaling. Otherwise a CPU-based autoscaler between `replicas` and this."
  type        = number
  default     = 0
}

variable "ingress_host" {
  description = "Host name for an Ingress; empty: no Ingress (expose the Service yourself)."
  type        = string
  default     = ""
}

variable "ingress_class_name" {
  type    = string
  default = ""
}

variable "ingress_annotations" {
  description = "E.g. cert-manager or load balancer annotations. The controller must allow WebSockets."
  type        = map(string)
  default     = {}
}

variable "ingress_tls_secret" {
  type    = string
  default = ""
}

variable "backup_enabled" {
  type    = bool
  default = true
}

variable "backup_schedule" {
  type    = string
  default = "0 2 * * *"
}

variable "backup_retention_days" {
  type    = number
  default = 14
}

variable "backup_s3_bucket" {
  description = "Upload backups to this bucket; empty: keep them on a volume in the cluster."
  type        = string
  default     = ""
}

variable "backup_s3_endpoint" {
  description = "For S3-compatible storage (empty: AWS S3)."
  type        = string
  default     = ""
}

variable "backup_s3_region" {
  type    = string
  default = "us-east-1"
}

variable "prometheus_operator" {
  description = "Create a ServiceMonitor and alert rules (the cluster must run the Prometheus Operator)."
  type        = bool
  default     = false
}

variable "extra_env" {
  description = "More control plane settings, e.g. { S3_BUCKET = \"...\", ALLOW_REGISTRATION = \"false\" }."
  type        = map(string)
  default     = {}
}
