import pkg from 'pg';
const { Client } = pkg;

const connectionString = "postgresql://neondb_owner:npg_vIwXikTUCP46@ep-blue-pine-a2jdjcnr-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  const res = await client.query("SELECT schema_name FROM information_schema.schemata;");
  console.log("Schemas found on server:", res.rows.map(r => r.schema_name));
  await client.end();
}

main().catch(console.error);
