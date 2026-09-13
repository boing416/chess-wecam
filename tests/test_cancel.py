import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import chess
import server


class CancelScanTest(unittest.TestCase):
    def test_cancel_releases_scan_and_discards_late_result(self):
        entered, finish = threading.Event(), threading.Event()
        game = SimpleNamespace(
            scan_lock=threading.Lock(), lock=threading.Lock(), corners=[],
            revision=0, scan_id=0, board=chess.Board(), active=True,
            pending=None, player=chess.WHITE, baseline=chess.Board(),
            check_revision=lambda revision: None,
        )
        errors = []
        def slow(*args):
            entered.set()
            finish.wait(3)
            return {'uci': 'e2e4'}
        handler = object.__new__(server.Handler)
        def run():
            try:
                handler.scan('/api/scan', {'image': 'test'})
            except ValueError as exc:
                errors.append(str(exc))
        with patch.object(server, 'GAME', game), patch.object(server.vision, 'decode_image'), patch.object(server.vision, 'rectify'), patch.object(server.vision, 'recognize_move', slow):
            thread = threading.Thread(target=run)
            thread.start()
            try:
                self.assertTrue(entered.wait(1))
                with game.lock:
                    game.scan_id += 1
                thread.join(1)
                self.assertFalse(thread.is_alive())
                self.assertFalse(game.scan_lock.locked())
                self.assertEqual(errors, ['Распознавание остановлено.'])
            finally:
                finish.set()
                thread.join(2)
