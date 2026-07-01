# alloydb.tf — managed AlloyDB (ScaNN) migration target, PLAN §11 / eng-F4.
#
# Cloud SQL + pgvector is the day-one store (cloudsql.tf). AlloyDB is adopted
# ONLY on a MEASURED trigger:
#     p95 filtered-ANN latency > X   OR   recall@10 < Y   at Z rows.
# (Quantified + instrumented from day one — eng-F4.) Until that trigger fires,
# this cluster stays at count = 0 so it costs nothing: flip
# var.enable_alloydb to true to provision it, then run the migration runbook
# in README ("AlloyDB cutover").
#
# Authored now (not later) so the cutover is a variable flip + apply, not a
# scramble — the cost line ($450–700/mo) is opt-in and explicit.

variable "enable_alloydb" {
  description = "Flip true ONLY after the eng-F4 measured trigger fires (PLAN §11)."
  type        = bool
  default     = false
}

variable "alloydb_cpu_count" {
  description = "vCPU per AlloyDB primary node when enabled."
  type        = number
  default     = 4
}

resource "google_alloydb_cluster" "voxi" {
  provider   = google-beta
  count      = var.enable_alloydb ? 1 : 0
  cluster_id = "voxi-alloydb"
  location   = var.region
  network_config {
    network = google_compute_network.voxi.id
  }
  depends_on = [google_service_networking_connection.psa]
}

resource "google_alloydb_instance" "primary" {
  provider      = google-beta
  count         = var.enable_alloydb ? 1 : 0
  cluster       = google_alloydb_cluster.voxi[0].name
  instance_id   = "voxi-alloydb-primary"
  instance_type = "PRIMARY"

  machine_config {
    cpu_count = var.alloydb_cpu_count
  }

  # ScaNN index for filtered ANN over the catalog embeddings is created in SQL
  # post-cutover (CREATE INDEX ... USING scann), not declarable here.
}
