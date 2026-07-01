# cloudsql.tf — Cloud SQL for PostgreSQL with pgvector.
#
# ONE instance, ONE database (var.db_name) holding BOTH:
#   - the eve workflow.* schema (graphile-worker / @workflow/world-postgres),
#   - the app.* schema (catalog, threads, metering, moderation, csam_report).
# This co-location is deliberate (PLAN §4.4/§11): the eve poller's LISTEN/NOTIFY
# and the app's pgvector catalog share one transactional store.
#
# Migration target: managed AlloyDB (ScaNN) on a MEASURED trigger (p95
# filtered-ANN latency or recall@10 regression, eng-F4). The AlloyDB cluster is
# authored but kept count=0 until that trigger fires — see alloydb.tf.

resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "random_password" "db_eve" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "voxi" {
  name                = "voxi-pg"
  database_version    = var.db_version
  region              = var.region
  deletion_protection = var.db_deletion_protection
  depends_on          = [google_service_networking_connection.psa]

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL" # REGIONAL at scale; ZONAL fits the §11 envelope
    disk_size         = var.db_disk_size_gb
    disk_autoresize   = true
    user_labels       = var.labels

    ip_configuration {
      # Private IP only — the DB is never on a public address. Reached via the
      # VPC connector (Cloud Run) and the VPC directly (poller). eng-F5/§12.
      ipv4_enabled    = false
      private_network = google_compute_network.voxi.id
    }

    # pgvector is enabled per-database via CREATE EXTENSION in the migrations
    # (packages/db/migrations), not a flag here. We DO enable the flags the
    # workflow world relies on for LISTEN/NOTIFY throughput + observability.
    database_flags {
      name  = "max_connections"
      value = "200"
    }
    database_flags {
      name  = "cloudsql.logical_decoding" # safe to keep on for future CDC/export
      value = "on"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  lifecycle {
    # A world-schema migration is the one operation that can corrupt durable
    # eve sessions. PLAN §4.5 mandates a Cloud SQL snapshot BEFORE any such
    # migration; prevent_destroy guards the instance itself.
    prevent_destroy = true
  }
}

resource "google_sql_database" "voxi" {
  name     = var.db_name
  instance = google_sql_database_instance.voxi.name

  # Both schemas live here. Schema-level CREATE SCHEMA workflow / app and the
  # pgvector extension are applied by packages/db migrations at deploy time.
}

resource "google_sql_user" "app" {
  name     = var.db_app_user
  instance = google_sql_database_instance.voxi.name
  password = random_password.db_app.result
}

resource "google_sql_user" "eve" {
  name     = var.db_eve_user
  instance = google_sql_database_instance.voxi.name
  password = random_password.db_eve.result
}

############################################
# Connection strings -> Secret Manager
# Authored here (we have the generated passwords + private IP) but stored ONLY
# in Secret Manager, never in outputs. See secrets.tf for the containers.
############################################

locals {
  db_private_ip = google_sql_database_instance.voxi.private_ip_address

  database_url_app = format(
    "postgresql://%s:%s@%s:5432/%s?schema=app",
    var.db_app_user, random_password.db_app.result, local.db_private_ip, var.db_name
  )
  database_url_eve = format(
    "postgresql://%s:%s@%s:5432/%s?schema=workflow",
    var.db_eve_user, random_password.db_eve.result, local.db_private_ip, var.db_name
  )
}

# Push the generated URLs as secret VERSIONS into the pre-created containers.
# (The empty containers are declared in secrets.tf; here we add the one value
# Terraform legitimately owns because it generated the password.)
resource "google_secret_manager_secret_version" "database_url_app" {
  secret      = google_secret_manager_secret.containers["database-url-app"].id
  secret_data = local.database_url_app
}

resource "google_secret_manager_secret_version" "database_url_eve" {
  secret      = google_secret_manager_secret.containers["database-url-eve"].id
  secret_data = local.database_url_eve
}
