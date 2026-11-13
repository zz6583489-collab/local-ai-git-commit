import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const action = process.argv[2];
const tag = process.env.GITHUB_REF_NAME;
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8'));

if (!['check', 'bundle'].includes(action)) {
  throw new Error('Expected check or bundle action.');
}
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag ?? '')) {
  throw new Error('Release tag must use vX.Y.Z format.');
}
if (tag !== `v${version}`) {
  throw new Error(`Tag ${tag} does not match package.json version ${version}.`);
}
if (lockfile.version !== version || lockfile.packages?.['']?.version !== version) {
  throw new Error(`package-lock.json does not match package.json version ${version}.`);
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const section = changelog
  .split(/\r?\n(?=## )/)
  .find((part) => part.split(/\r?\n/, 1)[0] === `## ${version}`);
const notes = section?.slice(section.indexOf('\n') + 1).trim();

if (!notes) {
  throw new Error(`CHANGELOG.md is missing notes for ${version}.`);
}

if (action === 'bundle') {
  if (!process.env.RUNNER_TEMP) {
    throw new Error('RUNNER_TEMP is required to bundle release assets.');
  }
  const releaseDir = join(process.env.RUNNER_TEMP, 'release');
  mkdirSync(releaseDir, { recursive: true });

  const vsixName = `ai-git-commit-${version}.vsix`;
  const vsix = readFileSync(vsixName);
  copyFileSync(vsixName, join(releaseDir, vsixName));
  writeFileSync(
    join(releaseDir, `${vsixName}.sha256`),
    `${createHash('sha256').update(vsix).digest('hex')}  ${vsixName}\n`,
  );
  writeFileSync(join(releaseDir, 'release-notes.md'), `${notes}\n`);
}

console.log(`Release ${tag} ${action} complete.`);
