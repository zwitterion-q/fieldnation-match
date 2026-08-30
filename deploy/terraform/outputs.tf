# Consumed by deploy/Makefile and deploy/scripts/*. Anything a script parses is
# a plain string, not a formatted block, so `terraform output -raw` works.

output "region" { value = var.region }
output "cluster_name" { value = module.eks.cluster_name }
output "vpc_id" { value = module.network.vpc_id }

output "ecr_registry" { value = module.platform.ecr_registry }
output "ecr_repositories" { value = module.platform.ecr_repository_urls }

output "db_endpoint" { value = module.data.db_endpoint }
output "db_secret_arn" { value = module.data.db_secret_arn }
output "mq_endpoint" { value = module.data.mq_endpoint }
output "mq_console" { value = module.data.mq_console_url }
output "mq_secret_arn" { value = module.data.mq_secret_arn }
output "app_secret_arn" { value = module.data.app_secret_arn }
output "secret_prefix" { value = local.name }

output "alb_role_arn" { value = module.platform.alb_role_arn }
output "eso_role_arn" { value = module.platform.eso_role_arn }

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.region} --profile ${var.aws_profile}"
}

# What this costs while it is up. Printed by `make cost` so the number is never
# a surprise at the end of the month. ap-southeast-1 on-demand list prices,
# 730h; excludes data transfer and anything the load test drives.
output "estimated_monthly_usd" {
  value = var.sizing == "minimal" ? join("", [
    "~USD 195/month while running  |  ",
    "EKS control plane 73 (fixed, the single largest line and unavoidable), ",
    "2x t3.medium SPOT 23, ",
    "NAT gateway 43 (single-NAT already applied; per-AZ would be 86), ",
    "Amazon MQ mq.t3.micro 19, ",
    "ALB 18, ",
    "RDS db.t4g.micro + 20GB gp3 18, ",
    "Secrets Manager / ECR / logs ~1",
    ]) : join("", [
    "~USD 340/month while running  |  ",
    "EKS 73, 3x t3.large on-demand 88, 2x NAT 86, ",
    "clustered MQ 57, ALB 18, multi-AZ RDS db.t4g.small 36",
  ])
}

# The number that actually matters: an idle stack still bills. EKS, NAT and MQ
# charge by the hour whether or not a single request is served.
output "hourly_usd_idle" {
  value = var.sizing == "minimal" ? "~0.27/hour — a weekend left running is ~13 USD" : "~0.47/hour"
}
