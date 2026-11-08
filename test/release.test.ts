import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, chmodSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { trusted, releaseForSource, nextVersion, requiredAssets, verifyAssets } from '../scripts/release-policy.mjs';
const trustedEnv = { repository: 'concept-less/quick', ref: 'refs/heads/main', event: 'push', workflowRef: 'concept-less/quick/.github/workflows/release.yml@refs/heads/main' };
test('cloud trigger gate: only main push/manual in the exact release workflow', () => {
  assert.ok(trusted(trustedEnv));
  assert.ok(trusted({ ...trustedEnv, event: 'workflow_dispatch' }));
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'release', 'schedule']) assert.equal(trusted({ ...trustedEnv, event }), false);
  for (const ref of ['refs/pull/1/merge','refs/heads/feature','refs/tags/v1.0.0']) assert.equal(trusted({ ...trustedEnv, ref }), false);
  assert.equal(trusted({ ...trustedEnv, repository: 'fork/quick' }), false);
  assert.equal(trusted({ ...trustedEnv, workflowRef: 'concept-less/quick/.github/workflows/evil.yml@refs/heads/main' }), false);
});
test('monotonic version reservation counts drafts/tags even when main version is stale', () => {
  assert.equal(nextVersion(['0.4.1','v0.4.3','v0.4.2']), '0.4.4');
  assert.equal(nextVersion(['v0.4.3'], 'minor'), '0.5.0');
  assert.equal(nextVersion(['v0.4.3'], 'major'), '1.0.0');
  assert.equal(nextVersion(['v0.4.3'], '0.5.1'), '0.5.1');
  for (const bad of ['0.4.3','0.4.2','; echo pwn','nightly']) assert.throws(() => nextVersion(['v0.4.3'], bad));
});
test('source SHA lookup is exact and covers published releases and retryable drafts', () => {
  const draft = { body: '<!-- quick-source:abc -->', draft: true };
  assert.equal(releaseForSource([draft], 'abc'), draft);
  assert.equal(releaseForSource([draft], 'ab'), undefined);
  assert.equal(releaseForSource([{ ...draft, prerelease: true }], 'abc'), undefined);
  assert.equal(releaseForSource([{ ...draft, draft: false }], 'abc')?.draft, false);
});
test('publication requires all platforms and manifest', () => {
  const names = [...requiredAssets('1.2.3'), 'SHA256SUMS'];
  verifyAssets('1.2.3', names);
  for (const missing of names) assert.throws(() => verifyAssets('1.2.3', names.filter(n => n !== missing)));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qa-release-test-'));
  const remote = join(root, 'origin.git'), repo = join(root, 'checkout'), bin = join(root, 'bin');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  execFileSync('git', ['init','--bare',remote], { stdio:'ignore' }); mkdirSync(repo); mkdirSync(bin);
  git('init','-b','main'); git('config','user.name','Test'); git('config','user.email','test@example.com'); git('remote','add','origin',remote);
  mkdirSync(join(repo,'scripts'));
  for(const file of ['auto-release.mjs','release-policy.mjs']) cpSync(new URL(`../scripts/${file}`, import.meta.url),join(repo,'scripts',file));
  writeFileSync(join(repo,'package.json'), '{"version":"0.4.1"}');
  git('add','.'); git('commit','-m','source change'); git('push','origin','main');
  const source = git('rev-parse','HEAD');
  const output = join(root,'output'); writeFileSync(output,'');
  function stub(name: string, text: string) { writeFileSync(join(bin,name),`#!/bin/sh\n${text}\n`); chmodSync(join(bin,name),0o755); }
  const env = { ...process.env, PATH:`${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: trustedEnv.repository, GITHUB_REF: trustedEnv.ref, GITHUB_EVENT_NAME: trustedEnv.event, GITHUB_WORKFLOW_REF: trustedEnv.workflowRef, GITHUB_OUTPUT:output, GITHUB_RUN_ID:'123', RUNNER_NAME:'quick-release-cloud' };
  const prepare = () => spawnSync(process.execPath,['scripts/auto-release.mjs','prepare'],{cwd:repo,env,encoding:'utf8'});
  return {root,repo,git,source,output,env,stub,prepare,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('driver test failure leaves no tag, draft or version bump', () => {
  const f=fixture(); try {
    f.stub('gh', 'if [ "$1" = api ]; then echo "[[]]"; else echo "unexpected publication" >&2; exit 99; fi');
    f.stub('npm','echo test-failure >&2; exit 42');
    const result=f.prepare(); assert.notEqual(result.status,0); assert.match(result.stderr,/test-failure/);
    assert.equal(f.git('tag','--list'),''); assert.equal(f.git('rev-parse','HEAD'),f.source);
    assert.equal(JSON.parse(readFileSync(join(f.repo,'package.json'),'utf8')).version,'0.4.1');
  } finally {f.close();}
});
test('driver published SHA retry skips tests, tagging, bump and publication', () => {
  const f=fixture(); try {
    f.stub('gh', `if [ "$1" = api ]; then echo '[[{"body":"<!-- quick-source:${f.source} -->","draft":false,"tag_name":"v0.4.2","html_url":"https://example/release"}]]'; else exit 99; fi`);
    f.stub('npm','exit 99');
    assert.equal(f.prepare().status,0); assert.equal(f.prepare().status,0);
    assert.match(readFileSync(f.output,'utf8'),/skip=true/); assert.equal(f.git('tag','--list'),'');
  } finally {f.close();}
});
test('workflow lock covers auto + manual through final publication, no self-trigger commits', () => {
  const workflow=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.match(workflow,/push:\n    branches: \[main\]/); assert.match(workflow,/workflow_dispatch:/);
  assert.doesNotMatch(workflow,/pull_request|types: \[published\]/);
  assert.match(workflow,/group: quick-release-main/); assert.match(workflow,/cancel-in-progress: false/);
  assert.match(workflow,/runs-on: \[self-hosted, linux, x64, quick-release-cloud\]/);
  assert.match(workflow,/runs-on: macos-latest/); assert.match(workflow,/auto-release.mjs finalize/);
  const driver=readFileSync(new URL('../scripts/auto-release.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(driver,/git\('push', 'origin', 'main'/);
  assert.match(driver,/git\('push', 'origin', `refs\/tags\/\$\{tag\}`\)/);
  const manual=readFileSync(new URL('../scripts/release.sh',import.meta.url),'utf8');
  assert.match(manual,/gh workflow run release.yml/); assert.doesNotMatch(manual,/gh release create|npm publish/);
});

test('driver resumes intact draft without reserving another version', () => {
  const f=fixture(); try {
    const cloudNames=requiredAssets('0.4.2').filter(n=>!n.endsWith('.dmg')&&!n.endsWith('-mac.zip'));
    f.stub('gh', `if [ "$1" = api ]; then echo '[[{"body":"<!-- quick-source:${f.source} -->","draft":true,"tag_name":"v0.4.2"}]]'; else echo '${JSON.stringify({assets:cloudNames.map(name=>({name}))})}'; fi`);
    f.stub('npm','exit 99');
    assert.equal(f.prepare().status,0); assert.match(readFileSync(f.output,'utf8'),/tag=v0.4.2/);
    assert.equal(f.git('tag','--list'),'');
    f.stub('gh', `if [ "$1" = api ]; then echo '[[{"body":"<!-- quick-source:${f.source} -->","draft":true,"tag_name":"v0.4.2"}]]'; else echo '{"assets":[]}'; fi`);
    const bad=f.prepare(); assert.notEqual(bad.status,0); assert.match(bad.stderr,/draft missing cloud asset/);
  } finally {f.close();}
});
test('driver successful cloud build only pushes immutable release tag and creates draft', () => {
  const f=fixture(); try {
    mkdirSync(join(f.repo,'electron')); mkdirSync(join(f.repo,'browser'));
    for(const file of ['electron/package.json','electron/package-lock.json','browser/manifest.json']) writeFileSync(join(f.repo,file),'{"version":"0.4.1"}');
    writeFileSync(join(f.repo,'CHANGELOG.md'),'# Changelog\n');
    writeFileSync(join(f.repo,'scripts/pack-extension.sh'),'mkdir -p dist; touch dist/quick-agent-extension-0.4.2-chrome.zip dist/quick-agent-extension-0.4.2-firefox.zip\n');
    f.git('add','.'); f.git('commit','-m','build fixture'); f.git('tag','v0.4.1'); f.git('push','origin','main','--tags');
    const source=f.git('rev-parse','HEAD');
    f.stub('gh', `if [ "$1" = api ]; then echo '[[]]'; else printf '%s\\n' "$@" > '${f.root}/gh-args'; fi`);
    f.stub('npm','if [ "$1" = test ]; then exit 0; else touch dist/release/quick-agent-0.4.2.tgz; fi');
    const result=f.prepare(); assert.equal(result.status,0,result.stderr);
    assert.equal(f.git('rev-parse','origin/main'),source); // no bump push, no self-trigger
    assert.equal(f.git('rev-parse','v0.4.2^'),source); // annotated tag -> release-only commit's parent
    const meta=JSON.parse(readFileSync(join(f.repo,'dist/release/release.json'),'utf8'));
    assert.equal(meta.source,source); assert.equal(meta.version,'0.4.2');
    assert.match(readFileSync(join(f.root,'gh-args'),'utf8'),/--draft/);
    assert.match(readFileSync(f.output,'utf8'),/tag=v0.4.2/);
    execFileSync('sha256sum',['-c','SHA256SUMS'],{cwd:join(f.repo,'dist/release'),stdio:'ignore'});
    appendFileSync(join(f.repo,'dist/release/quick-agent-0.4.2.tgz'),'tampered');
    assert.throws(()=>execFileSync('sha256sum',['-c','SHA256SUMS'],{cwd:join(f.repo,'dist/release'),stdio:'ignore'}));
  } finally {f.close();}
});

test('finalizer rejects incomplete platform assets without publishing', () => {
  const f=fixture(); try {
    f.stub('gh', 'if [ "$1 $2" = "release view" ]; then echo \'{"isDraft":true,"assets":[],"body":""}\'; else echo "must not publish" >&2; exit 99; fi');
    const result=spawnSync(process.execPath,['scripts/auto-release.mjs','finalize'],{cwd:f.repo,env:{...f.env,TAG:'v0.4.2'},encoding:'utf8'});
    assert.notEqual(result.status,0); assert.match(result.stderr,/incomplete release/); assert.doesNotMatch(result.stderr,/must not publish/);
  } finally {f.close();}
});
