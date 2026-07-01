# cloudrun_voice_bot.tf — voice-bot realtime media plane (PLAN §6.3, task #22).
#
# The sub-second realtime voice loop (Python/uvicorn, SmallWebRTC signalling). It is the MEDIA plane, not an
# auth surface: the BFF (voxi-api/src/voice-routes.ts) mints a per-session connect URL that points a client
# here AFTER a voiceMin entitlement check, and the voice-bot calls agent tools THROUGH the BFF via a
# per-session SCOPED token (never a broad credential). So it is a PRIVATE Cloud Run service (internal +
# load-balancing ingress only — reachable via the same LB the BFF fronts, never public).
#
# It needs a WARM instance (min=1): WebRTC ICE/handshake latency is user-visible and cold starts break the
# sub-second budget. Higher per-instance concurrency than a request/response service (many media sessions),
# and a long timeout (a conversation is long-lived).

resource "google_cloud_run_v2_service" "voice_bot" {
  name     = "voice-bot"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" # private: only the LB (fronting the BFF) reaches it
  labels   = var.labels

  template {
    service_account = google_service_account.voice_bot.email

    scaling {
      min_instance_count = 1 # keep the ICE/handshake path warm (sub-second budget, §6.3)
      max_instance_count = 10
    }

    # A conversation is long-lived; allow up to the Cloud Run hard ceiling. Many media sessions per instance.
    max_instance_request_concurrency = 20
    timeout                          = "3600s"

    vpc_access {
      connector = google_vpc_access_connector.voxi.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.img_voice_bot

      ports {
        container_port = 7071 # uvicorn (voice_server.py)
      }

      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }
      # The voice-bot reaches the BFF (the only auth surface) for the scoped-token tool bridge + transcript
      # writeback. The concrete URL is injected at deploy time (deploy.sh resolves the voxi-api URL).
      env {
        name  = "BFF_INTERNAL_URL"
        value = "https://voxi-api-${var.region}.run.app"
      }

      dynamic "env" {
        for_each = {
          DEEPGRAM_API_KEY     = "deepgram-key"         # STT (§6.3)
          ELEVENLABS_API_KEY   = "elevenlabs-key"       # Voxi TTS voice (D5)
          EVE_SCOPED_TOKEN_KEY = "eve-scoped-token-key" # per-session scoped token to call agent tools via the BFF
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
          cpu    = "2"
          memory = "2Gi"
        }
      }
    }
  }

  depends_on = [google_secret_manager_secret.containers]
}

# Only the BFF SA may invoke the voice-bot (the BFF mints the per-session connect URL after the entitlement
# check; the media plane is never reached directly by a client without that BFF-minted, scoped grant).
resource "google_cloud_run_v2_service_iam_member" "voice_bot_caller_bff" {
  name     = google_cloud_run_v2_service.voice_bot.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.voxi_api.email}"
}
