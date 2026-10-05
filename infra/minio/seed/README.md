# MinIO demo seed

The controlled demo bucket allowlist is `customer-uploads`, `support-attachments`, `exports`, and `eraseops-backups`. `docker compose up` runs the `minio-init` one-shot service and creates fake CUST-1042 objects. Seed objects must be fake data only; production buckets and credentials are not supported.
