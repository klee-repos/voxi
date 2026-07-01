# iam.tf — cross-cutting project-level role bindings (least privilege).
#
# Secret accessors live in secrets.tf; Cloud Run/Tasks invoker bindings live
# next to their resources. This file holds the remaining workload grants:
# Cloud SQL client, GCS object access per bucket, Vertex/Vision, and telemetry.

############################################
# Cloud SQL client (connect via the connector / private IP)
############################################

locals {
  sql_clients = [
    google_service_account.voxi_api.email,   # app.* reads/writes
    google_service_account.eve_front.email,  # workflow.* (front)
    google_service_account.eve_poller.email, # workflow.* (poller LISTEN/NOTIFY)
    google_service_account.podcast_worker.email,
  ]
}

resource "google_project_iam_member" "sql_client" {
  for_each = toset(local.sql_clients)
  project  = var.project_id
  role     = "roles/cloudsql.client"
  member   = "serviceAccount:${each.value}"
}

############################################
# GCS object access — bucket-scoped, not project-wide.
############################################

# BFF signs URLs for + reads/writes redacted photos.
resource "google_storage_bucket_iam_member" "bff_photos" {
  bucket = google_storage_bucket.photos.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.voxi_api.email}"
}

# BFF needs the signBlob capability on its own SA to mint V4 signed URLs (eng-F5)
# without a long-lived JSON key.
resource "google_service_account_iam_member" "bff_sign_self" {
  service_account_id = google_service_account.voxi_api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.voxi_api.email}"
}

# eve front/poller write redacted exemplars + read photos for identify.
resource "google_storage_bucket_iam_member" "eve_front_photos" {
  bucket = google_storage_bucket.photos.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.eve_front.email}"
}

resource "google_storage_bucket_iam_member" "eve_poller_photos" {
  bucket = google_storage_bucket.photos.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.eve_poller.email}"
}

# eve writes the CSAM quarantine object (write-only; no read/redistribute, §15).
resource "google_storage_bucket_iam_member" "eve_front_csam_write" {
  bucket = google_storage_bucket.csam_quarantine.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.eve_front.email}"
}

resource "google_storage_bucket_iam_member" "eve_poller_csam_write" {
  bucket = google_storage_bucket.csam_quarantine.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.eve_poller.email}"
}

# Podcast worker writes rendered audio; BFF reads/signs it.
resource "google_storage_bucket_iam_member" "worker_audio" {
  bucket = google_storage_bucket.audio.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.podcast_worker.email}"
}

resource "google_storage_bucket_iam_member" "bff_audio" {
  bucket = google_storage_bucket.audio.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.voxi_api.email}"
}

############################################
# Vertex AI + Cloud Vision — eve does the identify/embed/SafeSearch work (D8/§15).
############################################

locals {
  ai_consumers = [
    google_service_account.eve_front.email,
    google_service_account.eve_poller.email,
  ]
}

resource "google_project_iam_member" "vertex_user" {
  for_each = toset(local.ai_consumers)
  project  = var.project_id
  role     = "roles/aiplatform.user"
  member   = "serviceAccount:${each.value}"
}

############################################
# Telemetry — every workload writes logs/traces (PLAN §11 Cloud Logging/Trace).
############################################

locals {
  all_workloads = [
    google_service_account.voxi_api.email,
    google_service_account.eve_front.email,
    google_service_account.eve_poller.email,
    google_service_account.podcast_worker.email,
    # The voice-bot writes logs/traces like every workload. It gets NO Cloud SQL / vendor-broad grant —
    # it reaches the BFF (the only auth surface) with a per-session scoped token (§6.3).
    google_service_account.voice_bot.email,
  ]
}

resource "google_project_iam_member" "log_writer" {
  for_each = toset(local.all_workloads)
  project  = var.project_id
  role     = "roles/logging.logWriter"
  member   = "serviceAccount:${each.value}"
}

resource "google_project_iam_member" "trace_agent" {
  for_each = toset(local.all_workloads)
  project  = var.project_id
  role     = "roles/cloudtrace.agent"
  member   = "serviceAccount:${each.value}"
}
