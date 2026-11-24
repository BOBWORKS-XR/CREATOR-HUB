'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const feed = require('./check-release-feed.cjs');
const signatures = require('./windows-020-release-qualification.cjs');
const product = '1598962f4edefd1831e973b0b069bcd8b725df93', sourceTree = '8363e87e58a03bc91d8ea660d9c444fd27d5eddb';
const tag = 'v0.1.27', id = 457371653, repo = 'BOBWORKS-XR/CREATOR-HUB';
const assets = {
  "Creator.Hub_0.1.27_x64-setup.exe": {
    "id": 788972386,
    "bytes": 38744117,
    "sha256": "3ef9ce5cc25a00e59b466dee216a8c7d20d63c5c981796f2e2318380af6d37b0"
  },
  "creator-hub-windows-x86_64.json": {
    "id": 788973501,
    "bytes": 505,
    "sha256": "0b080b7de2e1548962fa62efbc86fe4a39a708e05173633f4f35894d1dfb637f"
  },
  "creator-hub-windows-x86_64.json.minisig": {
    "id": 788973584,
    "bytes": 316,
    "sha256": "31d3f46e983c1b7c56fa6d3d7c4c0657580835043b4987ee8bbbde2f27d36e07"
  },
  "latest.json": {
    "id": 788973724,
    "bytes": 816,
    "sha256": "40944ded7690d5f57796177da517eb18ddb102b79bb06d7b7d472421eddc6ada"
  }
};
const files = ['.github/workflows/release.yml','scripts/verify-027-draft.cjs'];
const run = (exe, args) => execFileSync(exe, args, {windowsHide:true,timeout:90000,maxBuffer:50*1024*1024});
const git = args => run('git',args).toString().trim();
const get = route => JSON.parse(run('gh',['api','repos/'+repo+'/'+route]));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function main(){
  const head = git(['rev-parse','HEAD']);
  assert.equal(process.env.GITHUB_REPOSITORY,repo); assert.equal(process.env.GITHUB_REF,'refs/tags/'+tag);
  assert.equal(process.env.GITHUB_SHA,head); assert.equal(git(['show','-s','--format=%P',head]),product);
  assert.equal(git(['rev-parse',product+'^{tree}']),sourceTree);
  assert.deepEqual(git(['diff','--name-only',product,head]).split(/\r?\n/).sort(),files);
  assert.equal(get('git/ref/tags/'+tag).object.sha,head);
  const old = get('releases/latest'); assert.equal(old.id,449231020); assert.equal(old.tag_name,'v0.1.26');
  const release=get('releases/'+id);
  assert.equal(release.tag_name,tag); assert.equal(release.draft,true); assert.equal(release.prerelease,true);
  assert.equal(release.target_commitish,product);
  assert.deepEqual(release.assets.map(a=>a.name).sort(),Object.keys(assets).sort());
  const bytes={};
  for(const a of release.assets){
    const pin=assets[a.name]; assert.equal(a.id,pin.id); assert.equal(a.state,'uploaded'); assert.equal(a.size,pin.bytes);
    assert.equal(a.digest,'sha256:'+pin.sha256);
    bytes[a.name]=run('gh',['api','repos/'+repo+'/releases/assets/'+a.id,'-H','Accept: application/octet-stream']);
    assert.equal(bytes[a.name].length,pin.bytes); assert.equal(hash(bytes[a.name]),pin.sha256);
  }
  const d='creator-hub-windows-x86_64.json',desc=JSON.parse(bytes[d]),l=JSON.parse(bytes['latest.json']);
  assert.equal(desc.version,'0.1.27'); assert.equal(desc.executableSha256,'6233f80b86b70ca8e965e81724a2ff3f7daf8aaaef58d6a06fad528f30715ccb');
  const key=signatures.publicKey(path.resolve(__dirname,'..'));
  signatures.verifySignature(bytes[d],bytes[d+'.minisig'],key);
  signatures.verifySignature(bytes[desc.assetName],Buffer.from(l.platforms['windows-x86_64'].signature,'base64'),key);
  assert.equal(get('actions/runs/45388392157').head_sha,'efb61deaab07eb350dd0c4a4298390a692c5d477');
  const jobs=get('actions/runs/45388392157/jobs?per_page=100').jobs;
  assert.deepEqual(jobs.map(j=>j.id).sort(),[138425278680,138425630442,138425630497,138425630516,138425630551,138425630660].sort());
  assert.ok(jobs.every(j=>j.conclusion==='success'));
  const budget=await feed.checkDraft('0.1.27');assert.equal(budget.previousStable,'0.1.26');
  console.log(JSON.stringify({draft:id,association:head,product,verifiedAssets:4,installerRebuilt:false,budget}));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
