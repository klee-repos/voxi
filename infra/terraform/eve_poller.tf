# eve_poller.tf — eve workflow POLLER.  [eng-F1 split: the NON-SERVERLESS half]
#
# THIS IS THE CORRECTED TOPOLOGY (PLAN §4.4, GATE G3 — a hard go/no-go).
#
# @workflow/world-postgres "does NOT run on serverless": it needs a LONG-LIVED
# poller holding a LISTEN/NOTIFY loop. Cloud Run *services* are serverless and
# autoscaling, so min-instances=1 is necessary-but-NOT-sufficient (no instance
# pinning; every instance would poll). Therefore the poller runs on a
# NON-serverless runtime, selectable via var.eve_poller_runtime:
#
#   "worker_pool" -> google_cloud_run_v2_worker_pool (manual scaling, NO
#                    request-driven autoscale; the managed non-serverless option)
#   "gce"         -> a single, size-PINNED MIG node (the portable fallback)
#
# Exactly one is created. count guards keep the other at zero. Instance count is
# var.eve_poller_instance_count (default 1 — single poller until G3 confirms
# SELECT ... FOR UPDATE SKIP LOCKED lease semantics for N>1).

############################################
# Option A: Cloud Run Worker Pool (preferred managed non-serverless runtime)
############################################

resource "google_cloud_run_v2_worker_pool" "eve_poller" {
  provider = google-beta
  count    = var.eve_poller_runtime == "worker_pool" ? 1 : 0

  name     = "eve-poller"
  location = var.region
  labels   = var.labels

  # No `ingress` and no request concurrency: a Worker Pool has NO HTTP front and
  # is NOT request-driven. This is precisely why it fits the durable poll loop.

  # MANUAL scaling — pinned instance count, no autoscale. The whole point of the
  # split: scaling_mode defaults to MANUAL, so manual_instance_count fixes the
  # number of poll loops and nothing scales it on traffic.
  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = var.eve_poller_instance_count
  }

  template {
    service_account = google_service_account.eve_poller.email

    # Direct VPC egress (Worker Pools use network_interfaces, not a connector).
    # Reaches the private-IP Cloud SQL and the internal eve front.
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.voxi.id
        subnetwork = google_compute_subnetwork.primary.id
      }
    }

    containers {
      image = local.img_eve_poller

      # ROLE flag selects the poller entrypoint (same image as the front, §4.4).
      env {
        name  = "EVE_ROLE"
        value = "poller"
      }
      # The poller advances runs by HTTP-calling the FRONT's self-callback
      # endpoint (/.well-known/workflow/*). NAME MATCHES the sibling container
      # contract: infra/docker/eve-poller/entrypoint.sh reads EVE_FRONT_URL.
      env {
        name  = "EVE_FRONT_URL"
        value = google_cloud_run_v2_service.eve_front.uri
      }
      # The poller's local liveness probe binds HEALTH_PORT (entrypoint default
      # 8080). Set it explicitly so the runtime + any probe agree.
      env {
        name  = "HEALTH_PORT"
        value = "8080"
      }
      # Lease semantics (PLAN §4.4): >1 poller is only safe with SELECT ... FOR
      # UPDATE SKIP LOCKED. POLLER_CONCURRENCY is read by the entrypoint; we also
      # surface EVE_POLLER_LEASE_MODE as an explicit guard the app can assert on.
      env {
        name  = "POLLER_CONCURRENCY"
        value = tostring(var.eve_poller_instance_count)
      }
      env {
        name  = "EVE_POLLER_LEASE_MODE"
        value = var.eve_poller_instance_count > 1 ? "skip_locked_multi" : "single"
      }

      dynamic "env" {
        for_each = {
          DATABASE_URL     = "database-url-eve" # workflow.* — the poll target
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
          cpu    = var.eve_poller_cpu
          memory = var.eve_poller_memory
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.database_url_eve,
  ]
}

############################################
# Option B: single size-pinned GCE node (portable non-serverless fallback)
############################################

module "eve_poller_gce" {
  source = "./modules/eve-poller-gce"
  count  = var.eve_poller_runtime == "gce" ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  zone                  = var.zone
  network_id            = google_compute_network.voxi.id
  subnetwork_id         = google_compute_subnetwork.primary.id
  service_account_email = google_service_account.eve_poller.email
  image                 = local.img_eve_poller
  machine_type          = var.eve_poller_gce_machine_type
  instance_count        = var.eve_poller_instance_count
  eve_front_base_url    = google_cloud_run_v2_service.eve_front.uri
  database_url_secret   = google_secret_manager_secret.containers["database-url-eve"].secret_id
  labels                = var.labels
}
