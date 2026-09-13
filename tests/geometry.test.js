const assert = require("node:assert/strict");
const G = require("../static/geometry.js");
const corners = [
  [0.26, 0.18],
  [0.73, 0.23],
  [0.94, 0.88],
  [0.08, 0.82],
];
const h = G.homography(corners);
const source = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
const close = (a, b) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-8, `${a} != ${b}`));
source.forEach((p, i) => close(G.project(h, ...p), corners[i]));
for (let y = 0; y < 8; y++)
  for (let x = 0; x < 8; x++) {
    const square = "abcdefgh"[x] + (8 - y),
      p = G.center(h, square);
    close(G.unproject(h, ...p), [(x + 0.5) / 8, (y + 0.5) / 8]);
    assert.equal(G.square(h, square).length, 4);
  }
const rotated = G.homography([corners[2], corners[3], corners[0], corners[1]]);
close(G.center(rotated, "a8"), G.center(h, "h1"));
assert.equal(
  G.homography([
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ]),
  null,
);
console.log(
  "Camera projection: corners, all 64 squares, inverse hit testing, rotation and degenerate input pass.",
);
