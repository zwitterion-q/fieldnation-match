output "db_endpoint" { value = aws_db_instance.main.address }
output "db_port" { value = aws_db_instance.main.port }
output "db_name" { value = aws_db_instance.main.db_name }
output "db_username" { value = aws_db_instance.main.username }
output "db_secret_arn" { value = aws_secretsmanager_secret.db.arn }
output "db_security_group" { value = aws_security_group.db.id }

output "mq_endpoint" { value = aws_mq_broker.main.instances[0].endpoints[0] }
output "mq_console_url" { value = aws_mq_broker.main.instances[0].console_url }
output "mq_secret_arn" { value = aws_secretsmanager_secret.mq.arn }

# Marked sensitive so `terraform output` does not splatter them across a
# terminal that is being screen-shared during a demo.
output "db_password" {
  value     = random_password.db.result
  sensitive = true
}
output "mq_password" {
  value     = random_password.mq.result
  sensitive = true
}

output "app_secret_arn" { value = aws_secretsmanager_secret.app.arn }
