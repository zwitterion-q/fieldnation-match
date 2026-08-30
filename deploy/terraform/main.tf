# ============================================================================
# fieldnation-match — AWS deployment root
#
# Four layers, each a module, wired in dependency order:
#
#   network   VPC, subnets, NAT, flow logs
#   eks       cluster, node group, OIDC provider, core addons
#   data      RDS Postgres, Amazon MQ (RabbitMQ), Secrets Manager
#   platform  ECR repositories, IRSA roles for in-cluster controllers
#
# This is the *same application* as the local docker-compose stack. Nothing in
# services/, ingest/ or api/ changes between the two targets. What changes is
# where the connection strings point and who issues the credentials. See
# DEPLOYMENT.md for the side-by-side.
#
# State is local, on purpose. A remote S3+DynamoDB backend is the right answer
# for a team, and the wrong answer here: the backend bucket and lock table are
# themselves resources that `terraform destroy` cannot remove (they hold the
# state doing the destroying), so a "fully destroyable" stack with a remote
# backend always leaves two resources behind. For a single operator on a demo
# stack, local state costs nothing and destroys cleanly.
# ============================================================================

# The provider and its default_tags live in versions.tf. Every resource
# inherits Project/Environment/Owner/AutoDestroy from there, which is what
# deploy/scripts/verify-destroyed.sh searches on -- by tag, not by state, so it
# can find orphans Terraform never knew about.
locals {
  # One ECR repository per deployable image. Matches the build targets in
  # deploy/Makefile and the service list in docker-compose.yml.
  services = [
    "api",         # FastAPI matching + explain  — api/matching.py
    "ingest",      # extraction & embedding      — ingest/pipeline.py
    "identity",    # NestJS auth + RBAC          — services/identity
    "work-orders", # NestJS lifecycle + saga     — services/work-orders
    "payments",    # NestJS ledger + escrow      — services/payments
    "web-buyer",   # React hirer console
    "web-tech",    # React technician console
  ]

  # One logical database per stateful service. Same split as local; see the
  # db-* services in docker-compose.yml.
  databases = ["workorders", "identity", "payments", "technicians"]
}

# ---------------------------------------------------------------- kms -------
# One customer-managed key for everything outside EKS: Secrets Manager, ECR,
# the SSM parameter, CloudWatch log groups, and the Amazon MQ broker.
#
# The AWS-managed default keys would encrypt all of these at rest already. The
# difference a CMK makes is control: an explicit key policy saying who may
# decrypt, key rotation you own, and a single CloudTrail record of every
# decrypt call against your data. That is the difference between "encrypted"
# and "encrypted, and you can prove who read it".
#
# EKS keeps its own key (modules/eks) because its purpose is different --
# envelope encryption of Kubernetes secrets, with a lifecycle tied to the
# cluster rather than to the data tier.
#
# Cost: USD 1/month per key, plus a 7-day mandatory deletion window after
# destroy during which the key still bills. Two keys, so roughly USD 0.50 of
# residue after a teardown. verify-destroyed.sh reports them rather than
# pretending they are gone.
resource "aws_kms_key" "platform" {
  description             = "${local.name} platform data encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "platform" {
  name          = "alias/${local.name}-platform"
  target_key_id = aws_kms_key.platform.key_id
}

data "aws_caller_identity" "me" {}

data "aws_iam_policy_document" "kms" {
  # Without this first statement the key is unusable and unmanageable: KMS does
  # not fall back to IAM, so a key whose policy omits the account root cannot
  # be administered by anyone, including the person who created it.
  statement {
    sid    = "AccountAdmin"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.me.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  # The services that hold data encrypted with this key need to use it. Scoped
  # by service principal and by the account that called them, so the key cannot
  # be used from another account even if its ARN leaks.
  statement {
    sid    = "ServiceUse"
    effect = "Allow"
    principals {
      type = "Service"
      identifiers = [
        "secretsmanager.amazonaws.com",
        "ssm.amazonaws.com",
        "logs.${var.region}.amazonaws.com",
        "mq.amazonaws.com",
        "rds.amazonaws.com",
      ]
    }
    actions = [
      "kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*",
      "kms:GenerateDataKey*", "kms:DescribeKey", "kms:CreateGrant",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.me.account_id]
    }
  }
}

module "network" {
  source = "./modules/network"

  name               = local.name
  cluster_name       = local.name
  vpc_cidr           = var.vpc_cidr
  kms_key_arn        = aws_kms_key.platform.arn
  single_nat         = local.size.single_nat
  log_retention_days = var.log_retention_days
}

module "eks" {
  source = "./modules/eks"

  cluster_name       = local.name
  kubernetes_version = var.kubernetes_version
  private_subnet_ids = module.network.private_subnet_ids
  public_subnet_ids  = module.network.public_subnet_ids
  api_allowed_cidrs  = var.public_access_cidrs
  log_retention_days = var.log_retention_days

  instance_types = local.size.node_instance_types
  capacity_type  = local.size.capacity_type
  min_size       = local.size.node_min
  max_size       = local.size.node_max
  desired_size   = local.size.node_desired
}

module "data" {
  source = "./modules/data"

  name                  = local.name
  vpc_id                = module.network.vpc_id
  private_subnet_ids    = module.network.private_subnet_ids
  source_security_group = module.eks.cluster_security_group_id

  vpc_cidr      = var.vpc_cidr
  kms_key_arn   = aws_kms_key.platform.arn
  db_instance   = local.size.db_instance
  db_storage    = local.size.db_storage
  db_multi_az   = local.size.db_multi_az
  mq_instance   = local.size.mq_instance
  mq_deployment = local.size.mq_deployment

  databases           = local.databases
  deletion_protection = var.deletion_protection
  skip_final_snapshot = var.skip_final_snapshot
  log_retention_days  = var.log_retention_days
}

module "platform" {
  source = "./modules/platform"

  name              = local.name
  region            = var.region
  cluster_name      = module.eks.cluster_name
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_issuer       = module.eks.oidc_issuer

  kms_key_arn         = aws_kms_key.platform.arn
  services            = local.services
  secret_arns         = [module.data.db_secret_arn, module.data.mq_secret_arn, module.data.app_secret_arn]
  force_destroy_repos = var.force_destroy_buckets
}
