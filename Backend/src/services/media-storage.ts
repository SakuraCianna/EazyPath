import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getEnv, parseKeyring } from '../config/env.js';
import { hmacSha256 } from '../lib/crypto.js';

export const MEDIA_PART_BYTES = 1024 * 1024;
export const MEDIA_MAX_PARTS = 10;

export interface StoredEvidenceFile {
  storagePath: string;
  mimeType: string;
  byteSize: number;
  fingerprintHmac: string;
  fingerprintKeyVersion: string;
}

export async function prepareMediaDirectories(): Promise<void> {
  const env = getEnv();
  await Promise.all([
    mkdir(env.MEDIA_TEMP_DIR, { recursive: true }),
    mkdir(env.MEDIA_UPLOAD_STAGING_DIR, { recursive: true }),
    mkdir(env.MEDIA_EVIDENCE_DIR, { recursive: true }),
  ]);
  // AI 临时图不可恢复，进程启动前清空残留，满足用完即删。
  const entries = await readdir(env.MEDIA_TEMP_DIR, { withFileTypes: true });
  await Promise.all(entries.map((entry) => rm(path.join(env.MEDIA_TEMP_DIR, entry.name), { recursive: true, force: true })));
}

export async function saveTemporaryVerificationImage(file: File): Promise<string> {
  const env = getEnv();
  if (file.size <= 0 || file.size > env.MEDIA_MAX_IMAGE_BYTES) throw new Error('IMAGE_SIZE_INVALID');
  const bytes = Buffer.from(await file.arrayBuffer());
  detectImageMime(bytes);
  const target = path.join(path.resolve(env.MEDIA_TEMP_DIR), `${crypto.randomUUID()}.upload`);
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  return target;
}

export function uploadDirectory(uploadId: string): string {
  const root = path.resolve(getEnv().MEDIA_UPLOAD_STAGING_DIR);
  const target = path.resolve(root, uploadId);
  if (path.dirname(target) !== root) throw new Error('INVALID_UPLOAD_PATH');
  return target;
}

export async function writeUploadPart(
  uploadId: string,
  partNumber: number,
  bytes: Buffer,
): Promise<{ path: string; sha256: string }> {
  if (bytes.length <= 0 || bytes.length > MEDIA_PART_BYTES) throw new Error('PART_SIZE_INVALID');
  const directory = uploadDirectory(uploadId);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${partNumber}.part`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(target, bytes, { mode: 0o600 });
  return { path: target, sha256: digest };
}

export async function assembleEvidenceFile(
  uploadId: string,
  partPaths: string[],
  expectedSha256: string,
): Promise<StoredEvidenceFile> {
  const env = getEnv();
  const buffers = await Promise.all(partPaths.map((partPath) => readFile(partPath)));
  const file = Buffer.concat(buffers);
  if (file.length > env.MEDIA_MAX_IMAGE_BYTES) throw new Error('IMAGE_SIZE_INVALID');
  const actualSha256 = createHash('sha256').update(file).digest('hex');
  if (actualSha256 !== expectedSha256.toLowerCase()) throw new Error('WHOLE_HASH_MISMATCH');
  const mimeType = detectImageMime(file);
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : 'webp';
  const root = path.resolve(env.MEDIA_EVIDENCE_DIR);
  const finalPath = path.join(root, `${crypto.randomUUID()}.${extension}`);
  const partialPath = `${finalPath}.partial`;
  await writeFile(partialPath, file, { flag: 'wx', mode: 0o600 });
  await rename(partialPath, finalPath);

  const keyring = parseKeyring(env.MEDIA_FINGERPRINT_KEYRING);
  const key = keyring.get(env.MEDIA_FINGERPRINT_KEY_CURRENT_VERSION);
  if (!key) throw new Error('MEDIA_FINGERPRINT_KEY_MISSING');
  return {
    storagePath: finalPath,
    mimeType,
    byteSize: file.length,
    fingerprintHmac: hmacSha256(file, key),
    fingerprintKeyVersion: env.MEDIA_FINGERPRINT_KEY_CURRENT_VERSION,
  };
}

export async function removeUploadDirectory(uploadId: string): Promise<void> {
  await rm(uploadDirectory(uploadId), { recursive: true, force: true });
}

export async function removeEvidenceFile(storagePath: string): Promise<void> {
  const root = path.resolve(getEnv().MEDIA_EVIDENCE_DIR);
  const target = path.resolve(storagePath);
  if (path.dirname(target) !== root) throw new Error('INVALID_EVIDENCE_PATH');
  await rm(target, { force: true });
}

export async function readEvidenceFile(storagePath: string): Promise<Buffer> {
  const root = await realpath(path.resolve(getEnv().MEDIA_EVIDENCE_DIR));
  const target = await realpath(path.resolve(storagePath));
  if (path.dirname(target) !== root) throw new Error('INVALID_EVIDENCE_PATH');
  return readFile(target);
}

export async function mediaDiskUsageBytes(): Promise<number> {
  const root = path.resolve(getEnv().MEDIA_EVIDENCE_DIR);
  const entries = await readdir(root, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    total += (await stat(path.join(root, entry.name))).size;
  }
  return total;
}

function detectImageMime(file: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (file.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (file.subarray(0, 4).toString('ascii') === 'RIFF' && file.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('UNSUPPORTED_IMAGE_TYPE');
}
