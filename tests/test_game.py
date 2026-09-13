import json
from pathlib import Path
import tempfile
import unittest
import chess
import chess.pgn
import io
import numpy as np
import cv2
from game import Game
from vision import rank_moves, changed_squares, rectify, decode_image, encode

def picture(board):
    im=np.zeros((640,640,3),np.uint8)
    for r in range(8):
        for c in range(8):
            im[r*80:(r+1)*80,c*80:(c+1)*80]=[100,140,100] if (r+c)%2 else [220,230,210]
            p=board.piece_at(chess.square(c,7-r))
            if p:cv2.circle(im,(c*80+40,r*80+40),22,(250,250,250) if p.color else (20,20,20),-1)
    return im

class GameTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.g=Game(Path(self.temp.name)/'game.json')
    def tearDown(self):
        if self.g.engine:self.g.engine.quit()
        self.temp.cleanup()
    def start(self,color='white',fen=''):
        self.g.start({'player':color,'camera_mode':False,'fen':fen})
    def test_proposal_not_committed_until_confirmation(self):
        self.start();self.g.propose('e2e4');self.assertEqual(len(self.g.board.move_stack),0)
        self.g.confirm();self.assertEqual(self.g.board.peek().uci(),'e2e4')
    def test_illegal_move_rejected(self):
        self.start()
        with self.assertRaises(ValueError):self.g.propose('e2e5')
    def test_camera_needs_current_frame(self):
        self.g.baseline=picture(chess.Board());self.g.start({'player':'white','camera_mode':True})
        self.g.propose('e2e4')
        with self.assertRaises(ValueError):self.g.confirm()
        self.g.scan_frame=self.g.baseline;self.g.scan_revision=self.g.revision;self.g.confirm()
    def test_engine_pending_then_commit_and_undo(self):
        self.start();self.g.propose('e2e4');self.g.confirm();self.g.engine_move()
        self.assertIsNotNone(self.g.pending);self.assertEqual(len(self.g.board.move_stack),1)
        self.g.execute_computer();self.assertEqual(len(self.g.board.move_stack),2)
        self.g.undo();self.assertEqual(self.g.board.fen(),chess.STARTING_FEN)
    def test_black_gets_opening_move(self):
        self.start('black');self.g.engine_move();self.assertIsNotNone(self.g.pending)
        self.g.execute_computer();self.assertEqual(self.g.board.turn,chess.BLACK)
    def test_persist_replay(self):
        self.start();self.g.propose('e2e4');self.g.confirm();h=Game(self.g.path)
        self.assertEqual(h.board.fen(),self.g.board.fen());self.assertEqual(h.state()['history'][0]['san'],'e4')
        pgn=chess.pgn.read_game(io.StringIO(self.g.pgn()));self.assertEqual(pgn.end().board().fen(),self.g.board.fen())
    def test_undo_pending_computer(self):
        self.start();self.g.propose('e2e4');self.g.confirm();self.g.engine_move();self.g.undo()
        self.assertIsNone(self.g.pending);self.assertEqual(self.g.board.fen(),chess.STARTING_FEN)
    def test_special_moves(self):
        self.start(fen='r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1')
        m=chess.Move.from_uci('e1g1');self.assertEqual(len(changed_squares(self.g.board,m)),4)
        self.g.propose('e1g1');self.g.confirm();self.assertEqual(self.g.board.piece_at(chess.F1).symbol(),'R')
        self.start(fen='4k3/P7/8/8/8/8/8/4K3 w - - 0 1');self.g.propose('a7a8n');self.g.confirm();self.assertEqual(self.g.board.piece_at(chess.A8).symbol(),'N')
    def test_en_passant_and_game_over(self):
        b=chess.Board('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1')
        self.assertEqual(len(changed_squares(b,chess.Move.from_uci('e5d6'))),3)
        self.start(fen='7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');self.assertEqual(self.g.state()['result'],'1-0')
    def test_stale_revision(self):
        rev=self.g.revision;self.start()
        with self.assertRaises(ValueError):self.g.check_revision(rev)
    def test_camera_reset_after_undo(self):
        self.start();self.g.propose('e2e4');self.g.confirm();self.g.camera_mode=True;self.g.baseline=np.ones((640,640,3));self.g.undo();self.assertIsNone(self.g.baseline)
    def test_rank_change(self):
        b=chess.Board();a=picture(b);after=b.copy();after.push_uci('e2e4')
        moves,_,warning=rank_moves(b,a,picture(after));self.assertEqual(moves[0]['uci'],'e2e4');self.assertFalse(warning)
    def test_no_change_or_lifted_piece(self):
        b=chess.Board();a=picture(b);self.assertEqual(rank_moves(b,a,a)[0],[])
        b.remove_piece_at(chess.E2);self.assertTrue(rank_moves(chess.Board(),a,picture(b))[2])
    def test_castling_and_en_passant_vision(self):
        for fen,uci in [('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','e1g1'),('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1','e5d6')]:
            b=chess.Board(fen);a=picture(b);other=b.copy();other.push_uci(uci)
            self.assertEqual(rank_moves(b,a,picture(other))[0][0]['uci'],uci)
    def test_calibration_and_codec(self):
        im=picture(chess.Board());self.assertEqual(decode_image(encode(im)).shape,im.shape)
        self.assertEqual(rectify(im,[[0,0],[1,0],[1,1],[0,1]]).shape,im.shape)
        with self.assertRaises(ValueError):rectify(im,[[0,0],[0,0],[0,0],[0,0]])

if __name__=='__main__':unittest.main()
