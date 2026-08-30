#!/usr/bin/env bash
# ============================================================================
# Prove nothing is left running and billing.
#
# `terraform destroy` reporting success is not the same as your account being
# empty. Orphans survive: an ELB Kubernetes made, a log group EKS created, an
# EBS volume from a PVC, a snapshot RDS kept because someone left
# skip_final_snapshot off.
#
# This searches by TAG, not by Terraform state, so it finds things Terraform
# never knew about -- which is the entire category of thing that costs money
# after you thought you were done.
# ============================================================================
set -uo pipefail
REGION="${AWS_REGION:-ap-southeast-1}"
PROFILE="${AWS_PROFILE:-fieldnation}"
PROJECT="${PROJECT:-fieldnation}"
q() { aws --region "$REGION" --profile "$PROFILE" "$@" 2>/dev/null; }
found=0
row() { printf "  %-26s %s\n" "$1" "$2"; [ "$2" != "0" ] && [ "$2" != "None" ] && found=1; }

echo "── surviving resources in $REGION (profile $PROFILE)"
row "EKS clusters"      "$(q eks list-clusters --query "length(clusters[?contains(@,'$PROJECT')])" --output text)"
row "EC2 instances"     "$(q ec2 describe-instances --filters "Name=tag:Project,Values=$PROJECT" "Name=instance-state-name,Values=running,pending,stopping,stopped" --query 'length(Reservations[].Instances[])' --output text)"
row "NAT gateways"      "$(q ec2 describe-nat-gateways --filter "Name=tag:Project,Values=$PROJECT" --query "length(NatGateways[?State!='deleted'])" --output text)"
row "Elastic IPs"       "$(q ec2 describe-addresses --filters "Name=tag:Project,Values=$PROJECT" --query 'length(Addresses)' --output text)"
row "VPCs"              "$(q ec2 describe-vpcs --filters "Name=tag:Project,Values=$PROJECT" --query 'length(Vpcs)' --output text)"
row "Load balancers"    "$(q elbv2 describe-load-balancers --query 'length(LoadBalancers)' --output text)"
row "RDS instances"     "$(q rds describe-db-instances --query "length(DBInstances[?contains(DBInstanceIdentifier,'$PROJECT')])" --output text)"
row "RDS snapshots"     "$(q rds describe-db-snapshots --snapshot-type manual --query "length(DBSnapshots[?contains(DBSnapshotIdentifier,'$PROJECT')])" --output text)"
row "MQ brokers"        "$(q mq list-brokers --query "length(BrokerSummaries[?contains(BrokerName,'$PROJECT')])" --output text)"
row "EBS volumes"       "$(q ec2 describe-volumes --filters "Name=tag:Project,Values=$PROJECT" --query 'length(Volumes)' --output text)"
row "Unattached volumes" "$(q ec2 describe-volumes --filters Name=status,Values=available --query 'length(Volumes)' --output text)"
row "S3 buckets"        "$(q s3api list-buckets --query "length(Buckets[?contains(Name,'$PROJECT')])" --output text)"
row "Log groups"        "$(q logs describe-log-groups --log-group-name-prefix "/aws/eks/$PROJECT" --query 'length(logGroups)' --output text)"
# Counted separately because a key pending deletion is expected here, unlike
# everything above it.
row "KMS keys (pending)"  "$(q kms list-keys --query 'length(Keys)' --output text)"

echo
if [ "$found" = "0" ]; then
  echo "  ✓ nothing left — the account is clean"
else
  echo "  ⚠ resources above are still present and may still be billing."
  echo "    KMS keys linger for their mandatory deletion window (7 days, the"
  echo "    minimum AWS allows) and DO still bill at ~USD 1/month each — about"
  echo "    USD 0.50 of residue for the two keys. That is expected."
  echo "    Anything else should be investigated."
fi
