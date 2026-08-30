variable "name" { type = string }
variable "cluster_name" { type = string }
variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}
variable "single_nat" {
  type    = bool
  default = true
}
variable "log_retention_days" {
  type    = number
  default = 3
}

variable "kms_key_arn" {
  type        = string
  description = "Shared platform CMK — encrypts the VPC flow log group."
}
