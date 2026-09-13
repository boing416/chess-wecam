/* Project board coordinates into a calibrated camera frame. No network calls. */
(function (root) {
  function homography(corners) {
    const source = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    if (!Array.isArray(corners) || corners.length !== 4) return null;
    const a = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = source[i],
        [u, v] = corners[i];
      if (![u, v].every(Number.isFinite)) return null;
      a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (let col = 0; col < 8; col++) {
      let pivot = col;
      for (let row = col + 1; row < 8; row++)
        if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      if (Math.abs(a[pivot][col]) < 1e-10) return null;
      [a[col], a[pivot]] = [a[pivot], a[col]];
      const scale = a[col][col];
      for (let j = col; j < 9; j++) a[col][j] /= scale;
      for (let row = 0; row < 8; row++)
        if (row !== col) {
          const factor = a[row][col];
          for (let j = col; j < 9; j++) a[row][j] -= factor * a[col][j];
        }
    }
    return a.map((row) => row[8]).concat(1);
  }
  function project(h, x, y) {
    const z = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z];
  }
  function unproject(h, u, v) {
    const a = h[0] - u * h[6],
      b = h[1] - u * h[7],
      c = u * h[8] - h[2];
    const d = h[3] - v * h[6],
      e = h[4] - v * h[7],
      f = v * h[8] - h[5],
      det = a * e - b * d;
    if (Math.abs(det) < 1e-10) return null;
    return [(c * e - b * f) / det, (a * f - c * d) / det];
  }
  function square(h, square) {
    const x = "abcdefgh".indexOf(square[0]) / 8,
      y = (8 - Number(square[1])) / 8;
    return [
      [x, y],
      [x + 1 / 8, y],
      [x + 1 / 8, y + 1 / 8],
      [x, y + 1 / 8],
    ].map(([u, v]) => project(h, u, v));
  }
  function center(h, square) {
    return project(
      h,
      ("abcdefgh".indexOf(square[0]) + 0.5) / 8,
      (8 - Number(square[1]) + 0.5) / 8,
    );
  }
  const api = { homography, project, unproject, square, center };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BoardGeometry = api;
})(typeof window !== "undefined" ? window : this);
