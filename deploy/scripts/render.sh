#!/usr/bin/env bash
# Substitute the per-account values Terraform produced into the manifests, and
# write the result to deploy/.rendered/ (gitignored).
#
# The placeholders are not committed values, so nothing account-specific ever
# reaches the repository -- which is the same reason the secrets themselves go
# through External Secrets rather than through here.
set -euo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=terraform"
REGISTRY=$($TF output -raw ecr_registry)
REGION=$($TF   output -raw region)
PREFIX=$($TF   output -raw secret_prefix)
OUT=.rendered

rm -rf "$OUT"; mkdir -p "$OUT"
kubectl kustomize k8s/overlays/aws \
  | sed -e "s#IMAGE_PLACEHOLDER#${REGISTRY}/fieldnation#g" \
        -e "s#REGION_PLACEHOLDER#${REGION}#g" \
        -e "s#SECRET_PREFIX#${PREFIX}#g" \
  > "$OUT/manifests.yaml"

echo "  rendered $(grep -c '^kind:' "$OUT/manifests.yaml") objects → $OUT/manifests.yaml"
echo "  registry $REGISTRY"
echo "  secrets  $PREFIX/{postgres,rabbitmq,app}"
