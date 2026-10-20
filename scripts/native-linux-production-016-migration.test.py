"""Pure/temp execution contracts only; never installs or opens a native app."""
import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("migration016", HERE / "native-linux-production-016-migration.py")
M = importlib.util.module_from_spec(spec); sys.modules[spec.name] = M; spec.loader.exec_module(M)


def environment(scenario=None):
    return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
            "GITHUB_REF": M.BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": M.WORKFLOW,
            "GITHUB_SHA": "f" * 40, "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
            "CREATOR_NATIVE_LINUX_PRODUCTION_016": "1", "CREATOR_MIGRATION_016_EXECUTE": "true",
            "CREATOR_MIGRATION_016_SCENARIO": scenario or M.SCENARIOS[0]}


def binding():
    pins = {key: {"size": 64, "sha256": "a" * 64} for key in M.P.PINS}
    profile = {"schemaVersion": 1, "cohort": M.P.COHORT, "mode": "pages", "pins": pins,
               "assembly": {"sourceCommit": "b" * 40, "sourceTree": "c" * 40, "runId": 1, "runAttempt": 1,
                            "jobId": 2, "artifactId": 3, "zipBytes": 64, "zipSha256": "d" * 64}}
    api = {"schemaVersion": 1, "cohort": M.P.COHORT, "harnessSource": "f" * 40, "assembly": profile["assembly"],
           "privatePayload": dict(M.P.PRIVATE), "privateSourcePaths": {key: "9" * 40 for key in M.P.PRIVATE_PATHS}, "legacy": [], **M.P.FLAGS}
    for product, repo, tag, name in (("mcp", "CREATOR-WORKS-UNITY-MCP", "v2.7.7", "Creator.Works.MCP_2.7.7_amd64.deb"),
                                    ("setup", "CREATOR-PROJECT-SETUP", "v0.3.7", "Creator.Project.Setup_0.3.7_amd64.deb")):
        size, sha = M.P.S.LEGACY[product]
        api["legacy"].append({"product": product, "repo": repo, "tag": tag, "name": name, "size": size, "sha256": sha, "assetId": 1, "releaseId": 2})
    contract = {"protocolVersion": 2, "cohort": "creator-hub-deb-retirement-016-v1", "mode": "production",
                "mcpVersion": M.MCP_VERSION, "setupVersion": M.SETUP_VERSION, "nativeAcceptance": False, "externalQualificationRequired": True}
    proof = {"cohort": M.P.COHORT, "sourceCommit": profile["assembly"]["sourceCommit"], "sourceTree": profile["assembly"]["sourceTree"],
             "compiledFeatures": list(M.P.FEATURES), "rawHub": pins["rawHub"], "hub": pins["hub"], "productionContract": contract,
             "rawToPackaged": "exact-tauri-bundle-marker-deb", **M.P.FLAGS}
    return {"schemaVersion": 1, "cohort": M.P.COHORT, "inspectionOnly": True, "profile": profile, "api": api,
            "productionProof": proof, "packageFiles": {M.P.S.DEB_MEMBERS[name]: {**pins[name], "mode": mode} for name, mode in
                                                       (("hub", 0o755), ("helper", 0o755), ("policy", 0o644), ("service", 0o644))},
            "resourceFiles": {"mcp/server/creator-works-mcp.mjs": "8" * 64}, **M.P.FLAGS}


def records(session, commands, ids):
    return [{"session": session * 64, "id": number, "command": name, "outcome": "returned-ok"} for name, number in zip(commands, ids)]


class ControllerTests(unittest.TestCase):
    def test_manual_exact_workflow_optin_is_independent_of_inspection_mode(self):
        for scenario in M.SCENARIOS:
            self.assertEqual(M.admission(environment(scenario), system="linux", uid=1001), scenario)
        for key, value in (("GITHUB_WORKFLOW_REF", M.WORKFLOW.replace("-migration", "")), ("GITHUB_EVENT_NAME", "push"),
                           ("GITHUB_REF", "refs/heads/main"), ("RUNNER_ENVIRONMENT", "self-hosted"), ("RUNNER_ARCH", "ARM64"),
                           ("CREATOR_MIGRATION_016_EXECUTE", "false"), ("CREATOR_MIGRATION_016_EXECUTE", "1"),
                           ("CREATOR_MIGRATION_016_SCENARIO", "migration-cancel"), ("GITHUB_SHA", ""),
                           ("APPIMAGE", "/tmp/a"), ("LD_PRELOAD", ""), ("PYTHONPATH", ""), ("NODE_OPTIONS", "--inspect")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**environment(), key: value}, system="linux", uid=1001)
        with self.assertRaises(RuntimeError):
            M.admission(environment(), system="win32", uid=1001)

    def test_binding_requires_exact_new_source_features_protocol_and_all_false_inspection_flags(self):
        value = binding()
        self.assertEqual(M.validate_binding(value, "f" * 40), value["profile"])
        mutations = [lambda b: b.update(inspectionOnly=False), lambda b: b.update(migrationAccepted=True),
                     lambda b: b["productionProof"].update(compiledFeatures=["integrated-features"]),
                     lambda b: b["productionProof"].update(sourceTree="0" * 40),
                     lambda b: b["productionProof"]["productionContract"].update(protocolVersion=1),
                     lambda b: b["productionProof"]["productionContract"].update(protocolVersion=True),
                     lambda b: b["productionProof"]["productionContract"].update(nativeAcceptance=True),
                     lambda b: b["productionProof"]["productionContract"].update(externalQualificationRequired=False),
                     lambda b: b["profile"].update(mode="migration-approve"), lambda b: b["api"].update(harnessSource="e" * 40),
                     lambda b: b["packageFiles"].update({"../outside": {"size": 1, "sha256": "a" * 64, "mode": 0o644}}),
                     lambda b: b["packageFiles"][M.P.S.DEB_MEMBERS["helper"]].update(mode=0o777),
                     lambda b: b["resourceFiles"].update({"/outside": "a" * 64}), lambda b: b.update(exec="/bin/true")]
        for index, mutate in enumerate(mutations):
            changed = copy.deepcopy(value); mutate(changed)
            with self.subTest(index=index), self.assertRaises(RuntimeError):
                M.validate_binding(changed, "f" * 40)

    def test_execution_request_binds_scenario_source_workflow_and_original_binding_bytes(self):
        raw = json.dumps(binding()).encode()
        with patch.object(M.sys, "platform", "linux"), patch.object(M.os, "getuid", return_value=1001, create=True):
            request = M.execution_request(environment(), raw)
            self.assertEqual(M.check_request(request, environment(), raw), M.SCENARIOS[0])
            for key, replacement in (("scenario", M.SCENARIOS[1]), ("workflowRef", "other"), ("bindingSha256", "0" * 64),
                                     ("harnessSource", "0" * 40), ("schemaVersion", True), ("extra", True)):
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    M.check_request({**request, key: replacement}, environment(), raw)
            with self.assertRaises(RuntimeError):
                M.check_request(request, environment(), raw + b" ")

    def test_four_actual_scenario_branches_have_finite_order_and_no_followup_on_uncertain_input(self):
        expected = [[("consent", False), ("cancel-check",)], [("consent", True), ("review-connections",), ("mcp", False)],
                    [("consent", True), ("review-connections",), ("mcp", True), ("setup", False)],
                    [("consent", True), ("review-connections",), ("mcp", True), ("setup", True)]]
        for scenario, wanted in zip(M.SCENARIOS, expected):
            events = []
            M.execute_scenario(scenario, lambda approve: events.append(("consent", approve)),
                               lambda target, approve: events.append((target, approve)), lambda: events.append(("cancel-check",)),
                               lambda: events.append(("review-connections",)))
            self.assertEqual(events, wanted)
            for failure in range(len(wanted)):
                events = []
                def step(value):
                    events.append(value)
                    if len(events) == failure + 1:
                        raise RuntimeError("uncertain action")
                with self.assertRaises(RuntimeError):
                    M.execute_scenario(scenario, lambda approve: step(("consent", approve)),
                                       lambda target, approve: step((target, approve)), lambda: step(("cancel-check",)),
                                       lambda: step(("review-connections",)))
                self.assertEqual(events, wanted[:failure + 1])

    def test_unverified_connection_context_binds_exact_clients_beforeimages_and_verified_router(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); before = M.fixture(root); home = root / "home"
            router = home / "verified/router"
            real_read = M.read_file
            def reader(file, *args, **kwargs):
                self.assertEqual(kwargs, {"uid": M.UID, "mode": 0o600})
                return real_read(file, *args)
            with patch.object(M, "read_file", side_effect=reader), patch.object(M, "verified_route", return_value=(router, home / "server")) as verified:
                context = M.connection_review(home, before, binding())
                details = [f"{name}\nCommand: {M.OLD_NODE}\nServer: {M.OLD_SERVER}\nProject kept: {home / 'current-project'}" for name in ("Codex", "Claude Code")]
                self.assertEqual(context["question"], "These existing connections could not be publisher-verified:\n\n" + "\n\n".join(details)
                                 + f"\n\nMove them to the verified Hub router at {router}? Names and ownership markers are not proof. Continue only for your Creator Works connections. Exact backups, client options and other servers are kept. Cancel stops migration before changing any of these clients.")
                self.assertEqual(context["beforeImages"][".claude.json"]["sha256"], M.digest(before[".claude.json"]))
                verified.assert_called_once_with(home, binding())
                for name in (".codex/config.toml", ".claude.json", "config/Claude/claude_desktop_config.json"):
                    file = home / name; file.write_bytes(b"changed")
                    with self.assertRaises(RuntimeError): M.connection_review(home, before, binding())
                    file.write_bytes(before[name])
                extra = home / ".gemini/config/mcp_config.json"; extra.parent.mkdir(parents=True); extra.write_bytes(b"{}")
                with self.assertRaises(RuntimeError): M.connection_review(home, before, binding())

    def test_unverified_native_graph_refuses_other_clients_router_text_buttons_owner_and_extra_labels(self):
        question = "Exact two-client before-images and verified router"
        graph = [{"reference": [":1.2", str(i)], "parent": [":1.2", "app" if i == 0 else "0"], "pid": 123,
                  "role": role, "name": name, "ready": True} for i, (role, name) in enumerate(
                      [(2, "Warning"), (29, question), (43, "Move reviewed connections"), (43, "Keep existing")])]
        check = lambda value: M.graph_contract(value, pid=123, title="Warning", question=question, connection_review=True)
        check(graph)
        for mutate in (lambda g: g[1].update(name=question + "\nExtra client"), lambda g: g[1].update(name="Different router"),
                       lambda g: g[0].update(name="Information"), lambda g: g[2].update(name="Move to Hub"),
                       lambda g: g[2].update(pid=999), lambda g: g[2].update(ready=False),
                       lambda g: g.append({**g[1], "reference": [":1.2", "extra"], "name": "Unexpected text"}),
                       lambda g: g.append({**g[2], "reference": [":1.2", "extra"], "name": "Extra action"})):
            bad = copy.deepcopy(graph); mutate(bad)
            with self.assertRaises(RuntimeError): check(bad)

    def test_connection_review_click_is_exactly_once_and_mismatch_or_uncertainty_never_replays(self):
        button, action = Mock(), Mock()
        button.get_action_iface.return_value = action
        action.get_n_actions.return_value = 1; action.get_action_name.return_value = "click"; action.do_action.return_value = True
        profile = {"question": "exact synthetic clients", "beforeImages": {"client": "before"}, "router": "/verified/router", "frame": [0, 0, 50, 50]}
        record = {}; guard = Mock()
        M.approve_connection_review(Mock(return_value=(button, profile)), guard, record)
        action.do_action.assert_called_once_with(0); self.assertEqual(guard.call_count, 4)
        with self.assertRaises(RuntimeError): M.approve_connection_review(Mock(), guard, record)
        for call in (1, 2):
            for key in profile:
                action.do_action.reset_mock()
                changed = {**profile, key: "changed"}; frames = [copy.deepcopy(profile) for _ in range(3)]; frames[call] = changed
                with self.assertRaises(RuntimeError):
                    M.approve_connection_review(Mock(side_effect=[(button, frame) for frame in frames]), Mock(), {})
                action.do_action.assert_not_called()
        action.do_action.return_value = False; action.do_action.reset_mock(); uncertain = {}
        with self.assertRaises(RuntimeError): M.approve_connection_review(Mock(return_value=(button, profile)), Mock(), uncertain)
        self.assertEqual(uncertain["actionAttempts"], 1)
        with self.assertRaises(RuntimeError): M.approve_connection_review(Mock(), Mock(), uncertain)
        action.do_action.assert_called_once_with(0)

    def test_original_authority_and_logind_session_are_revalidated_after_broker_wait_before_any_input(self):
        native = M.load("native-linux-polkit-probe")
        for kind in ("cancel", "authenticate"):
            for changed_peer in ("authority", "parent-session", "agent-session", "root-session"):
                for replacement_wait in ((0, 1, 3, 5) if kind == "authenticate" else (0, 1, 3)):
                    with self.subTest(kind=kind, peer=changed_peer, replacement_wait=replacement_wait):
                        s, sdk = Mock(), Mock(); s.owned = {"pid": 30}; p = s.polkit
                        endpoint = {"owner": ":1.2", "pid": 20, "uid": M.UID, "authority": {"owner": ":1.1", "pid": 1, "uid": 0}}
                        original_session = {"object": "/session/original", "Id": "c1", "Leader": 10, "User": [M.UID, "/user"]}
                        state = {"authority": copy.deepcopy(endpoint["authority"]), "sessions": {pid: copy.deepcopy(original_session) for pid in (10, 20, 30)}}
                        p.bus_identity.side_effect = lambda _bus, name, _glib: state["authority"] if name == "org.freedesktop.PolicyKit1" else {k: endpoint[k] for k in ("owner", "pid", "uid")}
                        p.session.side_effect = lambda _bus, pid, _glib: state["sessions"][pid]
                        a = M.Authorization(s, Mock(), {"pid": 20}, {"pid": 10}, endpoint, Mock(), Mock(), Mock(), "question", [0], sdk, original_session)
                        def replace():
                            if changed_peer == "authority": state["authority"] = {**state["authority"], "owner": ":1.99"}
                            else: state["sessions"][{"parent-session": 10, "agent-session": 20, "root-session": 30}[changed_peer]]["Leader"] = 999
                        waits = [0]
                        def waited(_check):
                            waits[0] += 1
                            if waits[0] == replacement_wait: replace()
                        s.pages.wait.side_effect = waited
                        if replacement_wait == 0: replace()
                        def proof(*_args, **_kwargs):
                            return json.dumps({"request": {"index": a.counter[0], "target": "mcp"}, "ok": True, "proof": {"root": s.owned, "target": "mcp"}}).encode()
                        button, password = Mock(), Mock()
                        password.get_editable_text_iface.return_value.set_text_contents.return_value = True
                        profile = Mock(return_value=((password, button), {"selectedIdentityVerified": True, "selectedIdentity": M.USER}) if kind == "authenticate" else (button, {}))
                        record = {"mode": kind}
                        with patch.dict(M.os.environ, {"CREATOR_MIGRATION_016_SCENARIO": M.SCENARIOS[3]}), patch.object(M, "publish") as publish, patch.object(M, "read_file", side_effect=proof):
                            with self.assertRaises(RuntimeError):
                                if kind == "authenticate": native.authenticate_once(profile, lambda: a.input_guard("mcp", record), record, bytearray(b"a" * 64))
                                else: native.cancel_once(profile, lambda: a.input_guard("mcp", record), record)
                        if replacement_wait <= 1: profile.assert_not_called()
                        button.get_action_iface.assert_not_called()
                        # A replacement after the valid password write must
                        # still prevent the later Authenticate input.
                        self.assertEqual(password.get_editable_text_iface.return_value.set_text_contents.call_count,
                                         1 if kind == "authenticate" and replacement_wait == 5 else 0)
                        self.assertEqual(publish.call_count, replacement_wait)
                        p.own_agent.assert_called()  # The held agent itself never changed.

    def test_each_successful_authentication_guard_rechecks_both_sides_of_the_kernel_proof_wait(self):
        native = M.load("native-linux-polkit-probe")
        s, sdk = Mock(), Mock(); s.owned = {"pid": 30}; p = s.polkit
        endpoint = {"owner": ":1.2", "pid": 20, "uid": M.UID, "authority": {"owner": ":1.1", "pid": 1, "uid": 0}}
        original = {"object": "/session/original", "Leader": 10}
        p.bus_identity.side_effect = lambda _bus, name, _glib: endpoint["authority"] if name == "org.freedesktop.PolicyKit1" else {k: endpoint[k] for k in ("owner", "pid", "uid")}
        p.session.return_value = original
        a = M.Authorization(s, Mock(), {"pid": 20}, {"pid": 10}, endpoint, Mock(), Mock(), Mock(), "question", [0], sdk, original)
        def proof(*_args, **_kwargs):
            return json.dumps({"request": {"index": a.counter[0], "target": "mcp"}, "ok": True, "proof": {"root": s.owned, "target": "mcp"}}).encode()
        password, button, action = Mock(), Mock(), Mock()
        password.get_editable_text_iface.return_value.set_text_contents.return_value = True
        button.get_action_iface.return_value = action
        action.get_n_actions.return_value = 1; action.get_action_name.return_value = "click"; action.do_action.return_value = True
        profile = Mock(return_value=((password, button), {"selectedIdentityVerified": True, "selectedIdentity": M.USER}))
        with patch.dict(M.os.environ, {"CREATOR_MIGRATION_016_SCENARIO": M.SCENARIOS[3]}), patch.object(M, "publish") as publish, patch.object(M, "read_file", side_effect=proof):
            native.authenticate_once(profile, lambda: a.input_guard("mcp", {}), {"mode": "authenticate"}, bytearray(b"a" * 64))
        self.assertEqual(publish.call_count, 5)
        self.assertEqual(sum(call.args[1] == "org.freedesktop.PolicyKit1" for call in p.bus_identity.call_args_list), 10)
        self.assertEqual(p.session.call_count, 30)
        password.get_editable_text_iface.return_value.set_text_contents.assert_called_once(); action.do_action.assert_called_once_with(0)

    def test_guide_cancel_allows_only_two_completed_reads_per_new_root_and_preserves_prefix(self):
        empty = {"revision": 1, "records": []}
        first = {"revision": 1, "records": records("a", ["load_config", "discover_unity_projects"], [3, 4])}
        second = {"revision": 1, "records": first["records"] + records("b", ["load_config", "discover_unity_projects"], [3, 4])}
        M.journal_delta(empty, first); M.journal_delta(first, second)
        mutations = [lambda v: v["records"].pop(), lambda v: v["records"].append(dict(v["records"][-1])),
                     lambda v: v["records"][0].update(command="apply_client_config"),
                     lambda v: v["records"][0].update(outcome="unknown"), lambda v: v["records"][0].update(id=True),
                     lambda v: v["records"][1].update(id=5), lambda v: v["records"][1].update(session="b" * 64),
                     lambda v: v.update(revision=True), lambda v: v.update(extra=1)]
        for mutate in mutations:
            bad = copy.deepcopy(first); mutate(bad)
            with self.assertRaises(RuntimeError): M.journal_delta(empty, bad)
        bad = copy.deepcopy(second); bad["records"][0]["outcome"] = "returned-error"
        with self.assertRaises(RuntimeError): M.journal_delta(first, bad)
        repeated = {"revision": 1, "records": first["records"] * 2}
        with self.assertRaises(RuntimeError): M.journal_delta(first, repeated)

    def test_transfer_journal_has_only_source_defined_completed_commands_then_exact_reopen_reads(self):
        names = ["review_existing_client_connections", "review_convergence_server", "load_config", "discover_unity_projects"]
        first = {"revision": 1, "records": records("a", names, [2, 3, 7, 8])}
        M.journal_delta({"revision": 1, "records": []}, first, transferred=True)
        second = {"revision": 1, "records": first["records"] + records("b", names[-2:], [3, 4])}
        M.journal_delta(first, second)
        for index in range(4):
            bad = copy.deepcopy(first); bad["records"][index]["command"] = "unexpected"
            with self.assertRaises(RuntimeError): M.journal_delta({"revision": 1, "records": []}, bad, transferred=True)

    def test_scenario_package_states_do_not_treat_partial_cleanup_as_rollback_or_completion(self):
        self.assertEqual([M.retention_state(s) for s in M.SCENARIOS], [(False, False), (False, False), (True, False), (True, True)])
        with self.assertRaises(RuntimeError): M.retention_state("all")

    def test_inspections_require_production_protocol_exact_types_counts_and_target(self):
        for target in ("mcp", "setup"):
            for retained in (False, True):
                other = "setup" if target == "mcp" else "mcp"
                value = {"protocolVersion": 2, "cohort": "creator-hub-deb-retirement-016-v1", "mode": "production",
                         "status": "inspected-retained-read-only" if retained else "inspected-read-only", "nativeAcceptance": False,
                         "externalQualificationRequired": True, "product": target,
                         "package": "creator-works-mcp" if target == "mcp" else "creator-project-setup",
                         "packageState": "compatibility" if retained else "original",
                         "version": (M.MCP_VERSION if target == "mcp" else M.SETUP_VERSION) if retained else ("2.7.7" if target == "mcp" else "0.3.7"),
                         "readOnly": True, "baselineMatches": not retained, "compatibilityMatches": retained,
                         "snapshotAuthoritative": False, "packageTransactionStarted": False,
                         "retainedFilesVerified": 9 if retained and target == "mcp" else 0,
                         "tombstoneFilesVerified": 1 if retained and target == "setup" else 0,
                         "omittedFilesVerified": 5 if retained else 0}
                M.inspection(value, target, retained)
                with self.assertRaises(RuntimeError): M.inspection(value, other, retained)
                for key, bad in (("protocolVersion", 1), ("nativeAcceptance", True), ("packageTransactionStarted", True),
                                 ("retainedFilesVerified", True), ("omittedFilesVerified", 6), ("extra", False)):
                    with self.subTest(target=target, retained=retained, key=key), self.assertRaises(RuntimeError):
                        M.inspection({**value, key: bad}, target, retained)

    def test_route_verifies_actual_minisig_names_generation_and_every_bound_payload(self):
        home = Path("/synthetic/home")
        base = home / "data/creator-hub"
        resource = {"mcp/server/creator-works-mcp.mjs": b"synthetic server", "mcp/server/runtime/node": b"synthetic node"}
        module = {"executable": "mcp/creator-works-mcp-launcher", "version": "2.7.7",
                  "files": {name: M.digest(raw) for name, raw in resource.items()}}
        generation = M.digest(json.dumps({**module, "files": dict(sorted(module["files"].items()))}, separators=(",", ":")).encode())
        runtime = json.dumps({"module": module}).encode()
        resource.update({"routing/runtime.json": runtime, "routing/runtime.minisig": b"synthetic runtime signature",
                         "routing/router.json": json.dumps({"sha256": M.digest(b"synthetic router")}).encode(),
                         "routing/router.minisig": b"synthetic router signature"})
        active = {"schemaVersion": 1, "descriptorSha256": M.digest(runtime), "generation": generation}
        route = base / "mcp-route-v1/linux-x86_64"
        files = {route / "active.json": json.dumps(active).encode(),
                 route / "router-v1/creator-hub-mcp-router": b"synthetic router"}
        for name, raw in resource.items():
            destination = (route / "descriptors" / active["descriptorSha256"] / name.removeprefix("routing/") if name.startswith("routing/runtime") else
                           route / "router-v1" / name.removeprefix("routing/") if name.startswith("routing/router") else
                           base / "runtime-generations/linux-x86_64" / generation / name)
            files[destination] = raw
        pins = {"resourceFiles": {name: M.digest(raw) for name, raw in resource.items()}}
        def reader(file, *_args, **_kwargs):
            return files[file]
        with patch.object(M, "read_file", side_effect=reader):
            router, server = M.verified_route(home, pins)
            self.assertEqual(router, route / "router-v1/creator-hub-mcp-router")
            self.assertEqual(server, base / "runtime-generations/linux-x86_64" / generation / "mcp/server/creator-works-mcp.mjs")
            for name in list(files):
                if name.name == "active.json": continue
                original = files[name]; files[name] = b"changed"
                with self.subTest(path=str(name)), self.assertRaises((RuntimeError, ValueError)):
                    M.verified_route(home, pins)
                files[name] = original

    def test_pending_kernel_request_is_target_specific_not_historical_sealed_dpkg(self):
        for target, argument in (("mcp", "retire-mcp-2.7.7"), ("setup", "retire-setup-0.3.7")):
            raw = b"\0".join(v.encode() for v in ("/usr/bin/pkexec", "--disable-internal-agent", M.HELPER, argument)) + b"\0"
            M.pending_command(raw, target)
            for bad in (raw + b"extra\0", raw.replace(b"--disable-internal-agent\0", b""), raw.replace(argument.encode(), b"inspect"),
                        b"/usr/bin/pkexec\0--disable-internal-agent\0/usr/bin/dpkg\0--install\0/proc/self/fd/0\0"):
                with self.assertRaises(RuntimeError): M.pending_command(bad, target)
        with self.assertRaises(RuntimeError): M.proof_request({"index": 1, "target": "mcp"}, M.SCENARIOS[0])
        with self.assertRaises(RuntimeError): M.proof_request({"index": 1, "target": "setup"}, M.SCENARIOS[1])
        for value in ({"index": True, "target": "mcp"}, {"index": 49, "target": "mcp"}, {"index": 1, "target": "mcp", "command": "other"}):
            with self.assertRaises(RuntimeError): M.proof_request(value, M.SCENARIOS[3])

    def test_policy_remains_uncached_admin_and_fixed_helper(self):
        raw = (HERE.parent / "packaging/linux/com.creatorworks.hub.deb-retirement.production-016.policy").read_bytes()
        self.assertIn("user settings and Unity projects will be kept", M.policy_question(raw))
        for bad in (raw.replace(b"auth_admin", b"yes"), raw.replace(b"auth_admin", b"auth_admin_keep"), raw.replace(M.HELPER.encode(), b"/bin/sh")):
            with self.assertRaises(RuntimeError): M.policy_question(bad)

    def test_native_guide_graph_requires_source_question_owner_buttons_and_readiness(self):
        question = M.GUIDE + M.GUIDE_SUMMARY + M.GUIDE_END
        graph = [{"reference": [":1.2", str(i)], "parent": [":1.2", "app" if i == 0 else "0"], "pid": 123,
                  "role": role, "name": name, "ready": True} for i, (role, name) in enumerate(
                      [(2, "Information"), (29, question), (43, "Move to Hub"), (43, "Not now")])]
        M.graph_contract(graph, pid=123, title="Information", question=question)
        for mutate in (lambda v: v[1].update(pid=999), lambda v: v[1].update(name="wrong question"),
                       lambda v: v[2].update(name="Install"), lambda v: v[2].update(ready=False),
                       lambda v: v[1].update(parent=[":other", "/outside"]), lambda v: v[1].update(role=40),
                       lambda v: v[2].update(reference=v[1]["reference"])):
            bad = copy.deepcopy(graph); mutate(bad)
            with self.assertRaises(RuntimeError): M.graph_contract(bad, pid=123, title="Information", question=question)
        for bounds in ((-1, 0, 1, 1), (0, 0, 0, 10), (1, 1, 1000, 10), (False, 0, 1, 1)):
            with self.assertRaises(RuntimeError): M.inside(bounds, (0, 0, 100, 100))

    def test_pre_map_empty_inventory_is_not_an_error_or_an_ownership_bypass(self):
        self.assertEqual(M.startup_inventory(None), [])
        self.assertEqual(M.startup_inventory((33, 32, [])), [])
        self.assertEqual(M.startup_inventory((33, 32, [42])), [42])
        for value in ((33, 32, [42, 43]), (1, 32, [42]), (33, 8, [42]), (33, 32, [True]), (33, 32, [0]), []):
            with self.assertRaises(RuntimeError): M.startup_inventory(value)

    def test_native_process_guard_rejects_legacy_gui_and_host_backend_but_allows_private_node(self):
        for image, command in ((M.OLD_NODE, [M.OLD_NODE, M.OLD_SERVER]),
                               ("/usr/bin/creator-hub", ["/usr/bin/creator-hub"]),
                               ("/memfd:creator-node (deleted)", ["node", "/proc/self/fd/9"])):
            M.no_legacy_backend({"executable": image}, b"\0".join(value.encode() for value in command) + b"\0")
        for image, command in (("/usr/bin/creator-works-mcp-launcher", b"launcher\0"),
                               ("/usr/bin/creator-project-setup", b"setup\0"),
                               ("/memfd:creator-works-mcp-launcher (deleted)", b"module\0"),
                               ("/memfd:module (deleted)", b"module\0--creator-hub-host\0"),
                               (M.OLD_NODE, b"node\0--creator-hub-host\0")):
            with self.subTest(image=image), self.assertRaises(RuntimeError):
                M.no_legacy_backend({"executable": image}, command)
        for command in (b"", b"unterminated", b"x" * 8192 + b"\0"):
            with self.assertRaises(RuntimeError): M.no_legacy_backend({"executable": M.OLD_NODE}, command)

    def test_actual_home_observation_requires_linux_version_dense_projects_selection_and_bridge_fields(self):
        home, values = Path("/synthetic/home"), {}
        for selector, text in (("#platform-status", "Linux"), (".footer-version", "0.1.16"), ("#page-title", "CREATOR HUB"),
                               ("#projects-home-title", "Projects"), ("#unified-home-updater #hub-update-title", "Creator Hub update")):
            values[selector, "text"] = text
        for selector, shown in (("#platform-status", True), (".footer-version", True), ("#view-projects", True),
                                ("#projects-home-title", True), ("#unified-home-updater", True), ("#view-hub", False),
                                ("#view-hosted", False), ("#view-native-features", False)):
            values[selector, "displayed"] = shown
        values["#view-projects", "attribute/aria-busy"] = "false"
        for selected, name, y in ((True, "current-project", 100), (False, "missing-project", 220)):
            row = '#project-list .project-row[data-mcp-selected="' + str(selected).lower() + '"]'
            values.update({(row, "displayed"): True, (row + " .project-info small", "text"): str(home / name),
                           (row + " .project-bridge-warning", "text"): "MCP bridge not installed",
                           (row + " .project-bridge-warning", "displayed"): True,
                           (row + " .project-selected", "text"): "Selected for MCP", (row + " .project-selected", "displayed"): True,
                           (row, "css/display"): "flex", (row, "css/padding-top"): "14px", (row, "css/padding-bottom"): "14px",
                           (row + " .project-tags", "css/font-size"): "11px", (row, "rect"): {"x": 24, "y": y, "width": 892, "height": 100}})
        d = Mock()
        d.read.side_effect = lambda selector, endpoint="text": values[selector, endpoint]
        d.elements.side_effect = lambda selector: ["a", "b"] if selector == "#project-list .project-row" else [] if selector == "iframe,object,embed" else ["a"]
        d.call.return_value = ["one-native-root"]
        result = M.home_observation(d, home)
        self.assertEqual(result["platform"], "Linux"); self.assertEqual(result["version"], "0.1.16")
        self.assertTrue(result["rows"][0]["selected"])
        for key, bad in ((("#platform-status", "text"), "Windows"), ((".footer-version", "text"), "0.1.14"),
                         (("#view-hosted", "displayed"), True), (("#view-projects", "attribute/aria-busy"), "true"),
                         (("#platform-status", "displayed"), False)):
            old = values[key]; values[key] = bad
            with self.subTest(key=key), self.assertRaises(RuntimeError): M.home_observation(d, home)
            values[key] = old
        row = '#project-list .project-row[data-mcp-selected="true"]'
        for endpoint, bad in (("css/display", "grid"), ("css/padding-top", "40px"), ("rect", {"x": 24, "y": 210, "width": 892, "height": 100})):
            old = values[row, endpoint]; values[row, endpoint] = bad
            with self.assertRaises(RuntimeError): M.home_observation(d, home)
            values[row, endpoint] = old
        key = row + " .project-bridge-warning", "text"
        values[key] = "MCP bridge not checked"
        with self.assertRaises(RuntimeError): M.home_observation(d, home)

    def test_guide_cancel_preserves_settings_but_not_blanket_ignores_root_journal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            before = M.fixture(root)
            home = root / "home"
            M.preserved(home, before, transferred=False)
            (home / M.JOURNAL).write_text(json.dumps({"revision": 1, "records": records("a", ["load_config", "discover_unity_projects"], [3, 4])}))
            M.journal_delta(M.P.parse(before[M.JOURNAL]), M.P.parse(M.read_file(home / M.JOURNAL)))
            M.preserved(home, before, transferred=False)
            target = home / M.CONFIG; target.write_text("changed")
            with self.assertRaises(RuntimeError): M.preserved(home, before, transferred=False)

    def test_stable_file_reader_rejects_links_sizes_and_descriptor_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary).resolve() / "record.json"
            file.write_bytes(b"original")
            self.assertEqual(M.read_file(file), b"original")
            with self.assertRaises(RuntimeError): M.read_file(file, limit=7)
            with self.assertRaises(RuntimeError): M.read_file(file.parent)
            before = file.stat()
            changed = Mock(**{k: getattr(before, k) for k in dir(before) if k.startswith("st_")})
            changed.st_ino += 1
            with patch.object(M.os, "fstat", return_value=changed), self.assertRaises(RuntimeError):
                M.read_file(file)
            hardlink = file.with_name("hardlink")
            os.link(file, hardlink)
            with self.assertRaises(RuntimeError): M.read_file(file)

    def test_tool_disposal_accepts_proven_tool_exit_and_never_signals_product(self):
        s = M.Session.__new__(M.Session)
        s.child, s.native, s.helper, s.pages = Mock(), Mock(), Mock(), Mock()
        s.child.pid = 11
        s.driver_identity, s.backend = {"pid": 11}, {"pid": 12}
        s.child.poll.return_value = 0
        with patch.object(M.select, "select", return_value=([99], [], [])), patch.object(M.signal, "pidfd_send_signal", create=True) as send:
            s.dispose_tools(99)
            s.native.native_process.assert_not_called()
            s.child.terminate.assert_not_called(); send.assert_not_called()
        s.child.poll.return_value = None
        s.native.native_process.side_effect = [s.driver_identity, s.backend]
        with patch.object(M.select, "select", return_value=([], [], [])), patch.object(M.signal, "pidfd_send_signal", create=True) as send:
            s.dispose_tools(99)
            s.child.terminate.assert_called_once()
            send.assert_called_once_with(99, M.signal.SIGTERM)
            self.assertEqual(s.native.native_process.call_args_list[0].args[0], 11)
            self.assertEqual(s.native.native_process.call_args_list[1].args[0], 12)
        s.child.terminate.reset_mock()
        s.native.native_process.side_effect = None
        s.native.native_process.return_value = {"pid": 500}
        with patch.object(M.signal, "pidfd_send_signal", create=True) as send, self.assertRaises(RuntimeError):
            s.dispose_tools(99)
        s.child.terminate.assert_not_called(); send.assert_not_called()

    def test_startup_failure_keeps_bounded_refusal_and_existing_driver_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            log = Mock()
            log.metadata.return_value = {"stderr": {"truncated": False}}
            def start(session):
                session.evidence["root"] = {"pid": 16, "kernelImageSha256": "a" * 64}
                session.logs = log
                raise RuntimeError("Root mapping refused")
            with patch.object(M.Session, "start", start), self.assertRaisesRegex(RuntimeError, "Root mapping refused"):
                M.Session(root, binding())
            receipt = M.P.parse(M.read_file(root / "session.json"))
            self.assertFalse(receipt["normalCloseObserved"])
            self.assertEqual(receipt["root"]["pid"], 16)
            self.assertEqual(receipt["startupRefused"], {"type": "RuntimeError", "message": "Root mapping refused"})
            log.pump.assert_called_once(); log.close.assert_called_once()

    def test_syntax_sdk_uses_locked_library_and_has_no_signal_based_transport_close(self):
        source = (HERE / "native-linux-production-016-migration.py").read_text()
        ast.parse(source, feature_version=(3, 10))
        subprocess.run(["node", "--check", "--input-type=commonjs"], input=M.SDK_JS.encode(), check=True, capture_output=True)
        self.assertIn("@modelcontextprotocol/sdk/client/index.js", M.SDK_JS)
        self.assertIn("stdin.end()", M.SDK_JS)
        for token in ("process.kill", ".kill(", "StdioClientTransport", "eval("):
            self.assertNotIn(token, M.SDK_JS)
        self.assertEqual(M.FLAGS["releaseReady"], False)
        self.assertNotIn("request_restart", source)

    def test_sdk_pin_is_the_actual_linux_checkout_lock_not_windows_crlf_bytes(self):
        lock = (HERE.parent / "modules/mcp/package-lock.json").read_bytes()
        self.assertEqual(M.digest(lock.replace(b"\r\n", b"\n")), M.SDK_LOCK)
        workflow = (HERE.parent / ".github/workflows/native-linux-production-016-migration.yml").read_text()
        self.assertIn("= " + M.SDK_LOCK, workflow)
        self.assertIn('digest(read_file(source / "package-lock.json", 2 * 1024 * 1024)) == SDK_LOCK',
                      (HERE / "native-linux-production-016-migration.py").read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
