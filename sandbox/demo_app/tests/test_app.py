import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app  # noqa: E402
import inventory  # noqa: E402


class AppTests(unittest.TestCase):
    def test_config_valid(self):
        cfg = app.load_config()
        self.assertIsInstance(cfg["port"], int)

    def test_state_builds(self):
        state = app.build_state(app.load_config())
        self.assertGreater(len(state["items"]), 0)

    def test_total_value(self):
        items = [{"qty": 2, "price": 1.5}, {"qty": 1, "price": 3.0}]
        self.assertEqual(inventory.total_value(items), 6.0)


if __name__ == "__main__":
    unittest.main()
