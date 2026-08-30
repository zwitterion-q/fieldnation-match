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

module "network" {
  source = "./modules/network"

  name               = local.name
  cluster_name       = local.name
  vpc_cidr           = var.vpc_cidr
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

  services            = local.services
  secret_arns         = [module.data.db_secret_arn, module.data.mq_secret_arn, module.data.app_secret_arn]
  force_destroy_repos = var.force_destroy_buckets
}
