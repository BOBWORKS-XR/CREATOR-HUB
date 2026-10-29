"""Read-only checks of exact existing synthetic-continuation lifecycle ordering."""
import ast
from pathlib import Path
import unittest


ROOT = Path.cwd()


def function(file, name):
    tree = ast.parse((ROOT / "scripts" / file).read_bytes())
    return next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)


class ExistingBoundary(unittest.TestCase):
    def test_adoption_precedes_uid_inventory_and_quiescence(self):
        text = ast.unparse(function("native-linux-migrated-update.py", "changed_broker"))
        self.assertLess(text.index("sealed = changed_adopt(env, original)"), text.index("initial_uid_inventory = M.native_process_inventory"))
        self.assertLess(text.index("initial_uid_inventory = M.native_process_inventory"), text.index("fixture_quiescence(initial_uid_inventory"))
        self.assertEqual(text.count("M.native_process_inventory("), 1)

    def test_final_session_guard_precedes_agent_and_window_manager_cleanup(self):
        text = ast.unparse(function("native-linux-migrated-update.py", "changed_session"))
        self.assertLess(text.index("report['normalFinalClose'] = True"), text.index("guard.finish()"))
        self.assertLess(text.index("guard.finish()"), text.index("agent.terminate()"))
        self.assertLess(text.index("guard.finish()"), text.index("wm.wait(timeout=10)"))
        self.assertNotIn("native_process_inventory(", text)

    def test_inventory_is_uid_scoped_and_excludes_stable_mixed_uid_actor(self):
        text = ast.unparse(function("native-linux-production-016-migration.py", "native_process_inventory"))
        self.assertIn("file.stat().st_uid != UID", text)
        self.assertIn("identity['uids'] != [UID] * 4", text)
        self.assertIn("continue", text)


if __name__ == "__main__": unittest.main(verbosity=2)
