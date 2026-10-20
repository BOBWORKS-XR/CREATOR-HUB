"""Synthetic archives, pure production verifiers and Node proof functions only.

No real DEB decoding, package installation, product execution, network or GUI.
Windows models only the owned Unix input-read boundary; native metadata checks
remain mandatory in the real CLI and are tested on Linux without that model.
"""
import ast
import copy
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("production_stage", HERE / "native-linux-production-016-stage.py")
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


def pin(raw):
    return {"size": len(raw), "sha256": P.digest(raw)}


def tar(rows):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as stream:
        for name, body, mode, kind in rows:
            row = tarfile.TarInfo(name)
            row.uid = row.gid = 0
            row.mode, row.type = mode, kind
            row.size = len(body) if kind == tarfile.REGTYPE else 0
            stream.addfile(row, io.BytesIO(body))
    return output.getvalue()


class Fixture:
    def __init__(self, home):
        self.input, self.output = home / "input", home / "stage"
        self.input.mkdir(mode=0o700)
        self.output.mkdir(mode=0o700)
        rows = [("mcp/server/creator-works-mcp.mjs", b"// synthetic resource", 0o644, tarfile.REGTYPE),
                ("setup/creator-project-setup", b"synthetic setup, never executed", 0o755, tarfile.REGTYPE),
                ("routing/creator-hub-mcp-router", b"synthetic router, never executed", 0o755, tarfile.REGTYPE)]
        archive = gzip.compress(tar(rows))
        hashes = {name: P.digest(body) for name, body, _, _ in rows}
        manifest = {"platform": "linux", "arch": "x86_64", "modules": {"mcp": {"files": {rows[0][0]: hashes[rows[0][0]]}},
                    "setup": {"files": {rows[1][0]: hashes[rows[1][0]]}}}, "managedRouting": {"files": {rows[2][0]: hashes[rows[2][0]]}},
                    "payloadArchive": {"schemaVersion": 1, "file": "modules.tar.gz", **pin(archive),
                    "files": {name: {"size": len(body), "mode": mode} for name, body, mode, _ in rows},
                    "unpackedSize": sum(len(body) for _, body, _, _ in rows)}}
        manifest_raw = json.dumps(manifest).encode()
        raw = bytearray(64)
        raw[:7] = b"\x7fELF\x02\x01\x01"
        raw[18] = 0x3e
        raw += b"__TAURI_BUNDLE_TYPE_VAR_UNK\0" + manifest_raw
        raw = bytes(raw)
        hub = raw.replace(b"__TAURI_BUNDLE_TYPE_VAR_UNK", b"__TAURI_BUNDLE_TYPE_VAR_DEB")
        helper = bytearray(64)
        helper[:7] = b"\x7fELF\x02\x01\x01"
        helper[18] = 0x3e
        helper = bytes(helper)
        policy = (HERE.parent / "packaging/linux/com.creatorworks.hub.deb-retirement.production-016.policy").read_bytes()
        self.deb_body = b"synthetic DEB carrier, never executed"
        self.contents = {"rawHub": raw, "hub": hub, "helper": helper, "policy": policy, "service": P.V.SERVICE_BYTES,
                         "deb": self.deb_body, "manifest": manifest_raw, "modulesArchive": archive}
        self.p = {"schemaVersion": 1, "cohort": P.COHORT, "mode": "pages", "assembly": {"sourceCommit": "a" * 40,
                  "sourceTree": "e" * 40, "runId": 1, "runAttempt": 1, "jobId": 2, "artifactId": 3, "zipBytes": 1, "zipSha256": "b" * 64},
                  "pins": {name: pin(body) for name, body in self.contents.items()}}
        contract = {"protocolVersion": 2, "cohort": "creator-hub-deb-retirement-016-v1", "mode": "production",
                    "mcpVersion": "2.7.7-1+hub.retention016.1", "setupVersion": "0.3.7-1+hub.retention016.1",
                    "nativeAcceptance": False, "externalQualificationRequired": True}
        flags = {key: False for key in ("nativeGuiAccepted", "migrationAccepted", "authenticationAccepted", "signedUpdateAccepted", "releaseReady")}
        staging = {"schemaVersion": 2, "acceptanceOnly": True, "sourceCommit": self.p["assembly"]["sourceCommit"], "platform": "linux", "arch": "x86_64",
                   "rootFeature": "linux-production-migration", "helperFeature": "production-transaction", "profile": P.COHORT, "productionContract": contract,
                   "files": {"/" + P.S.DEB_MEMBERS[name]: {**self.p["pins"][name], "mode": mode, "uid": 0, "gid": 0} for name, mode in (("helper", 0o755), ("policy", 0o644))}, **flags}
        self.receipt = {"schemaVersion": 1, "product": "com.creatorworks.hub.unix-signed-assembly", "platform": "linux", "arch": "x86_64", "hubVersion": "0.1.16",
                        "assemblyCommit": self.p["assembly"]["sourceCommit"], "privateSource": dict(P.PRIVATE), "handoffSha256": "d" * 64,
                        "compiledFeatures": list(P.FEATURES), "mcpMode": "writable", "privateModulesRecompiled": False, "privateModulesResigned": False,
                        "nativeGuiAccepted": False, "releaseReady": False,
                        "productionMigration": {"schemaVersion": 1, "profile": P.COHORT, "sourceCommit": self.p["assembly"]["sourceCommit"],
                            "sourceTree": self.p["assembly"]["sourceTree"], "compiledFeatures": list(P.FEATURES), "rawHub": self.p["pins"]["rawHub"], "staging": staging},
                        "portableHostBuild": {"schemaVersion": 1, "version": "0.1.16", "target": "x86_64-unknown-linux-gnu", "sourceCommit": self.p["assembly"]["sourceCommit"],
                            "sourceTree": self.p["assembly"]["sourceTree"], "compiledFeatures": list(P.FEATURES), "startupImageBinding": 1, "rawHub": self.p["pins"]["rawHub"]}}
        self.integrity = {"schemaVersion": 1, "platform": "linux", "arch": "x86_64", "experimental": True, "mcpMode": "writable",
                          "writableGuiAccepted": False, "releaseReady": False, "integrityPassed": True,
                          "packages": [{"format": "deb", "path": P.S.MEMBERS["deb"], "sha256": self.p["pins"]["deb"]["sha256"], "hubSha256": self.p["pins"]["hub"]["sha256"], "files": hashes}]}
        parents = P.V.PARENTS | P.V.SERVICE_PARENTS | {"usr/bin", "usr/lib", "usr/lib/Creator Hub"}
        self.deb_rows = [(name, b"", 0o755, tarfile.DIRTYPE) for name in sorted(parents)]
        self.deb_rows += [(member, self.contents[key], 0o755 if key in ("hub", "helper") else 0o644, tarfile.REGTYPE) for key, member in P.S.DEB_MEMBERS.items()]
        control = ("Package: creator-hub\nVersion: 0.1.16\nArchitecture: amd64\nDescription: " + P.V.INTEGRATED_DESCRIPTION
                   + "\nDepends: policykit-1, libwebkit2gtk-4.1-0, libgtk-3-0\n").encode()
        self.control = tar([("control", control, 0o644, tarfile.REGTYPE), ("md5sums", b"", 0o644, tarfile.REGTYPE)])
        self.legacy = {}
        self.api = {"schemaVersion": 1, "cohort": P.COHORT, "harnessSource": "f" * 40, "assembly": self.p["assembly"],
                    "privatePayload": dict(P.PRIVATE), "privateSourcePaths": {key: "9" * 40 for key in P.PRIVATE_PATHS}, "legacy": [], **P.FLAGS}
        for product, repo, tag, name in (("mcp", "CREATOR-WORKS-UNITY-MCP", "v2.7.7", "Creator.Works.MCP_2.7.7_amd64.deb"),
                ("setup", "CREATOR-PROJECT-SETUP", "v0.3.7", "Creator.Project.Setup_0.3.7_amd64.deb")):
            body = ("synthetic original " + product).encode()
            self.legacy[product] = (len(body), P.digest(body))
            P.write(self.input / (product + ".deb"), body)
            self.api["legacy"].append({"product": product, "repo": repo, "tag": tag, "name": name, "assetId": 1, "releaseId": 2, **pin(body)})
        self.repack()

    def repack(self, rows=None):
        self.contents["assemblyReceipt"] = json.dumps(self.receipt).encode()
        self.contents["packageIntegrity"] = json.dumps(self.integrity).encode()
        self.p["pins"] = {key: pin(body) for key, body in self.contents.items()}
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            for key, name in P.S.MEMBERS.items():
                archive.writestr(name, self.contents[key])
            if rows is None:
                archive.writestr("creator-hub", self.contents["rawHub"])
            else:
                for name, body in rows:
                    archive.writestr(name, body)
        raw = data.getvalue()
        self.p["assembly"]["zipBytes"], self.p["assembly"]["zipSha256"] = len(raw), P.digest(raw)
        (self.input / "assembly.zip").write_bytes(raw)
        os.chmod(self.input / "assembly.zip", 0o600)

    def decoder(self, package, helper, policy, version, cohort):
        assert package == str(self.output / "deb.deb")
        assert (helper, policy, version, cohort) == (self.p["pins"]["helper"]["sha256"], self.p["pins"]["policy"]["sha256"], "0.1.16", P.COHORT)
        P.V.control(io.BytesIO(self.control), version, cohort)
        return {"files": P.V.data(io.BytesIO(tar(self.deb_rows)), helper, policy, cohort), "profile": cohort}

    def node(self):
        # Execute only the source-owned pure JS verifier on synthetic buffers,
        # not its native CLI or any bytes from the candidate archive.
        script = "const fs=require('node:fs'),x=JSON.parse(fs.readFileSync(0,'utf8')),m=require('./scripts/native-linux-production-016-input.cjs');process.stdout.write(JSON.stringify(m.inspectBuffers(x.receipt,x.p,Buffer.from(x.raw,'hex'),Buffer.from(x.hub,'hex'))));"
        result = subprocess.run(["node", "-e", script], cwd=HERE.parent,
            input=json.dumps({"receipt": self.receipt, "p": self.p, "raw": self.contents["rawHub"].hex(), "hub": self.contents["hub"].hex()}).encode(),
            capture_output=True, timeout=30, check=True)
        return P.parse(result.stdout)

    def inspect(self):
        real_read = P.read_owned

        def read_model(file, maximum):
            if sys.platform != "win32":
                return real_read(file, maximum)
            assert file.resolve() == file and file.is_file() and file.stat().st_nlink == 1
            raw = file.read_bytes()
            assert 0 < len(raw) <= maximum
            return raw

        with patch.object(P.S, "LEGACY", self.legacy), patch.object(P, "read_owned", side_effect=read_model), \
                patch.object(P.S, "deb_records", return_value=tar(self.deb_rows)), \
                patch.object(P.V, "verify", side_effect=self.decoder), patch.object(P, "check_proofs", side_effect=self.node):
            P.profile(self.p)
            P.api_binding(self.api, self.p, "f" * 40)
            return P.inspect_stage(self.input, self.output, self.p, self.api)


class ProductionStageTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        return Fixture(Path(temporary.name).resolve())

    def test_real_pure_verifiers_bind_synthetic_archive_package_resources_and_both_root_proofs(self):
        f = self.fixture()
        binding = f.inspect()
        self.assertEqual(binding["cohort"], P.COHORT)
        self.assertIs(binding["inspectionOnly"], True)
        self.assertEqual(binding["productionProof"]["rawHub"], f.p["pins"]["rawHub"])
        self.assertEqual(binding["productionProof"]["hub"], f.p["pins"]["hub"])
        self.assertEqual(binding["productionProof"]["sourceTree"], f.p["assembly"]["sourceTree"])
        for key in P.FLAGS:
            self.assertIs(binding[key], False)
        self.assertFalse((f.output / "binding.json").exists())  # only guarded main publishes it
        self.assertEqual((f.input / "assembly.zip").stat().st_size, f.p["assembly"]["zipBytes"])

    @unittest.skipUnless(sys.platform == "linux", "Real Unix owner/mode/link/FIFO checks require native Linux")
    def test_owned_reader_refuses_links_modes_special_files_and_oversize_before_open(self):
        f = self.fixture()
        for kind in ("symlink", "hardlink", "mode", "fifo", "oversize"):
            with self.subTest(kind=kind):
                file = f.input / (kind + ".fixture")
                if kind == "fifo":
                    os.mkfifo(file, 0o600)
                elif kind == "symlink":
                    file.symlink_to(f.input / "assembly.zip")
                else:
                    P.write(file, b"bounded fixture")
                    if kind == "hardlink":
                        os.link(file, f.input / "other-link")
                    if kind == "mode":
                        file.chmod(0o644)
                with patch.object(P.os, "open", side_effect=AssertionError("Refuse before open")), self.assertRaises(RuntimeError):
                    P.read_owned(file, 1 if kind == "oversize" else 1024)
        file = f.input / "ordinary.fixture"
        P.write(file, b"ordinary bounded bytes")
        self.assertEqual(P.read_owned(file, 1024), b"ordinary bounded bytes")

    def test_schema_exact_keys_raw_pin_and_historical_profile_refusal(self):
        f = self.fixture()
        schema = json.loads((HERE / "native-linux-production-016-input.schema.json").read_text())
        self.assertEqual(schema["required"], list(f.p))
        self.assertEqual(set(schema["properties"]["pins"]["required"]), set(P.PINS))
        for mutate in (lambda p: p.update(cohort="integrated-candidate"), lambda p: p.update(mode="migration-approve"),
                lambda p: p["assembly"].pop("sourceTree"), lambda p: p["pins"].pop("rawHub"),
                lambda p: p["pins"]["rawHub"].update(size=True), lambda p: p["pins"]["rawHub"].update(path="/tmp/tool"),
                lambda p: p.update(schemaVersion=True), lambda p: p["assembly"].update(runId=True)):
            changed = copy.deepcopy(f.p)
            mutate(changed)
            with self.assertRaises((RuntimeError, KeyError, TypeError)):
                P.profile(changed)

    def test_duplicate_nonfinite_json_and_stale_api_or_acceptance_cannot_be_used(self):
        for text in ('{"cohort":"production-migration-016","cohort":"production-migration-016"}', '{"n":NaN}', '{"n":Infinity}'):
            with self.assertRaises(RuntimeError):
                P.parse(text)
        f = self.fixture()
        for mutate in (lambda a: a.update(cohort="integrated-candidate"), lambda a: a.update(harnessSource="0" * 40),
                lambda a: a["assembly"].update(sourceTree="0" * 40), lambda a: a["privatePayload"].update(runId=1),
                lambda a: a["assembly"].update(runAttempt=True), lambda a: a["privatePayload"].update(runAttempt=True),
                lambda a: a["privateSourcePaths"].pop("modules/mcp"), lambda a: a.update(nativeExecution=True),
                lambda a: a["legacy"][0].update(assetId=True)):
            changed = copy.deepcopy(f.api)
            mutate(changed)
            with patch.object(P.S, "LEGACY", f.legacy), self.assertRaises(RuntimeError):
                P.api_binding(changed, f.p, "f" * 40)

    def test_missing_unpinned_wrong_sized_or_directory_raw_root_refuses(self):
        for rows in ([], [("creator-hub", b"not the pinned raw Root")], [("creator-hub/", b"")]):
            f = self.fixture()
            f.repack(rows)
            with self.assertRaises((RuntimeError, KeyError, zipfile.BadZipFile)):
                f.inspect()
            self.assertFalse((f.output / "binding.json").exists())

    def test_old_receipt_changed_tree_tuple_and_self_certification_do_not_become_production(self):
        for mutate in (lambda r: r.pop("productionMigration"), lambda r: r.pop("portableHostBuild"),
                lambda r: r["productionMigration"].update(sourceTree="1" * 40),
                lambda r: r.update(compiledFeatures=["integrated-features", "experimental-flatpak-host", "experimental-linux-migration"]),
                lambda r: r.update(releaseReady=True), lambda r: r["productionMigration"]["staging"].update(helperFeature="experimental-transaction")):
            f = self.fixture()
            mutate(f.receipt)
            f.repack()
            with self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
                f.inspect()
            self.assertFalse((f.output / "binding.json").exists())

    def test_production_control_policy_service_and_resource_disagreement_refuses(self):
        for kind in ("control-script", "helper-mode", "policy", "service", "resources"):
            f = self.fixture()
            if kind == "control-script":
                f.control = tar([("postinst", b"never run", 0o755, tarfile.REGTYPE)])
            elif kind == "helper-mode":
                f.deb_rows = [(n, b, 0o777 if n == P.S.DEB_MEMBERS["helper"] else m, k) for n, b, m, k in f.deb_rows]
            elif kind in ("policy", "service"):
                member = P.S.DEB_MEMBERS[kind]
                f.deb_rows = [(n, b"unreviewed override" if n == member else b, m, k) for n, b, m, k in f.deb_rows]
            else:
                f.integrity["packages"][0]["files"] = {}
                f.repack()
            with self.assertRaises((RuntimeError, ValueError)):
                f.inspect()
            self.assertFalse((f.output / "binding.json").exists())

    def test_cli_admission_and_paths_cannot_be_overridden_or_turn_inspection_into_install(self):
        env = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
               "GITHUB_REF": P.BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "RUNNER_ENVIRONMENT": "github-hosted",
               "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "CREATOR_NATIVE_LINUX_PRODUCTION_016": "1", "GITHUB_SHA": "f" * 40}
        # Source-level platform model only: this test cannot execute the CLI.
        with patch.object(P.sys, "platform", "linux"), patch.object(P.os, "getuid", return_value=1000, create=True):
            P.admission(env)
            for key, value in (("GITHUB_REF", P.S.BRANCH), ("GITHUB_EVENT_NAME", "push"), ("RUNNER_ARCH", "ARM64"),
                    ("CREATOR_NATIVE_LINUX_PRODUCTION_016", "0"), ("NODE_OPTIONS", "--require=/tmp/other"), ("APPIMAGE", "/tmp/other")):
                with self.assertRaises(RuntimeError):
                    P.admission({**env, key: value})
        tree = ast.parse((HERE / "native-linux-production-016-stage.py").read_text())
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                 and isinstance(n.func.value, ast.Name) and n.func.value.id == "subprocess"]
        self.assertEqual(len(calls), 1)
        command = calls[0].args[0]
        self.assertIsInstance(command, ast.List)
        self.assertEqual(command.elts[0].value, "node")
        self.assertEqual(command.elts[-1].value, "--verify-staged")


if __name__ == "__main__":
    unittest.main(verbosity=2)
