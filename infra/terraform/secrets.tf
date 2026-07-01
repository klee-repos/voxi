# secrets.tf — Secret Manager containers + per-workload accessor IAM.
#
# PLAN §11/§12. Terraform creates the EMPTY secret containers and the IAM that
# lets each workload read exactly the secrets it needs. The VALUES (versions)
# are added out-of-band by humans/CI and are NEVER in tfvars/state — EXCEPT the
# two DB URLs, which Terraform legitimately owns because it generated the
# passwords (the version resources live in cloudsql.tf).
#
# Secret list comes from var.secret_ids: Clerk keys, DB URLs, vendor keys.

resource "google_secret_manager_secret" "containers" {
  for_each  = toset(var.secret_ids)
  secret_id = each.value
  labels    = var.labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

############################################
# Least-privilege accessor bindings.
# Each workload reads ONLY the secrets it consumes (matches the env blocks in
# the per-service files).
############################################

locals {
  # workload SA email -> the secret IDs it may read.
  secret_access = {
    (google_service_account.voxi_api.email) = [
      "clerk-jwt-key", "clerk-secret-key", "clerk-publishable-key",
      "database-url-app", "url-signing-key", "appstore-connect-api-key",
      # the BFF mints the voice-bot's per-session scoped token, and authenticates the Cloud Scheduler cron routes.
      "eve-scoped-token-key", "cron-shared-secret",
    ]
    (google_service_account.eve_front.email) = [
      "database-url-eve", "clerk-jwt-key",
      "vertex-ai-key", "cloud-vision-key", "elevenlabs-key", "photodna-key",
      "eve-scoped-token-key",
    ]
    (google_service_account.eve_poller.email) = [
      "database-url-eve", "clerk-jwt-key",
      "vertex-ai-key", "cloud-vision-key", "elevenlabs-key", "photodna-key",
      "eve-scoped-token-key",
    ]
    (google_service_account.podcast_worker.email) = [
      "database-url-app", "elevenlabs-key",
    ]
    # The voice-bot is the realtime media plane (§6.3): STT (Deepgram) + TTS (ElevenLabs) + the per-session
    # scoped-token key it uses to call agent tools THROUGH the BFF (never a broad DB/vendor credential).
    (google_service_account.voice_bot.email) = [
      "deepgram-key", "elevenlabs-key", "eve-scoped-token-key",
    ]
  }

  # Flatten to {sa, secret} pairs for for_each.
  secret_bindings = flatten([
    for sa, secrets in local.secret_access : [
      for s in secrets : { sa = sa, secret = s }
    ]
  ])
}

resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = {
    for b in local.secret_bindings : "${b.sa}:${b.secret}" => b
  }
  secret_id = google_secret_manager_secret.containers[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.sa}"
}
