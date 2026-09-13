import datetime
import json
import os
from pathlib import Path
import shutil
import threading
import chess
import chess.engine
import chess.pgn


class Game:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.engine_lock = threading.Lock()
        self.engine = None
        self.board = chess.Board()
        self.player = chess.WHITE
        self.level = 5
        self.active = False
        self.pending = None
        self.proposal = None
        self.revision = 0
        self.camera_mode = True
        self.baseline = None
        self.corners = None
        self.scan_frame = None
        self.scan_revision = None
        self.scan_id = 0
        self.scan_lock = threading.Lock()
        self.load_error = None
        if self.path.exists():
            try:
                d = json.loads(self.path.read_text())
                self.board = chess.Board(d["initial_fen"])
                for uci in d["moves"]:
                    self.board.push_uci(uci)
                self.player = d["player"]
                self.level = d["level"]
                self.active = d["active"]
                self.pending = d.get("pending")
                self.camera_mode = d.get("camera_mode", True)
                self.corners = d.get("corners")
            except Exception:
                self.load_error = "Не удалось прочитать сохранённую партию. Исходный файл оставлен на диске."
                self.board = chess.Board()
                self.active = False
                self.pending = None

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "initial_fen": self.board.root().fen(),
            "moves": [m.uci() for m in self.board.move_stack],
            "player": self.player,
            "level": self.level,
            "active": self.active,
            "pending": self.pending,
            "camera_mode": self.camera_mode,
            "corners": self.corners,
        }
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        os.replace(tmp, self.path)

    def check_revision(self, revision):
        if revision != self.revision:
            raise ValueError(
                "Позиция уже изменилась. Обновите кадр и повторите действие."
            )

    def state(self):
        b = self.board.root()
        history = []
        for m in self.board.move_stack:
            history.append(
                {
                    "uci": m.uci(),
                    "san": b.san(m),
                    "color": "white" if b.turn else "black",
                    "number": b.fullmove_number,
                }
            )
            b.push(m)
        outcome = self.board.outcome(claim_draw=True)
        pending = None
        if self.pending:
            m = chess.Move.from_uci(self.pending)
            pending = {
                "uci": self.pending,
                "san": self.board.san(m),
                "squares": [
                    chess.square_name(s)
                    for s in __import__("vision").changed_squares(self.board, m)
                ],
            }
        return {
            "fen": self.board.fen(),
            "pieces": {
                chess.square_name(s): p.symbol()
                for s, p in self.board.piece_map().items()
            },
            "turn": "white" if self.board.turn else "black",
            "player": "white" if self.player else "black",
            "level": self.level,
            "active": self.active,
            "pending": pending,
            "proposal": self.proposal,
            "history": history,
            "legal": [
                {"uci": m.uci(), "san": self.board.san(m)}
                for m in self.board.legal_moves
            ],
            "revision": self.revision,
            "check": self.board.is_check(),
            "result": outcome.result() if outcome else None,
            "termination": outcome.termination.name if outcome else None,
            "camera_mode": self.camera_mode,
            "calibrated": self.corners is not None,
            "synced": self.baseline is not None,
            "corners": self.corners,
            "load_error": self.load_error,
        }

    def start(self, data):
        board = chess.Board(data.get("fen") or chess.STARTING_FEN)
        if not board.is_valid():
            raise ValueError(
                "Некорректная позиция: проверьте королей, пешки и очередь хода."
            )
        level = int(data.get("level", 5))
        if level not in range(1, 21):
            raise ValueError("Уровень должен быть от 1 до 20.")
        if data.get("player") not in ["white", "black"]:
            raise ValueError("Выберите цвет.")
        camera_mode = bool(data.get("camera_mode", True))
        if camera_mode and self.baseline is None:
            raise ValueError(
                "Включите камеру, отметьте углы и подтвердите исходную расстановку."
            )
        # Preserve every previous game before replacing it.
        if self.board.move_stack:
            archive = self.path.parent / (
                "game-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".pgn"
            )
            archive.write_text(self.pgn())
        self.board = board
        self.player = data["player"] == "white"
        self.level = level
        self.active = True
        self.camera_mode = camera_mode
        self.pending = None
        self.proposal = None
        self.scan_frame = None
        self.scan_revision = None
        self.revision += 1
        self.save()

    def propose(self, uci):
        if (
            not self.active
            or self.pending
            or self.board.turn != self.player
            or self.board.is_game_over(claim_draw=True)
        ):
            raise ValueError("Сейчас не ваш ход.")
        move = chess.Move.from_uci(uci)
        if move not in self.board.legal_moves:
            raise ValueError("Этот ход невозможен по правилам шахмат.")
        self.proposal = {"uci": uci, "san": self.board.san(move)}

    def confirm(self):
        if not self.proposal:
            raise ValueError("Сначала укажите или распознайте ход.")
        if self.camera_mode and (
            self.scan_frame is None or self.scan_revision != self.revision
        ):
            raise ValueError("Нужен новый кадр: сначала нажмите «Я походил».")
        move = chess.Move.from_uci(self.proposal["uci"])
        if move not in self.board.legal_moves:
            raise ValueError("Ход больше недоступен.")
        self.board.push(move)
        self.proposal = None
        if self.camera_mode:
            self.baseline = self.scan_frame.copy()
        self.scan_frame = None
        self.scan_revision = None
        self.revision += 1
        self.save()

    def engine_move(self):
        with self.lock:
            if (
                not self.active
                or self.board.turn == self.player
                or self.board.is_game_over(claim_draw=True)
                or self.pending
            ):
                return
            rev = self.revision
            board = self.board.copy()
            level = self.level
        with self.engine_lock:
            if self.engine is None:
                path = shutil.which("stockfish") or next(
                    (
                        p
                        for p in [
                            "/opt/homebrew/bin/stockfish",
                            "/usr/local/bin/stockfish",
                        ]
                        if Path(p).exists()
                    ),
                    None,
                )
                if not path:
                    raise ValueError("Stockfish не установлен. Выполните setup.sh.")
                self.engine = chess.engine.SimpleEngine.popen_uci(path)
                self.engine.configure({"Threads": 2, "Hash": 128})
            result = self.engine.play(
                board,
                chess.engine.Limit(time=0.5 + level * 0.035),
                options={"Skill Level": level - 1},
            )
        with self.lock:
            if self.revision == rev and result.move:
                self.pending = result.move.uci()
                self.revision += 1
                self.save()

    def execute_computer(self, frame=None):
        if not self.pending:
            raise ValueError("Нет ожидающего хода компьютера.")
        if self.camera_mode and frame is None:
            raise ValueError("Нужен кадр переставленной позиции.")
        self.board.push_uci(self.pending)
        self.pending = None
        self.proposal = None
        self.baseline = frame
        self.scan_frame = None
        self.scan_revision = None
        self.revision += 1
        self.save()

    def undo(self):
        if self.proposal:
            self.proposal = None
            self.scan_frame = None
            self.scan_revision = None
            return
        if self.pending:
            self.pending = None
            if self.board.move_stack:
                self.board.pop()
        elif self.board.move_stack:
            self.board.pop()
            if self.board.turn != self.player and self.board.move_stack:
                self.board.pop()
        if self.camera_mode:
            self.baseline = None
        self.scan_frame = None
        self.scan_revision = None
        self.revision += 1
        self.save()

    def pgn(self):
        game = chess.pgn.Game.from_board(self.board)
        game.headers.update(
            Event="Chess Cam · Local",
            White="Вы" if self.player else "Stockfish",
            Black="Stockfish" if self.player else "Вы",
        )
        return str(game) + "\n"
