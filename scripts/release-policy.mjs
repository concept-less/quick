// Pure release policy; shared by the driver and tests.
export const REPO = 'concept-less/quick';
export function trusted({ repository, ref, event, workflowRef }) {
  return repository === REPO && ref === 'refs/heads/main'
    && ['push', 'workflow_dispatch'].includes(event)
    && workflowRef === `${REPO}/.github/workflows/release.yml@refs/heads/main`;
}
export function releaseForSource(releases, sha) {
  return releases.find(r => !r.prerelease && r.body?.includes(`<!-- quick-source:${sha} -->`));
}
export function nextVersion(versions, bump = 'patch') {
  const all = versions.map(v => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v)).filter(Boolean)
    .map(m => m.slice(1).map(Number)).sort((a,b) => b[0]-a[0] || b[1]-a[1] || b[2]-a[2]);
  const [a,b,c] = all[0] ?? [0,0,0];
  const v = bump === 'major' ? `${a+1}.0.0` : bump === 'minor' ? `${a}.${b+1}.0` : bump === 'patch' ? `${a}.${b}.${c+1}` : bump.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v) || all.some(x => compare(x, v.split('.').map(Number)) >= 0)) throw new Error('version must exceed all reserved tags');
  return v;
}
function compare(a,b) { return a[0]-b[0] || a[1]-b[1] || a[2]-b[2]; }
export function requiredAssets(version) {
  return [`quick-agent-${version}.tgz`, ...['chrome','firefox'].map(x => `quick-agent-extension-${version}-${x}.zip`),
    `quick-agent-${version}-arm64.dmg`, `quick-agent-${version}-arm64-mac.zip`, 'release.json'];
}
export function verifyAssets(version, names) {
  const missing = [...requiredAssets(version), 'SHA256SUMS'].filter(x => !names.includes(x));
  if (missing.length) throw new Error(`incomplete release: ${missing.join(', ')}`);
}
