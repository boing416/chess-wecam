import unittest
from unittest.mock import patch
import chess
import vision

class ModelOptionalTest(unittest.TestCase):
    def test_clear_difference_never_needs_model(self):
        ranked = [{'uci': 'd7d5', 'score': .8}, {'uci': 'd7d6', 'score': .2}]
        with patch.object(vision, 'rank_moves', return_value=(ranked, ['d7','d5'], '')), patch.object(vision, 'ask_model') as model:
            result = vision.recognize_move(chess.Board(), None, None, True)
            self.assertEqual(result['uci'], 'd7d5')
            model.assert_not_called()

    def test_ambiguous_difference_stays_unconfirmed_without_model(self):
        ranked = [{'uci': 'e2e4', 'score': .5}, {'uci': 'e2e3', 'score': .45}]
        with patch.object(vision, 'rank_moves', return_value=(ranked, [], '')), patch.object(vision, 'ask_model') as model:
            result = vision.recognize_move(chess.Board(), None, None)
            self.assertIsNone(result['uci'])
            self.assertTrue(result['warning'])
            model.assert_not_called()
