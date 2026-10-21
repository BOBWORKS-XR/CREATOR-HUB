"""Closed same-session updater continuation; never a standalone application runner.

Outer contract: stage the frozen launcher with the existing pure
Node validators, seal launcher_contract() as review.flatpakLauncher, copy its
sources to inputs/flatpak-source, and bind EXTRA_SOURCES in request.sources.
Merge retention_fixture() into the original single seed before fingerprinting.
Provision the exact read-only observer authorization before the GUI session;
install the private launcher in that same session before the first Hub launch.
After the real signed update/successor/normal close:

    handoff = admit(updater_module, env, before, update_report)
    report['flatpakContinuation'] = after_update(handoff, inspect_pages)

inspect_pages(record, x11, evidence_dir) is a function in the bound updater
source. It must run Surface/version17/direct_pages/bitmap checks, close only its
owned AX connection, and return the exact page proof checked below. It borrows
the supplied X11 connection. The original updater X11 object must outlive this
continuation. No observer or borrowed GIO/WM/MCP owner is replaced or reset.
After return the outer updater still performs its original preservation,
MCP after-hub-close/reconnect/EOF, outcome and TLS cleanup protocol. This module
cannot declare that protocol, combined acceptance or a public release passed.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time
from types import ModuleType

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('update_flatpak_controller', HERE / 'native-linux-production-016-flatpak.py')
F = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(F)
require = F.require
BASE = Path('/opt/creator-polkit-fixture')
ROOT, HOME = BASE / 'result', BASE / 'result/home'
EVIDENCE, LAUNCHER_SOURCE = ROOT / 'flatpak-evidence', BASE / 'inputs/flatpak-source'
UID = 21314
SCENARIO = 'portable-flatpak-approve'
PROFILE = 'production016-private017-native-update'
CONTEXT = 'portable-update-016'
RETENTION = '.var/app/com.creatorworks.hub/data/update-retention.json'
RETENTION_BYTES = b'{"fixture":"launcher-removal-retains-data","schemaVersion":1}\n'
PROTECTED = (RETENTION, 'data/CreatorHub/consent/hub-usage-terms.json',
    'config/creator-works-mcp/launcher-config.json', 'data/CreatorHub/preferences/hub-preferences.json',
    'data/CreatorHub/projects.json', 'data/CreatorProjectSetup/editor-roots.json', 'config/Claude/claude_desktop_config.json',
    '.claude.json', '.codex/config.toml', 'config/Code/User/mcp.json', 'unrelated/keep.json',
    *(project + '/' + name for project in ('selected-project', 'other-project')
      for name in ('Assets/keep.txt', 'Packages/manifest.json', 'ProjectSettings/ProjectVersion.txt')))
REF, RUNTIME = F.REF, F.RUNTIME
BUNDLE = 'Creator.Hub_0.1.16_x86_64.flatpak'
COMMIT = 'fd8aa52965d4ce2e4a4a0c8d58d901bf20b2d3b059916799502ea24891c2bb90'
SOURCE_COMMIT = 'c13cb9ef3b9116ea5ffb1f6cf8250becf5fd49e7'
SOURCE_TREE = '10623f5cdc379028ff91cbdfdbb103615969856d'
TARGET_SOURCE = '75a99ff4a267064aaa3ac9e30039bc91dc791d89'
TARGET_TREE = '5f62bf4bc1ba85eb293ca9a5a30330b06b6b4351'
FILE_ROWS = (
    (BUNDLE, 199408, '30904def15d0e3d5333af2d1bb2af9e6fcab8569578a4f6cc9595de08a34bf24'),
    ('creator-hub-flatpak-activate', 597640, '89a3c15e88eaa5189417bca7e59fab7a177e805847b2ccc6c8db90e24716b908'),
    ('production-flatpak-receipt.json', 22935, 'b6d89999c199740af2b6b8bc151191e29c781ddfb74127a2c8656b564190ca6c'),
)
SOURCE_ROWS = (
    ('native/flatpak-native-activation/Cargo.toml', 507, '8dd5ca16d10e99f61f1955200181b3d06f218f7fd5d31d6ff1068dcb4f435a40'),
    ('native/flatpak-native-activation/Cargo.lock', 20903, '6d49eb8833b85a1d2e294fcbd099e79bdbde343d7a0a245d820b12e17cf78de4'),
    ('native/flatpak-native-activation/src/lib.rs', 12537, '8a404fceda70623a5fd7ee521e3c0fce165ce4ad4603c7660b50f07a745b0297'),
    ('native/flatpak-native-activation/src/main.rs', 358, 'e0a0af2864a50cfc621356a59effed8344551e74cb45afe4e0bb74db2803123a'),
    ('native/flatpak-native-activation/src/linux.rs', 3790, '2466f00905a05bee914f8fe15a77ca27f8c69ec2fe8e3b12c5d81099223da0d4'),
    ('native/flatpak-native-activation/src/check.rs', 840, '01782c5e779b8437740a1987cf8f89a5002db49b9a50a8e8746cf9c488cee55f'),
    ('native/flatpak-native-activation/com.creatorworks.hub.Host.service', 92, '9a270a39c219b4f2d294cfaa2a849db84b1e1883fa532d2c90d7f95625780340'),
    ('src-tauri/src/catalog-key.pub', 119, '23b3eee2d1c8cb7d705120953cda67ff94a722a207d5be1679c250be8ca90308'),
    ('src-tauri/icons/128x128.png', 8835, '4be3a9795c9478c9c37b5e7fdb8b775168fc574352097fa0a038a31ea88245cb'),
    ('LICENSE', 1068, 'b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f'),
    ('package.json', 829, '524c6af5da5213f9a348c9e8ad151b7a54097496b1b8db8b37b96f0ea0838318'),
    ('src-tauri/tauri.conf.json', 1646, '0e28e4262e8d259a08a9c0cf815f5af34b7ae1e0e361e47f3162e6d76bdf5e66'),
)
HARNESS = (
    'native-linux-production-016-flatpak.py', 'native-linux-production-016-flatpak.test.py',
    'native-linux-flatpak-activation-observer.py', 'native-linux-flatpak-activation-observer.test.py',
    'native-linux-flatpak-dialog-input.py', 'native-linux-flatpak-dialog-input.test.py',
    'native-unix-window.py', 'native-unix-window.test.py',
)
EXTRA_SOURCES = (*HARNESS, 'native-linux-update-flatpak.py', 'native-linux-update-flatpak.test.py',
                 'native-linux-production-016-flatpak.cjs', 'flatpak-native-production-016.cjs')
SCOPE = 'private016-launcher-to-private017-portable-only'
CONTEXT_KEYS = ('UPDATE_SCENARIO', 'UPDATE_EXECUTE', 'UPDATE_PROFILE_SHA256', 'GITHUB_ACTIONS', 'GITHUB_REPOSITORY',
    'GITHUB_REPOSITORY_ID', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_WORKFLOW_REF', 'GITHUB_SHA', 'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY')
_SEAL = object()


def pins(rows):
    return {name: {'size': size, 'sha256': digest} for name, size, digest in rows}


def launcher_contract():
    return {'version': '0.1.16', 'commit': COMMIT, 'source': {
        'schemaVersion': 1, 'profile': 'production-native-activation-016',
        'sourceCommit': SOURCE_COMMIT, 'sourceTree': SOURCE_TREE, 'files': pins(SOURCE_ROWS)},
        'producer': {'source': 'ef2b79956f59a4b40daf0026123160c3c6405fb2',
            'tree': '58a74ab8bcefe94db5a183fac6959b8261b9370e', 'run': 39348943839, 'attempt': 1,
            'job': 118388279954, 'artifact': 12231574692, 'name': 'linux-016-production-flatpak-39348943839-1',
            'branch': 'validation/linux-flatpak-production-016', 'workflow': '.github/workflows/flatpak-native-production-016.yml',
            'zip': {'size': 820465, 'sha256': '7139c913164d6901c6de689d07f4ac764e6d82b29d2d5c033b06f405144fa668'},
            'files': pins(FILE_ROWS)}}


def retention_fixture():
    """Data for the outer initial seed only; never write or reseed a home here."""
    return {RETENTION: RETENTION_BYTES}


def helper_commands():
    """Closed policy specification; provisioning requires the root updater broker."""
    prefix = ('/usr/bin/python3', '-I', '-S', '-B', '/var/lib/creator-hub-flatpak-proxy-observer/observer.py')
    return (prefix + ('root-inventory-probe-update016',), prefix + ('root-proxy-snapshot-update016',))


def validate_launcher_profile(profile):
    require(profile.get('flatpakLauncher') == launcher_contract()
            and profile['artifacts'].get('flatpak16') == profile['flatpakLauncher']['producer'],
            'Explicit original launcher profile/producer required; no inferred product defaults')


def validate_source_api(profile, value):
    validate_launcher_profile(profile)
    source = profile['flatpakLauncher']['source']
    require(type(value) is dict and value.get('sha') == source['sourceCommit']
            and value.get('tree', {}).get('sha') == source['sourceTree'], 'Original launcher source/tree API differs')


def launcher_sources(u, folder, profile):
    validate_launcher_profile(profile)
    directory = folder / 'flatpak-source'
    require(directory.resolve(strict=True) == directory and directory.is_dir(), 'Ordinary original-source directory required')
    expected = profile['flatpakLauncher']['source']['files']
    actual = set()
    parents = {parent.as_posix() for name in expected for parent in Path(name).parents if parent != Path('.')}
    for file in directory.rglob('*'):
        relative = file.relative_to(directory).as_posix()
        require(not file.is_symlink() and file.resolve(strict=True) == file, 'Redirected launcher source')
        if file.is_dir():
            require(relative in parents, 'Unknown source directory')
        else:
            actual.add(relative)
    require(actual == set(expected), 'Complete exact twelve-file launcher source closure required')
    return {name: u.bound(directory / name, expected[name], 2 * 1024**2) for name in expected}


def copy_launcher_source(u, source, target, profile):
    bodies = launcher_sources(u, source, profile)
    directory = target / 'flatpak-source'
    directory.mkdir(mode=0o700)
    for name, raw in bodies.items():
        file = directory / name
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        u.write(file, raw)


def stage_launcher(u, folder, profile, api, env, sealed):
    validate_source_api(profile, api['flatpakSource'])
    launcher_sources(u, folder, profile)
    def rebind():
        u.bound(Path(env['CONTROLLER_NODE']), sealed['nodeImage'], 128 * 1024**2, mode=0o755)
        for name in ('native-linux-production-016-flatpak.cjs', 'flatpak-native-production-016.cjs'):
            u.bound(HERE / name, sealed['sources'][name], 2 * 1024**2)
    rebind()
    # Only pure validators, never the other workflow's admission, builder or session.
    script = """const fs=require('node:fs'),path=require('node:path'),a=require('node:assert/strict');
const lane=require(process.argv[1]),root=process.argv[2];
const p=JSON.parse(fs.readFileSync(path.join(root,'profile.json'))),api=JSON.parse(fs.readFileSync(path.join(root,'api.json')));
lane.flatpakAPI(api.flatpak16);
const read=(base,pins)=>Object.fromEntries(Object.keys(pins).map(n=>[n,fs.readFileSync(path.join(root,base,n))]));
const result=lane.flatpakFiles(read('members/flatpak16',p.flatpakLauncher.producer.files),read('flatpak-source',p.flatpakLauncher.source.files));
a.deepEqual(result.source,p.flatpakLauncher.source);a.equal(result.commit,p.flatpakLauncher.commit);
process.stdout.write(JSON.stringify({source:result.source,commit:result.commit}));"""
    result = u.parse(u.run_tool([env['CONTROLLER_NODE'], '-e', script,
        str(HERE / 'native-linux-production-016-flatpak.cjs'), str(folder)], limit=32768, timeout=30))
    rebind()
    require(result == {key: profile['flatpakLauncher'][key] for key in ('source', 'commit')}, 'Pure launcher validator result differs')
    return copy.deepcopy(profile['flatpakLauncher'])


OBSERVER_TOOL = Path('/var/lib/creator-hub-flatpak-proxy-observer/observer.py')
OBSERVER_POLICY = Path('/etc/sudoers.d/creator-hub-update-flatpak-observer')


def helper_policy():
    return ('creator-polkit-fixture ALL=(root) NOPASSWD: ' + ', '.join(' '.join(c) for c in helper_commands()) + '\n').encode()


def install_observer(u, env, sealed):
    require(u.admission(env) == SCENARIO and os.getuid() == os.geteuid() == 0
            and sealed['scenario'] == SCENARIO and env['GITHUB_SHA'] == sealed['context']['GITHUB_SHA'],
            'Root updater authority and original source required')
    require(not any(env.get(k) for k in ('DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'EXECUTION_REQUEST')),
            'Helper setup must precede the native session')
    u.protected_ancestry(OBSERVER_TOOL.parent.parent)
    u.protected_ancestry(OBSERVER_POLICY.parent)
    require(not os.path.lexists(OBSERVER_TOOL.parent) and not os.path.lexists(OBSERVER_POLICY), 'Existing helper/policy refused')
    body = u.bound(u.BASE / 'scripts/native-linux-flatpak-activation-observer.py',
                   sealed['sources']['native-linux-flatpak-activation-observer.py'], 1024 * 1024, uid=0, mode=0o444)
    policy = helper_policy()
    receipt = {'schemaVersion': 1, 'scenario': SCENARIO, 'harnessSource': env['GITHUB_SHA'],
        'context': CONTEXT, 'uid': UID, 'runtime': str(ROOT / 'runtime'), 'commands': [list(c) for c in helper_commands()],
        'tool': u.pin(body), 'policy': u.pin(policy), 'installed': False, 'probePassed': False,
        'readOnly': True, 'inputPermitted': False, 'authorityGranted': False}
    failure = None
    try:
        OBSERVER_TOOL.parent.mkdir(mode=0o755)
        u.write(OBSERVER_TOOL, body, 0o444)
        u.write(OBSERVER_POLICY, policy, 0o440)
        u.bound(OBSERVER_TOOL, receipt['tool'], 1024 * 1024, uid=0, mode=0o444)
        u.bound(OBSERVER_POLICY, receipt['policy'], 8192, uid=0, mode=0o440)
        u.run_tool(['/usr/sbin/visudo', '-c', '-f', str(OBSERVER_POLICY)], limit=8192, timeout=10)
        receipt['installed'] = True
        context = u.clean_context(env)
        # No desktop, bus, password, alternate workflow intent or arbitrary path.
        require(u.USER == 'creator-polkit-fixture' and u.BASE == BASE, 'Fixed synthetic caller only')
        result = u.run_tool(['/usr/sbin/runuser', '--user', u.USER, '--', '/usr/bin/env', '-i',
            *(key + '=' + value for key, value in context.items()), '/usr/bin/python3', '-I', '-S', '-B',
            str(u.BASE / 'scripts/native-linux-production-016-update.py'), 'flatpak-probe'], limit=32768, timeout=15)
        require(not result, 'Updater-owned observer preflight emitted unexpected output')
        proof = u.parse(u.read(ROOT / 'flatpak-helper-probe.json', 32768, uid=UID, mode=0o600))
        require(proof['harnessSource'] == env['GITHUB_SHA'] and proof['context'] == CONTEXT
                and proof['inventoryProbed'] is True and proof['codeSha256'] == receipt['tool']['sha256'], 'Observer preflight receipt differs')
        receipt['probePassed'] = True
    except Exception as error:
        failure = error
        receipt['refused'] = type(error).__name__
        raise
    finally:
        try:
            u.save(u.BASE / 'flatpak-helper-install.json', receipt, 0o644)
        except Exception:
            if failure is None:
                raise


def observer_probe(u, env, sealed):
    require(u.admission(env) == SCENARIO and os.getuid() == os.geteuid() == UID
            and not any(env.get(k) for k in ('DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'EXECUTION_REQUEST')),
            'Updater-only headless observer preflight required')
    expected = sealed['sources']['native-linux-flatpak-activation-observer.py']
    raw = u.bound(HERE / 'native-linux-flatpak-activation-observer.py', expected, 1024 * 1024, uid=0, mode=0o444)
    module = ModuleType('update016_observer_probe')
    module.__file__ = str(HERE / 'native-linux-flatpak-activation-observer.py')
    exec(compile(raw, module.__file__, 'exec'), module.__dict__)
    context = module.named_context(CONTEXT)
    require(context.uid == UID and context.runtime == ROOT / 'runtime', 'Fixed updater observer context differs')
    module.protected_tool(expected['sha256'])
    request = dict(schemaVersion=1, operation=context.probe_operation, harnessSource=env['GITHUB_SHA'],
        codeSha256=expected['sha256'], sequence=1, nonce=secrets.token_hex(32),
        expiresNs=time.monotonic_ns() + 4 * 10**9, caller=module.root_process(os.getpid(), context=context))
    module.probe_request(request, time.monotonic_ns(), context=context)
    result = F.root_exchange(module.PROXY_TOOL, context.probe_command, encoded(request), request['expiresNs'] / 10**9)
    answer = u.parse(result.stdout)
    require(result.returncode == 0 and not result.stderr and set(answer) == {'request', 'ok', 'snapshot'}
            and answer['request'] == request and answer['ok'] is True, 'Protected inventory operation refused')
    module.validate_probe(answer['snapshot'], request, context=context)
    module.protected_tool(expected['sha256'])
    require(time.monotonic_ns() < request['expiresNs'], 'Observer preflight expired')
    u.save(ROOT / 'flatpak-helper-probe.json', dict(schemaVersion=1, harnessSource=env['GITHUB_SHA'], context=CONTEXT,
        codeSha256=expected['sha256'], inventoryProbed=True, request=request, snapshot=answer['snapshot'],
        readOnly=True, inputPermitted=False, authorityGranted=False))


def install_launcher(u, env, sealed, profile):
    validate_environment(env)
    require(u.admission(env) == SCENARIO and os.getuid() == os.geteuid() == UID, 'Original unprivileged session only')
    validate_launcher_profile(profile)
    proof = u.parse(u.read(BASE / 'flatpak-helper-install.json', 32768, uid=0, mode=0o644))
    require(proof['scenario'] == SCENARIO and proof['harnessSource'] == env['GITHUB_SHA']
            and proof['installed'] is proof['probePassed'] is True and proof['commands'] == [list(c) for c in helper_commands()]
            and proof['tool'] == sealed['sources']['native-linux-flatpak-activation-observer.py']
            and proof['policy'] == u.pin(helper_policy()), 'Exact helper authorization/preflight required')
    u.bound(OBSERVER_TOOL, proof['tool'], 1024 * 1024, uid=0, mode=0o444)
    require(not os.path.lexists(ROOT / 'installation') and not os.path.lexists(ROOT / 'installed-flatpak.json'), 'Fresh private Flatpak installation required')
    context = F.clean_environment(ROOT)
    require(context['HOME'] == str(HOME) and context['FLATPAK_USER_DIR'] == str(ROOT / 'installation'), 'Foreign install roots refused')
    run = lambda args, timeout=120: F.command(['/usr/bin/flatpak', '--user', *args], env=context, timeout=timeout)
    bundle = BASE / 'inputs/members/flatpak16' / BUNDLE
    u.bound(bundle, profile['flatpakLauncher']['producer']['files'][BUNDLE], uid=0, mode=0o644)
    run(['remote-add', 'flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo'])
    require(run(['remote-info', '--show-ref', 'flathub', RUNTIME]).decode().strip() == RUNTIME, 'Exact runtime ref required')
    commit = run(['remote-info', '--show-commit', 'flathub', RUNTIME]).decode().strip()
    require(re.fullmatch('[a-f0-9]{64}', commit), 'Exact observed runtime commit required')
    run(['install', '--noninteractive', '--assumeyes', '--no-related', 'flathub', RUNTIME], timeout=900)
    run(['update', '--noninteractive', '--assumeyes', '--no-related', '--commit=' + commit, RUNTIME], timeout=900)
    require(run(['info', '--show-commit', RUNTIME]).decode().strip() == commit, 'Runtime commit changed')
    run(['install', '--bundle', '--noninteractive', '--assumeyes', '--no-related', '--no-deps', str(bundle)])
    require(run(['info', '--show-commit', REF]).decode().strip() == profile['flatpakLauncher']['commit'], 'Installed launcher commit differs')
    import configparser
    config = configparser.RawConfigParser(strict=True); config.optionxform = str
    config.read_string(run(['info', '--show-metadata', REF]).decode('utf8'))
    require(set(config.sections()) == {'Application', 'Context', 'Session Bus Policy'}
        and dict(config['Application']) == {'name': 'com.creatorworks.hub', 'runtime': 'org.gnome.Platform/x86_64/50',
             'sdk': 'org.gnome.Sdk/x86_64/50', 'command': 'creator-hub-flatpak-activate'}
        and dict(config['Context']) == {'sockets': 'wayland;fallback-x11;'}
        and dict(config['Session Bus Policy']) == {F.NAME: 'talk'}, 'Installed Flatpak permissions differ')
    u.save(ROOT / 'installed-flatpak.json', dict(ref=REF, commit=profile['flatpakLauncher']['commit'], runtime=RUNTIME,
        runtimeCommit=commit, manualBundle=True, releaseReady=False))


def recheck_helper_install(u, env, sealed):
    require(u.admission(env) == SCENARIO and os.getuid() == os.geteuid() == 0, 'Root final helper check only')
    proof = u.parse(u.read(BASE / 'flatpak-helper-install.json', 32768, uid=0, mode=0o644))
    require(proof['harnessSource'] == env['GITHUB_SHA'] and proof['installed'] is proof['probePassed'] is True
            and proof['tool'] == sealed['sources']['native-linux-flatpak-activation-observer.py']
            and proof['policy'] == u.pin(helper_policy()), 'Helper install receipt differs')
    u.protected_ancestry(OBSERVER_TOOL.parent)
    u.protected_ancestry(OBSERVER_POLICY.parent)
    u.bound(OBSERVER_TOOL, proof['tool'], 1024 * 1024, uid=0, mode=0o444)
    u.bound(OBSERVER_POLICY, proof['policy'], 8192, uid=0, mode=0o440)
    return proof


def evidence_names(u):
    fixed = ('flatpak-helper-install.json', 'result/flatpak-helper-probe.json', 'result/installed-flatpak.json')
    if not os.path.lexists(EVIDENCE):
        return fixed
    require(EVIDENCE.resolve(strict=True) == EVIDENCE and EVIDENCE.is_dir(), 'Ordinary continuation evidence required')
    names = []
    for file in EVIDENCE.rglob('*'):
        require(not file.is_symlink() and file.resolve(strict=True) == file, 'Redirected continuation evidence')
        if file.is_dir():
            require(file.relative_to(EVIDENCE).as_posix() in ('cold-pages', 'warm-surface'), 'Unknown evidence directory')
            continue
        relative = file.relative_to(EVIDENCE).as_posix()
        require(relative in ('report.json', 'cold-pages/pages.json', 'cold-pages/root-window.png', 'warm-surface/root-window.png')
                or re.fullmatch(r'(?:cold|warm)\.(?:stdout|stderr)', relative)
                or re.fullmatch(r'(?:warm-activation-observer-gtk|(?:cold|warm)(?:-disclosure)?(?:-readiness|-outcome)?-gtk)\.json', relative),
                'Unknown continuation evidence member')
        names.append(file.relative_to(u.BASE).as_posix())
        require(len(names) <= 64, 'Continuation evidence count bound')
    return fixed + tuple(sorted(names))


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def validate_environment(env):
    expected = {'UPDATE_SCENARIO': SCENARIO, 'UPDATE_EXECUTE': 'true', 'GITHUB_ACTIONS': 'true',
        'GITHUB_REPOSITORY': 'BOBWORKS-XR/CREATOR-HUB', 'GITHUB_REPOSITORY_ID': '1364807512',
        'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/validation/native-linux-production-016-update',
        'GITHUB_WORKFLOW_REF': 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-update.yml@refs/heads/validation/native-linux-production-016-update',
        'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64',
        'HOME': str(HOME), 'XDG_CONFIG_HOME': str(HOME / 'config'), 'XDG_DATA_HOME': str(HOME / 'data'),
        'XDG_CACHE_HOME': str(HOME / 'cache'), 'XDG_RUNTIME_DIR': str(ROOT / 'runtime'), 'TMPDIR': str(ROOT / 'tmp')}
    require(all(env.get(k) == v for k, v in expected.items()), 'Exact updater context and existing fixture paths required')
    require(not env.get('EXECUTION_REQUEST') and not env.get('FLATPAK_ID')
            and env.get('FLATPAK_USER_DIR', str(ROOT / 'installation')) == str(ROOT / 'installation'),
            'No manufactured Flatpak intent or foreign installation')
    require(re.fullmatch(r'[a-f0-9]{40}', env.get('GITHUB_SHA', ''))
            and re.fullmatch(r':[0-9]+(?:\.[0-9]+)?', env.get('DISPLAY', ''))
            and type(env.get('DBUS_SESSION_BUS_ADDRESS')) is str and 0 < len(env['DBUS_SESSION_BUS_ADDRESS']) <= 4096,
            'Existing private display/bus and immutable source required')


def validate_host_pair(updater, review):
    require(review.get('signaturesVerified') is True and review.get('flatpakLauncher') == launcher_contract(),
            'Separate frozen16 launcher review and verified signed hosts required')
    require(set(review['portable']) == {'16', '17'}, 'Exact two reviewed signed generations required')
    for version in ('16', '17'):
        package = review['portable'][version]
        require(set(package) == {'generation', 'manifest', 'signature'}
                and type(package['generation']) is str and re.fullmatch('[a-f0-9]{64}', package['generation']),
                'Exact independently signed generation binding required')
        updater.portable_manifest(package['manifest'], version, review['baseline'])
        updater.validate_pin(package['signature'], 4096)
    current, previous = review['portable']['17'], review['portable']['16']
    require(current['manifest']['sourceCommit'] == TARGET_SOURCE and current['manifest']['sourceTree'] == TARGET_TREE
            and current['manifest']['version'] == '0.1.17' and previous['manifest']['version'] == '0.1.16'
            and current['generation'] != previous['generation'], 'No relabelled16 host or generation alias')
    return current, previous


class _Handoff:
    __slots__ = ('_seal', '_u', '_env', '_request', '_review', '_before', '_update', '_claimed')

    def __setattr__(self, name, value):
        raise AttributeError('Immutable updater handoff')

    def __init__(self, seal, updater, env, request, review, before, update):
        require(seal is _SEAL, 'Only admitted internal handoff')
        for name, value in dict(_seal=seal, _u=updater, _env=encoded({k: env[k] for k in CONTEXT_KEYS if k in env}), _request=request, _review=review,
                                _before=encoded(before), _update=encoded(update), _claimed=False).items():
            object.__setattr__(self, name, value)

    def claim(self):
        require(self._seal is _SEAL and self._claimed is False, 'Continuation is one-shot; never retry failed input')
        object.__setattr__(self, '_claimed', True)
        self.recheck()

    def data(self):
        return self._u.parse(self._review)

    def recheck(self):
        u, env = self._u, self._u.parse(self._env)
        require(sys.platform == 'linux' and os.getuid() == os.geteuid() == UID and HERE == BASE / 'scripts',
                'Only the existing owned native updater session may continue')
        validate_environment(dict(os.environ))
        require(all(os.environ.get(k) == env.get(k) for k in ('GITHUB_SHA', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY')),
                'Same-session display/bus/source changed')
        require(u.admission(env) == u.admission(dict(os.environ)) == SCENARIO and u.BASE == BASE and u.UID == UID
                and Path(u.__file__) == BASE / 'scripts/native-linux-production-016-update.py', 'Outer updater admission is not wired')
        require(u.read(BASE / 'request.json', 65536, uid=0, mode=0o644) == self._request
                and u.read(BASE / 'review.json', 2 * 1024**2, uid=0, mode=0o644) == self._review,
                'Root-owned source/review handoff changed')
        request = u.parse(self._request)
        require(u.admission(request['context']) == SCENARIO and request['scenario'] == SCENARIO
                and request['context']['GITHUB_SHA'] == env['GITHUB_SHA'], 'Original updater intent/source differs')
        require(set(request['sources']) == set(u.source_names(SCENARIO))
                and set(EXTRA_SOURCES) <= set(request['sources']), 'Complete bound outer source closure required')
        for name in request['sources']:
            u.bound(BASE / 'scripts' / name, request['sources'][name], 2 * 1024**2, uid=0, mode=0o444)
        profile_raw = u.read(BASE / 'inputs/profile.json', 65536, uid=0, mode=0o644)
        api_raw = u.read(BASE / 'inputs/api.json', 512 * 1024, uid=0, mode=0o644)
        require(u.pin(profile_raw) == request['profile'] and u.pin(api_raw) == request['api'], 'Sealed original input identity changed')
        profile = u.validate_profile(u.parse(profile_raw), SCENARIO)
        u.validate_all_api(profile, u.parse(api_raw), request['context'])
        require(profile['artifacts']['flatpak16'] == launcher_contract()['producer'], 'Original frozen launcher producer differs')
        for name, expected in pins(FILE_ROWS).items():
            u.bound(BASE / 'inputs/members/flatpak16' / name, expected, uid=0, mode=0o644)
        for name, expected in pins(SOURCE_ROWS).items():
            u.bound(LAUNCHER_SOURCE / name, expected, uid=0, mode=0o644)
        validate_host_pair(u, self.data())
        before = u.parse(self._before)
        require(set(PROTECTED) <= set(before), 'Original project/client/preferences baseline must not be narrowed')
        for name in before:
            u.safe_name(name)
        require(before[RETENTION]['size'] == len(RETENTION_BYTES)
                and before[RETENTION]['sha256'] == hashlib.sha256(RETENTION_BYTES).hexdigest(),
                'Retention sentinel must belong to the original fixture baseline, never a later seed')
        return u.preserved(HOME, before)

    def host_state(self):
        self.recheck()
        u, review = self._u, self.data()
        current, previous = validate_host_pair(u, review)
        directory = u.portable_state(HOME, review, '17', previous=previous['generation'])
        for package in (previous, current):
            u.verify_generation(HOME, package)
        store = HOME / u.STORE
        require({p.name for p in (store / 'generations').iterdir()} == {previous['generation'], current['generation']},
                'Unknown or removed portable generation')
        names = (u.STORE + '/current.json', u.HOST_SERVICE, u.STORE + '/activation-v1/creator-hub-portable-selector')
        return directory, {name: u.fingerprint(HOME / name) for name in names}


def admit(updater, env, before, completed_update):
    """No native action; reject until the outer updater actually admits this case."""
    require(type(updater) is ModuleType and type(env) is dict and type(before) is dict and bool(before), 'Typed existing updater state required')
    validate_environment(env)
    require(sys.platform == 'linux' and os.getuid() == os.geteuid() == UID
            and HERE == BASE / 'scripts' and Path(updater.__file__) == HERE / 'native-linux-production-016-update.py',
            'Fixed native copied-source context required')
    require(updater.admission(env) == SCENARIO, 'Combined scenario is not admitted by outer updater')
    require(type(completed_update) is dict and completed_update.get('scenario') == SCENARIO
            and completed_update.get('harnessSource') == env['GITHUB_SHA']
            and all(completed_update.get(k) is True for k in ('initial16Verified', 'nativeConfirmationObserved',
                'oldNormalExit', 'automaticRestartObserved', 'installed17Verified', 'fresh17UiVersion', 'directPagesObserved', 'normalFinalClose')),
            'Real update and automatic successor normal-close proof required before continuation')
    request = updater.read(BASE / 'request.json', 65536, uid=0, mode=0o644)
    review = updater.read(BASE / 'review.json', 2 * 1024**2, uid=0, mode=0o644)
    handoff = _Handoff(_SEAL, updater, env, request, review, before, completed_update)
    handoff.recheck()
    return handoff


def validate_installed(value):
    require(type(value) is dict and set(value) == {'ref', 'commit', 'runtime', 'runtimeCommit', 'manualBundle', 'releaseReady'}
            and value['ref'] == REF and value['commit'] == COMMIT and value['runtime'] == RUNTIME
            and type(value['runtimeCommit']) is str and re.fullmatch('[a-f0-9]{64}', value['runtimeCommit'])
            and value['manualBundle'] is True and value['releaseReady'] is False, 'Exact installed launcher/runtime receipt required')
    return value


def removal_command():
    return ['/usr/bin/flatpak', '--user', 'uninstall', '--noninteractive', '--assumeyes', REF]


def ref_inventory(run):
    raw = run(['/usr/bin/flatpak', '--user', 'list', '--columns=ref'])
    require(type(raw) is bytes and len(raw) <= 16384, 'Bounded private Flatpak refs required')
    refs = raw.decode('utf8').splitlines()
    require(0 < len(refs) <= 32 and len(set(refs)) == len(refs)
            and all(re.fullmatch(r'(?:app|runtime)/[A-Za-z0-9_.-]+/x86_64/[A-Za-z0-9_.-]+', ref) for ref in refs)
            and all(not ref.startswith('app/') or ref == REF for ref in refs), 'Foreign/aliased app ref in private installation')
    result = {}
    for ref in refs:
        raw_commit = run(['/usr/bin/flatpak', '--user', 'info', '--show-commit', ref])
        require(type(raw_commit) is bytes and re.fullmatch(rb'[a-f0-9]{64}\n?', raw_commit), 'Exact installed ref commit required')
        result[ref] = raw_commit.decode().strip()
    return result


def page_proof(value, root):
    require(type(value) is dict and set(value) == {'version', 'root', 'directPagesObserved', 'bitmap', 'ownedAxConnectionClosed'}
            and value['version'] == '0.1.17' and value['root'] == root and value['directPagesObserved'] is True
            and value['ownedAxConnectionClosed'] is True and type(value['bitmap']) is dict and value['bitmap'].get('nonblank') is True,
            'Actual17 pages/owned frame and closed owned AX connection required')
    return value


def continuation_proof(report):
    require(report.get('scope') == SCOPE and report.get('launcherVersion') == '0.1.16'
            and report.get('hostVersion') == '0.1.17' and report.get('combinedAccepted') is False
            and report.get('releaseReady') is False and report.get('nativeHelperRemovalAccepted') is False
            and all(report.get(key) is True for key in ('coldActivationAccepted', 'warmActivationAccepted',
                'normalCloseObserved', 'launcherRemoved', 'nativeHostRetained', 'settingsRetained')),
            'Incomplete continuation; outer MCP/preservation/teardown acceptance remains separate')


class UpdateSession(F.Session):
    def __init__(self, handoff):
        require(type(handoff) is _Handoff and handoff._seal is _SEAL and handoff._claimed is True, 'Internal claimed handoff required')
        self.handoff = handoff
        handoff.recheck()
        require(not os.path.lexists(EVIDENCE), 'Fresh separate continuation evidence required; no adoption')
        EVIDENCE.mkdir(mode=0o700)
        launcher = launcher_contract()
        super().__init__(ROOT, {'flatpak': {'source': launcher['source'], 'files': launcher['producer']['files'], 'commit': COMMIT}},
                         observer_context=CONTEXT)
        self.report = {'schemaVersion': 1, 'scope': SCOPE, 'phase': 'starting', 'launcherVersion': '0.1.16',
                       'hostVersion': '0.1.17', 'combinedAccepted': False, 'releaseReady': False}
        self.host_before = None

    @property
    def evidence_root(self):
        return EVIDENCE

    def harness_sources(self, names):
        self.handoff.recheck()
        require(set(names) == {'scripts/' + name for name in HARNESS}, 'Exact eight-file observer binding required')
        request = self.handoff._u.parse(self.handoff._request)
        files = {name: request['sources'][name.removeprefix('scripts/')] for name in names}
        sources = {name: self.handoff._u.bound(BASE / name, files[name], 1024 * 1024, uid=0, mode=0o444) for name in names}
        return {'harnessSource': request['context']['GITHUB_SHA'], 'harnessFiles': files,
                'profile': PROFILE, 'scenario': SCENARIO}, sources

    def launcher_source(self, name):
        self.handoff.recheck()
        require(name in pins(SOURCE_ROWS), 'Only original reviewed launcher source')
        return self.handoff._u.bound(LAUNCHER_SOURCE / name, pins(SOURCE_ROWS)[name], 262144, uid=0, mode=0o644)

    def disclosure_source(self):
        return self.launcher_source('native/flatpak-native-activation/src/lib.rs')

    def host_identity(self):
        directory, state = self.handoff.host_state()
        if self.host_before is not None:
            require(state == self.host_before, 'Selection/registration/selector identity changed')
        return self.handoff.data()['portable']['17']['manifest']['entries']['usr/bin/creator-hub']['sha256'], directory / 'usr/bin/creator-hub'

    def snapshot_preserved(self):
        result = self.handoff.recheck()
        self.host_identity()
        return result

    def installed_flatpak(self):
        return validate_installed(super().installed_flatpak())

    def flatpak_command(self, args):
        self.handoff.recheck()
        require(args in (['/usr/bin/flatpak', '--user', 'list', '--columns=ref'], removal_command())
                or type(args) is list and len(args) == 5 and args[:4] == ['/usr/bin/flatpak', '--user', 'info', '--show-commit']
                and type(args[4]) is str and (args[4] == REF or re.fullmatch(r'runtime/[A-Za-z0-9_.-]+/x86_64/[A-Za-z0-9_.-]+', args[4])),
                'Only exact private ref inspection or launcher-only removal')
        require(self.app_env.get('FLATPAK_USER_DIR') == str(ROOT / 'installation')
                and self.app_env.get('HOME') == str(HOME), 'Never use a default or foreign Flatpak installation')
        return F.command(args, env=self.app_env, timeout=120)

    def activate_cold(self, inspect_pages):
        require(self.host_owner() is None and not self.windows(), 'No live Root/window may be replaced at cold activation')
        self.flatpak('Open Creator Hub', 'cold')
        self.wait(lambda: self.host_owner() is not None and len(self.windows()) == 1)
        digest, path = self.host_identity()
        cold = self.process(self.host_owner()['pid'], digest)
        require(cold['executable'] == str(path) and cold['uids'] == [UID] * 4
                and os.readlink(f'/proc/{cold["pid"]}/ns/mnt') == os.readlink('/proc/self/ns/mnt'), 'Exact signed native17 image required')
        self.stable(cold)
        with open(f'/proc/{cold["pid"]}/environ', 'rb') as stream:
            environment = stream.read(32769)
        self.stable(cold)
        require(len(environment) <= 32768, 'Owned native environment bound exceeded')
        values = dict(item.split(b'=', 1) for item in environment.split(b'\0') if b'=' in item)
        require(all(values.get(name.encode()) == str(path).encode() for name, path in (
            ('HOME', HOME), ('XDG_CONFIG_HOME', HOME / 'config'), ('XDG_DATA_HOME', HOME / 'data'))),
            'Cold native17 uses a different settings home')
        window = self.owned_window(cold, F.P.TITLE)
        owner, xres = self.host_owner(), self.x11.inspect(window)
        require(owner['pid'] == cold['pid'] == xres['pid'] and xres['mapped'] is True, 'Cold Root/Host1/XRes ownership must agree')
        self.stable(cold)
        require(self.host_owner() == owner and self.x11.inspect(window) == xres, 'Cold binding changed')
        self.report.update(coldRoot=cold, coldHost1Owner=owner, coldRootWindow=window, coldRootXres=xres)
        pages = EVIDENCE / 'cold-pages'; pages.mkdir(mode=0o700)
        self.report['coldPages'] = page_proof(inspect_pages(copy.deepcopy(cold), self.x11, pages), cold)
        self.stable(cold)
        require(self.host_owner() == owner and self.x11.inspect(window) == xres, 'Page inspection changed the cold Root binding')
        self.report['coldActivationAccepted'] = True

    def activate_warm(self):
        self.flatpak('Open Creator Hub', 'warm')
        cold, window = self.report['coldRoot'], self.report['coldRootWindow']
        self.stable(cold)
        require(self.host_owner() == self.report['coldHost1Owner'] and self.windows() == [window]
                and self.x11.inspect(window) == self.report['coldRootXres'], 'Warm activation replaced Root/owner/window')
        self.wait(lambda: self.x11.property(self.x11.x.XDefaultRootWindow(self.x11.display), '_NET_ACTIVE_WINDOW')[2] == [window])
        directory = EVIDENCE / 'warm-surface'; directory.mkdir(mode=0o700)
        request = self.helper.Request('snapshot', cold['pid'], cold['startTime'], cold['executable'], cold['kernelImageSha256'], window, F.P.TITLE, 'FRAME')
        self.report['warmSurface'] = self.native.bitmap(request, directory, self.helper, self.x11)
        require(self.report['warmSurface'].get('nonblank') is True, 'Warm frame is blank')
        self.report['warmActivationAccepted'] = True

    def normal_close(self):
        self.close(self.report['coldRoot'], self.report['coldRootWindow'])
        self.wait(lambda: self.host_owner() is None)
        require(not self.windows(), 'Normal close left a visible app')
        require(all(child.poll() == 0 for child in self.children), 'Owned launcher did not exit normally')
        self.report['normalCloseObserved'] = True

    def remove_launcher(self, before):
        require(self.report.get('normalCloseObserved') is True and not self.windows() and self.host_owner() is None,
                'Only remove the closed launcher after normal Hub close')
        installed = self.installed_flatpak()
        require(before.get(REF) == COMMIT and before.get(RUNTIME) == installed['runtimeCommit'],
                'Exact launcher/runtime must exist before removal')
        self.snapshot_preserved()
        require(ref_inventory(self.flatpak_command) == before, 'Installation changed before exact launcher removal')
        self.flatpak_command(removal_command())
        after = ref_inventory(self.flatpak_command)
        require(after == {k: v for k, v in before.items() if k != REF} and REF not in after,
                'Launcher removal affected runtime/other refs or left app installed')
        self.snapshot_preserved()
        self.report.update(launcherRemoved=True, nativeHostRetained=True, settingsRetained=True,
                           retainedRefs=after, nativeHelperRemovalAccepted=False)

    def dispose(self):
        failures = []
        pending = getattr(self, 'warm_activation_pending', None)
        if pending is not None:
            self.finish_warm_activation_diagnostic(pending)
            self.warm_activation_pending = None
        for capture in self.captures:
            try:
                capture.close()
            except Exception as error:
                failures.append(type(error).__name__)
        for fd in self.fds:
            try:
                os.close(fd)
            except Exception as error:
                failures.append(type(error).__name__)
        self.fds.clear()
        # This connection was installed after the outer updater's handler. Restore
        # it first; never dispose the borrowed outer X11/GIO/WM/MCP objects here.
        try:
            self.x11.dispose()
        except Exception as error:
            failures.append(type(error).__name__)
        require(not failures, 'Continuation cleanup refused: ' + ','.join(failures))


def after_update(handoff, inspect_pages):
    require(type(handoff) is _Handoff and handoff._seal is _SEAL, 'Arbitrary JSON cannot authorize continuation')
    require(callable(inspect_pages) and getattr(inspect_pages, '__module__', None) == handoff._u.__name__
            and getattr(inspect_pages, '__code__', None) is not None
            and Path(inspect_pages.__code__.co_filename) == BASE / 'scripts/native-linux-production-016-update.py',
            'Page callback must be implemented in the independently bound outer updater')
    handoff.claim()
    session, failure = None, None
    try:
        session = UpdateSession(handoff)
        _, session.host_before = handoff.host_state()
        installed = session.installed_flatpak()
        refs = ref_inventory(session.flatpak_command)
        require(refs.get(REF) == COMMIT and refs.get(RUNTIME) == installed['runtimeCommit'], 'Installed launcher/runtime commits drifted')
        session.report['installedBefore'] = refs
        for phase, action in (('cold', lambda: session.activate_cold(inspect_pages)), ('warm', session.activate_warm),
                              ('normal-close', session.normal_close), ('launcher-removal', lambda: session.remove_launcher(refs))):
            session.report['phase'] = phase
            session.snapshot_preserved()
            action()
            session.snapshot_preserved()
        continuation_proof(session.report)
        session.report['phase'] = 'complete'
    except Exception as error:
        failure = error
        if session is not None:
            session.report.update(refused=type(error).__name__, phase='failed', recovery='unknown-no-retry-disposable-runner-teardown')
    finally:
        if session is not None:
            try:
                session.report['logs'] = [capture.metadata() for capture in session.captures]
                require(not any(child.poll() is None for child in session.children), 'Owned launcher remains live; no forced cleanup')
            except Exception as error:
                failure = failure or error
            try:
                session.dispose()
            except Exception as error:
                failure = failure or error
                session.report['cleanupRefused'] = type(error).__name__
            if failure is not None:
                session.report.update(phase='failed', recovery='unknown-no-retry-disposable-runner-teardown')
            try:
                F.save(EVIDENCE / 'report.json', session.report)
            except Exception as error:
                failure = failure or error
    if failure is not None:
        raise failure
    return copy.deepcopy(session.report)
