"""Loopback-only Chess Cam server. No camera frames leave this computer."""

import argparse
import json
import mimetypes
import os
from pathlib import Path
import threading
import queue
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.parse
import chess
import chess.svg
import cv2
from game import Game
import vision

ROOT = Path(__file__).resolve().parent
GAME = Game(Path(os.environ.get("CHESS_CAM_DATA", str(ROOT / "data"))) / "game.json")


class Handler(BaseHTTPRequestHandler):
    def send(self, status, data, kind="application/json; charset=utf-8"):
        raw = (
            json.dumps(data, ensure_ascii=False).encode()
            if kind.startswith("application/json")
            else (data.encode() if isinstance(data, str) else data)
        )
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
        )
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def allowed(self):
        host = self.headers.get("Host", "").split(":")[0]
        origin = self.headers.get("Origin")
        return host in ["127.0.0.1", "localhost"] and (
            not origin or origin == f'http://{self.headers.get("Host")}'
        )

    def do_GET(self):
        if not self.allowed():
            return self.send(403, {"error": "Доступ только с этого компьютера."})
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/state":
            with GAME.lock:
                return self.send(200, GAME.state())
        if path == "/api/status":
            import shutil

            return self.send(
                200,
                {
                    "lm": vision.lm_status(),
                    "engine": bool(
                        shutil.which("stockfish")
                        or Path("/opt/homebrew/bin/stockfish").exists()
                    ),
                    "local": True,
                },
            )
        if path == "/api/pgn":
            with GAME.lock:
                return self.send(
                    200, GAME.pgn(), "application/x-chess-pgn; charset=utf-8"
                )
        if path.startswith("/pieces/"):
            name = path.rsplit("/", 1)[-1].removesuffix(".svg")
            if name in "PNBRQKpnbrqk" and len(name) == 1:
                return self.send(
                    200,
                    chess.svg.piece(chess.Piece.from_symbol(name), size=80),
                    "image/svg+xml",
                )
            return self.send(404, {"error": "Нет фигуры"})
        file = ROOT / "static" / ("index.html" if path == "/" else path.lstrip("/"))
        if (
            not file.resolve().is_relative_to((ROOT / "static").resolve())
            or not file.is_file()
        ):
            return self.send(404, {"error": "Не найдено"})
        return self.send(
            200,
            file.read_bytes(),
            mimetypes.guess_type(file.name)[0] or "application/octet-stream",
        )

    def do_POST(self):
        if not self.allowed():
            return self.send(403, {"error": "Доступ только с этого компьютера."})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 12_000_000:
                raise ValueError("Кадр слишком большой.")
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise ValueError("Ожидается JSON.")
            data = json.loads(self.rfile.read(n))
            action = self.path
            if action in ["/api/scan", "/api/recognize"]:
                return self.scan(action, data)
            with GAME.lock:
                GAME.check_revision(data.get("revision"))
                if action == "/api/camera-reset":
                    GAME.baseline = None
                    GAME.corners = None
                    GAME.proposal = None
                    GAME.scan_frame = None
                    GAME.scan_revision = None
                    GAME.scan_id += 1
                    GAME.revision += 1
                    GAME.save()
                elif action == "/api/calibrate":
                    if GAME.proposal:
                        raise ValueError("Сначала отмените распознанный ход.")
                    frame = vision.decode_image(data["image"])
                    corners = data["corners"]
                    baseline = vision.rectify(frame, corners)
                    GAME.corners = corners
                    GAME.baseline = baseline
                    GAME.revision += 1
                    GAME.scan_id += 1
                    GAME.save()
                elif action == "/api/sync":
                    if GAME.corners is None:
                        raise ValueError("Сначала отметьте углы доски.")
                    if GAME.proposal:
                        raise ValueError("Сначала отмените распознанный ход.")
                    GAME.baseline = vision.rectify(
                        vision.decode_image(data["image"]), GAME.corners
                    )
                    GAME.revision += 1
                    GAME.scan_id += 1
                    GAME.save()
                elif action == "/api/prepare-new":
                    GAME.prepare_new()
                elif action == "/api/start":
                    GAME.start(data)
                elif action == "/api/propose":
                    manual_frame = None
                    if GAME.camera_mode and data.get("image"):
                        if GAME.corners is None:
                            raise ValueError("Сначала отметьте углы доски.")
                        manual_frame = vision.rectify(vision.decode_image(data["image"]), GAME.corners)
                    GAME.propose(data["uci"])
                    if manual_frame is not None:
                        GAME.scan_frame = manual_frame
                        GAME.scan_revision = GAME.revision
                elif action == "/api/confirm":
                    GAME.confirm()
                elif action == "/api/cancel":
                    GAME.proposal = None
                    GAME.scan_id += 1
                elif action == "/api/undo":
                    GAME.undo()
                elif action == "/api/computer":
                    frame = None
                    if GAME.camera_mode:
                        if not GAME.pending or GAME.baseline is None:
                            raise ValueError("Сначала синхронизируйте доску.")
                        frame = vision.rectify(
                            vision.decode_image(data["image"]), GAME.corners
                        )
                        rankings, changed, warning = vision.rank_moves(
                            GAME.board, GAME.baseline, frame
                        )
                        expected = next(
                            (m for m in rankings if m["uci"] == GAME.pending), None
                        )
                        if not data.get("manual") and (
                            not expected
                            or expected["strength"] < 4
                            or expected["coverage"] < 0.6
                        ):
                            return self.send(
                                200,
                                {
                                    "state": GAME.state(),
                                    "verify_required": True,
                                    "message": "Камера не смогла подтвердить ход компьютера. Сверьте все переставленные фигуры со стрелкой.",
                                },
                            )
                    GAME.execute_computer(frame)
                elif action == "/api/engine":
                    pass
                else:
                    return self.send(404, {"error": "Неизвестная команда"})
            if action in ["/api/start", "/api/confirm", "/api/engine"]:
                try:
                    GAME.engine_move()
                except Exception:
                    with GAME.lock:
                        return self.send(
                            200,
                            {
                                "state": GAME.state(),
                                "warning": "Ход сохранён, но Stockfish не ответил. Нажмите «Повторить расчёт».",
                            },
                        )
            with GAME.lock:
                return self.send(200, {"state": GAME.state()})
        except (ValueError, KeyError, TypeError) as exc:
            return self.send(400, {"error": str(exc)})
        except Exception as exc:
            print("Request error:", type(exc).__name__, str(exc), flush=True)
            return self.send(
                500,
                {
                    "error": "Не удалось выполнить действие. Партия сохранена; попробуйте ещё раз."
                },
            )

    def scan(self, action, data):
        if not GAME.scan_lock.acquire(blocking=False):
            raise ValueError("Предыдущий кадр ещё обрабатывается.")
        try:
            with GAME.lock:
                GAME.check_revision(data.get("revision"))
                if GAME.corners is None:
                    raise ValueError("Сначала отметьте углы доски.")
                after = vision.rectify(vision.decode_image(data["image"]), GAME.corners)
                rev = GAME.revision
                scan_id = GAME.scan_id
                board = GAME.board.copy()
                if action == "/api/scan":
                    if not GAME.active or GAME.pending or board.turn != GAME.player:
                        raise ValueError("Сейчас не ваш ход.")
                    if GAME.baseline is None:
                        raise ValueError(
                            "Подтвердите расстановку после возврата хода или перезапуска."
                        )
                    before = GAME.baseline.copy()
            if action == "/api/recognize":
                answer = vision.ask_model(
                    'Read this physical chessboard. Each square is labelled. Return ONLY JSON {"placement":"8/8/8/8/8/8/8/8"} with actual FEN piece placement. Uppercase=white, lowercase=black; p pawn, n knight, b bishop, r rook, q queen, k king. Read ranks 8 to 1, files a to h. Do not invent obscured pieces. If you cannot see all pieces return {"placement":null}.',
                    [after],
                )
                placement = answer.get("placement")
                if not placement:
                    raise ValueError(
                        "Модель не смогла прочитать позицию. Проверьте ракурс и освещение."
                    )
                test = chess.Board(placement + " w - - 0 1")
                if (
                    len(test.pieces(chess.KING, chess.WHITE)) != 1
                    or len(test.pieces(chess.KING, chess.BLACK)) != 1
                ):
                    raise ValueError(
                        "Модель не нашла обоих королей. Попробуйте кадр ближе к виду сверху."
                    )
                with GAME.lock:
                    GAME.check_revision(rev)
                    return self.send(
                        200, {"placement": placement, "preview": vision.encode(after)}
                    )
            completed = queue.Queue(maxsize=1)

            def recognize():
                try:
                    completed.put((vision.recognize_move(
                        board, before, after, bool(data.get("use_model", False))
                    ), None))
                except Exception as exc:
                    completed.put((None, exc))

            threading.Thread(target=recognize, daemon=True).start()
            while True:
                with GAME.lock:
                    if GAME.scan_id != scan_id:
                        raise ValueError("Распознавание остановлено.")
                try:
                    result, error = completed.get(timeout=0.1)
                    if error:
                        raise error
                    break
                except queue.Empty:
                    continue
            with GAME.lock:
                GAME.check_revision(rev)
                if GAME.scan_id != scan_id:
                    raise ValueError("Распознавание отменено. Сделайте новый кадр.")
                GAME.scan_frame = after
                GAME.scan_revision = rev
                GAME.proposal = None
                if result["uci"]:
                    GAME.propose(result["uci"])
                return self.send(
                    200,
                    {
                        "state": GAME.state(),
                        "recognition": result,
                        "preview": vision.encode(after),
                    },
                )
        finally:
            GAME.scan_lock.release()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Chess Cam → http://localhost:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if GAME.engine:
            GAME.engine.quit()
