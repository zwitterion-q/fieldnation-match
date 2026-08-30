# ============================================================================
# Platform layer: image registry, and the IAM identities that let in-cluster
# controllers call AWS.
#
# The interesting part here is IRSA. A pod that needs to call AWS has three
# options: bake static credentials into the image (never), attach a policy to
# the node role so every pod on the node inherits it (common, and wrong -- it
# means a compromised sidecar has the load balancer controller's permissions),
# or IRSA, where the ServiceAccount token is exchanged for a role via the
# cluster's OIDC provider and the permission is scoped to that one
# ServiceAccount in that one namespace.
#
# The trust policy below is where that scoping actually happens: the `sub`
# condition pins the role to `system:serviceaccount:<ns>:<name>`. Get that
# string wrong and the pod silently falls back to the node role, which usually
# still works -- which is exactly why this misconfiguration survives in real
# clusters.
# ============================================================================

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  oidc_sub   = "${var.oidc_issuer}:sub"
  oidc_aud   = "${var.oidc_issuer}:aud"
}

# --------------------------------------------------------------- registry ---
resource "aws_ecr_repository" "svc" {
  for_each = toset(var.services)

  name                 = "${var.name}/${each.value}"
  image_tag_mutability = "MUTABLE" # demo: `latest` gets re-pushed. In
  # production this is IMMUTABLE, which is
  # what makes a deployed digest auditable.

  # Destroyability: without this, `terraform destroy` fails on every repository
  # that has ever been pushed to, with "repository contains images".
  force_delete = var.force_destroy_repos

  image_scanning_configuration { scan_on_push = true }

  # ECR encrypts with an AWS-managed key by default. Using the platform CMK
  # puts image layers under the same key policy and the same CloudTrail record
  # as the secrets and the database.
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

# Images pile up fast when every `make aws-push` writes a new digest. Untagged
# layers cost storage forever unless something expires them.
resource "aws_ecr_lifecycle_policy" "svc" {
  for_each   = aws_ecr_repository.svc
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "keep the last 5 images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
        action       = { type = "expire" }
      }
    ]
  })
}

# ------------------------------------------------------------------ IRSA ----
# The trust policy every IRSA role shares. StringEquals on both sub and aud:
# dropping the aud condition is a real and frequently-missed vulnerability,
# because without it any OIDC token from the cluster satisfies the trust.
data "aws_iam_policy_document" "irsa_trust" {
  for_each = {
    alb = "system:serviceaccount:kube-system:aws-load-balancer-controller"
    eso = "system:serviceaccount:external-secrets:external-secrets"
    ebs = "system:serviceaccount:kube-system:ebs-csi-controller-sa"
  }

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = local.oidc_sub
      values   = [each.value]
    }

    condition {
      test     = "StringEquals"
      variable = local.oidc_aud
      values   = ["sts.amazonaws.com"]
    }
  }
}

# ---- AWS Load Balancer Controller -------------------------------------------
resource "aws_iam_role" "alb" {
  name               = "${var.name}-alb-controller"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["alb"].json
}

# The upstream policy for this controller is ~200 lines of JSON. Rather than
# paste a copy that will rot, the permissions are narrowed to what the
# controller actually uses for an internet-facing ALB in one VPC, plus a
# condition that it may only touch resources tagged for this cluster.
data "aws_iam_policy_document" "alb" {
  statement {
    sid    = "Describe"
    effect = "Allow"
    actions = [
      "ec2:Describe*", "elasticloadbalancing:Describe*",
      "acm:ListCertificates", "acm:DescribeCertificate",
      "iam:ListServerCertificates", "iam:GetServerCertificate",
      "wafv2:GetWebACL", "wafv2:GetWebACLForResource",
      "shield:GetSubscriptionState",
    ]
    resources = ["*"] # Describe calls do not accept resource ARNs
  }

  # Creating a load balancer or a security group has no ARN to scope to -- the
  # resource does not exist yet -- so these actions must be on "*". What can be
  # constrained is the request: the controller may only create resources that
  # carry this cluster's tag.
  statement {
    sid    = "Create"
    effect = "Allow"
    actions = [
      "elasticloadbalancing:CreateLoadBalancer",
      "elasticloadbalancing:CreateTargetGroup",
      "elasticloadbalancing:CreateListener",
      "elasticloadbalancing:CreateRule",
      "elasticloadbalancing:AddTags",
      "ec2:CreateSecurityGroup",
      "ec2:CreateTags",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/elbv2.k8s.aws/cluster"
      values   = [var.cluster_name]
    }
  }

  # Mutating an existing resource does have an ARN, so these are constrained by
  # the tag already on it. The practical effect: this role cannot delete a load
  # balancer belonging to anything else in the account.
  statement {
    sid    = "Mutate"
    effect = "Allow"
    actions = [
      "elasticloadbalancing:Delete*", "elasticloadbalancing:Modify*",
      "elasticloadbalancing:Register*", "elasticloadbalancing:Deregister*",
      "elasticloadbalancing:Set*", "elasticloadbalancing:RemoveTags",
      "elasticloadbalancing:AddListenerCertificates",
      "ec2:DeleteSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress",
      "ec2:DeleteTags",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/elbv2.k8s.aws/cluster"
      values   = [var.cluster_name]
    }
  }
}

resource "aws_iam_role_policy" "alb" {
  name   = "alb-controller"
  role   = aws_iam_role.alb.id
  policy = data.aws_iam_policy_document.alb.json
}

# ---- External Secrets Operator ----------------------------------------------
# Terraform generated the database and broker passwords. They must reach the
# pods without ever being written into a manifest, a values file or the repo.
# ESO watches an ExternalSecret CR, reads Secrets Manager using this role, and
# materialises a Kubernetes Secret. The rotation story follows for free: change
# the secret in AWS, ESO refreshes it on its interval.
resource "aws_iam_role" "eso" {
  name               = "${var.name}-external-secrets"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["eso"].json
}

data "aws_iam_policy_document" "eso" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = var.secret_arns # exactly two ARNs, not secretsmanager:*
  }
}

resource "aws_iam_role_policy" "eso" {
  name   = "read-app-secrets"
  role   = aws_iam_role.eso.id
  policy = data.aws_iam_policy_document.eso.json
}

# ---- EBS CSI driver ---------------------------------------------------------
# Needed by anything with a PVC -- in this deployment that is Prometheus,
# Grafana and Qdrant. Note that these PVCs are the resources deploy/scripts/
# pre-destroy.sh deletes first: an EBS volume created by the CSI driver is
# invisible to Terraform and will survive `terraform destroy`, still billing.
resource "aws_iam_role" "ebs" {
  name               = "${var.name}-ebs-csi"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["ebs"].json
}

resource "aws_iam_role_policy_attachment" "ebs" {
  role       = aws_iam_role.ebs.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name             = var.cluster_name
  addon_name               = "aws-ebs-csi-driver"
  service_account_role_arn = aws_iam_role.ebs.arn

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
}
