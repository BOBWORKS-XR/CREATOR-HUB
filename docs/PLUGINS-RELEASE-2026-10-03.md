# Creator Hub 0.1.12: Plugins reliability

- Refresh catalogue metadata before downloads and sending packages to Unity.
- Preserve pending-import status when returning from Unity to the app.
- Revalidate after approval without rejecting unchanged packages due to the cache time limit. Changed or withdrawn listings still require review.
- Unity helper 0.1.3 preserves absent download fields so supplemental listings, including OptiC's Warehouse Loft, are visible.
- Upgrade exact known older helpers with backups. Refuse to overwrite user-modified helpers.

Local shared regressions: 66 Plugins browser tests and 60 native Plugins tests passed. Unity metadata checks loaded all 13 current entries on Unity 2022.3.39f1 and 6000.3.21f1. Both editors also passed a real native package cancel/retry test using a disposable text-asset archive: the cancelled import restored no asset, and the retried import restored the exact bytes with durable receipts. Native wizard actions were automated; this is not physical end-user acceptance or proof of every community package's compatibility.

Release candidates require exact installer, signed catalogue and installed update acceptance before publication. No user projects or live installations are release fixtures.
