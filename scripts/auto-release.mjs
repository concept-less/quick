#!/usr/bin/env node
// Runs ONLY inside the serialized release workflow, in its disposable checkout.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, trusted, releaseForSource, nextVersion, requiredAssets, verifyAssets } from './release-policy.mjs';
const env = process.env;
const run = (cmd, args, opts = {}) => (execFileSync(cmd, args, { encoding: 'utf8', ...opts }) ?? '').trim();
const git = (...args) => run('git', args);
const retry = (operation) => {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (attempt === 3) throw error;
      console.warn(`GitHub operation failed; retry ${attempt + 1}/3 in ${2 ** attempt}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 * 2 ** attempt);
    }
  }
};
const gh = (...args) => retry(() => run('gh', [...args, '-R', REPO]));
const output = (key,value) => appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
const runUrl = `https://github.com/${REPO}/actions/runs/${env.GITHUB_RUN_ID}`;
const mode = process.argv[2];
if (mode === 'prepare') {
  if (!trusted({ repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF, event: env.GITHUB_EVENT_NAME, workflowRef: env.GITHUB_WORKFLOW_REF })) throw new Error('untrusted release invocation');
  // Fetch under the workflow lock: coalesce all queued pushes to the current main tip.
  git('fetch', 'origin', 'main', '--tags');
  git('checkout', '--detach', 'origin/main');
  const releases = JSON.parse(retry(() => run('gh', ['api', '--paginate', '--slurp', `repos/${REPO}/releases?per_page=100`]))).flat();
  // A retry of the same Action resumes its original source, even if main advanced.
  const previousRun = releases.find(r => r.body?.includes(`Build: ${runUrl}\n`));
  const pinnedSource = previousRun?.body?.match(/<!-- quick-source:([a-f0-9]{40}) -->/)?.[1];
  if (pinnedSource) git('checkout', '--detach', pinnedSource);
  const source = git('rev-parse', 'HEAD');
  const existing = releaseForSource(releases, source);
  if (existing && !existing.draft) {
    console.log(`Already published ${source}: ${existing.html_url}`);
    output('skip', 'true'); output('tag', existing.tag_name); process.exit(0);
  }
  output('skip', 'false');
  if (existing) {
    if (!/^v\d+\.\d+\.\d+$/.test(existing.tag_name)) throw new Error('bad draft tag');
    output('tag', existing.tag_name);
    console.log(`Resume draft ${existing.tag_name} for ${source}`);
    // The immutable tag was created only after tests + all cloud assets succeeded.
    const metadata = JSON.parse(gh('release', 'view', existing.tag_name, '--json', 'assets'));
    for (const name of requiredAssets(existing.tag_name.slice(1)).filter(n => !/\.dmg$|-mac\.zip$/.test(n))) {
      if (!metadata.assets.some(a => a.name === name)) throw new Error(`draft missing cloud asset ${name}; inspect/delete incomplete draft before retry`);
    }
    process.exit(0);
  }
  run('npm', ['test'], { stdio: 'inherit' }); // failure: no tag, no draft, no installed version change
  const versions = [JSON.parse(readFileSync('package.json')).version, ...git('tag', '--list', 'v*').split('\n')];
  const version = nextVersion(versions, env.RELEASE_BUMP || 'patch');
  const tag = `v${version}`;
  for (const path of ['package.json', 'electron/package.json', 'electron/package-lock.json', 'browser/manifest.json']) {
    const old = readFileSync(path, 'utf8');
    const data = JSON.parse(old); data.version = version;
    if (data.packages?.['']) data.packages[''].version = version;
    writeFileSync(path, JSON.stringify(data, null, /^\{\n\t/.test(old) ? '\t' : 2) + '\n');
  }
  const previous = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
  const changes = git('log', '--no-merges', '--format=- %s', `${previous}..${source}`);
  const notes = `## ${tag}\n\n${changes}\n\nSource SHA: ${source}\nBuild: ${runUrl}\nCloud: quick-release-cloud (dedicated trusted runner)\n\n<!-- quick-source:${source} -->\n`;
  writeFileSync('CHANGELOG.md', `# Changelog\n\n${notes}\n${readFileSync('CHANGELOG.md', 'utf8').replace(/^# Changelog\s*/, '')}`);
  git('config', 'user.name', 'quick-release[bot]'); git('config', 'user.email', 'quick-release@users.noreply.github.com');
  git('add', 'package.json', 'electron/package.json', 'electron/package-lock.json', 'browser/manifest.json', 'CHANGELOG.md');
  // A release-only commit, parent=source main SHA. NEVER push this commit to main:
  // no bump/changelog push to self-trigger, no race with human main pushes.
  git('commit', '-m', `release ${tag}\n\nQuick-Source: ${source}`);
  git('tag', '-a', tag, '-m', `quick-agent ${tag}; source ${source}`);
  mkdirSync('dist/release', { recursive: true });
  run('npm', ['pack', '--silent', '--pack-destination', 'dist/release'], { stdio: 'inherit' });
  run('bash', ['scripts/pack-extension.sh'], { stdio: 'inherit' });
  for (const name of readdirSync('dist').filter(x => x.startsWith(`quick-agent-extension-${version}-`))) run('cp', [`dist/${name}`, `dist/release/${name}`]);
  writeFileSync('dist/release/release.json', JSON.stringify({ version, tag, source, commit: git('rev-parse', 'HEAD'), run: runUrl, cloud: env.RUNNER_NAME, builtAt: new Date().toISOString() }, null, 2) + '\n');
  writeFileSync('dist/release/SHA256SUMS', readdirSync('dist/release').filter(n => n !== 'SHA256SUMS').sort().map(n => run('sha256sum', [n], { cwd: 'dist/release' })).join('\n') + '\n');
  writeFileSync('dist/release-notes.md', notes);
  git('push', 'origin', `refs/tags/${tag}`);
  gh('release', 'create', tag, ...readdirSync('dist/release').map(n => `dist/release/${n}`), '--draft', '--verify-tag', '--title', `quick-agent ${tag}`, '--notes-file', 'dist/release-notes.md');
  output('tag', tag);
  console.log(`Draft ready: ${tag}; source ${source}; ${runUrl}`);
} else if (mode === 'finalize') {
  const tag = env.TAG;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('bad release tag');
  const release = JSON.parse(gh('release', 'view', tag, '--json', 'isDraft,assets,body'));
  if (!release.isDraft) { console.log('Already public; no mutation'); process.exit(0); }
  const version = tag.slice(1);
  const names = release.assets.map(a => a.name);
  verifyAssets(version, names);
  const dir = mkdtempSync(join(tmpdir(), 'quick-release-'));
  try {
    gh('release', 'download', tag, '--dir', dir);
    // Verify core manifest before replacing it with the complete cross-platform manifest.
    run('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: dir, stdio: 'inherit' });
    const meta = JSON.parse(readFileSync(join(dir, 'release.json')));
    if (meta.version !== version || !release.body.includes(`<!-- quick-source:${meta.source} -->`) || meta.commit !== git('rev-parse', 'HEAD')) throw new Error('release provenance mismatch');
    const required = requiredAssets(version);
    writeFileSync(join(dir, 'SHA256SUMS'), required.map(n => run('shasum', ['-a', '256', n], { cwd: dir })).join('\n') + '\n');
    run('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: dir, stdio: 'inherit' });
    gh('release', 'upload', tag, join(dir, 'SHA256SUMS'), '--clobber');
    gh('release', 'edit', tag, '--draft=false', '--latest');
    console.log(`Published https://github.com/${REPO}/releases/tag/${tag}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else throw new Error('expected prepare or finalize');
