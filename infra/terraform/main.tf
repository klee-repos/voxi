# main.tf — providers, enabled APIs, VPC + connector, PSA, service accounts.
#
# This file wires the shared substrate that every per-service .tf builds on:
#   the VPC + subnet, the Serverless VPC connector (so the Cloud Run SERVICES
#   reach the private-IP Cloud SQL and the internal eve front; the Worker Pool
#   poller uses Direct VPC egress instead), the PSA range for managed DB private
#   IP, Cloud NAT, and one least-privilege SA per workload.
#
# Per-service resources live in their own files:
#   cloudrun_voxi_api.tf      — BFF (only public surface)
#   cloudrun_eve_front.tf     — eve request FRONT (stateless)
#   eve_poller.tf             — eve workflow POLLER (NON-serverless) <-- eng-F1 split
#   cloudrun_podcast_worker.tf— async ffmpeg/TTS render target
#   cloudsql.tf               — Postgres + pgvector (workflow.* + app.*)
#   storage_cdn.tf            — GCS buckets + Cloud CDN
#   cloudtasks.tf             — podcast render queue
#   secrets.tf                — Secret Manager containers + IAM
#   iam.tf                    — cross-cutting role bindings

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

############################################
# Enabled services (APIs)
############################################

locals {
  required_apis = [
    "run.googleapis.com",
    "compute.googleapis.com", # GCE poller fallback + LB/CDN + VPC
    "sqladmin.googleapis.com",
    "alloydb.googleapis.com", # migration target (PLAN §11), created lazily
    "secretmanager.googleapis.com",
    "cloudtasks.googleapis.com",
    "storage.googleapis.com",
    "vpcaccess.googleapis.com",         # Serverless VPC Access connector
    "servicenetworking.googleapis.com", # PSA for private-IP Cloud SQL
    "aiplatform.googleapis.com",        # Vertex / Gemini (D8)
    "vision.googleapis.com",            # web detection + SafeSearch (§15)
    "iam.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudtrace.googleapis.com",
    "logging.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each                   = toset(local.required_apis)
  project                    = var.project_id
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}

############################################
# Networking
############################################

resource "google_compute_network" "voxi" {
  name                    = "voxi-net"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.enabled]
}

resource "google_compute_subnetwork" "primary" {
  name          = "voxi-subnet-primary"
  ip_cidr_range = "10.10.0.0/20"
  region        = var.region
  network       = google_compute_network.voxi.id

  # Required for the poller node to reach Vertex/Vision/Secret Manager privately.
  private_ip_google_access = true
}

# Serverless VPC Access connector: lets the Cloud Run services (BFF, eve front,
# podcast worker) reach the private-IP Cloud SQL and the in-VPC poller, and lets
# the eve front reach its OWN base URL for the /.well-known/workflow self-callback
# (PLAN §4.4 self-callback gotcha).
resource "google_vpc_access_connector" "voxi" {
  name          = "voxi-vpc-connector"
  region        = var.region
  network       = google_compute_network.voxi.name
  ip_cidr_range = var.vpc_connector_cidr
  depends_on    = [google_project_service.enabled]
}

# Private Services Access (PSA) range that backs Cloud SQL / AlloyDB private IP.
resource "google_compute_global_address" "psa_range" {
  name          = "voxi-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.private_ip_cidr_prefix
  network       = google_compute_network.voxi.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.voxi.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa_range.name]
  depends_on              = [google_project_service.enabled]
}

# Cloud NAT so the size-pinned poller node (no external IP) can reach the
# internet (vendor APIs, npm, the workflow self-callback over public URL).
resource "google_compute_router" "voxi" {
  name    = "voxi-router"
  region  = var.region
  network = google_compute_network.voxi.id
}

resource "google_compute_router_nat" "voxi" {
  name                               = "voxi-nat"
  router                             = google_compute_router.voxi.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

############################################
# Service accounts — one per workload, least privilege (PLAN §3/§12)
############################################

resource "google_service_account" "voxi_api" {
  account_id   = "voxi-api"
  display_name = "voxi-api BFF (only public surface)"
}

resource "google_service_account" "eve_front" {
  account_id   = "eve-front"
  display_name = "eve request FRONT (stateless, Cloud Run)"
}

resource "google_service_account" "eve_poller" {
  account_id   = "eve-poller"
  display_name = "eve workflow POLLER (NON-serverless)"
}

resource "google_service_account" "podcast_worker" {
  account_id   = "podcast-worker"
  display_name = "voxi-podcast-worker (async ffmpeg/TTS)"
}

resource "google_service_account" "voice_bot" {
  account_id   = "voice-bot"
  display_name = "voxi voice-bot (realtime SmallWebRTC media plane, §6.3)"
}

# Cloud Tasks needs an SA to mint the OIDC token it uses when invoking the
# podcast worker (private Cloud Run).
resource "google_service_account" "tasks_invoker" {
  account_id   = "voxi-tasks-invoker"
  display_name = "Cloud Tasks -> podcast worker OIDC invoker"
}

############################################
# Shared locals consumed by per-service files
############################################

locals {
  # Resolve a concrete image string, substituting PROJECT in the default tokens.
  img_voxi_api       = replace(var.image_voxi_api, "PROJECT", var.project_id)
  img_eve_front      = replace(var.image_eve_front, "PROJECT", var.project_id)
  img_eve_poller     = replace(var.image_eve_poller, "PROJECT", var.project_id)
  img_podcast_worker = replace(var.image_podcast_worker, "PROJECT", var.project_id)
  img_voice_bot      = replace(var.image_voice_bot, "PROJECT", var.project_id)
}
