"""Exercise complete games through a separate loopback server and temp data."""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import chess
from test_game import picture
from vision import encode


class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.proc = subprocess.Popen(
            [sys.executable, "server.py", "--port", str(cls.port)],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "CHESS_CAM_DATA": cls.temp.name},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cls.base = f"http://127.0.0.1:{cls.port}"
        for _ in range(100):
            try:
                with urllib.request.urlopen(cls.base + "/api/state", timeout=0.2):
                    return
            except Exception:
                time.sleep(0.05)
        raise RuntimeError("Test server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)
        cls.temp.cleanup()

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as r:
            return json.load(r)

    def post(self, path, **data):
        data = {"revision": self.get("/api/state")["revision"], **data}
        req = urllib.request.Request(
            self.base + "/api/" + path,
            json.dumps(data).encode(),
            {"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)

    def test_complete_camera_cycle_correction_and_undo(self):
        self.post("camera-reset")
        b = chess.Board()
        corners = [[0, 0], [1, 0], [1, 1], [0, 1]]
        self.post("calibrate", image=encode(picture(b)), corners=corners)
        self.post("start", camera_mode=True, player="white")
        b.push_uci("e2e4")
        result = self.post("scan", image=encode(picture(b)), use_model=False)
        self.assertEqual(result["state"]["proposal"]["uci"], "e2e4")
        self.assertEqual(result["state"]["history"], [])
        self.post("cancel")
        self.post("propose", uci="e2e4")
        result = self.post("confirm")
        self.assertEqual(len(result["state"]["history"]), 1)
        pending = result["state"]["pending"]["uci"]
        b.push_uci(pending)
        result = self.post("computer", image=encode(picture(b)))
        self.assertNotIn("verify_required", result)
        self.assertEqual(len(result["state"]["history"]), 2)
        result = self.post("undo")
        self.assertEqual(result["state"]["fen"], chess.STARTING_FEN)
        self.assertFalse(result["state"]["synced"])

    def test_unmoved_computer_is_not_committed(self):
        b = chess.Board()
        self.post(
            "calibrate",
            image=encode(picture(b)),
            corners=[[0, 0], [1, 0], [1, 1], [0, 1]],
        )
        self.post("start", camera_mode=True, player="black")
        result = self.post("computer", image=encode(picture(b)))
        self.assertTrue(result["verify_required"])
        self.assertEqual(result["state"]["history"], [])

    def test_host_origin_and_data_access(self):
        for headers in [{"Host": "evil.example"}, {"Origin": "https://evil.example"}]:
            req = urllib.request.Request(self.base + "/api/state", headers=headers)
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req)
            self.assertEqual(cm.exception.code, 403)
        for path in ["/data/game.json", "/.git/config", "/../server.py"]:
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(self.base + path)
            self.assertEqual(cm.exception.code, 404)

    def test_invalid_and_stale_requests(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.post("start", player="white", camera_mode=False, fen="bad")
        with self.assertRaises(urllib.error.HTTPError):
            self.post("start", player="white", camera_mode=False, revision=-1)

    def test_pieces_are_available(self):
        for piece in "PNBRQKpnbrqk":
            with urllib.request.urlopen(self.base + "/pieces/" + piece + ".svg") as r:
                self.assertIn(b"<svg", r.read())


if __name__ == "__main__":
    unittest.main()
