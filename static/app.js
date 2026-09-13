"use strict";
const $ = (id) => document.getElementById(id);
let state = null,
  chosenColor = "white",
  flipped = false,
  selected = null,
  busy = false,
  scanStopped = false,
  candidatePreview = null,
  stream = null;
let corners = [],
  calibrationImage = null,
  pendingComputerFrame = null,
  preparing = false;
let queenCheck = -1;
const files = "abcdefgh",
  cornerLabels = ["a8", "h8", "h1", "a1"];
const names = {
  p: "Пешка",
  n: "Конь",
  b: "Слон",
  r: "Ладья",
  q: "Ферзь",
  k: "Король",
};
const capture = document.createElement("canvas");
function message(text, error = false) {
  for (const id of ["message", "setupMessage"]) {
    $(id).textContent = text;
    $(id).className = "message" + (error ? " error" : "");
  }
}
async function api(path, data) {
  const options =
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: state?.revision, ...data }),
        };
  const res = await fetch("/api/" + path, options);
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Ошибка соединения");
  return result;
}
async function work(label, fn) {
  if (busy) return;
  scanStopped = false;
  busy = true;
  candidatePreview = null;
  if (state) renderBoard();
  document.body.classList.add("working");
  message(label);
  $("message").classList.add("busy");
  $("setupMessage").classList.add("busy");
  renderControls();
  try {
    await fn();
  } catch (e) {
    message(scanStopped ? "Распознавание остановлено. Нажмите «Я походил», чтобы сделать новый снимок." : e.message, !scanStopped);
  } finally {
    $("stopScan").hidden = true;
    busy = false;
    document.body.classList.remove("working");
    $("message").classList.remove("busy");
    $("setupMessage").classList.remove("busy");
    renderControls();
  }
}
function apply(result) {
  if (result.state) {
    candidatePreview = null;
    $("manualMove").hidden = true;
    state = result.state;
    selected = null;
    render();
  }
  if (result.warning) message(result.warning, true);
}
function sqAt(row, col) {
  return files[flipped ? 7 - col : col] + (flipped ? row + 1 : 8 - row);
}
function pos(sq) {
  let c = files.indexOf(sq[0]),
    r = 8 - Number(sq[1]);
  if (flipped) {
    c = 7 - c;
    r = 7 - r;
  }
  return [(c + 0.5) * 100, (r + 0.5) * 100];
}
function moveText(uci) {
  const piece = state?.pieces[uci.slice(0, 2)];
  return `${names[piece?.toLowerCase()] || "Фигура"} ${uci.slice(0, 2)} → ${uci.slice(2, 4)}${uci[4] ? " · " + names[uci[4]] : ""}`;
}
function addArrow(from, to) {
  const [x1, y1] = pos(from),
    [x2, y2] = pos(to),
    line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  for (const [k, v] of Object.entries({ x1, y1, x2, y2 }))
    line.setAttribute(k, v);
  $("arrowLines").append(line);
}
function renderBoard() {
  if (!state) return;
  const frag = document.createDocumentFragment();
  const last = state.history.at(-1)?.uci;
  const targets = selected
    ? state.legal
        .filter((m) => m.uci.startsWith(selected))
        .map((m) => m.uci.slice(2, 4))
    : [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const sq = sqAt(r, c),
        piece = state.pieces[sq],
        button = document.createElement("button");
      button.className =
        "square" +
        ((r + c) % 2 ? " dark" : "") +
        (sq === selected ? " selected" : "") +
        (targets.includes(sq) ? " target" : "") +
        (last && (sq === last.slice(0, 2) || sq === last.slice(2, 4))
          ? " last"
          : "");
      button.dataset.square = sq;
      button.setAttribute("role", "gridcell");
      button.setAttribute(
        "aria-label",
        `${sq}${piece ? " " + (piece === piece.toUpperCase() ? "белые " : "чёрные ") + names[piece.toLowerCase()] : ", пусто"}`,
      );
      if (state.check && piece === (state.turn === "white" ? "K" : "k"))
        button.classList.add("in-check");
      if (piece) {
        const img = document.createElement("img");
        img.src = "/pieces/" + piece + ".svg";
        img.alt = "";
        button.append(img);
      }
      button.onclick = () => selectSquare(sq);
      frag.append(button);
    }
  $("board").replaceChildren(frag);
  $("files").replaceChildren(
    ...Array.from({ length: 8 }, (_, c) =>
      Object.assign(document.createElement("span"), {
        textContent: files[flipped ? 7 - c : c],
      }),
    ),
  );
  $("ranks").replaceChildren(
    ...Array.from({ length: 8 }, (_, r) =>
      Object.assign(document.createElement("span"), {
        textContent: flipped ? r + 1 : 8 - r,
      }),
    ),
  );
  $("arrowLines").replaceChildren();
  const arrow = state.proposal?.uci || state.pending?.uci || candidatePreview;
  if (arrow) {
    $("arrows").style.color = candidatePreview ? "#ad8cff" : "#efb13b";
    addArrow(arrow.slice(0, 2), arrow.slice(2, 4));
    const piece = state.pieces[arrow.slice(0, 2)];
    if (
      piece?.toLowerCase() === "k" &&
      Math.abs(files.indexOf(arrow[0]) - files.indexOf(arrow[2])) === 2
    ) {
      const rank = arrow[1];
      addArrow(
        (arrow[2] === "g" ? "h" : "a") + rank,
        (arrow[2] === "g" ? "f" : "d") + rank,
      );
    }
  }
}
function render() {
  if (!state) return;
  renderBoard();
  $("playerName").textContent =
    "Вы · " + (state.player === "white" ? "белые" : "чёрные");
  $("playerPiece").textContent = state.player === "white" ? "♔" : "♚";
  $("levelText").textContent = `Уровень ${state.level} · локально`;
  const byNumber = new Map();
  state.history.forEach((m) => {
    if (!byNumber.has(m.number)) byNumber.set(m.number, {});
    byNumber.get(m.number)[m.color] = m;
  });
  $("moveCount").textContent = state.history.length;
  if (state.history.length) {
    $("history").replaceChildren(
      ...[...byNumber].map(([num, moves]) => {
        const row = document.createElement("div");
        row.className = "history-row";
        for (const value of [
          num + ".",
          moves.white?.san || "—",
          moves.black?.san || "—",
        ]) {
          const span = document.createElement("span");
          span.textContent = value;
          row.append(span);
        }
        row.children[
          state.history.at(-1).color === "white" ? 1 : 2
        ].classList.toggle("latest", num === state.history.at(-1).number);
        return row;
      }),
    );
    $("history").scrollTop = $("history").scrollHeight;
  } else
    $("history").innerHTML =
      '<div class="empty-history"><span>♙</span><p>Каждая партия начинается<br>с первого хода.</p></div>';
  renderControls();
}
function renderControls() {
  if (!state) return;
  const active = state.active && !preparing,
    ended = !!state.result,
    computer = !!state.pending,
    yourTurn = state.turn === state.player,
    needsSync = state.camera_mode && (!state.synced || !stream);
  $("cameraMode").disabled = active;
  $("newGameSettings").hidden = active;
  $("activeControls").hidden = !active;
  $("start").disabled = busy;
  $("start").textContent =
    $("cameraMode").checked && !stream
      ? "1. Подключить камеру →"
      : $("cameraMode").checked && !state.synced
        ? state.calibrated
          ? "2. Подтвердить расстановку →"
          : "2. Отметить углы доски →"
        : "Начать партию →";
  $("scan").hidden = !yourTurn || computer || ended || !!state.proposal;
  $("pointMove").hidden = !yourTurn || computer || ended || !active || !!state.proposal;
  $("pointMove").disabled = busy || (state.camera_mode && !stream);
  $("scan").disabled = busy || (state.camera_mode && (!stream || needsSync));
  $("scan").textContent = state.camera_mode
    ? "Я походил →"
    : "Укажите ход на доске";
  $("computerDone").hidden = !computer || ended;
  $("computerDone").disabled =
    busy || (state.camera_mode && (!stream || needsSync));
  $("retryEngine").hidden = !active || yourTurn || computer || ended;
  $("proposal").hidden = !state.proposal;
  $("confirm").disabled = busy || (state.camera_mode && !stream);
  $("undo").disabled =
    busy || (!state.history.length && !state.proposal && !state.pending);
  $("export").disabled = !state.history.length;
  if (state.proposal)
    $("proposalText").textContent = moveText(state.proposal.uci);
  $("gameBadge").textContent = ended
    ? "Завершена"
    : active
      ? "Идёт игра"
      : "Подготовка";
  let title = "Шахматы за настоящей доской",
    instruction = "Подключите камеру, отметьте углы доски и расставьте фигуры.",
    label = "Готовы к первой партии?",
    step = "01";
  if (active) {
    if (ended) {
      title =
        state.termination === "CHECKMATE"
          ? "Мат. Партия завершена"
          : "Партия завершена";
      label = state.result;
      instruction = `Результат ${state.result}. Сохраните партию в PGN или начните новую.`;
      step = "✓";
    } else if (needsSync) {
      title = "Сверьте физическую доску";
      label = "Нужен опорный кадр";
      instruction =
        "Поставьте фигуры как на экранной доске. В настройках нажмите «Фигуры как на экране». Затем продолжайте игру.";
    } else if (state.proposal) {
      title = "Верно распознал ваш ход?";
      label = "Ждём вашего подтверждения";
      instruction =
        moveText(state.proposal.uci) +
        ". Подтвердите ход справа или исправьте его на доске.";
      step = "03";
    } else if (computer) {
      title = "Ответ компьютера";
      label = "Переставьте фигуру";
      instruction =
        moveText(state.pending.uci) +
        ". Сделайте этот ход на физической доске и нажмите «Ход компьютера выполнен».";
      step = "04";
    } else if (yourTurn) {
      title = state.check ? "Вам шах — ваш ход" : "Ваш ход";
      label = state.player === "white" ? "Ход белых" : "Ход чёрных";
      instruction = state.camera_mode
        ? ""
        : "Нажмите на фигуру, затем на поле назначения. Подтвердите ход справа.";
      step = "02";
    } else {
      title = "Компьютер выбирает ход";
      label = "Stockfish";
      instruction = "Если расчёт прервался, нажмите «Повторить расчёт».";
    }
  }
  if (!active && $("cameraMode").checked) {
    instruction = !stream
      ? "Нажмите «Подключить камеру» справа. Затем отметьте четыре угла настоящей доски."
      : !state.synced
        ? "Нажмите зелёную кнопку справа. На снимке отметьте a8 → h8 → h1 → a1, затем подтвердите расстановку."
        : "Доска настроена. Выберите цвет и нажмите «Начать партию».";
  }
  $("headline").textContent = title;
  $("instruction").textContent = instruction;
  $("instruction").parentElement.hidden = !instruction;
  $("turnLabel").textContent = label;
  $("stepNo").textContent = step;
  $("cameraStatus").textContent = !stream
    ? "Ожидает подключения"
    : !state.calibrated
      ? "Отметьте углы доски"
      : !state.synced
        ? "Нужен опорный кадр"
        : "Доска настроена";
}
async function selectSquare(sq) {
  if (
    busy ||
    preparing ||
    !state.active ||
    state.pending ||
    state.turn !== state.player ||
    state.result
  )
    return;
  candidatePreview = null;
  if (selected === sq) {
    selected = null;
    renderBoard();
    return;
  }
  if (selected) {
    const moves = state.legal.filter((m) => m.uci.startsWith(selected + sq));
    if (moves.length === 1) {
      await propose(moves[0].uci);
      return;
    }
    if (moves.length > 1) {
      $("promotionChoices").replaceChildren(
        ...moves.map((m) => {
          const b = document.createElement("button"),
            img = document.createElement("img");
          img.src =
            "/pieces/" +
            (state.player === "white" ? m.uci[4].toUpperCase() : m.uci[4]) +
            ".svg";
          img.alt = names[m.uci[4]];
          b.append(img);
          b.onclick = () => {
            $("promotion").close();
            propose(m.uci);
          };
          return b;
        }),
      );
      $("promotion").showModal();
      return;
    }
  }
  const piece = state.pieces[sq];
  selected =
    piece && (piece === piece.toUpperCase()) === (state.player === "white")
      ? sq
      : null;
  renderBoard();
  message(selected ? `Выбрано ${sq}. Нажмите клетку назначения.` : "Нажмите клетку, где ваша фигура стояла до хода.");
}
async function propose(uci) {
  await work("Показываю выбранный ход…", async () => {
    apply(await api("propose", { uci, ...(state.camera_mode ? { image: frame() } : {}) }));
    message(
      state.camera_mode
        ? "Свежий кадр сохранён. Проверьте стрелку и нажмите «Да, верно»."
        : "Подтвердите выбранный ход.",
    );
  });
}
function frame() {
  const video = $("video");
  if (!stream || !video.videoWidth || video.readyState < 2)
    throw new Error("Камера ещё не готова. Включите её в настройках.");
  const scale = Math.min(1, 1280 / video.videoWidth);
  capture.width = Math.round(video.videoWidth * scale);
  capture.height = Math.round(video.videoHeight * scale);
  capture
    .getContext("2d")
    .drawImage(video, 0, 0, capture.width, capture.height);
  return capture.toDataURL("image/jpeg", 0.9);
}
async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices(),
    select = $("cameraSelect"),
    current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  select.replaceChildren(
    ...devices
      .filter((d) => d.kind === "videoinput")
      .map((d, i) => {
        const option = document.createElement("option");
        option.value = d.deviceId;
        option.textContent = d.label || `Камера ${i + 1}`;
        option.selected = d.deviceId === current;
        return option;
      }),
  );
}
async function connect() {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error(
      "Камера работает в Chrome на localhost. Откройте приложение через run.sh.",
    );
  const previousCamera =
    stream?.getVideoTracks()[0]?.getSettings().deviceId ||
    localStorage.getItem("chessCam.camera");
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  let id = $("cameraSelect").value;
  if (!id) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    id =
      devices.find((d) => d.kind === "videoinput" && /usb/i.test(d.label))
        ?.deviceId || "";
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(id ? { deviceId: { exact: id } } : {}),
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  } catch (e) {
    throw new Error(
      e.name === "NotAllowedError"
        ? "Разрешите доступ к камере в Chrome и настройках конфиденциальности macOS."
        : e.name === "NotReadableError"
          ? "Камера занята другим приложением. Закройте его и подключите камеру снова."
          : "Камера не найдена. Проверьте подключение и выбор устройства.",
    );
  }
  $("video").srcObject = stream;
  await $("video").play();
  const currentCamera = stream.getVideoTracks()[0].getSettings().deviceId;
  const changedCamera = previousCamera && currentCamera !== previousCamera;
  const savedCorners = state.corners?.map((point) => [...point]) || [];
  if (changedCamera || !savedCorners.length)
    apply(await api("camera-reset", {}));
  corners = changedCamera ? [] : savedCorners;
  if (currentCamera) localStorage.setItem("chessCam.camera", currentCamera);
  $("cameraPlaceholder").hidden = true;
  $("liveLabel").hidden = false;
  await listCameras();
  stream.getVideoTracks()[0].onended = () => {
    stream = null;
    $("cameraPlaceholder").hidden = false;
    $("liveLabel").hidden = true;
    message(
      "Камера отключилась. Подключите её и заново сверьте углы доски.",
      true,
    );
    renderControls();
  };
  snapshot();
  message(
    state.calibrated
      ? "Камера подключена. Проверьте, что контур совпадает с доской. Партия и разметка сохранены."
      : "Камера подключена. Отметьте четыре угла доски.",
  );
  renderControls();
}
function snapshot() {
  const uri = frame();
  calibrationImage = new Image();
  calibrationImage.onload = drawCalibration;
  calibrationImage.src = uri;
  $("calibrationHint").hidden = true;
}
function drawCalibration() {
  if (!calibrationImage?.complete) return;
  const canvas = $("calibration"),
    ctx = canvas.getContext("2d");
  canvas.width = calibrationImage.naturalWidth;
  canvas.height = calibrationImage.naturalHeight;
  ctx.drawImage(calibrationImage, 0, 0);
  const scale = canvas.width / 960;
  ctx.lineWidth = 3 * scale;
  ctx.strokeStyle = "#dbeaa1";
  if (corners.length) {
    ctx.beginPath();
    corners.forEach(([x, y], i) =>
      i
        ? ctx.lineTo(x * canvas.width, y * canvas.height)
        : ctx.moveTo(x * canvas.width, y * canvas.height),
    );
    if (corners.length === 4) ctx.closePath();
    ctx.stroke();
    corners.forEach(([x, y], i) => {
      ctx.fillStyle = "#e6efaa";
      ctx.beginPath();
      ctx.arc(x * canvas.width, y * canvas.height, 8 * scale, 0, 2 * Math.PI);
      ctx.fill();
      ctx.font = `bold ${19 * scale}px sans-serif`;
      ctx.fillStyle = "#14251a";
      ctx.fillRect(
        x * canvas.width + 10 * scale,
        y * canvas.height - 13 * scale,
        34 * scale,
        23 * scale,
      );
      ctx.fillStyle = "#fff";
      ctx.fillText(
        cornerLabels[i],
        x * canvas.width + 13 * scale,
        y * canvas.height + 4 * scale,
      );
    });
  }
  if (corners.length === 4)
    drawCoordinates(ctx, BoardGeometry.homography(corners), ([x,y]) => [x * canvas.width, y * canvas.height], canvas.width, canvas.height);
  $("cornerStep").textContent =
    corners.length < 4
      ? "Отметьте угол " + cornerLabels[corners.length]
      : "Четыре угла отмечены";
}
function openSetup() {
  queenCheck = -1;
  if (state?.corners) corners = state.corners.map((p) => [...p]);
  $("setup").showModal();
  if (stream) snapshot();
}
function renderFenPreview(fen) {
  const host = $("recognizePreview");
  host.replaceChildren();
  try {
    const rows = fen.trim().split(/\s+/)[0].split("/");
    if (rows.length !== 8) return;
    for (let r = 0; r < 8; r++) {
      let c = 0;
      for (const p of rows[r]) {
        const tokens = /[1-8]/.test(p) ? Array(Number(p)).fill(null) : [p];
        for (const piece of tokens) {
          if (c > 7) throw Error();
          const cell = document.createElement("div");
          if ((r + c) % 2) cell.className = "dark";
          if (piece && /[prnbqkPRNBQK]/.test(piece)) {
            const img = document.createElement("img");
            img.src = "/pieces/" + piece + ".svg";
            img.alt = piece;
            cell.append(img);
          }
          host.append(cell);
          c++;
        }
      }
      if (c !== 8) throw Error();
    }
  } catch {
    host.replaceChildren();
  }
}
$("colors").onclick = (e) => {
  const b = e.target.closest("[data-color]");
  if (!b) return;
  chosenColor = b.dataset.color;
  document
    .querySelectorAll("[data-color]")
    .forEach((x) => x.classList.toggle("selected", x === b));
};
$("level").oninput = () => {
  $("levelValue").textContent = $("level").value + " / 20";
};
$("flip").onclick = () => {
  flipped = !flipped;
  renderBoard();
};
$("openSetup").onclick = openSetup;
$("calibrateOpen").onclick = openSetup;
$("closeSetup").onclick = () => $("setup").close();
$("connect").onclick = () => {
  openSetup();
  work("Подключаю камеру…", connect);
};
$("reconnect").onclick = () => work("Подключаю камеру…", connect);
$("snapshot").onclick = () => {
  try {
    snapshot();
  } catch (e) {
    message(e.message, true);
  }
};
$("calibration").onclick = (e) => {
  if (!calibrationImage || corners.length >= 4) return;
  const rect = e.currentTarget.getBoundingClientRect();
  corners.push([
    (e.clientX - rect.left) / rect.width,
    (e.clientY - rect.top) / rect.height,
  ]);
  drawCalibration();
};
$("resetCorners").onclick = () => {
  corners = [];
  drawCalibration();
};
$("saveCalibration").onclick = () =>
  work("Запоминаю доску…", async () => {
    if (corners.length !== 4)
      throw new Error("Отметьте все четыре угла доски.");
    apply(await api("calibrate", { image: frame(), corners }));
    message(
      state.active
        ? "Опорный кадр обновлён. Убедитесь, что фигуры совпадают с экранной доской."
        : "Камера настроена. Проверьте начальную расстановку и начните партию.",
    );
    $("setup").close();
  });
$("sync").onclick = () =>
  work("Обновляю опорный кадр…", async () => {
    apply(await api("sync", { image: frame() }));
    message("Расстановка подтверждена. Можно продолжать.");
    $("setup").close();
  });
$("cameraMode").onchange = renderControls;
$("start").onclick = () => {
  if ($("cameraMode").checked && (!stream || !state.synced)) {
    openSetup();
    if (!stream) work("Подключаю камеру…", connect);
    return;
  }
  if ($("cameraMode").checked && !$("fen").value.trim() && queenCheck !== 2) {
    queenCheck = 0;
    $("setup").close();
    $("headline").textContent = "Проверим расположение ферзей";
    message("Нажмите на клетку белого ферзя на видео, у основания фигуры. Ожидается d1 — светлая клетка.");
    return;
  }
  work("Начинаю партию…", async () => {
    const result = await api("start", {
      player: chosenColor,
      level: Number($("level").value),
      camera_mode: $("cameraMode").checked,
      fen: $("fen").value.trim(),
    });
    preparing = false;
    queenCheck = -1;
    apply(result);
    flipped = chosenColor === "black";
    render();
    message("Партия началась. Ходы сохраняются на этом Mac.");
  });
};
$("scan").onclick = () => {
  if (!state.camera_mode) {
    message("Выберите фигуру и поле назначения на экранной доске.");
    return;
  }
  work(
    $("useModel").checked
      ? "Сравниваю кадры и проверяю ход в Gemma…"
      : "Сравниваю кадры доски…",
    async () => {
      scanStopped = false;
      $("stopScan").hidden = false;
      $("stopScan").disabled = false;
      const result = await api("scan", {
        image: frame(),
        use_model: $("useModel").checked,
      });
      if (scanStopped) return;
      apply(result);
      $("candidates").replaceChildren();
      if (!state.proposal) {
        candidatePreview = result.recognition.candidates.find((m) => m.score > 0)?.uci || null;
        for (const m of result.recognition.candidates) {
          const b = document.createElement("button");
          b.textContent =
            m.san + " · " + m.uci.slice(0, 2) + "–" + m.uci.slice(2, 4);
          const preview = () => {
            candidatePreview = m.uci;
            renderBoard();
            for (const button of $("candidates").children)
              button.classList.toggle("previewing", button === b);
          };
          b.onmouseenter = preview;
          b.onfocus = preview;
          b.classList.toggle("previewing", m.uci === candidatePreview);
          b.title = "Показать стрелку; нажать для подтверждения варианта";
          b.onclick = () => propose(m.uci);
          $("candidates").append(b);
        }
      }
      if (!state.proposal) {
        $("manualMove").hidden = false;
        const order = result.recognition.candidates.map((m) => m.uci);
        const allMoves = [...state.legal].sort((a, b) => {
          const rank = (m) => order.includes(m.uci) ? order.indexOf(m.uci) : 100;
          return rank(a) - rank(b);
        });
        $("legalMove").replaceChildren(...allMoves.map((m) => {
          const option = document.createElement("option");
          option.value = m.uci;
          option.textContent = moveText(m.uci);
          return option;
        }));
        if (candidatePreview) $("legalMove").value = candidatePreview;
      }
      renderBoard();
      message(
        result.recognition.warning ||
          (state.proposal
            ? "Проверьте стрелку и подтвердите свой ход."
            : "Выберите ход из вариантов или укажите его на доске."),
        !!result.recognition.warning,
      );
    },
  );
};
$("pointMove").onclick = () => {
  selected = null;
  candidatePreview = null;
  renderBoard();
  message("На реальной доске нажмите клетку, откуда вы походили, затем клетку назначения. Нажимайте на клетки у основания фигур.");
};
$("legalMove").onchange = () => {
  candidatePreview = $("legalMove").value;
  renderBoard();
};
$("chooseLegalMove").onclick = () => {
  if ($("legalMove").value) propose($("legalMove").value);
};
$("showCoordinates").checked = localStorage.getItem("chessCam.coordinates") === "true";
$("showCoordinates").onchange = () => {
  localStorage.setItem("chessCam.coordinates", String($("showCoordinates").checked));
  drawCalibration();
};
function drawCoordinates(ctx, h, pixel, width, height) {
  if (!h || !$("showCoordinates").checked) return;
  ctx.save();
  const size = Math.max(11, Math.min(18, width / 65));
  ctx.font = `bold ${size}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const label = (x, y, text) => {
    let [px, py] = pixel(BoardGeometry.project(h, x, y));
    px = Math.max(size, Math.min(width - size, px));
    py = Math.max(size, Math.min(height - size, py));
    ctx.fillStyle = "#14231eef";
    ctx.fillRect(px - size * .7, py - size * .7, size * 1.4, size * 1.4);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, px, py);
  };
  for (let i = 0; i < 8; i++) {
    const t = (i + .5) / 8;
    label(t, -.04, files[i]);
    label(t, 1.04, files[i]);
    label(-.04, t, String(8 - i));
    label(1.04, t, String(8 - i));
  }
  ctx.restore();
}
$("stopScan").onclick = async () => {
  $("stopScan").disabled = true;
  try {
    apply(await api("cancel", {}));
    scanStopped = true;
    message("Распознавание остановлено. Можно повторить снимок после завершения отмены.");
  } catch (e) {
    message(e.message, true);
    $("stopScan").disabled = false;
  }
};
$("confirm").onclick = () =>
  work("Ход подтверждён. Компьютер думает…", async () => {
    const result = await api("confirm", {});
    apply(result);
    $("candidates").replaceChildren();
    message(
      result.warning ||
        "Ваш ход записан. Переставьте фигуру компьютера по стрелке.",
      !!result.warning,
    );
  });
$("cancel").onclick = () =>
  work("Отменяю распознанный ход…", async () => {
    apply(await api("cancel", {}));
    $("candidates").replaceChildren();
    message(
      "Партия не изменилась. Нажмите «Я походил» для нового кадра или исправьте ход на доске.",
    );
  });
$("computerDone").onclick = () =>
  work("Проверяю перестановку…", async () => {
    pendingComputerFrame = state.camera_mode ? frame() : null;
    const result = await api("computer", { image: pendingComputerFrame });
    apply(result);
    if (result.verify_required) {
      $("expectedMove").textContent = moveText(state.pending.uci);
      $("verifyComputer").showModal();
      message(result.message, true);
    } else message("Ход компьютера записан. Теперь ваш ход.");
  });
$("manualComputer").onclick = () =>
  work("Подтверждаю перестановку…", async () => {
    apply(
      await api("computer", {
        image: state.camera_mode ? frame() : null,
        manual: true,
      }),
    );
    $("verifyComputer").close();
    message("Вы подтвердили расстановку вручную. Теперь ваш ход.");
  });
$("retryComputer").onclick = () => $("verifyComputer").close();
$("retryEngine").onclick = () =>
  work("Stockfish рассчитывает ответ…", async () => {
    const result = await api("engine", {});
    apply(result);
    if (!result.warning) message("Переставьте фигуру компьютера по стрелке.");
  });
$("undo").onclick = () =>
  work("Возвращаю предыдущую позицию…", async () => {
    apply(await api("undo", {}));
    $("candidates").replaceChildren();
    message(
      state.camera_mode
        ? "Верните физические фигуры как на экране, затем обновите опорный кадр в настройках камеры."
        : "Ход отменён.",
    );
  });
$("newGame").onclick = () => {
  if (!confirm("Начать новую партию? Текущая будет сохранена в архив.")) return;
  work("Готовлю новую партию…", async () => {
    apply(await api("prepare-new", {}));
    preparing = true;
    queenCheck = -1;
    selected = null;
    candidatePreview = null;
    $("candidates").replaceChildren();
    $("fen").value = "";
    render();
    message("Расставьте фигуры для новой партии и запомните расстановку в настройках камеры.");
    if (state.camera_mode) openSetup();
  });
};
$("export").onclick = async () => {
  try {
    const res = await fetch("/api/pgn");
    if (!res.ok) throw Error("Не удалось экспортировать партию");
    const blob = await res.blob(),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "chess-cam-" + new Date().toISOString().slice(0, 10) + ".pgn";
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    message(e.message, true);
  }
};
$("recognize").onclick = () =>
  work("Gemma читает фигуры. Это может занять до полутора минут…", async () => {
    const result = await api("recognize", { image: frame() });
    $("fen").value = result.placement + " w - - 0 1";
    renderFenPreview($("fen").value);
    $("fenHint").textContent =
      "Проверьте каждую фигуру. По умолчанию ход белых, рокировка выключена. Исправьте FEN при необходимости.";
    message(
      "Позиция прочитана как черновик. Она применится только при старте новой партии.",
    );
  });
$("fen").oninput = () => renderFenPreview($("fen").value);
$("resetFen").onclick = () => {
  $("fen").value = "";
  $("recognizePreview").replaceChildren();
  $("fenHint").textContent = "";
};
$("cancelPromotion").onclick = () => $("promotion").close();
async function status() {
  try {
    const s = await api("status");
    $("engineStatus").textContent = (s.engine ? "●" : "○") + " Stockfish";
    $("engineStatus").classList.toggle("ok", s.engine);
    $("modelStatus").textContent = (s.lm.available ? "●" : "○") + " LM Studio";
    $("modelStatus").classList.toggle("ok", s.lm.available);
  } catch {
    $("engineStatus").textContent = "○ Сервер недоступен";
  }
}
(async () => {
  try {
    state = await api("state");
    chosenColor = state.player;
    flipped = state.player === "black";
    $("cameraMode").checked = state.camera_mode;
    $("level").value = state.level;
    $("levelValue").textContent = state.level + " / 20";
    document
      .querySelectorAll("[data-color]")
      .forEach((b) =>
        b.classList.toggle("selected", b.dataset.color === chosenColor),
      );
    render();
    if (state.active)
      message(
        state.camera_mode
          ? "Партия восстановлена. Подключите камеру и подтвердите текущую расстановку."
          : "Партия восстановлена. Можно продолжать.",
      );
    if (state.load_error) message(state.load_error, true);
    status();
  } catch (e) {
    message("Сервер недоступен. Запустите run.sh и обновите страницу.", true);
  }
})();

// Live camera annotations use the same a8 → h8 → h1 → a1 calibration as vision.py.
let liveMapping = null;
function drawLiveBoard() {
  requestAnimationFrame(drawLiveBoard);
  const canvas = $("liveCanvas"),
    video = $("video");
  if (!stream || video.readyState < 2 || !video.videoWidth) {
    liveMapping = null;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio),
    height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = "#17231b";
  ctx.fillRect(0, 0, rect.width, rect.height);
  const scale = Math.min(
    rect.width / video.videoWidth,
    rect.height / video.videoHeight,
  );
  const dw = video.videoWidth * scale,
    dh = video.videoHeight * scale;
  const ox = (rect.width - dw) / 2,
    oy = (rect.height - dh) / 2;
  ctx.drawImage(video, ox, oy, dw, dh);
  const G = window.BoardGeometry;
  const h = state?.corners ? G.homography(state.corners) : null;
  liveMapping = h ? { h, ox, oy, dw, dh } : null;
  const move = state?.proposal?.uci || state?.pending?.uci || candidatePreview;
  $("liveMove").hidden = !move || !h;
  if (move && h)
    $("liveMove").textContent =
      (state.proposal ? "Ваш ход: " : state.pending ? "Компьютер: " : "Предположение: ") + moveText(move);
  if (!h) return;
  const pixel = ([u, v]) => [ox + u * dw, oy + v * dh];
  function path(points) {
    points.forEach((p, i) => {
      const [x, y] = pixel(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
  ctx.beginPath();
  ctx.rect(ox, oy, dw, dh);
  path(state.corners);
  ctx.fillStyle = "rgba(12,22,14,.36)";
  ctx.fill("evenodd");
  ctx.beginPath();
  path(state.corners);
  ctx.strokeStyle = "#dfedb5aa";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  drawCoordinates(ctx, h, pixel, rect.width, rect.height);
  function highlight(sq, fill, stroke) {
    ctx.beginPath();
    path(G.square(h, sq));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  function arrow(from, to) {
    const [x1, y1] = pixel(G.center(h, from)),
      [x2, y2] = pixel(G.center(h, to));
    const angle = Math.atan2(y2 - y1, x2 - x1),
      length = Math.hypot(x2 - x1, y2 - y1);
    const head = Math.min(20, Math.max(10, length * 0.2));
    ctx.save();
    ctx.shadowColor = "#0009";
    ctx.shadowBlur = 5;
    ctx.lineCap = "round";
    ctx.strokeStyle = candidatePreview ? "#ad8cff" : state.proposal ? "#63eed0" : "#ffd45c";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = Math.max(4, dw / 170);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(
      x2 - Math.cos(angle) * head * 0.65,
      y2 - Math.sin(angle) * head * 0.65,
    );
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - head * Math.cos(angle - 0.48),
      y2 - head * Math.sin(angle - 0.48),
    );
    ctx.lineTo(
      x2 - head * Math.cos(angle + 0.48),
      y2 - head * Math.sin(angle + 0.48),
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const label = to,
      [lx, ly] = pixel(G.center(h, to));
    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = "#14231ee6";
    ctx.fillRect(lx + 10, ly - 27, 30, 20);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, lx + 16, ly - 12);
  }
  if (move) {
    highlight(move.slice(0, 2), "#ffd45c25", "#ffd45c");
    highlight(move.slice(2, 4), "#ffd45c66", "#ffe68b");
    arrow(move.slice(0, 2), move.slice(2, 4));
    if (
      state.pieces[move.slice(0, 2)]?.toLowerCase() === "k" &&
      Math.abs(files.indexOf(move[0]) - files.indexOf(move[2])) === 2
    ) {
      const from = (move[2] === "g" ? "h" : "a") + move[1],
        to = (move[2] === "g" ? "f" : "d") + move[1];
      highlight(from, "#ffd45c25", "#ffd45c");
      highlight(to, "#ffd45c44", "#ffe68b");
      arrow(from, to);
    }
  } else {
    const last = state?.history.at(-1)?.uci;
    if (last) highlight(last.slice(2, 4), "#8edaa922", "#b9f0c799");
  }
  if (queenCheck === 0 || queenCheck === 1) {
    const square = queenCheck === 0 ? "d1" : "d8";
    highlight(square, "#68d8ef44", "#95eaff");
    $("liveMove").hidden = false;
    $("liveMove").textContent = queenCheck === 0
      ? "Нажмите клетку белого ферзя · d1"
      : "Нажмите клетку чёрного ферзя · d8";
  }
  if (selected) {
    highlight(selected, "#68d8ef44", "#95eaff");
    for (const m of state.legal.filter((m) => m.uci.startsWith(selected)))
      highlight(m.uci.slice(2, 4), "#68d8ef33", "#95eaff99");
  }
}
$("liveCanvas").onclick = (event) => {
  if (!liveMapping) return;
  const rect = event.currentTarget.getBoundingClientRect(),
    { h, ox, oy, dw, dh } = liveMapping;
  const point = window.BoardGeometry.unproject(
    h,
    (event.clientX - rect.left - ox) / dw,
    (event.clientY - rect.top - oy) / dh,
  );
  if (!point || point.some((v) => v < 0 || v >= 1)) return;
  const square = files[Math.floor(point[0] * 8)] + (8 - Math.floor(point[1] * 8));
  if (queenCheck === 0 || queenCheck === 1) {
    const expected = queenCheck === 0 ? "d1" : "d8";
    if (square !== expected) {
      message(`Вы указали ${square}, а ожидается ${expected}. Проверьте фигуру и разметку. Если ферзь стоит на своём цвете, откройте «Углы камеры» и исправьте ориентацию; затем повторите старт.`, true);
      return;
    }
    queenCheck += 1;
    message(queenCheck === 1
      ? "Белый ферзь совпал с d1. Теперь нажмите клетку чёрного ферзя — d8."
      : "Оба ферзя совпали с разметкой. Нажмите «Начать партию». Это ручная проверка, остальные фигуры сверьте со схемой.");
    if (queenCheck === 2) $("headline").textContent = "Ферзи проверены · можно начинать";
    return;
  }
  selectSquare(square);
};
requestAnimationFrame(drawLiveBoard);
