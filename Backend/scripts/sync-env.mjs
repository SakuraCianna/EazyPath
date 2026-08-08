import { readFile, writeFile } from 'node:fs/promises';
import { buildEnvEntries, upsertGradleProperty } from './env-template.mjs';

const envPath = new URL('../.env', import.meta.url);
const examplePath = new URL('../.env.example', import.meta.url);

function parseEnv(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

const current = parseEnv(await readFile(envPath, 'utf8').catch(() => ''));
const entries = buildEnvEntries(current);
const legacyAndroidKey = current.get('AMAP_ANDROID_KEY');
if (legacyAndroidKey) {
  const androidPropertiesPath = new URL('../../App/local.properties', import.meta.url);
  const existingProperties = await readFile(androidPropertiesPath, 'utf8').catch(() => '');
  await writeFile(androidPropertiesPath, upsertGradleProperty(existingProperties, 'AMAP_ANDROID_KEY', legacyAndroidKey), { encoding: 'utf8', mode: 0o600 });
  console.info('已将旧 AMAP_ANDROID_KEY 迁移到被 Git 忽略的 App/local.properties');
}

function render(valueIndex) {
  return `${entries.map(([comment, name, value, example]) => `# ${comment}\n${name}=${valueIndex === 2 ? value : example}`).join('\n\n')}\n`;
}

await writeFile(envPath, render(2), { encoding: 'utf8', mode: 0o600 });
await writeFile(examplePath, render(3), 'utf8');
console.info(`已同步 ${entries.length} 个环境变量, 未输出任何配置值`);
