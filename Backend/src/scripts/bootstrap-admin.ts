import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { getEnv } from '../config/env.js';
import { adminRoles, adminUsers, db, queryClient } from '../db/index.js';

async function main(): Promise<void> {
  const env = getEnv();
  if (!env.ADMIN_BOOTSTRAP_USERNAME) throw new Error('缺少 ADMIN_BOOTSTRAP_USERNAME');
  const [existing] = await db.select().from(adminUsers).where(eq(adminUsers.username, env.ADMIN_BOOTSTRAP_USERNAME)).limit(1);
  if (existing) {
    console.info('管理员引导已完成，无需重复创建');
    return;
  }
  const password = env.ADMIN_BOOTSTRAP_PASSWORD_FILE
    ? (await readFile(env.ADMIN_BOOTSTRAP_PASSWORD_FILE, 'utf8')).trim()
    : env.ADMIN_BOOTSTRAP_PASSWORD;
  const minimumLength = env.APP_ENV === 'development' && !env.ADMIN_BOOTSTRAP_PASSWORD_FILE ? 6 : 12;
  if (!password || password.length < minimumLength) {
    throw new Error(`管理员引导密码至少 ${minimumLength} 个字符`);
  }
  const [role] = await db.insert(adminRoles).values({ code: 'super_admin', name: '超级管理员', permissions: ['*'] }).onConflictDoUpdate({ target: adminRoles.code, set: { name: '超级管理员', permissions: ['*'] } }).returning();
  if (!role) throw new Error('无法创建管理员角色');
  await db.insert(adminUsers).values({
    username: env.ADMIN_BOOTSTRAP_USERNAME,
    passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 }),
    roleId: role.id,
  });
  console.info('首个管理员创建完成');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '管理员引导失败');
    process.exitCode = 1;
  })
  .finally(() => queryClient.end());
