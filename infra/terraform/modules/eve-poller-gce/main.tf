# modules/eve-poller-gce — the GCE fallback for the eve workflow POLLER.
#
# PLAN §4.4 names two acceptable NON-serverless runtimes for the poller; this is
# the second: a SIZE-PINNED managed instance group (MIG) of Container-Optimized
# OS nodes, each running the eve poller container with EVE_ROLE=poller.
#
# Why a MIG with a fixed target_size instead of an autoscaler: the poll lease
# must NOT scale with traffic. The group size is pinned to instance_count
# (default 1) so exactly the intended number of LISTEN/NOTIFY loops exist —
# the same invariant the Worker Pool's manual_instance_count gives us.

terraform {
  required_providers {
    google = { source = "hashicorp/google" }
  }
}

variable "project_id" { type = string }
variable "region" { type = string }
variable "zone" { type = string }
variable "network_id" { type = string }
variable "subnetwork_id" { type = string }
variable "service_account_email" { type = string }
variable "image" { type = string }
variable "machine_type" { type = string }
variable "instance_count" { type = number }
variable "eve_front_base_url" { type = string }
variable "database_url_secret" { type = string }
variable "labels" { type = map(string) }

# COS node that boots the poller container. cloud-init pulls DATABASE_URL from
# Secret Manager at boot (the node SA has accessor on the eve secrets).
locals {
  startup_script = templatefile("${path.module}/cloud-init.tpl.sh", {
    image               = var.image
    eve_front_url       = var.eve_front_base_url
    database_url_secret = var.database_url_secret
    project_id          = var.project_id
    poller_concurrency  = var.instance_count
    lease_mode          = var.instance_count > 1 ? "skip_locked_multi" : "single"
  })
}

resource "google_compute_instance_template" "poller" {
  name_prefix  = "eve-poller-"
  machine_type = var.machine_type
  region       = var.region
  labels       = var.labels

  disk {
    source_image = "projects/cos-cloud/global/images/family/cos-stable"
    auto_delete  = true
    boot         = true
    disk_size_gb = 20
  }

  network_interface {
    network    = var.network_id
    subnetwork = var.subnetwork_id
    # No access_config => no external IP; egress via Cloud NAT (defined in root).
  }

  service_account {
    email  = var.service_account_email
    scopes = ["cloud-platform"]
  }

  metadata = {
    user-data                 = local.startup_script
    google-logging-enabled    = "true"
    google-monitoring-enabled = "true"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Health check: the poller container exposes a tiny /healthz reporting that its
# LISTEN/NOTIFY loop holds an active lease. Autohealing replaces a wedged node
# WITHOUT changing the group size (failover, not scale-out) — PLAN §4.4.
resource "google_compute_health_check" "poller" {
  name                = "eve-poller-health"
  check_interval_sec  = 15
  timeout_sec         = 5
  healthy_threshold   = 1
  unhealthy_threshold = 3

  http_health_check {
    # HEALTH_PORT default in infra/docker/eve-poller/entrypoint.sh is 8080.
    port         = 8080
    request_path = "/healthz"
  }
}

resource "google_compute_instance_group_manager" "poller" {
  name               = "eve-poller-mig"
  zone               = var.zone
  base_instance_name = "eve-poller"

  version {
    instance_template = google_compute_instance_template.poller.id
  }

  # SIZE-PINNED. No google_compute_autoscaler is attached on purpose: the number
  # of poll loops is fixed to instance_count, never traffic-driven.
  target_size = var.instance_count

  auto_healing_policies {
    health_check      = google_compute_health_check.poller.id
    initial_delay_sec = 120
  }

  named_port {
    name = "health"
    port = 8080
  }
}

output "mig_self_link" {
  value = google_compute_instance_group_manager.poller.self_link
}

output "target_size" {
  value = google_compute_instance_group_manager.poller.target_size
}
