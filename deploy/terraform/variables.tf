variable "project" {
  type    = string
  default = "fieldnation"
}
variable "environment" {
  type    = string
  default = "demo"
}
variable "owner" {
  type    = string
  default = "shakil"
}
variable "region" {
  type = string
  # Singapore: the closest low-latency AWS region to Dhaka.
  default = "ap-southeast-1"
}
variable "aws_profile" {
  type    = string
  default = "fieldnation"
}

# ---------------------------------------------------------------- sizing ----
# Two profiles. `minimal` exists because a portfolio deployment that costs
# $280/month is a portfolio deployment that gets left running by accident.
variable "sizing" {
  type        = string
  default     = "minimal"
  description = "minimal | production"
  validation {
    condition     = contains(["minimal", "production"], var.sizing)
    error_message = "sizing must be minimal or production."
  }
}

locals {
  name = "${var.project}-${var.environment}"

  sizes = {
    minimal = {
      node_instance_types = ["t3.medium"]
      node_min            = 2
      node_max            = 3
      node_desired        = 2
      capacity_type       = "SPOT" # ~70% cheaper; fine for a demo, and
      # demonstrates handling interruption
      db_instance   = "db.t4g.micro"
      db_storage    = 20
      db_multi_az   = false
      mq_instance   = "mq.t3.micro"
      mq_deployment = "SINGLE_INSTANCE"
      single_nat    = true # one NAT instead of one per AZ: saves
      # ~$32/month per extra AZ, at the cost
      # of the NAT being a single point of
      # failure. Correct trade for a demo,
      # wrong for production.
    }
    production = {
      node_instance_types = ["t3.large"]
      node_min            = 3
      node_max            = 6
      node_desired        = 3
      capacity_type       = "ON_DEMAND"
      db_instance         = "db.t4g.small"
      db_storage          = 50
      db_multi_az         = true
      mq_instance         = "mq.t3.micro"
      mq_deployment       = "CLUSTER_MULTI_AZ"
      single_nat          = false
    }
  }

  size = local.sizes[var.sizing]
}

# ------------------------------------------------------- destroyability -----
# These default to the destroyable setting. Flipping them is what you would do
# in production, and the comment is the reminder of why they are off here.
variable "deletion_protection" {
  type        = bool
  default     = false
  description = "RDS deletion protection. MUST be false for a destroyable demo."
}

variable "skip_final_snapshot" {
  type        = bool
  default     = true
  description = "Skip the RDS final snapshot. A retained snapshot survives destroy and keeps billing."
}

variable "force_destroy_buckets" {
  type        = bool
  default     = true
  description = "Allow S3 buckets with objects to be deleted. Without this, destroy fails on a non-empty bucket."
}

variable "log_retention_days" {
  type        = number
  default     = 3
  description = "CloudWatch retention. Log groups outlive the cluster unless managed and expired."
}

# ---------------------------------------------------------------- network ---
variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "kubernetes_version" {
  type    = string
  default = "1.31"
}

variable "public_access_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0"]
  description = <<-EOT
    Who may reach the Kubernetes API endpoint.

    The default is open, which is what almost every EKS tutorial does and what
    almost every EKS cluster ends up with. It is defensible only because the
    endpoint still requires IAM authentication and the cluster holds nothing
    real -- it is not defensible in production.

    Set it to your own address before a demo:
        terraform apply -var='public_access_cidrs=["1.2.3.4/32"]'
    or  make aws-up LOCKDOWN=1     (resolves your public IP automatically)
  EOT
}
