# cloudrun_podcast_worker.tf — voxi-podcast-worker.
#
# PLAN §6.2 / D7: the 5-minute two-host podcast render is OFFLOADED here via a
# Cloud Task (justbash can't run ffmpeg, renders are long, must be idempotent).
# This is exactly the "long work" the eve front must NOT do inline (§4.4(c)).
# Private Cloud Run service; invoked ONLY by Cloud Tasks with an OIDC token.

resource "google_cloud_run_v2_service" "podcast_worker" {
  name     = "voxi-podcast-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  labels   = var.labels

  template {
    service_account = google_service_account.podcast_worker.email

    scaling {
      min_instance_count = 0 # scale to zero between renders
      max_instance_count = 5
    }

    # Renders are long; allow up to the Cloud Run hard ceiling.
    timeout = "3600s"

    vpc_access {
      connector = google_vpc_access_connector.voxi.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.img_podcast_worker

      ports {
        container_port = 8080
      }

      env {
        name  = "GCS_AUDIO_BUCKET"
        value = google_storage_bucket.audio.name
      }

      dynamic "env" {
        for_each = {
          DATABASE_URL   = "database-url-app"
          ELEVENLABS_KEY = "elevenlabs-key" # ONE multi-speaker TTS call (D5)
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
          cpu    = "4" # ffmpeg encode
          memory = "4Gi"
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.database_url_app,
  ]
}

# Only the Cloud Tasks invoker SA may call the worker (OIDC). See cloudtasks.tf
# where the queue's tasks are configured to mint this token.
resource "google_cloud_run_v2_service_iam_member" "podcast_worker_invoker" {
  name     = google_cloud_run_v2_service.podcast_worker.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.tasks_invoker.email}"
}
