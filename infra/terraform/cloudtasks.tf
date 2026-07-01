# cloudtasks.tf — the async podcast-render queue.
#
# PLAN §6.2 / D7: eve enqueues a render here (enqueue_podcast tool); Cloud Tasks
# delivers it to voxi-podcast-worker with an OIDC token. Retries are bounded and
# the worker is idempotent (verified by metering idempotency tests, eng-F6/F8).
# This is the offload path that keeps eve turns under the ~60s self-callback
# ceiling (§4.4(c)).

resource "google_cloud_tasks_queue" "podcast" {
  name     = "voxi-podcast-render"
  location = var.region

  rate_limits {
    max_dispatches_per_second = var.podcast_queue_max_dispatches_per_second
    max_concurrent_dispatches = var.podcast_queue_max_concurrent_dispatches
  }

  retry_config {
    max_attempts       = var.podcast_queue_max_attempts
    min_backoff        = "5s"
    max_backoff        = "300s"
    max_doublings      = 5
    max_retry_duration = "3600s"
  }

  depends_on = [google_project_service.enabled]
}

# Allow the enqueuers (BFF + eve front/poller) to create tasks on the queue.
resource "google_cloud_tasks_queue_iam_member" "enqueue_bff" {
  name     = google_cloud_tasks_queue.podcast.name
  location = var.region
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.voxi_api.email}"
}

resource "google_cloud_tasks_queue_iam_member" "enqueue_eve_front" {
  name     = google_cloud_tasks_queue.podcast.name
  location = var.region
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.eve_front.email}"
}

resource "google_cloud_tasks_queue_iam_member" "enqueue_eve_poller" {
  name     = google_cloud_tasks_queue.podcast.name
  location = var.region
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.eve_poller.email}"
}

# The enqueuers must also be able to actAs the tasks_invoker SA when they set
# the OIDC token on a task (so the worker can verify the caller).
resource "google_service_account_iam_member" "bff_actas_tasks_invoker" {
  service_account_id = google_service_account.tasks_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.voxi_api.email}"
}

resource "google_service_account_iam_member" "eve_front_actas_tasks_invoker" {
  service_account_id = google_service_account.tasks_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.eve_front.email}"
}

resource "google_service_account_iam_member" "eve_poller_actas_tasks_invoker" {
  service_account_id = google_service_account.tasks_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.eve_poller.email}"
}
