# outputs.tf — handles other tooling/CI needs. NO SECRETS leave here.

output "voxi_api_url" {
  description = "Public BFF URL (the only public surface)."
  value       = google_cloud_run_v2_service.voxi_api.uri
}

output "eve_front_url" {
  description = "Internal eve request FRONT URL (BFF + self-callback only)."
  value       = google_cloud_run_v2_service.eve_front.uri
}

output "eve_poller_runtime" {
  description = "Which NON-serverless runtime hosts the poller (eng-F1 split)."
  value       = var.eve_poller_runtime
}

output "eve_poller_worker_pool" {
  description = "Worker Pool poller (null if runtime=gce)."
  value = var.eve_poller_runtime == "worker_pool" ? {
    name           = google_cloud_run_v2_worker_pool.eve_poller[0].name
    instance_count = var.eve_poller_instance_count
    scaling        = "manual (non-serverless, no request-driven autoscale)"
  } : null
}

output "eve_poller_gce" {
  description = "GCE MIG poller (null if runtime=worker_pool)."
  value = var.eve_poller_runtime == "gce" ? {
    mig_self_link = module.eve_poller_gce[0].mig_self_link
    target_size   = module.eve_poller_gce[0].target_size
    scaling       = "size-pinned MIG (non-serverless, no autoscaler attached)"
  } : null
}

output "podcast_worker_url" {
  description = "Internal podcast render worker URL (Cloud Tasks invokes it)."
  value       = google_cloud_run_v2_service.podcast_worker.uri
}

output "sql_instance_connection_name" {
  description = "Cloud SQL connection name (project:region:instance)."
  value       = google_sql_database_instance.voxi.connection_name
}

output "sql_private_ip" {
  description = "Cloud SQL private IP (in-VPC only)."
  value       = google_sql_database_instance.voxi.private_ip_address
}

output "db_name" {
  description = "The single DB holding workflow.* + app.*."
  value       = google_sql_database.voxi.name
}

output "photos_bucket" {
  description = "Private redacted-photos bucket (never on the CDN)."
  value       = google_storage_bucket.photos.name
}

output "audio_bucket" {
  description = "Audio/HLS bucket (global path fronted by Cloud CDN)."
  value       = google_storage_bucket.audio.name
}

output "audio_cdn_ip" {
  description = "Cloud CDN global anycast IP for the global-only audio path."
  value       = google_compute_global_address.audio_cdn.address
}

output "csam_quarantine_bucket" {
  description = "Retention-locked CSAM quarantine bucket (§15/RT-4)."
  value       = google_storage_bucket.csam_quarantine.name
}

output "podcast_queue_id" {
  description = "Cloud Tasks queue for async podcast renders."
  value       = google_cloud_tasks_queue.podcast.id
}

output "vpc_connector_id" {
  description = "Serverless VPC Access connector (Cloud Run -> VPC/private DB)."
  value       = google_vpc_access_connector.voxi.id
}

output "secret_ids" {
  description = "Created (empty) Secret Manager containers; add versions out-of-band."
  value       = [for s in google_secret_manager_secret.containers : s.secret_id]
}

output "service_accounts" {
  description = "Per-workload service accounts (least privilege)."
  value = {
    voxi_api       = google_service_account.voxi_api.email
    eve_front      = google_service_account.eve_front.email
    eve_poller     = google_service_account.eve_poller.email
    podcast_worker = google_service_account.podcast_worker.email
    tasks_invoker  = google_service_account.tasks_invoker.email
  }
}
