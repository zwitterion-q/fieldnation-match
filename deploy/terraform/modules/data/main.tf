# ============================================================================
# Data tier: PostgreSQL (RDS) and RabbitMQ (Amazon MQ).
#
# Local runs these as containers in docker-compose. Here they are managed
# services, and that swap is the whole point of the two-target design: the
# application code does not change, only the connection strings it is handed.
# The services read DATABASE_URL and AMQP_URL either way.
#
# ---- one instance, many databases
# Every stateful service owns its own schema and no service reads another's
# tables. Locally that is separate databases in one Postgres container; here it
# is separate databases in one RDS instance. Separate *instances* would be
# more faithful isolation and roughly 4x the bill, which is not a trade worth
# making for a demo. The boundary that matters -- no cross-service queries --
# is enforced by the credentials and the code, not by the instance count.
#
# ---- Amazon MQ rather than self-hosted RabbitMQ
# Running RabbitMQ in-cluster would need a StatefulSet, PVCs and a quorum of
# pods. The PVCs are exactly the thing that orphans EBS volumes and breaks
# `terraform destroy`. Amazon MQ is a Terraform resource that Terraform
# genuinely owns and can genuinely delete, and it speaks the same AMQP 0-9-1
# the local broker does, so `libs/tsevents` and `libs/pyevents` connect to it
# unmodified.
# ============================================================================

# ------------------------------------------------------------ credentials ---
# Generated, never typed, never committed. Terraform writes them to Secrets
# Manager; the platform layer reads them back and projects them into the
# cluster as Kubernetes Secrets. They exist in a tfstate file locally, which is
# why deploy/terraform/*.tfstate is gitignored.
resource "random_password" "db" {
  length  = 32
  special = false # RDS rejects several punctuation characters, and a
  # 32-char alphanumeric password is already far past
  # the point where charset matters
}

resource "random_password" "mq" {
  length  = 32
  special = false # Amazon MQ forbids commas and colons in passwords
}

resource "aws_secretsmanager_secret" "db" {
  name                    = "${var.name}/postgres"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0 # destroyability: the default 30-day recovery
  # window keeps the secret name reserved, so a
  # re-deploy fails with "already scheduled for
  # deletion". 0 deletes immediately.
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = aws_db_instance.main.username
    password = random_password.db.result
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    dbname   = aws_db_instance.main.db_name
  })
}

resource "aws_secretsmanager_secret" "mq" {
  name                    = "${var.name}/rabbitmq"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "mq" {
  secret_id = aws_secretsmanager_secret.mq.id
  secret_string = jsonencode({
    username = "fieldnation"
    password = random_password.mq.result
    endpoint = aws_mq_broker.main.instances[0].endpoints[0]
    console  = aws_mq_broker.main.instances[0].console_url
  })
}

# The JWT signing key. Locally this defaults to "fn-dev-secret-change-me" in
# docker-compose, which is fine for a laptop and would be a critical finding
# anywhere else. Here it is generated, stored in Secrets Manager, and delivered
# to pods by the External Secrets operator -- it is never in the repo, never in
# a manifest, and never printed.
resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.name}/app"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    jwt_secret = random_password.jwt.result
  })
}

# -------------------------------------------------------------- postgres ----
resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres — reachable only from the EKS cluster security group"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Postgres from cluster nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.source_security_group]
    # Deliberately no cidr_blocks. There is no path to this database from the
    # internet, and no path from a bastion, because there is no bastion. Access
    # for a human is `kubectl exec` into a pod that is already inside the
    # allowed SG -- see `make aws-db-shell`.
  }

  egress {
    # A database has no business dialling the internet. Confining egress to the
    # VPC means a compromised instance cannot exfiltrate outward, and costs
    # nothing -- RDS reaches CloudWatch and S3 over the AWS network.
    description = "VPC-internal only"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = { Name = "${var.name}-db" }
}

resource "aws_db_parameter_group" "main" {
  name   = "${var.name}-pg16"
  family = "postgres16"

  # The outbox relay polls; slow queries there are worth seeing.
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }

  # Reject any non-TLS connection at the server. The DSNs already say
  # sslmode=require, but that is the client promising to use TLS -- this is the
  # server refusing to accept anything else, which is the half that holds when
  # a client is misconfigured.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  lifecycle { create_before_destroy = true }
}

resource "aws_db_instance" "main" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = var.db_instance

  allocated_storage     = var.db_storage
  max_allocated_storage = var.db_storage * 2 # storage autoscaling, so a load
  # test cannot fill the disk and
  # wedge the demo
  storage_type      = "gp3"
  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  db_name  = "fieldnation"
  username = "fnadmin"
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  multi_az               = var.db_multi_az
  publicly_accessible    = false

  # ---- destroyability ----
  # These three lines are the difference between `terraform destroy` finishing
  # and `terraform destroy` leaving you with a protected instance and a
  # retained snapshot that bills for storage indefinitely.
  deletion_protection      = var.deletion_protection
  skip_final_snapshot      = var.skip_final_snapshot
  delete_automated_backups = true
  backup_retention_period  = 0 # no automated backups on a demo; also means
  # nothing survives the instance

  # Lets a human authenticate with a 15-minute IAM token instead of the master
  # password. The services still use the password from Secrets Manager --
  # refreshing a token inside a connection pool is real work, not a flag.
  iam_database_authentication_enabled = true

  # Without this a snapshot carries no tags, and verify-destroyed.sh -- which
  # searches by tag -- cannot see an orphaned one.
  copy_tags_to_snapshot = true

  apply_immediately            = true
  auto_minor_version_upgrade   = true
  performance_insights_enabled = false # not free on t4g.micro-class

  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = { Name = var.name }
}

# ---- the other logical databases -------------------------------------------
# RDS creates exactly one database at provision time. The rest are created by
# the postgresql provider, which connects through the same private path the
# services use. This runs from wherever Terraform runs, so it needs network
# reach -- in CI that is a runner inside the VPC; from a laptop it is skipped
# and the bootstrap Job in the platform layer does it instead. See
# deploy/k8s/jobs/db-bootstrap.yaml.
resource "aws_ssm_parameter" "databases" {
  name = "/${var.name}/databases"
  # SecureString rather than StringList. The value is only a list of database
  # names, but "it is not sensitive today" is how parameters end up holding
  # something sensitive tomorrow with no one revisiting the type.
  type   = "SecureString"
  key_id = var.kms_key_arn
  value  = join(",", var.databases)
}

# -------------------------------------------------------------- rabbitmq ----
resource "aws_security_group" "mq" {
  name        = "${var.name}-mq"
  description = "Amazon MQ (RabbitMQ) — reachable only from the EKS cluster"
  vpc_id      = var.vpc_id

  ingress {
    description     = "AMQPS from cluster nodes"
    from_port       = 5671
    to_port         = 5671
    protocol        = "tcp"
    security_groups = [var.source_security_group]
    # Note the port: 5671, not 5672. Amazon MQ only speaks AMQP over TLS.
    # That is a real code difference from local -- the connection URL is
    # amqps:// and the client must not disable certificate verification.
    # Handled in libs/tsevents/src/bus.ts and libs/pyevents/pyevents/bus.py.
  }

  ingress {
    description     = "Management console from cluster nodes"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [var.source_security_group]
  }

  egress {
    description = "VPC-internal only"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = { Name = "${var.name}-mq" }
}

resource "aws_mq_broker" "main" {
  broker_name         = var.name
  engine_type         = "RabbitMQ"
  engine_version      = "3.13"
  host_instance_type  = var.mq_instance
  deployment_mode     = var.mq_deployment
  publicly_accessible = false

  subnet_ids      = var.mq_deployment == "SINGLE_INSTANCE" ? [var.private_subnet_ids[0]] : var.private_subnet_ids
  security_groups = [aws_security_group.mq.id]

  # Amazon MQ has no equivalent of definitions.json import. The 7 exchanges,
  # 45 queues and 65 bindings in infra/rabbitmq/definitions.json are declared
  # instead by the topology bootstrap that already runs on service start --
  # libs/tsevents/src/topology.ts assertTopology(). Declaring topology from the
  # application is idempotent and survives a broker replacement, which is the
  # better pattern anyway; the local definitions file is a convenience, not the
  # source of truth.

  user {
    username = "fieldnation"
    password = random_password.mq.result
  }

  logs { general = true }

  maintenance_window_start_time {
    day_of_week = "SUNDAY"
    time_of_day = "18:00"
    time_zone   = "UTC"
  }

  auto_minor_version_upgrade = true
  apply_immediately          = true

  encryption_options {
    kms_key_id        = var.kms_key_arn
    use_aws_owned_key = false
  }

  tags = { Name = var.name }
}

# ---- log groups Terraform owns ---------------------------------------------
# Amazon MQ and RDS both create log groups on first write if you do not. Ones
# they create are not in state, so destroy leaves them behind, retaining
# forever and quietly billing. Declaring them here means Terraform deletes
# them.
resource "aws_cloudwatch_log_group" "mq" {
  name              = "/aws/amazonmq/broker/${var.name}/general"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}
