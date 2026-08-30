# Each module pins its own provider requirements rather than inheriting the
# root's. Inheritance works right up until the module is reused from another
# root that happens to pin something different -- at which point the failure is
# a provider-version error deep inside a module that has not changed. Declaring
# them here makes the module self-describing and is what `tflint` enforces.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}
