const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('qualification cannot use a dispatched branch name as a release tag or build/publish assets', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
  const jobs = [...source.matchAll(/^    if: (.+)$/gm)].map(match => match[1]);
  assert.ok(jobs.length > 0);
  for (const condition of jobs) {
    assert.ok(condition.includes("(github.ref_type == 'tag' && startsWith(github.ref_name, 'v')) || github.event_name == 'workflow_dispatch'"));
    assert.ok(condition.includes("github.repository_id == '1364807512'"));
  }
  assert.match(source, /\$version = \(Get-Content package\.json -Raw \| ConvertFrom-Json\)\.version/);
  assert.match(source, /GITHUB_REF_TYPE -ceq 'tag' -and \$env:GITHUB_REF_NAME -cne "v\$version"/);
  assert.doesNotMatch(source, /GITHUB_REF_NAME\.Substring|gh release (?:create|upload|edit)|tauri-action|npm run build|cargo build/);
});
