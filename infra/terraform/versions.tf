# versions.tf — provider + Terraform version pins.
#
# Pin everything. The eve/@workflow line is pre-GA and the GCP runtime surfaces
# we lean on (Cloud Run Worker Pools, AlloyDB) move fast — a floating provider
# would silently change plan output between applies. See PLAN.md §4.5
# (version-compatibility matrix + documented rollback).

terraform {
  required_version = ">= 1.7.0, < 2.0.0"

  required_providers {
    # Stable GA resources (Cloud Run service, Cloud SQL, GCS, Secret Manager,
    # Cloud Tasks, VPC connector).
    google = {
      source  = "hashicorp/google"
      version = "~> 6.12"
    }
    # google-beta carries the resources that are still beta in the provider:
    #   - google_cloud_run_v2_worker_pool   (the NON-serverless eve poller, §4.4)
    #   - google_alloydb_*                  (the AlloyDB migration target, §11)
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.12"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state lives in its own GCS bucket so the poller-vs-front split and the
  # DB password generation aren't trapped on one laptop. Bucket is created
  # out-of-band (chicken/egg); see README "Bootstrap".
  backend "gcs" {
    # bucket = "voxi-tfstate-<project>"   # set via -backend-config at init
    prefix = "voxi/infra"
  }
}
