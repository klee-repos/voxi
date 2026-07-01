# cloudrun_voxi_api.tf — the voxi-api BFF.
#
# THE ONLY PUBLIC SURFACE (PLAN §3). Verifies the Clerk JWT networkless, signs
# short-TTL user-bound URLs (eng-F5), enforces metering/entitlements + per-user
# ACL, and proxies session create/stream to the eve FRONT (never to the poller,
# never to the DB directly for eve work).

resource "google_cloud_run_v2_service" "voxi_api" {
  name     = "voxi-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL" # public — this is intentional and unique
  labels   = var.labels

  template {
    service_account = google_service_account.voxi_api.email

    scaling {
      min_instance_count = 1 # keep one warm: it's the front door
      max_instance_count = 50
    }

    vpc_access {
      connector = google_vpc_access_connector.voxi.id
      egress    = "PRIVATE_RANGES_ONLY" # reach private DB + internal eve front
    }

    containers {
      image = local.img_voxi_api

      ports {
        container_port = 8080
      }

      env {
        name  = "EVE_FRONT_URL"
        value = google_cloud_run_v2_service.eve_front.uri
      }
      env {
        name  = "PODCAST_QUEUE"
        value = google_cloud_tasks_queue.podcast.id
      }
      env {
        # NAME MATCHES the sibling BFF: infra/docker/voxi-api/server.ts reads
        # GCS_PHOTO_BUCKET.
        name  = "GCS_PHOTO_BUCKET"
        value = google_storage_bucket.photos.name
      }
      env {
        name  = "GCS_AUDIO_BUCKET"
        value = google_storage_bucket.audio.name
      }
      env {
        name  = "CDN_AUDIO_HOST"
        value = google_compute_global_address.audio_cdn.address
      }
      env {
        name  = "TASKS_INVOKER_SA"
        value = google_service_account.tasks_invoker.email
      }

      # Secrets: mounted as env from Secret Manager (latest version). Names match
      # the code: voxi-api/src/auth.ts uses CLERK_JWT_KEY; signing.ts uses
      # VOXI_URL_SIGNING_KEY.
      dynamic "env" {
        for_each = {
          CLERK_JWT_KEY        = "clerk-jwt-key"
          CLERK_SECRET_KEY     = "clerk-secret-key"
          DATABASE_URL         = "database-url-app"
          VOXI_URL_SIGNING_KEY = "url-signing-key"
          APPSTORE_CONNECT_KEY = "appstore-connect-api-key"
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.containers[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.database_url_app,
  ]
}

# Public invocation: allUsers may invoke the BFF (and ONLY the BFF). Every other
# service is private and reachable only by its named caller.
resource "google_cloud_run_v2_service_iam_member" "voxi_api_public" {
  name     = google_cloud_run_v2_service.voxi_api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
