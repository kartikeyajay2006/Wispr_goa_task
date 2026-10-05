// Loads infra/fixtures/demo-dataset.json into the docker-compose PostgreSQL and MinIO services.
// Usage: docker compose up -d && npm run seed:local
import {Pool} from 'pg';
import {loadConfig, loadEnvFile} from '../apps/api/src/config.js';
import {loadDatasetFixture} from '../packages/connectors/src/dataset.js';
import {MinioHttpObjectClient} from '../packages/connectors/src/s3-client.js';
import {seedLocalSystems} from '../packages/connectors/src/local-seed.js';

async function main() {
  loadEnvFile();
  const config = loadConfig(process.env);
  const pool = new Pool({connectionString: config.databaseUrl});
  try {
    const result = await seedLocalSystems(pool, new MinioHttpObjectClient(config.minio), loadDatasetFixture(config.datasetFile));
    console.log(`Seeded ${result.rows} PostgreSQL rows and ${result.objects} MinIO objects from the demo fixture.`);
  } catch (error) {
    console.error(`Seeding failed: ${error instanceof Error ? error.message : error}`);
    console.error('Is `docker compose up -d` running, and do DATABASE_URL / MINIO_* match docker-compose.yml?');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
