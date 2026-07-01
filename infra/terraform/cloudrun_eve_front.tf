# cloudrun_eve_front.tf — eve request FRONT.  [eng-F1 split: the SERVERLESS half]
#
# PLAN §4.4: the eve deployment is SPLIT. This is the stateless HTTP channel /
# streaming front on Cloud Run — it autoscales, holds no durable poll loop, and
# is safe to run at N>1. It does NOT run the @workflow/world-postgres LISTEN/
# NOTIFY loop; that is the POLLER's job (eve_poller.tf), which is NON-serverless.
#
# Self-callback caveat (PLAN §4.4): graphile-worker advances runs by HTTP-calling
# the app's OWN /.well-known/workflow/v1/flow, which has a ~60s route ceiling.
# So this service:
#   (a) serves BOTH /eve/* AND /.well-known/workflow/*  (one container, both
#       route prefixes — handled in the eve-agent app, infra just ensures the
#       container is reachable at a stable base URL);
#   (b) must reach its OWN base URL -> EVE_SELF_BASE_URL is set to this service's
#       URI and egress allows it;
#   (c) request timeout is capped near the 60s ceiling so a turn that tries to
#       run one long opaque step fails loudly instead of silently breaching it
#       (long work -> Cloud Tasks podcast worker, §6.2/D7).

resource "google_cloud_run_v2_service" "eve_front" {
  name     = "eve-front"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY" # only the BFF + self-callback reach it
  labels   = var.labels

  template {
    service_account = google_service_account.eve_front.email

    # eng-F1: FRONT autoscales. Stateless => N>1 is fine (each instance just
    # handles HTTP/streaming; none of them owns the durable poll lease).
    scaling {
      min_instance_count = var.eve_front_min_instances
      max_instance_count = var.eve_front_max_instances
    }

    # Cap below the graphile-worker self-callback route ceiling (~60s). A turn
    # that needs longer must checkpoint or offload (PLAN §4.4(c)).
    max_instance_request_concurrency = 80
    timeout                          = "55s"

    vpc_access {
      connector = google_vpc_access_connector.voxi.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.img_eve_front

      ports {
        container_port = 8080
      }

      # ROLE flag distinguishes this from the poller (same image, §4.4).
      env {
        name  = "EVE_ROLE"
        value = "front"
      }
      # (b) the service must reach its OWN base URL for the self-callback.
      # NAME MATCHES the sibling container contract: infra/docker/eve-front/
      # entrypoint.sh reads EVE_SELF_URL. The eve app should also fall back to
      # its own URL at runtime (K_SERVICE / metadata) if this is unset.
      env {
        name  = "EVE_SELF_URL"
        value = "https://eve-front-${var.region}.run.app"
      }
      # (a) the container serves both prefixes; declared for clarity/health checks.
      env {
        name  = "EVE_ROUTE_PREFIXES"
        value = "/eve/*,/.well-known/workflow/*"
      }
      env {
        name  = "CLERK_JWT_KEY_REQUIRED"
        value = "1" # the eve channel AuthFn verifies the Clerk JWT (§4.2)
      }

      dynamic "env" {
        for_each = {
          DATABASE_URL     = "database-url-eve" # workflow.* connection
          CLERK_JWT_KEY    = "clerk-jwt-key"
          VERTEX_AI_KEY    = "vertex-ai-key"
          CLOUD_VISION_KEY = "cloud-vision-key"
          ELEVENLABS_KEY   = "elevenlabs-key"
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

  depends_on = [
    google_secret_manager_secret_version.database_url_eve,
  ]
}

# Only the BFF SA may invoke the eve front. (The self-callback originates from
# the front's own SA over the internal URL — granted below too.)
resource "google_cloud_run_v2_service_iam_member" "eve_front_caller_bff" {
  name     = google_cloud_run_v2_service.eve_front.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.voxi_api.email}"
}

# (b) self-callback: the front invokes its OWN /.well-known/workflow/* endpoint.
resource "google_cloud_run_v2_service_iam_member" "eve_front_self_callback" {
  name     = google_cloud_run_v2_service.eve_front.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.eve_front.email}"
}

# The poller also drives runs through the same /.well-known/workflow/* surface,
# so it must be allowed to invoke the front (PLAN §4.4).
resource "google_cloud_run_v2_service_iam_member" "eve_front_caller_poller" {
  name     = google_cloud_run_v2_service.eve_front.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.eve_poller.email}"
}
