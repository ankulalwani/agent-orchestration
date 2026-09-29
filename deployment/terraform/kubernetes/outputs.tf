output "namespace" {
  value = local.namespace
}

output "release" {
  value = helm_release.this.name
}

output "public_url" {
  value = var.public_url
}

output "encryption_key" {
  description = "Back this up outside the cluster: without it, stored secrets can't be recovered."
  value       = kubernetes_secret.app.data["ENCRYPTION_KEY"]
  sensitive   = true
}
