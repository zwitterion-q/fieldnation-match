#!/usr/bin/env bash
# Build every service image for linux/amd64 and push to ECR.
#
# The --platform flag is not optional on an Apple Silicon machine. Without it
# Docker builds arm64, the push succeeds, and the pods then crash-loop with
# "exec format error" -- which reads like a broken entrypoint, not a wrong
# architecture, and costs an hour to diagnose.
set -euo pipefail
cd "$(dirname "$0")/../.."

TF="terraform -chdir=deploy/terraform"
REGISTRY=$($TF output -raw ecr_registry)
REGION=$($TF   output -raw region)
PROFILE="${AWS_PROFILE:-fieldnation}"
TAG="${TAG:-$(git rev-parse --short HEAD)}"

aws ecr get-login-password --region "$REGION" --profile "$PROFILE" \
  | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
echo "  logged in to $REGISTRY"

build() {  # name  context  dockerfile
  local name=$1 ctx=$2 df=$3
  local repo="$REGISTRY/fieldnation/$name"
  echo "── $name"
  docker build --platform linux/amd64 -t "$repo:$TAG" -t "$repo:latest" -f "$df" "$ctx"
  docker push -q "$repo:$TAG"
  docker push -q "$repo:latest"
  echo "   pushed $repo:$TAG"
}

build api         ./api               ./api/Dockerfile
build ingest      ./ingest            ./ingest/Dockerfile
build identity    ./services/identity ./services/identity/Dockerfile
build work-orders .                   ./services/work-orders/Dockerfile
build payments    .                   ./services/payments/Dockerfile
build web-buyer   ./web-buyer         ./web-buyer/Dockerfile
build web-tech    ./web-tech          ./web-tech/Dockerfile

echo
echo "  all images pushed at tag $TAG"
