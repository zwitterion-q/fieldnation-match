output "ecr_repository_urls" { value = { for k, v in aws_ecr_repository.svc : k => v.repository_url } }
output "ecr_registry" { value = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com" }
output "alb_role_arn" { value = aws_iam_role.alb.arn }
output "eso_role_arn" { value = aws_iam_role.eso.arn }
output "account_id" { value = local.account_id }
