variable "cluster_name" { type = string }
variable "kubernetes_version" {
  type    = string
  default = "1.31"
}
variable "private_subnet_ids" { type = list(string) }
variable "public_subnet_ids" { type = list(string) }
variable "instance_types" { type = list(string) }
variable "capacity_type" { type = string }
variable "min_size" { type = number }
variable "max_size" { type = number }
variable "desired_size" { type = number }
variable "log_retention_days" {
  type    = number
  default = 3
}
variable "api_allowed_cidrs" {
  type        = list(string)
  description = "Who may reach the Kubernetes API. Set to your own IP/32, never 0.0.0.0/0."
}
