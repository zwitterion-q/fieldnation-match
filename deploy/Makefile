# ============================================================================
# AWS deployment target.
#
# This is the SECOND of two deployment targets. The first is the root Makefile,
# which runs the identical application on docker-compose on a laptop. Neither
# is a degraded version of the other -- see DEPLOYMENT.md for what actually
# differs and why.
#
# Everything here is idempotent and everything here is reversible. `make down`
# removes every resource this Makefile created, and `make verify-down` proves
# it by searching AWS by tag rather than trusting Terraform state.
#
#   make up          preflight → terraform apply → images → deploy
#   make down        kubernetes cleanup → terraform destroy → verify
#
# ============================================================================

SHELL      := /bin/bash
.DEFAULT_GOAL := help

AWS_PROFILE ?= fieldnation
AWS_REGION  ?= ap-southeast-1
SIZING      ?= minimal
TF          := terraform -chdir=terraform
TFVARS      := -var=aws_profile=$(AWS_PROFILE) -var=region=$(AWS_REGION) -var=sizing=$(SIZING)

export AWS_PROFILE
export AWS_REGION

# LOCKDOWN=1 restricts the Kubernetes API endpoint to the machine running make.
# Off by default because a changing home IP then locks you out of your own
# cluster mid-demo; on for anything left running.
ifeq ($(LOCKDOWN),1)
  MYIP   := $(shell curl -s https://checkip.amazonaws.com)
  TFVARS += -var='public_access_cidrs=["$(MYIP)/32"]'
endif

.PHONY: help preflight init plan up infra images deploy addons down destroy verify-down \
        nuke status cost urls kubeconfig logs db-shell mq-console fmt validate

help: ## Show this help
	@echo ""
	@echo "  fieldnation-match — AWS deployment  (profile: $(AWS_PROFILE), region: $(AWS_REGION), sizing: $(SIZING))"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  Local deployment is the root Makefile: cd .. && make up"
	@echo ""

# ------------------------------------------------------------- stand up -----
preflight: ## Check tools, credentials, region and quotas before spending anything
	@./scripts/preflight.sh

init: ## terraform init
	@$(TF) init -input=false

fmt: ## Format all Terraform
	@terraform fmt -recursive terraform/

validate: init ## Validate Terraform and every Kubernetes manifest, no cluster needed
	@# -check, not a silent rewrite: CI runs the same command, so a local
	@# `make validate` that quietly reformatted would still fail the pipeline.
	@terraform -chdir=terraform fmt -check -recursive -diff
	@$(TF) validate
	@kubectl kustomize k8s/overlays/aws \
	  | kubeconform -strict -summary -kubernetes-version 1.31.0 -ignore-missing-schemas

plan: init ## Show what would change
	@$(TF) plan $(TFVARS) -input=false

infra: preflight init ## Provision AWS: VPC, EKS, RDS, Amazon MQ, ECR  (~15 min)
	@$(TF) apply $(TFVARS) -input=false -auto-approve
	@$(MAKE) kubeconfig

kubeconfig: ## Point kubectl at the cluster
	@aws eks update-kubeconfig \
	  --name $$($(TF) output -raw cluster_name) \
	  --region $$($(TF) output -raw region) \
	  --profile $(AWS_PROFILE)

addons: ## Install the in-cluster controllers (ALB, External Secrets, KEDA, metrics)
	@# These are Helm releases, not Terraform resources, on purpose: Terraform's
	@# helm provider needs cluster credentials at PLAN time, which creates a
	@# chicken-and-egg on first apply and a much worse failure on destroy, where
	@# Terraform tries to talk to a cluster it has already deleted.
	@# Terraform owns AWS. Helm owns Kubernetes. The boundary stays clean.
	helm repo add eks https://aws.github.io/eks-charts >/dev/null 2>&1 || true
	helm repo add external-secrets https://charts.external-secrets.io >/dev/null 2>&1 || true
	helm repo add kedacore https://kedacore.github.io/charts >/dev/null 2>&1 || true
	helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ >/dev/null 2>&1 || true
	helm repo update >/dev/null

	helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
	  -n kube-system \
	  --set clusterName=$$($(TF) output -raw cluster_name) \
	  --set serviceAccount.create=true \
	  --set serviceAccount.name=aws-load-balancer-controller \
	  --set-string serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=$$($(TF) output -raw alb_role_arn) \
	  --set region=$$($(TF) output -raw region) \
	  --set vpcId=$$($(TF) output -raw vpc_id) \
	  --wait

	helm upgrade --install external-secrets external-secrets/external-secrets \
	  -n external-secrets --create-namespace \
	  --set installCRDs=true \
	  --set serviceAccount.name=external-secrets \
	  --set-string serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=$$($(TF) output -raw eso_role_arn) \
	  --wait

	helm upgrade --install keda kedacore/keda -n keda --create-namespace --wait
	helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system --wait
	@echo "  controllers ready"

images: ## Build for linux/amd64 and push every service image to ECR
	@./scripts/push.sh

deploy: ## Render manifests with this account's values and apply them
	@./scripts/render.sh
	@kubectl apply -f .rendered/manifests.yaml
	@echo "  waiting for the secret to materialise from Secrets Manager..."
	@kubectl wait --for=create secret/fieldnation-runtime -n fieldnation --timeout=120s
	@kubectl rollout status deploy/identity    -n fieldnation --timeout=300s
	@kubectl rollout status deploy/work-orders -n fieldnation --timeout=300s
	@kubectl rollout status deploy/payments    -n fieldnation --timeout=300s
	@kubectl rollout status deploy/api         -n fieldnation --timeout=300s
	@$(MAKE) urls

up: infra addons images deploy ## Everything, in order  (~25 min from nothing)
	@echo ""
	@echo "  stack is up. \033[33mIt bills while it runs — 'make down' when finished.\033[0m"
	@$(MAKE) cost

# ---------------------------------------------------------------- tear down --
down: destroy verify-down ## Remove everything and prove it is gone

destroy: ## Delete Kubernetes-owned AWS resources, then terraform destroy
	@# Order matters and this is the single most common EKS teardown failure.
	@# terraform destroy alone fails on "DependencyViolation" deleting the VPC,
	@# because a load balancer Kubernetes created still holds ENIs in the
	@# subnets -- and Terraform never knew that load balancer existed.
	@./scripts/pre-destroy.sh
	@$(TF) destroy $(TFVARS) -input=false -auto-approve

verify-down: ## Search AWS by tag for anything still running and billing
	@./scripts/verify-destroyed.sh

nuke: ## Last resort: destroy, ignoring errors, then report what survived
	@# For when destroy has already failed once and state is half-applied.
	@./scripts/pre-destroy.sh || true
	@$(TF) destroy $(TFVARS) -input=false -auto-approve || true
	@$(TF) destroy $(TFVARS) -input=false -auto-approve || true
	@./scripts/verify-destroyed.sh

# ------------------------------------------------------------- inspection ----
status: ## Pods, nodes and the ingress
	@kubectl get nodes -o wide
	@echo ""
	@kubectl get pods -n fieldnation -o wide
	@echo ""
	@kubectl get ingress -n fieldnation

urls: ## Print the public URLs
	@echo ""
	@host=$$(kubectl get ingress fieldnation -n fieldnation -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null); \
	 if [ -z "$$host" ]; then echo "  ALB not provisioned yet — retry in a minute"; else \
	 echo "  hirer console      http://$$host/"; \
	 echo "  technician console http://$$host/tech"; \
	 echo "  matching API       http://$$host/api/docs"; \
	 echo "  identity           http://$$host/id/health"; fi
	@echo "  rabbitmq console   $$($(TF) output -raw mq_console 2>/dev/null)"
	@echo ""

cost: ## What this costs per month while it is up
	@echo ""
	@echo "  estimated: $$($(TF) output -raw estimated_monthly_usd 2>/dev/null || echo 'run make infra first')"
	@echo ""

logs: ## Tail a service  (SVC=work-orders)
	@kubectl logs -n fieldnation -l app=$(or $(SVC),work-orders) --tail=100 -f

db-shell: ## psql into RDS from inside the cluster (nothing else can reach it)
	@kubectl run psql-$$RANDOM -n fieldnation --rm -it --restart=Never \
	  --image=postgres:16-alpine \
	  --overrides='{"spec":{"containers":[{"name":"psql","image":"postgres:16-alpine","stdin":true,"tty":true,"command":["sh","-c","psql \"$$WO_DSN\""],"env":[{"name":"WO_DSN","valueFrom":{"secretKeyRef":{"name":"fieldnation-runtime","key":"WO_DSN"}}}]}]}}'

mq-console: ## Open the Amazon MQ console (private — needs VPN or a port-forward)
	@open "$$($(TF) output -raw mq_console)" 2>/dev/null || echo "$$($(TF) output -raw mq_console)"
