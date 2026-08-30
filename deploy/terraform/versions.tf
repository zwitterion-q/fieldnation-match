terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
    # No kubernetes or helm provider, deliberately. Terraform owns AWS; Helm
    # owns Kubernetes. Terraform's helm provider needs cluster credentials at
    # PLAN time, which is a chicken-and-egg on first apply and a much worse
    # failure on destroy, where it tries to reach a cluster Terraform has
    # already deleted. The in-cluster controllers are installed by
    # `make -C deploy addons` instead.
    random = { source = "hashicorp/random", version = "~> 3.6" }
    tls    = { source = "hashicorp/tls", version = "~> 4.0" }
  }

  # State stays local on purpose for a demo account. In a real deployment this
  # is an S3 backend with DynamoDB locking -- but a remote backend is itself a
  # resource that must be created before it can be used, and it does not get
  # destroyed with the stack, which fights the "fully destroyable" requirement.
  # The S3 backend block is in backend.tf.disabled, ready to enable.
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  # Every resource is tagged. This is not bookkeeping -- it is how you find and
  # kill orphans after a failed destroy, and how you prove nothing was left
  # running when the bill arrives.
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Owner       = var.owner
      CostCenter  = "portfolio-demo"
      AutoDestroy = "true"
    }
  }
}
