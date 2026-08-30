#!/usr/bin/env bash
# ============================================================================
# Fail before spending money, not after.
#
# Every check here corresponds to a way the deploy fails 20 minutes in, when
# the EKS control plane is already provisioned and already billing.
# ============================================================================
set -uo pipefail
PROFILE="${AWS_PROFILE:-fieldnation}"
REGION="${AWS_REGION:-ap-southeast-1}"
fail=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$*"; fail=1; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }

echo "── tools"
for t in terraform kubectl helm aws docker; do
  if command -v "$t" >/dev/null; then
    ok "$t $($t version 2>/dev/null | head -1 | cut -c1-40)"
  else
    bad "$t not installed"
  fi
done

echo "── credentials"
if ident=$(aws sts get-caller-identity --profile "$PROFILE" --output json 2>/dev/null); then
  acct=$(echo "$ident" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Account"])')
  arn=$(echo  "$ident" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Arn"])')
  ok "profile $PROFILE → account $acct"
  ok "identity $arn"

  # Guard rail. The Ternary accounts are work infrastructure and this stack must
  # never land in one of them by a mistyped profile.
  case "$acct" in
    266995516908|865286056583|148221445406|341907318131|206875042099)
      bad "account $acct is a Ternary account — refusing. Use a personal account." ;;
  esac
else
  bad "profile '$PROFILE' has no working credentials — run: aws configure --profile $PROFILE"
fi

echo "── region + quotas"
if aws ec2 describe-availability-zones --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1; then
  azc=$(aws ec2 describe-availability-zones --region "$REGION" --profile "$PROFILE" \
        --query 'length(AvailabilityZones)' --output text)
  ok "$REGION reachable, $azc availability zones"
  # A brand-new account gets 5 VPCs and 5 Elastic IPs per region. Two failed
  # deploys that left orphans will exhaust the EIP quota, and the failure
  # message ("AddressLimitExceeded") does not say that.
  eips=$(aws ec2 describe-addresses --region "$REGION" --profile "$PROFILE" \
         --query 'length(Addresses)' --output text 2>/dev/null || echo 0)
  vpcs=$(aws ec2 describe-vpcs --region "$REGION" --profile "$PROFILE" \
         --query 'length(Vpcs)' --output text 2>/dev/null || echo 0)
  if [ "$eips" -lt 4 ]; then ok "elastic IPs in use: $eips/5"
  else warn "elastic IPs in use: $eips/5 — at the default quota of 5, the next apply fails with AddressLimitExceeded"; fi
  if [ "$vpcs" -lt 4 ]; then ok "VPCs in use: $vpcs/5"
  else warn "VPCs in use: $vpcs/5 — close to the default quota"; fi
else
  bad "cannot reach $REGION with profile $PROFILE"
fi

echo "── docker"
if docker info >/dev/null 2>&1; then
  ok "docker daemon running"
else
  bad "docker daemon not running (needed to build and push images)"
fi

echo
if [ "$fail" = "1" ]; then
  echo "  preflight failed — fix the above before running apply."
  exit 1
fi
echo "  preflight passed."
