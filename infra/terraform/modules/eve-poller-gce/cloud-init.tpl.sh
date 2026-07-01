#cloud-config
# cloud-init for the GCE eve-poller node (Container-Optimized OS).
# Boots ONE eve poller container (EVE_ROLE=poller) that runs the
# @workflow/world-postgres LISTEN/NOTIFY loop. DATABASE_URL is fetched from
# Secret Manager at boot using the node's service-account identity — it is never
# baked into the image or the template metadata.

write_files:
  - path: /etc/systemd/system/eve-poller.service
    permissions: "0644"
    content: |
      [Unit]
      Description=eve workflow poller (NON-serverless, PLAN 4.4)
      After=network-online.target
      Wants=network-online.target

      [Service]
      Environment=IMAGE=${image}
      Environment=EVE_FRONT_URL=${eve_front_url}
      Environment=POLLER_CONCURRENCY=${poller_concurrency}
      Environment=EVE_POLLER_LEASE_MODE=${lease_mode}
      Environment=DB_SECRET=${database_url_secret}
      Environment=GCP_PROJECT=${project_id}
      ExecStartPre=/usr/bin/docker-credential-gcr configure-docker
      ExecStartPre=/usr/bin/docker pull $${IMAGE}
      # Pull the DB URL from Secret Manager via the metadata-server token.
      ExecStart=/bin/bash -c '\
        TOKEN=$$(curl -s -H "Metadata-Flavor: Google" \
          "http://metadata/computeMetadata/v1/instance/service-accounts/default/token" \
          | sed -n "s/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p"); \
        DBURL=$$(curl -s -H "Authorization: Bearer $$TOKEN" \
          "https://secretmanager.googleapis.com/v1/projects/$${GCP_PROJECT}/secrets/$${DB_SECRET}/versions/latest:access" \
          | sed -n "s/.*\"data\":\"\\([^\"]*\\)\".*/\\1/p" | base64 -d); \
        exec /usr/bin/docker run --rm --name eve-poller \
          -p 8080:8080 \
          -e EVE_ROLE=poller \
          -e HEALTH_PORT=8080 \
          -e EVE_FRONT_URL=$${EVE_FRONT_URL} \
          -e POLLER_CONCURRENCY=$${POLLER_CONCURRENCY} \
          -e EVE_POLLER_LEASE_MODE=$${EVE_POLLER_LEASE_MODE} \
          -e DATABASE_URL=$$DBURL \
          $${IMAGE}'
      Restart=always
      RestartSec=5

      [Install]
      WantedBy=multi-user.target

runcmd:
  - systemctl daemon-reload
  - systemctl start eve-poller.service
