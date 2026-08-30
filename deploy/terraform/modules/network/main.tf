# ============================================================================
# VPC, subnets, NAT.
#
# Written for teardown as much as for standing up. The classic failed
# `terraform destroy` on an EKS stack is a VPC that will not delete because
# something Kubernetes created -- a load balancer, its ENIs, its security group
# -- is still attached, and Terraform never knew about it because kubectl made
# it, not Terraform.
#
# Two defences here: subnets are tagged so the AWS Load Balancer Controller
# puts its ELBs where we expect them, and the destroy tooling removes those
# Kubernetes-owned resources BEFORE terraform runs. See deploy/Makefile.
# ============================================================================

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # required by EKS and by RDS private endpoints
  tags                 = { Name = "${var.name}-vpc" }
}

# Every VPC ships with a default security group that allows all traffic between
# anything attached to it. Nothing here uses it -- but it exists, it is
# permissive, and a resource created later without an explicit SG lands in it.
# Emptying it turns that accident into a connection failure instead of an open
# path.
resource "aws_default_security_group" "main" {
  vpc_id = aws_vpc.main.id
  # No ingress or egress blocks: both are emptied.
  tags = { Name = "${var.name}-default-DO-NOT-USE" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone = local.azs[count.index]
  # Nothing launches into the public subnets. Nodes are private; the NAT
  # gateway and the ALB both carry explicitly-allocated addresses. Leaving
  # auto-assign on would silently give a public IP to anything that ever did
  # land here.
  map_public_ip_on_launch = false
  tags = {
    Name = "${var.name}-public-${local.azs[count.index]}"
    # These two tags are load-bearing, not decorative. Without them the AWS Load
    # Balancer Controller cannot discover where to place an internet-facing ELB
    # and silently fails to provision one.
    "kubernetes.io/role/elb"                    = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  }
}

resource "aws_subnet" "private" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 8)
  availability_zone = local.azs[count.index]
  tags = {
    Name                                        = "${var.name}-private-${local.azs[count.index]}"
    "kubernetes.io/role/internal-elb"           = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  }
}

# NAT is the single most expensive always-on line item after the EKS control
# plane -- about $32/month each, before data charges. One NAT shared across AZs
# halves the bill and introduces a single point of failure. Correct trade for a
# demo, wrong for production, which is why it is a variable and not a constant.
resource "aws_eip" "nat" {
  count  = var.single_nat ? 1 : length(local.azs)
  domain = "vpc"
  tags   = { Name = "${var.name}-nat-eip-${count.index}" }
}

resource "aws_nat_gateway" "main" {
  count         = var.single_nat ? 1 : length(local.azs)
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${var.name}-nat-${count.index}" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${var.name}-rt-public" }
}

resource "aws_route_table" "private" {
  count  = var.single_nat ? 1 : length(local.azs)
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }
  tags = { Name = "${var.name}-rt-private-${count.index}" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[var.single_nat ? 0 : count.index].id
}

# VPC Flow Logs. Short retention on purpose: a log group that outlives the stack
# keeps charging, and a demo does not need 30 days of flow records.
resource "aws_cloudwatch_log_group" "flow" {
  name              = "/aws/vpc/${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_flow_log" "main" {
  vpc_id       = aws_vpc.main.id
  traffic_type = "REJECT" # rejects only -- the security signal, at a
  # fraction of the volume of ALL
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow.arn
  iam_role_arn         = aws_iam_role.flow.arn
}

resource "aws_iam_role" "flow" {
  name = "${var.name}-flow-logs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "flow" {
  role = aws_iam_role.flow.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.flow.arn}:*"
    }]
  })
}
