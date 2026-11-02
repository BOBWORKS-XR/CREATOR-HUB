'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('migration is manual, candidate-bound and runs its regressions before baseline or native work', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-incoming-016.yml'), 'utf8');
  assert.match(workflow, /if: github\.repository == 'BOBWORKS-XR\/CREATOR-HUB' && github\.event_name == 'workflow_dispatch' && \(\(inputs\.mode == 'fresh' \|\| inputs\.mode == 'guarded'\) \|\| inputs\.mode == 'migration' \|\| inputs\.mode == 'incoming'\)/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /Migration admission, fixture and workflow regressions before baseline staging\s+if: inputs\.mode == 'migration'\s+run: node --test --test-concurrency=1 scripts\/native-windows-016-migration\.test\.cjs scripts\/windows-migration-workflow\.test\.cjs/);
  const preflight = workflow.indexOf('Migration admission, fixture and workflow regressions');
  const baseline = workflow.indexOf('Stage three exact original standalone baseline installers');
  const native = workflow.indexOf('Native single-guide cancellation');
  assert.ok(workflow.indexOf('artifact.digest') < preflight);
  assert.ok(workflow.indexOf('inspect-installer $directory') < preflight);
  assert.ok(workflow.indexOf('node scripts/windows-incoming-016.cjs $env:MODE') < preflight);
  assert.ok(preflight < baseline && baseline < native);
  assert.match(workflow, /Get-FileHash -LiteralPath \$target\)\.Hash\.ToLowerInvariant\(\) -cne \$baseline\.sha256/);
  assert.match(workflow, /CREATOR_WINDOWS_016_MIGRATION: '1'/);
  assert.match(workflow, /checkReceipt\(JSON\.parse\(f\.readFileSync\(process\.argv\[1\],'utf8'\)\),process\.argv\[2\]\)/);
  assert.doesNotMatch(workflow, /contents: write|pull_request:|rejectUnauthorized|ignore-certificate/);
});
