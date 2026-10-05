# MinIO demo seed

The controlled demo bucket allowlist is `customer-uploads`, `support-attachments`, `exports`, and `eraseops-backups`. `docker compose up` creates the buckets (`MINIO_DEFAULT_BUCKETS`), and `npm run seed:local` uploads the objects from `infra/fixtures/demo-dataset.json` with `customer-id` and `storage-tier` metadata. Seed objects must be fake data only; production buckets and credentials are not supported.
