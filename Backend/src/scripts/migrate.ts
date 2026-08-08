import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, queryClient } from '../db/index.js';

async function main(): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.info('数据库迁移完成');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '数据库迁移失败');
    process.exitCode = 1;
  })
  .finally(() => queryClient.end());
