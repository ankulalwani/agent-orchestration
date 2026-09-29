# Agent Orchestration on any Kubernetes cluster (EKS, GKE, AKS, or your own), with the Helm chart in
# deployment/helm/agent-orchestration. MongoDB (and optionally Redis) are external: pass their URLs.
#
# The generated JWT secret and encryption key are stored in the Terraform state. Use an encrypted remote
# backend, and back up the encryption key: without it, stored secrets can't be recovered.

terraform {
  required_version = ">= 1.5"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.16"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kubeconfig_context
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig_path
    config_context = var.kubeconfig_context
  }
}

resource "kubernetes_namespace" "this" {
  count = var.create_namespace ? 1 : 0
  metadata {
    name = var.namespace
  }
}

locals {
  namespace = var.create_namespace ? kubernetes_namespace.this[0].metadata[0].name : var.namespace
}

resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "random_id" "encryption_key" {
  byte_length = 32
}

resource "kubernetes_secret" "app" {
  metadata {
    name      = "${var.release_name}-agent-orchestration"
    namespace = local.namespace
  }
  data = merge(
    {
      JWT_SECRET     = random_password.jwt_secret.result
      ENCRYPTION_KEY = var.encryption_key != "" ? var.encryption_key : random_id.encryption_key.hex
      MONGODB_URI    = var.mongodb_uri
    },
    var.redis_url != "" ? { REDIS_URL = var.redis_url } : {},
    var.smtp_url != "" ? { SMTP_URL = var.smtp_url } : {},
    var.s3_access_key_id != "" ? { S3_ACCESS_KEY_ID = var.s3_access_key_id, S3_SECRET_ACCESS_KEY = var.s3_secret_access_key } : {},
  )
}

resource "helm_release" "this" {
  name      = var.release_name
  namespace = local.namespace
  chart     = "${path.module}/../../helm/agent-orchestration"

  values = [yamlencode({
    image          = { repository = var.image_repository, tag = var.image_tag }
    existingSecret = kubernetes_secret.app.metadata[0].name
    replicaCount   = var.replicas
    env = merge({
      PUBLIC_URL      = var.public_url
      WEB_URL         = var.public_url
      CORS_ORIGINS    = var.public_url
      TRUST_PROXY     = "true"
      METRICS_ENABLED = "true"
    }, var.extra_env)
    ingress = {
      enabled     = var.ingress_host != ""
      className   = var.ingress_class_name
      host        = var.ingress_host
      annotations = var.ingress_annotations
      tls         = var.ingress_tls_secret != "" ? [{ secretName = var.ingress_tls_secret, hosts = [var.ingress_host] }] : []
    }
    autoscaling = {
      enabled     = var.autoscaling_max_replicas > 0
      minReplicas = max(var.replicas, 1)
      maxReplicas = max(var.autoscaling_max_replicas, 1)
    }
    backup = {
      enabled       = var.backup_enabled
      schedule      = var.backup_schedule
      retentionDays = var.backup_retention_days
      s3 = {
        bucket   = var.backup_s3_bucket
        endpoint = var.backup_s3_endpoint
        region   = var.backup_s3_region
      }
    }
    monitoring = {
      serviceMonitor = { enabled = var.prometheus_operator }
      prometheusRule = { enabled = var.prometheus_operator }
    }
  })]

  lifecycle {
    precondition {
      condition     = var.replicas <= 1 || var.redis_url != ""
      error_message = "More than one replica needs redis_url (dispatch and live updates across instances)."
    }
    precondition {
      condition     = var.autoscaling_max_replicas == 0 || var.redis_url != ""
      error_message = "Autoscaling needs redis_url (dispatch and live updates across instances)."
    }
    precondition {
      condition     = var.backup_s3_bucket == "" || var.s3_access_key_id != ""
      error_message = "Backups to S3 need s3_access_key_id and s3_secret_access_key."
    }
  }
}
