output "cluster_name" { value = aws_eks_cluster.main.name }
output "cluster_endpoint" { value = aws_eks_cluster.main.endpoint }
output "cluster_ca" { value = aws_eks_cluster.main.certificate_authority[0].data }
output "oidc_provider_arn" { value = aws_iam_openid_connect_provider.oidc.arn }
output "oidc_issuer" { value = replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "") }
output "node_role_arn" { value = aws_iam_role.node.arn }

# The cluster security group is created by EKS, not by us, and every managed
# node is attached to it. Downstream (RDS, Amazon MQ) allows ingress from this
# SG rather than from a CIDR — so the rule stays correct when subnets change.
output "cluster_security_group_id" {
  value = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}
