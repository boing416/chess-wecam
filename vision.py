"""Local board rectification and conservative, legal-move change detection."""

import base64
import json
import re
import urllib.request
import cv2
import numpy as np
import chess

LM_URL = "http://127.0.0.1:1234/v1"
MODEL = "chess-vision"
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SIZE = 640


def decode_image(uri):
    if (
        not isinstance(uri, str)
        or not uri.startswith("data:image/")
        or len(uri) > 12_000_000
    ):
        raise ValueError("Нет корректного кадра с камеры.")
    image = cv2.imdecode(
        np.frombuffer(base64.b64decode(uri.split(",", 1)[1], validate=True), np.uint8),
        cv2.IMREAD_COLOR,
    )
    if image is None or image.shape[0] < 80 or image.shape[1] < 80:
        raise ValueError("Кадр камеры не удалось прочитать.")
    return image


def rectify(image, corners):
    points = np.array(corners, dtype=np.float32)
    if (
        points.shape != (4, 2)
        or not np.isfinite(points).all()
        or (points < 0).any()
        or (points > 1).any()
    ):
        raise ValueError("Отметьте четыре угла: a8, h8, h1, a1.")
    contour = points.reshape(-1, 1, 2)
    if not cv2.isContourConvex(contour) or abs(cv2.contourArea(contour)) < 0.025:
        raise ValueError("Углы должны образовывать четырёхугольник вокруг всей доски.")
    points *= [image.shape[1], image.shape[0]]
    matrix = cv2.getPerspectiveTransform(
        points,
        np.array(
            [[0, 0], [SIZE - 1, 0], [SIZE - 1, SIZE - 1], [0, SIZE - 1]], np.float32
        ),
    )
    return cv2.warpPerspective(image, matrix, (SIZE, SIZE))


def encode(image):
    ok, data = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not ok:
        raise ValueError("Не удалось подготовить изображение.")
    return "data:image/jpeg;base64," + base64.b64encode(data).decode()


def labelled(image):
    out = image.copy()
    for r in range(8):
        for c in range(8):
            x, y = c * 80 + 3, r * 80 + 15
            label = chr(97 + c) + str(8 - r)
            cv2.putText(out, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 3)
            cv2.putText(
                out, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1
            )
    return out


def differences(before, after):
    # Remove a global exposure shift; blur sensor noise; ignore square borders.
    a = cv2.GaussianBlur(before.astype(np.float32), (5, 5), 0)
    b = cv2.GaussianBlur(after.astype(np.float32), (5, 5), 0)
    shift = np.median(b - a, axis=(0, 1))
    diff = np.mean(np.abs(b - a - shift), axis=2)
    values = {}
    for r in range(8):
        for c in range(8):
            crop = diff[r * 80 + 10 : r * 80 + 70, c * 80 + 10 : c * 80 + 70]
            values[chess.square(c, 7 - r)] = float(np.mean(crop))
    return values


def changed_squares(board, move):
    other = board.copy()
    other.push(move)
    return {sq for sq in chess.SQUARES if board.piece_at(sq) != other.piece_at(sq)}


def rank_moves(board, before, after):
    values = differences(before, after)
    noise = float(np.median(list(values.values())))
    signal = {s: max(0, v - noise - 2) for s, v in values.items()}
    total = sum(signal.values())
    changed = [
        chess.square_name(s)
        for s, v in sorted(signal.items(), key=lambda x: -x[1])
        if v > 6
    ]
    if total < 12 or max(signal.values()) < 6:
        return (
            [],
            changed,
            "Не вижу изменения позиции. Сделайте ход и уберите руку из кадра.",
        )
    results = []
    for move in board.legal_moves:
        squares = changed_squares(board, move)
        scores = [signal[s] for s in squares]
        coverage = sum(scores) / (total + 1e-6)
        strength = min(scores)
        score = coverage * min(1, strength / 10)
        results.append(
            {
                "uci": move.uci(),
                "san": board.san(move),
                "score": round(score, 3),
                "coverage": round(coverage, 3),
                "strength": round(strength, 2),
            }
        )
    results.sort(key=lambda x: -x["score"])
    if not results or results[0]["strength"] < 4 or results[0]["coverage"] < 0.42:
        return (
            results[:5],
            changed,
            "Кадр неоднозначен: уберите руку, проверьте свет и неподвижность камеры.",
        )
    return results[:5], changed, ""


def lm_status():
    try:
        with HTTP.open(LM_URL + "/models", timeout=2) as r:
            models = [
                m["id"]
                for m in json.load(r).get("data", [])
                if "embedding" not in m["id"]
            ]
        return {
            "available": bool(models),
            "models": models,
            "model": MODEL if MODEL in models else (models[0] if models else None),
        }
    except Exception:
        return {"available": False, "models": [], "model": None}


def ask_model(prompt, images):
    status = lm_status()
    if not status["available"]:
        raise ValueError(
            "LM Studio недоступен. Запустите локальный сервер и загрузите модель с поддержкой изображений."
        )
    content = [{"type": "text", "text": prompt}] + [
        {"type": "image_url", "image_url": {"url": encode(labelled(im))}}
        for im in images
    ]
    data = {
        "model": status["model"],
        "messages": [{"role": "user", "content": content}],
        "temperature": 0,
        "max_tokens": 1000,
        "stream": False,
    }
    req = urllib.request.Request(
        LM_URL + "/chat/completions",
        json.dumps(data).encode(),
        {"Content-Type": "application/json"},
    )
    try:
        with HTTP.open(req, timeout=90) as r:
            answer = json.load(r)["choices"][0]["message"]["content"] or ""
    except Exception as exc:
        raise ValueError(
            "Модель не ответила на изображение. Проверьте загрузку vision-модели в LM Studio."
        ) from exc
    answer = re.sub(r"<think>.*?</think>", "", answer, flags=re.S)
    match = re.search(r"\{[^{}]*\}", answer, re.S)
    if not match:
        raise ValueError(
            "Модель не вернула понятный результат. Уточните позицию вручную."
        )
    return json.loads(match.group())


def recognize_move(board, before, after, use_model=True):
    ranked, changed, warning = rank_moves(board, before, after)
    result = {
        "candidates": ranked,
        "changed": changed,
        "warning": warning,
        "method": "Локальное сравнение кадров",
        "uci": None,
    }
    if not ranked or warning:
        return result
    best = ranked[0]
    if use_model:
        try:
            candidates = [m["uci"] for m in ranked if m["score"] > 0.15]
            answer = ask_model(
                "Two photos of the SAME physical chessboard, BEFORE and AFTER one move. "
                "Each square is labelled. Current FEN before move: "
                + board.fen()
                + ". "
                "Identify the single move actually made, comparing both photos. "
                "Allowed candidate moves in UCI: " + json.dumps(candidates) + ". "
                "Do NOT suggest a good chess move. Report only what visibly changed. "
                "If a hand obscures pieces or the move is unfinished, use null. "
                'Return JSON only: {"move":"e2e4", "confidence":0.9} or {"move":null,"confidence":0}.',
                [before, after],
            )
            uci = answer.get("move")
            confidence = float(answer.get("confidence", 0))
            if uci in candidates and confidence >= 0.65:
                result.update(uci=uci, method="Gemma + сравнение кадров")
                return result
            result["warning"] = (
                "Модель не уверена в ходе. Выберите вариант или укажите ход на доске."
            )
            return result
        except ValueError as exc:
            result["warning"] = str(exc) + " Показан результат сравнения кадров."
    gap = best["score"] - (ranked[1]["score"] if len(ranked) > 1 else 0)
    if best["score"] >= 0.55 and gap >= 0.12:
        result["uci"] = best["uci"]
    elif not result["warning"]:
        result["warning"] = "Есть несколько возможных ходов. Выберите правильный."
    return result
