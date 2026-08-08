import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Drizzle Kit 数据库迁移配置文件
 * 作用类似于 Java 生态中的 Flyway，用于自动化管理 PostgreSQL/PostGIS 数据库表结构的版本迁移
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? (() => {
      throw new Error('Drizzle Kit 需要 DATABASE_URL');
    })(),
  },
  verbose: true,
  strict: true,
});
