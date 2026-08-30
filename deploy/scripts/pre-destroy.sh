#!/usr/bin/env bash
# ============================================================================
# Remove everything KUBERNETES created in AWS, before Terraform tries to
# delete the VPC.
#
# This script exists because `terraform destroy` on an EKS stack reliably fails
# without it, and the failure is confusing: Terraform reports it cannot delete
# the VPC due to "DependencyViolation", with no indication of what depends on
# it.
#
# The cause is that Terraform did not create the blockers. When you deploy a
# Service of type LoadBalancer, the AWS Load Balancer Controller provisions a
# real ELB, its ENIs and its security groups. Terraform has never heard of any
# of them. It deletes the cluster, the orphaned ELB survives, its ENIs stay
# attached to the subnets, and the VPC will not go.
#
# So: delete the Kubernetes objects first, wait for AWS to reclaim what they
# created, then let Terraform run.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1   # deploy/, so `terraform -chdir=terraform` resolves

CLUSTER="${CLUSTER_NAME:-fieldnation-demo}"
REGION="${AWS_REGION:-ap-southeast-1}"
PROFILE="${AWS_PROFILE:-fieldnation}"

say() { printf "  %s\n" "$*"; }

if ! aws eks describe-cluster --name "$CLUSTER" --region "$REGION" --profile "$PROFILE" \
     >/dev/null 2>&1; then
  say "cluster $CLUSTER not found — nothing Kubernetes-owned to clean up"
  exit 0
fi

say "pointing kubectl at $CLUSTER"
aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1 || {
  say "could not reach the cluster; skipping Kubernetes cleanup"; exit 0; }

# ---- 1. LoadBalancer Services: each one owns a real ELB ---------------------
say "deleting Services of type LoadBalancer (each holds an ELB + ENIs)"
kubectl get svc --all-namespaces \
  -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.namespace}{" "}{.metadata.name}{"\n"}{end}' \
  2>/dev/null | while read -r ns name; do
    [ -z "${ns:-}" ] && continue
    say "  - $ns/$name"
    kubectl delete svc "$name" -n "$ns" --wait=false >/dev/null 2>&1
  done

# ---- 2. Ingresses: the ALB controller owns an ALB per ingress ---------------
say "deleting Ingresses (each holds an ALB)"
kubectl delete ingress --all --all-namespaces --wait=false >/dev/null 2>&1 || true

# ---- 3. PVCs: each holds an EBS volume that survives the cluster ------------
say "deleting PersistentVolumeClaims (each holds an EBS volume)"
kubectl delete pvc --all --all-namespaces --wait=false >/dev/null 2>&1 || true

# ---- 4. Wait for AWS to actually reclaim them -------------------------------
# Deleting the Kubernetes object only starts the process: the controller then
# calls AWS, and AWS takes its time. Proceeding immediately puts you straight
# back into DependencyViolation, so this waits for the load balancers to
# actually disappear from the VPC.
VPC=$(terraform -chdir=terraform output -raw vpc_id 2>/dev/null || echo "")

if [ -n "$VPC" ]; then
  say "waiting for AWS to release load balancers in $VPC (up to 5 minutes)"
  for i in $(seq 1 30); do
    alb=$(aws elbv2 describe-load-balancers --region "$REGION" --profile "$PROFILE" \
          --query "length(LoadBalancers[?VpcId=='$VPC'])" --output text 2>/dev/null || echo 0)
    clb=$(aws elb describe-load-balancers --region "$REGION" --profile "$PROFILE" \
          --query "length(LoadBalancerDescriptions[?VPCId=='$VPC'])" --output text 2>/dev/null || echo 0)
    if [ "${alb:-0}" = "0" ] && [ "${clb:-0}" = "0" ]; then
      say "  released after ~$((i * 10))s"
      break
    fi
    [ "$i" = "30" ] && say "  still $alb ALB / $clb CLB after 5 minutes — terraform destroy may fail; re-run 'make nuke'"
    sleep 10
  done

  # Security groups the ALB controller created are tagged with the cluster and
  # are deleted with their load balancer -- but a group whose LB deletion
  # raced can linger and hold the VPC. Report rather than force-delete, since
  # deleting a security group that is still in use fails loudly anyway.
  orphan=$(aws ec2 describe-security-groups --region "$REGION" --profile "$PROFILE" \
           --filters "Name=vpc-id,Values=$VPC" "Name=tag-key,Values=elbv2.k8s.aws/cluster" \
           --query 'length(SecurityGroups)' --output text 2>/dev/null || echo 0)
  [ "${orphan:-0}" != "0" ] && say "note: $orphan controller-created security group(s) still present"
fi

say "kubernetes-owned AWS resources cleaned up"
