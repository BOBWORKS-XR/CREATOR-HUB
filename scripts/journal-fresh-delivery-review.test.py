import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("review", Path(__file__).with_name("journal-fresh-delivery-review.py"))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def pin(raw):
    return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def example():
    installer = b"untrusted comment: synthetic test only\n"
    descriptor = {"appId": "creator-hub", "version": "0.1.17", "platform": "linux", "architecture": "x86_64",
                  "packageType": "deb", "assetName": review.ASSET_NAME, "byteLength": review.DEB["size"],
                  "sha256": review.DEB["sha256"], "executableSha256": review.HUB_SHA}
    latest = {"version": "0.1.17", "platforms": {"linux-x86_64-deb": {
        "url": "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.17/" + review.ASSET_NAME,
        "signature": base64.b64encode(installer).decode()}}}
    members = {"descriptor": json.dumps(descriptor).encode(), "descriptorSignature": b"synthetic descriptor signature",
               "latest": json.dumps(latest).encode(), "installerSignature": installer}
    expected = {"release": 2, "tag": "private-test", "asset": 3, "name": "test.zip",
                "zip": pin(b"synthetic ZIP"), "members": {key: pin(value) for key, value in members.items()}}
    release = {"id": 2, "tag_name": "private-test", "draft": True}
    asset = {"id": 3, "name": "test.zip", "size": expected["zip"]["size"], "state": "uploaded",
             "digest": "sha256:" + expected["zip"]["sha256"]}
    return expected, release, [copy.deepcopy(asset)], asset, members


class DeliveryReviewTests(unittest.TestCase):
    def test_synthetic_metadata_never_grants_authority(self):
        result = review.inspect(*example())
        self.assertEqual(result["status"], "DATA_ONLY_UNBOUND")
        self.assertTrue(all(value is False for key, value in result.items() if key != "status"))

    def test_every_member_is_byte_pinned(self):
        for role in review.ROLES:
            data = example(); data[-1][role] += b"x"
            with self.subTest(role=role), self.assertRaises(ValueError): review.inspect(*data)

    def test_draft_asset_alias_and_digest_refused(self):
        for mutation in (lambda x: x[1].update(draft=False), lambda x: x[3].update(digest="sha256:" + "0" * 64),
                         lambda x: x[2].append(dict(x[3], id=99)), lambda x: x[2].clear()):
            data = example(); mutation(data)
            with self.assertRaises(ValueError): review.inspect(*data)

    def test_wrong_target_and_duplicate_json_refused_even_with_repin(self):
        for raw in (b'{"appId":"creator-hub","appId":"other"}',
                    json.dumps({"appId": "creator-hub", "sha256": "0" * 64}).encode()):
            data = example(); data[-1]["descriptor"] = raw; data[0]["members"]["descriptor"] = pin(raw)
            with self.assertRaises(ValueError): review.inspect(*data)

    def test_installer_signature_must_equal_feed_bytes(self):
        data = example(); data[-1]["installerSignature"] += b"different"; data[0]["members"]["installerSignature"] = pin(data[-1]["installerSignature"])
        with self.assertRaises(ValueError): review.inspect(*data)

    def test_extra_or_missing_fields_and_unbounded_inputs_refused(self):
        for mutation in (lambda x: x[0].update(extra=True), lambda x: x[0]["members"].pop("latest"),
                         lambda x: x[0]["zip"].update(size=True), lambda x: x[2].extend([{}] * 100)):
            data = example(); mutation(data)
            with self.assertRaises(ValueError): review.inspect(*data)


if __name__ == "__main__":
    unittest.main()
