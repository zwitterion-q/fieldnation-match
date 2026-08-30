variable "name" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "source_security_group" {
  type        = string
  description = "EKS cluster SG — the only thing allowed to reach the data tier"
}

variable "db_instance" { type = string }
variable "db_storage" { type = number }
variable "db_multi_az" { type = bool }
variable "mq_instance" { type = string }
variable "mq_deployment" { type = string }

variable "deletion_protection" { type = bool }
variable "skip_final_snapshot" { type = bool }
variable "log_retention_days" { type = number }

variable "databases" {
  type        = list(string)
  description = "Logical databases created inside the single RDS instance, one per service that owns state."
}
