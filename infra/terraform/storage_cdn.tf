# storage_cdn.tf — GCS buckets + Cloud CDN.
#
# Two buckets with DELIBERATELY different exposure (PLAN §11, eng-F5):
#   voxi-photos : PRIVATE. Holds redacted photos (faces/plates removed BEFORE
#                 store, D12/§15). NEVER fronted by a shared/cacheable CDN path.
#                 Served only via short-TTL, user-bound, non-enumerable signed
#                 URLs minted by the BFF. Retention TTL lifecycle (30-90d).
#   voxi-audio  : audio/HLS. The cached-by-item-id assets are GLOBAL-only, so
#                 ONLY this bucket sits behind Cloud CDN. Private/per-user audio
#                 is never placed on the cacheable path.
#
# A third bucket, voxi-csam-quarantine, is the report-preserve-do-not-
# redistribute store (§15/RT-4): locked down, retention-locked, access-logged.

############################################
# voxi-photos — private, redacted, retention TTL, NEVER on the CDN
############################################

resource "google_storage_bucket" "photos" {
  name                        = "${var.project_id}-voxi-photos"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced" # hard block on any public ACL
  labels                      = var.labels

  # Retention TTL (PLAN §11/§15): delete raw/redacted photos past the window
  # unless re-homed to a kept thread (the app moves kept assets out of this TTL
  # prefix; lifecycle here is the backstop).
  lifecycle_rule {
    condition {
      age = var.photos_retention_days
    }
    action {
      type = "Delete"
    }
  }

  versioning {
    enabled = false
  }
}

############################################
# voxi-audio — audio/HLS; the GLOBAL-only path is the ONLY thing behind the CDN
############################################

resource "google_storage_bucket" "audio" {
  name                        = "${var.project_id}-voxi-audio"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = var.labels
}

# Backend bucket fronting ONLY the global audio path. enable_cdn = true. Private
# per-user audio is not stored under this prefix (enforced in the worker/BFF).
resource "google_compute_backend_bucket" "audio_cdn" {
  name        = "voxi-audio-cdn"
  bucket_name = google_storage_bucket.audio.name
  enable_cdn  = true

  cdn_policy {
    cache_mode  = "CACHE_ALL_STATIC"
    default_ttl = var.cdn_default_ttl
    client_ttl  = var.cdn_default_ttl
    max_ttl     = 86400
  }
}

# The CDN reads objects via a dedicated SA, NOT via allUsers public read — the
# bucket stays public_access_prevention=enforced. Grant the backend bucket's
# service identity objectViewer on the global audio prefix only.
resource "google_storage_bucket_iam_member" "audio_cdn_read" {
  bucket = google_storage_bucket.audio.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:service-${data.google_project.this.number}@cloud-cdn-fill.iam.gserviceaccount.com"
}

data "google_project" "this" {
  project_id = var.project_id
}

# Global anycast IP + HTTPS LB fronting the audio CDN backend.
resource "google_compute_global_address" "audio_cdn" {
  name = "voxi-audio-cdn-ip"
}

resource "google_compute_url_map" "audio_cdn" {
  name            = "voxi-audio-cdn-urlmap"
  default_service = google_compute_backend_bucket.audio_cdn.id
}

resource "google_compute_managed_ssl_certificate" "audio_cdn" {
  name = "voxi-audio-cdn-cert"
  managed {
    # Replace with the real CDN hostname before apply; placeholder keeps plan valid.
    domains = ["audio.voxi.example.com"]
  }
}

resource "google_compute_target_https_proxy" "audio_cdn" {
  name             = "voxi-audio-cdn-proxy"
  url_map          = google_compute_url_map.audio_cdn.id
  ssl_certificates = [google_compute_managed_ssl_certificate.audio_cdn.id]
}

resource "google_compute_global_forwarding_rule" "audio_cdn" {
  name       = "voxi-audio-cdn-fr"
  target     = google_compute_target_https_proxy.audio_cdn.id
  ip_address = google_compute_global_address.audio_cdn.id
  port_range = "443"
}

############################################
# voxi-csam-quarantine — §15/RT-4 report-preserve-do-not-redistribute
############################################

resource "google_storage_bucket" "csam_quarantine" {
  name                        = "${var.project_id}-voxi-csam-quarantine"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = merge(var.labels, { sensitivity = "regulated" })

  # 18 U.S.C. 2258A: 90-day preservation, immutable (retention LOCK), routed ONLY
  # to NCMEC out-of-band. No lifecycle delete inside the preservation window.
  retention_policy {
    retention_period = var.csam_preservation_days * 24 * 60 * 60
    is_locked        = true
  }

  logging {
    log_bucket = google_storage_bucket.access_logs.name
  }
}

# Access-log sink bucket for the quarantine store (§15 access logging).
resource "google_storage_bucket" "access_logs" {
  name                        = "${var.project_id}-voxi-access-logs"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = var.labels

  lifecycle_rule {
    condition {
      age = 400
    }
    action {
      type = "Delete"
    }
  }
}
