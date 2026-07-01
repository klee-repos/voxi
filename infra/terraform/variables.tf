# variables.tf — every knob the Voxi infra exposes.
#
# Defaults track the PLAN's "one project, one region" mandate (§11) and the
# cost envelope @ ~10k MAU ($120–350/mo Cloud SQL + ~$15–40/mo poller node).

############################################
# Project / location
############################################

variable "project_id" {
  description = "GCP project ID. One project for all of Voxi (PLAN §11)."
  type        = string
}

variable "region" {
  description = "Primary region. One region for all compute + data (PLAN §11)."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zone for the single, size-pinned eve-poller GCE node (PLAN §4.4)."
  type        = string
  default     = "us-central1-a"
}

variable "labels" {
  description = "Labels applied to every labelable resource (cost attribution)."
  type        = map(string)
  default = {
    app        = "voxi"
    managed-by = "terraform"
  }
}

############################################
# Container images (built/pushed by CI; infra only references them)
############################################

variable "image_voxi_api" {
  description = "Image for the voxi-api BFF (the ONLY public surface, PLAN §3)."
  type        = string
  default     = "us-central1-docker.pkg.dev/PROJECT/voxi/voxi-api:latest"
}

variable "image_eve_front" {
  description = "Image for the stateless eve request FRONT (Cloud Run, PLAN §4.4)."
  type        = string
  default     = "us-central1-docker.pkg.dev/PROJECT/voxi/eve-agent:latest"
}

variable "image_eve_poller" {
  description = <<-EOT
    Image for the eve workflow POLLER. Same code artifact as the front but a
    different entrypoint/role flag — the poller runs the @workflow/world-postgres
    LISTEN/NOTIFY loop on a NON-serverless runtime (PLAN §4.4). Defaults to the
    eve-agent image; override only if you ship a separate poller image.
  EOT
  type        = string
  default     = "us-central1-docker.pkg.dev/PROJECT/voxi/eve-agent:latest"
}

variable "image_podcast_worker" {
  description = "Image for voxi-podcast-worker (ffmpeg + multi-speaker TTS, PLAN §6.2/D7)."
  type        = string
  default     = "us-central1-docker.pkg.dev/PROJECT/voxi/voxi-podcast-worker:latest"
}

variable "image_voice_bot" {
  description = "Image for the voice-bot realtime SmallWebRTC media plane (Python/uvicorn, PLAN §6.3)."
  type        = string
  default     = "us-central1-docker.pkg.dev/PROJECT/voxi/voice-bot:latest"
}

############################################
# eng-F1 split — front vs poller sizing (PLAN §4.4)
# The split is the whole point of this section: front autoscales, poller does NOT.
############################################

variable "eve_front_min_instances" {
  description = "eve FRONT min instances (stateless, Cloud Run autoscaled)."
  type        = number
  default     = 0
}

variable "eve_front_max_instances" {
  description = "eve FRONT max instances (HTTP channel/streaming scale-out)."
  type        = number
  default     = 10
}

variable "eve_poller_runtime" {
  description = <<-EOT
    Which NON-serverless runtime hosts the eve workflow poller (PLAN §4.4):
      "worker_pool" -> Cloud Run Worker Pool (manual scaling, no request-driven
                       autoscale; the preferred managed option).
      "gce"         -> a single size-pinned GCE MIG node (the portable fallback).
    Exactly one is created. Cloud Run *services* are serverless and are NEVER
    used for the poller — that is the corrected topology.
  EOT
  type        = string
  default     = "worker_pool"

  validation {
    condition     = contains(["worker_pool", "gce"], var.eve_poller_runtime)
    error_message = "eve_poller_runtime must be 'worker_pool' or 'gce'."
  }
}

variable "eve_poller_instance_count" {
  description = <<-EOT
    Number of poller instances. graphile-worker/@workflow can run >1 concurrent
    poller ONLY if it leases via SELECT ... FOR UPDATE SKIP LOCKED. Until G3
    confirms that (PLAN §4.4), keep this at 1 (single-poller + documented
    failover). If confirmed, raise to >=2 with documented lease semantics.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.eve_poller_instance_count >= 1
    error_message = "Need at least one poller; the workflow world has no serverless mode."
  }
}

variable "eve_poller_gce_machine_type" {
  description = "Machine type for the GCE poller node. ~$15-40/mo class (PLAN §11)."
  type        = string
  default     = "e2-small"
}

variable "eve_poller_cpu" {
  description = "vCPU for the Worker Pool poller instance."
  type        = string
  default     = "1"
}

variable "eve_poller_memory" {
  description = "Memory for the Worker Pool poller instance."
  type        = string
  default     = "1Gi"
}

############################################
# Cloud SQL (Postgres + pgvector), PLAN §11
############################################

variable "db_tier" {
  description = "Cloud SQL machine tier. db-custom-1-3840 ~= the low end of the §11 envelope."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_version" {
  description = "Postgres major version. pgvector available as an extension."
  type        = string
  default     = "POSTGRES_16"
}

variable "db_disk_size_gb" {
  description = "Initial data disk (autoresize is on)."
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Logical database holding BOTH the eve workflow.* schema and app.* (PLAN §4.4/§11)."
  type        = string
  default     = "voxi"
}

variable "db_app_user" {
  description = "App/BFF DB user (owns app.* and reads workflow.*)."
  type        = string
  default     = "voxi_app"
}

variable "db_eve_user" {
  description = "eve DB user (owns workflow.*; the front + poller connect as this)."
  type        = string
  default     = "voxi_eve"
}

variable "db_deletion_protection" {
  description = "Block accidental DB destroy. Always true outside throwaway envs."
  type        = bool
  default     = true
}

############################################
# Networking / VPC connector (PLAN §4.4 self-callback + private DB)
############################################

variable "vpc_connector_cidr" {
  description = "/28 reserved for the Serverless VPC Access connector (Cloud Run -> VPC)."
  type        = string
  default     = "10.8.0.0/28"
}

variable "private_ip_cidr_prefix" {
  description = "Prefix length for the PSA range backing Cloud SQL/AlloyDB private IP."
  type        = number
  default     = 16
}

############################################
# GCS buckets + CDN (PLAN §11, eng-F5 signed-URL policy)
############################################

variable "photos_retention_days" {
  description = <<-EOT
    Raw/redacted photo retention TTL (PLAN §11/§15: 30-90d unless attached to a
    kept thread). Lifecycle deletes objects past this age. Private bucket — NEVER
    fronted by the shared CDN (eng-F5).
  EOT
  type        = number
  default     = 90
}

variable "csam_preservation_days" {
  description = "18 U.S.C. 2258A preservation window for quarantined CSAM evidence (PLAN §15)."
  type        = number
  default     = 90
}

variable "cdn_default_ttl" {
  description = "Cloud CDN default TTL for the GLOBAL-only audio path (cached by item id, PLAN §11)."
  type        = number
  default     = 3600
}

############################################
# Cloud Tasks (async podcast render, PLAN §6.2/D7)
############################################

variable "podcast_queue_max_dispatches_per_second" {
  description = "Rate cap on the podcast render queue."
  type        = number
  default     = 5
}

variable "podcast_queue_max_concurrent_dispatches" {
  description = "Concurrency cap on the podcast render queue."
  type        = number
  default     = 10
}

variable "podcast_queue_max_attempts" {
  description = "Retry attempts before a render task is dead-lettered (idempotent worker, D7)."
  type        = number
  default     = 5
}

############################################
# Secret Manager — values are NEVER set in TF (PLAN §11/§12)
# Terraform creates the secret *containers* and IAM; humans/CI add versions.
############################################

variable "secret_ids" {
  description = <<-EOT
    Logical secret IDs to create as empty containers. Versions (the actual
    values) are added out-of-band — never committed, never in tfvars. Covers
    Clerk keys, DB URLs, and vendor keys (PLAN §11/§12).
  EOT
  type        = list(string)
  default = [
    "clerk-secret-key",         # @clerk/backend verifyToken
    "clerk-publishable-key",    # client config surfaced via BFF
    "clerk-jwt-key",            # networkless JWKS/PEM (CLERK_JWT_KEY in voxi-api/auth.ts)
    "database-url-app",         # app.* connection (voxi-api)
    "database-url-eve",         # workflow.* connection (eve front + poller)
    "url-signing-key",          # VOXI_URL_SIGNING_KEY (signed-URL HMAC, eng-F5)
    "vertex-ai-key",            # Gemini 3 Flash/Pro + embeddings (D8)
    "cloud-vision-key",         # web detection + SafeSearch (D8/§15)
    "elevenlabs-key",           # Voxi narrator + 2-host podcast (D5/D6)
    "deepgram-key",             # STT for Pipecat realtime (§6.3)
    "appstore-connect-api-key", # StoreKit 2 server-side entitlement verification, direct (no vendor) (§13)
    "photodna-key",             # CSAM hash-match first pass (§15/RT-4)
    "eve-scoped-token-key",     # per-session scoped token the voice-bot uses to call agent tools via the BFF (§6.3)
    "cron-shared-secret",       # Cloud Scheduler → BFF /internal/cron/{dedup,promote} auth (§7.2/§7.4, §22.3 S1)
  ]
}
