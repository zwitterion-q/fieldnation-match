variable "name" { type = string }
variable "region" { type = string }
variable "cluster_name" { type = string }
variable "oidc_provider_arn" { type = string }
variable "oidc_issuer" { type = string }

variable "services" {
  type        = list(string)
  description = "One ECR repository per deployable image."
}

variable "secret_arns" {
  type        = list(string)
  description = "Secrets Manager ARNs the external-secrets controller may read."
}

variable "force_destroy_repos" {
  type        = bool
  description = "Let Terraform delete ECR repositories that still contain images."
}
