# Fractals CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `fractals`, a Go CLI that renders six ASCII-art fractals — `sierpinski`, `mandelbrot`, `julia`, `burningship`, `newton`, `fern` — to stdout with deterministic output.

**Architecture:** Pure algorithm packages take validated primitives and return `[]string` (one entry per row). A shared `escapetime` engine plus a `plane` coordinate package back the three escape-time fractals (mandelbrot/julia/burningship differ only by a `Step` closure and framing `Region`). Newton, fern, and sierpinski are their own packages. All flag parsing, validation, printing, and process exit live in `cli`. The plan builds bottom-up so tests stay green at every commit: `plane` → `escapetime` → escape fractals → newton/fern/sierpinski → `cli` scaffold → subcommands → integration.

**Tech Stack:** Go 1.21+, `github.com/spf13/cobra`, standard library `math` / `math/cmplx` / `math/rand`.

## Global Constraints

_The spec's project-wide requirements — every task's requirements implicitly include this section._

- **Go 1.21+.** Sole third-party dependency: `github.com/spf13/cobra`. Standard library `math`, `math/cmplx`, `math/rand`, `unicode`, `unicode/utf8` only — nothing else.
- **Module path:** `fractals`. Packages import as `fractals/internal/<pkg>`.
- Fractal output → **stdout**; diagnostics/errors → **stderr**. Exit code **0** on success, **1** on any validation or usage error. **stdout is empty whenever a run errors.**
- **Deterministic output** given all inputs, including the fern's `--seed`. No time-based seeds, no unseeded `math/rand`.
- Error messages are **exact and prefix-free**: the root command sets `SilenceUsage = true` and `SilenceErrors = true`, and `Execute()` prints the bare message to stderr (no `Error:` prefix, no usage dump).
- **Validators receive the bare flag name** (`"size"`, `"depth"`, …) and own the `--` prefix and full message template.
- **TDD throughout:** red → green → (refactor) → commit per task. Keep every commit's tests green. gofmt-clean, idiomatic Go.
- **Commit messages:** every `git commit` ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (append it even where a task's snippet abbreviates the message body). Commit-step command output is not asserted.
- **Authoritative design:** `docs/superpowers/specs/2026-07-01-fractals-cli-design.md`. Where any ambiguity arises, the spec wins.

---



---



---



---



---



---



---



---



---



---



---

### Task 1: Project setup + `internal/plane` (Region + At)

**Files:**
- Create: `go.mod` (module `fractals`), via `go mod init fractals`.
- Create: `internal/plane/plane.go` — the `plane` package (`Region`, `At`).
- Test: `internal/plane/plane_test.go`.

**Interfaces:**
- Consumes: nothing (first task; no dependencies — cobra is added later in the cli task, do NOT add it here).
- Produces:
  - `plane.Region struct{ XMin, XMax, YMin, YMax float64 }`
  - `func (r plane.Region) At(i, j, width, height int) (cx, cy float64)` — row 0 → YMax, col 0 → XMin, float64 division; `width == 1` → `cx = XMin`; `height == 1` → `cy = YMax`.

The mapping formulas (float64 throughout, never Go integer division):
- `cx = XMin + float64(j)/float64(width-1)*(XMax-XMin)`, except `width == 1` → `cx = XMin`.
- `cy = YMax - float64(i)/float64(height-1)*(YMax-YMin)`, except `height == 1` → `cy = YMax`.

Verified golden points for `Region{XMin:-2, XMax:2, YMin:-2, YMax:2}` on a 5×5 grid (computed by running the formula):
- `At(0,0,5,5) = (-2, 2)` (top-left → XMin, YMax)
- `At(4,0,5,5) = (-2, -2)` (bottom-left → XMin, YMin)
- `At(0,4,5,5) = (2, 2)` (top-right → XMax, YMax)
- `At(2,2,5,5) = (0, 0)` (interior midpoint → origin)
- `At(2,0,1,5) = (-2, 0)` (width==1 guard: cx pinned to XMin; cy still interpolated)
- `At(0,2,5,1) = (0, 2)` (height==1 guard: cy pinned to YMax; cx still interpolated)

---

- [ ] **Step 1: Initialize the module and directory layout.**
  Run these exact commands from the repo root `.`:
  ```bash
  cd .
  go mod init fractals
  mkdir -p cmd/fractals internal/plane internal/escapetime internal/newton internal/fern internal/sierpinski internal/cli
  ```
  Expected: `go mod init fractals` prints `go: creating new go.mod: module fractals`. A `go.mod` file now exists containing `module fractals` and a `go 1.2x` line. The `internal/...` and `cmd/fractals` directories now exist (empty for now — later tasks fill them). Do NOT run `go get` for any dependency in this task.

- [ ] **Step 2: Write the failing test** — create `internal/plane/plane_test.go` with exactly:
  ```go
  package plane

  import "testing"

  func TestAtCornersAndMidpoint(t *testing.T) {
  	r := Region{XMin: -2, XMax: 2, YMin: -2, YMax: 2}
  	const w, h = 5, 5

  	cases := []struct {
  		name           string
  		i, j           int
  		wantCx, wantCy float64
  	}{
  		{"top-left maps to (XMin, YMax)", 0, 0, -2, 2},
  		{"bottom-left maps to (XMin, YMin)", 4, 0, -2, -2},
  		{"top-right maps to (XMax, YMax)", 0, 4, 2, 2},
  		{"interior midpoint maps to origin", 2, 2, 0, 0},
  	}
  	for _, c := range cases {
  		t.Run(c.name, func(t *testing.T) {
  			cx, cy := r.At(c.i, c.j, w, h)
  			if cx != c.wantCx || cy != c.wantCy {
  				t.Errorf("At(%d, %d, %d, %d) = (%v, %v), want (%v, %v)",
  					c.i, c.j, w, h, cx, cy, c.wantCx, c.wantCy)
  			}
  		})
  	}
  }

  func TestAtSingleColumnPinsXMin(t *testing.T) {
  	r := Region{XMin: -2, XMax: 2, YMin: -2, YMax: 2}
  	cx, cy := r.At(2, 0, 1, 5)
  	if cx != -2 {
  		t.Errorf("width==1: cx = %v, want -2 (XMin)", cx)
  	}
  	if cy != 0 {
  		t.Errorf("width==1: cy = %v, want 0", cy)
  	}
  }

  func TestAtSingleRowPinsYMax(t *testing.T) {
  	r := Region{XMin: -2, XMax: 2, YMin: -2, YMax: 2}
  	cx, cy := r.At(0, 2, 5, 1)
  	if cx != 0 {
  		t.Errorf("height==1: cx = %v, want 0", cx)
  	}
  	if cy != 2 {
  		t.Errorf("height==1: cy = %v, want 2 (YMax)", cy)
  	}
  }
  ```

- [ ] **Step 3: Run it, verify it fails to compile** — run:
  ```bash
  cd . && go test ./internal/plane/
  ```
  Expected: a build failure because `plane.go` does not exist yet, e.g.:
  ```
  # fractals/internal/plane [fractals/internal/plane.test]
  ./plane_test.go:6:7: undefined: Region
  FAIL	fractals/internal/plane [build failed]
  ```
  (Exact wording may vary; the point is it fails to build because `Region`/`At` are undefined.)

- [ ] **Step 4: Implement** — create `internal/plane/plane.go` with exactly:
  ```go
  // Package plane maps grid cells of a rendered image to points in the
  // complex plane. It is shared by every escape-time fractal and Newton.
  package plane

  // Region is a rectangle in the complex plane bounded by [XMin, XMax] on the
  // real axis and [YMin, YMax] on the imaginary axis.
  type Region struct {
  	XMin, XMax, YMin, YMax float64
  }

  // At maps grid cell (row i, col j) of a width×height image to a point
  // (cx, cy) in the complex plane. Row 0 is the top of the image and maps to
  // YMax (y increases upward); col 0 maps to XMin. Single-row or single-column
  // images avoid divide-by-zero: width == 1 pins cx to XMin, height == 1 pins
  // cy to YMax. All divisions are float64.
  func (r Region) At(i, j, width, height int) (cx, cy float64) {
  	if width == 1 {
  		cx = r.XMin
  	} else {
  		cx = r.XMin + float64(j)/float64(width-1)*(r.XMax-r.XMin)
  	}
  	if height == 1 {
  		cy = r.YMax
  	} else {
  		cy = r.YMax - float64(i)/float64(height-1)*(r.YMax-r.YMin)
  	}
  	return cx, cy
  }
  ```

- [ ] **Step 5: Run tests, verify pass** — run:
  ```bash
  cd . && gofmt -l internal/plane/ && go test ./internal/plane/
  ```
  Expected: `gofmt -l` prints nothing (files are already formatted). `go test` prints:
  ```
  ok  	fractals/internal/plane	0.00s
  ```
  (timing may differ). If `gofmt -l` lists a file, run `gofmt -w internal/plane/` and re-run.

- [ ] **Step 6: Commit** — this repo is not yet a git repo, so initialize it first, then commit. Run:
  ```bash
  cd .
  git init
  printf '/fractals\n*.test\n' > .gitignore
  git add go.mod .gitignore internal/plane/plane.go internal/plane/plane_test.go
  git commit -m "Add plane.Region coordinate mapping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
  Expected: `git init` reports an initialized empty repository; `git commit` reports 4 files changed. (If `git init` reports the repo already exists, that is fine — just proceed to `git add`/`git commit`.)


---

### Task 2: internal/escapetime engine — `Step` type and `Render`

**Files:**
- Create `./internal/escapetime/engine.go`
- Test `./internal/escapetime/escapetime_test.go`

**Interfaces:**
- Consumes (from Task 1): `plane.Region struct{ XMin, XMax, YMin, YMax float64 }` and `func (r plane.Region) At(i, j, width, height int) (cx, cy float64)`, imported as `fractals/internal/plane`.
- Produces (used by later mandelbrot/julia/burningship tasks):
  - `type Step func(cx, cy float64) (count int, escaped bool)`
  - `func Render(width, height, maxIter int, region plane.Region, palette []rune, step Step) []string`

**Why this task exists (do not skip the fake-`Step` tests).** `Render` is the single loop behind `mandelbrot`, `julia`, and `burningship`. The `Step` seam lets us test the palette-mapping math directly with hand-built fake steps — no fractal math needed. Two historical bugs are guarded here:
1. **Sentinel collision:** an escaped point that escaped on the last possible iteration (`count == maxIter-1`) must map to a *lower* palette index, never the in-set glyph `palette[len-1]`.
2. **Integer division:** the index formula must use `float64` division. Under Go integer division a mid-range escaped count collapses to index 0; the float formula must land on a middle index.

The frozen index formula (implement EXACTLY):
```
n := maxIter
if escaped { n = count }
idx := int(math.Floor(float64(n) / float64(maxIter) * float64(len(palette)-1)))
clamp idx to [0, len(palette)-1]
row[j] = palette[idx]
```
`Render` assumes validated inputs: `width,height,maxIter >= 1`, `len(palette) >= 2`. The cli layer guarantees this; `Render` does not re-check.

Precomputed golden indices (verified by running the formula in Python — these are the exact numbers your tests assert):

| step returns          | maxIter | palette            | n  | idx | rune      |
|-----------------------|---------|--------------------|----|-----|-----------|
| `(0, false)` in-set   | 10      | 10-rune gradient   | 10 | 9   | `'@'`     |
| `(0, false)` in-set   | 10      | `[]rune{' ', '#'}` | 10 | 1   | `'#'`     |
| `(9, true)` last esc. | 10      | 10-rune gradient   | 9  | 8   | `'%'`     |
| `(9, true)` last esc. | 10      | `[]rune{' ', '#'}` | 9  | 0   | `' '`     |
| `(5, true)` mid esc.  | 10      | 10-rune gradient   | 5  | 4   | `'='`     |

10-rune gradient palette is `[]rune(" .:-=+*#%@")`, indices: 0=`' '` 1=`'.'` 2=`':'` 3=`'-'` 4=`'='` 5=`'+'` 6=`'*'` 7=`'#'` 8=`'%'` 9=`'@'`.

---

- [ ] **Step 1: Write the failing test.** Create `./internal/escapetime/escapetime_test.go` with exactly this content:

```go
package escapetime

import (
	"testing"

	"fractals/internal/plane"
)

// gradient is the 10-rune default palette used by the escape-time fractals.
var gradient = []rune(" .:-=+*#%@")

// twoRune is the single-char-mode palette: exterior blank, interior glyph.
var twoRune = []rune{' ', '#'}

// testRegion is arbitrary; constStep ignores the point, so its value only
// exercises plane.At without affecting the mapping under test.
var testRegion = plane.Region{XMin: -2, XMax: 1, YMin: -1, YMax: 1}

// constStep returns the same (count, escaped) for every pixel, so the whole
// grid maps to one palette rune. That isolates the index math from geometry.
func constStep(count int, escaped bool) Step {
	return func(cx, cy float64) (int, bool) { return count, escaped }
}

func assertRows(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("row count = %d, want %d (got %#v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d = %q, want %q", i, got[i], want[i])
		}
	}
}

// In-set points (escaped == false) must map to the LAST palette rune.
func TestRenderInSetMapsToLastGlyph(t *testing.T) {
	got := Render(3, 2, 10, testRegion, gradient, constStep(0, false))
	assertRows(t, got, []string{"@@@", "@@@"})

	got2 := Render(3, 2, 10, testRegion, twoRune, constStep(0, false))
	assertRows(t, got2, []string{"###", "###"})
}

// Guards the sentinel-collision fix: an escape at the final iteration
// (count == maxIter-1) must land BELOW the in-set glyph, never on it.
func TestRenderLastIterationEscapeNeverInSet(t *testing.T) {
	got := Render(4, 1, 10, testRegion, gradient, constStep(9, true))
	assertRows(t, got, []string{"%%%%"})
	if got[0][0] == byte('@') {
		t.Fatalf("last-iteration escape mapped to in-set glyph '@'")
	}

	got2 := Render(4, 1, 10, testRegion, twoRune, constStep(9, true))
	assertRows(t, got2, []string{"    "})
	if got2[0][0] == byte('#') {
		t.Fatalf("last-iteration escape mapped to in-set glyph '#'")
	}
}

// Guards the float-division fix: a mid-range escape count must map to a MIDDLE
// index. Under Go integer division float64(5)/float64(10) would be 5/10 == 0,
// collapsing every escaped point to index 0 (' '). The float formula gives '='.
func TestRenderMidRangeUsesFloatDivision(t *testing.T) {
	got := Render(3, 1, 10, testRegion, gradient, constStep(5, true))
	assertRows(t, got, []string{"==="})
	if got[0][0] == byte(gradient[0]) {
		t.Fatalf("mid-range escape collapsed to index 0 (integer division bug)")
	}
}

// Every output row must be exactly width runes, for both palettes and several
// sizes, whether the constant step reports in-set or escaped.
func TestRenderRowWidth(t *testing.T) {
	cases := []struct {
		width, height int
		palette       []rune
		step          Step
	}{
		{1, 1, gradient, constStep(0, false)},
		{5, 3, gradient, constStep(9, true)},
		{8, 2, twoRune, constStep(5, true)},
		{10, 4, twoRune, constStep(0, false)},
	}
	for _, c := range cases {
		rows := Render(c.width, c.height, 10, testRegion, c.palette, c.step)
		if len(rows) != c.height {
			t.Fatalf("height = %d, want %d", len(rows), c.height)
		}
		for i, r := range rows {
			if n := len([]rune(r)); n != c.width {
				t.Errorf("row %d width = %d, want %d (row=%q)", i, n, c.width, r)
			}
		}
	}
}
```

- [ ] **Step 2: Run it, verify it fails (no `Render` yet).** Run:
```
cd . && go test ./internal/escapetime/
```
Expected: a compile failure, because `Render`, `Step`, and the package's non-test file do not exist yet. Output contains something like:
```
# fractals/internal/escapetime [fractals/internal/escapetime.test]
internal/escapetime/escapetime_test.go:36:9: undefined: Render
internal/escapetime/escapetime_test.go:XX:XX: undefined: Step
FAIL	fractals/internal/escapetime [build failed]
```
(Exact line numbers may vary; the key signal is `undefined: Render` / `undefined: Step` and `[build failed]`.)

- [ ] **Step 3: Implement.** Create `./internal/escapetime/engine.go` with exactly this content:

```go
package escapetime

import (
	"math"
	"strings"

	"fractals/internal/plane"
)

// Step reports the iteration at which a pixel escaped and whether it escaped.
// Contract: escaped == true  => 0 <= count <= maxIter-1
//           escaped == false => count is ignored (the pixel is treated as in-set)
type Step func(cx, cy float64) (count int, escaped bool)

// Render runs the shared escape-time loop over a width x height grid and maps
// each cell's escape iteration to a palette rune, returning one string per row.
//
// It assumes validated inputs: width, height, maxIter >= 1 and len(palette) >= 2.
// In-set points (escaped == false) yield n == maxIter and map to palette[len-1];
// escaped points (n < maxIter) yield a fraction < 1 and therefore an index in
// [0, len-2] — they can never land on the in-set glyph. All division is float64.
func Render(width, height, maxIter int, region plane.Region, palette []rune, step Step) []string {
	rows := make([]string, height)
	for i := 0; i < height; i++ {
		var b strings.Builder
		for j := 0; j < width; j++ {
			cx, cy := region.At(i, j, width, height)
			count, escaped := step(cx, cy)
			n := maxIter
			if escaped {
				n = count
			}
			idx := int(math.Floor(float64(n) / float64(maxIter) * float64(len(palette)-1)))
			if idx < 0 {
				idx = 0
			}
			if idx > len(palette)-1 {
				idx = len(palette) - 1
			}
			b.WriteRune(palette[idx])
		}
		rows[i] = b.String()
	}
	return rows
}
```

- [ ] **Step 4: Run tests, verify pass.** Run:
```
cd . && gofmt -l internal/escapetime/ && go test ./internal/escapetime/
```
Expected: `gofmt -l` prints nothing (files are already formatted), then:
```
ok  	fractals/internal/escapetime	0.00s
```
(Timing varies.) If `gofmt -l` prints a filename, run `gofmt -w internal/escapetime/` and re-run.

- [ ] **Step 5: Commit.** Run:
```
cd . && git add internal/escapetime/engine.go internal/escapetime/escapetime_test.go && git commit -m "Add escape-time Render engine and Step seam

Render maps each grid cell's escape iteration to a palette rune using the
frozen float64 index formula. Fake-Step tests guard the sentinel-collision
and integer-division fixes and assert exact row widths.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: a commit is created reporting `2 files changed`.


---

### Task 3: escapetime.Mandelbrot

**Files:**
- Create: `internal/escapetime/mandelbrot.go` (module `fractals`)
- Modify (Test): `internal/escapetime/escapetime_test.go`

**Interfaces:**
- Consumes: `escapetime.Render(width, height, maxIter int, region plane.Region, palette []rune, step escapetime.Step) []string` and `plane.Region{XMin, XMax, YMin, YMax float64}` with `(plane.Region).At(i, j, width, height int) (cx, cy float64)`, both from earlier tasks. `Mandelbrot` lives in package `escapetime`, so it calls `Render(...)` unqualified and refers to `plane.Region` qualified.
- Produces: `func Mandelbrot(width, height, iterations int, palette []rune) []string`.

The golden below was computed by running the exact spec algorithm (region `{-2.5,1.0,-1.0,1.0}`, `z0=0`, `z=z*z+c`, escape `|z|^2>4`, 0-based loop returning `(n,true)`/`(iterations,false)`) through the frozen `Render` formula at width 21, height 11, iterations 50, gradient palette `" .:-=+*#%@"`. Do not hand-edit these rows.

- [ ] **Step 1: Write the failing test** — append these two functions to `internal/escapetime/escapetime_test.go`. Ensure the file's import block contains `"math"` and `"fractals/internal/plane"` (add them if the existing Render tests did not already import them).

```go
func TestMandelbrotGolden(t *testing.T) {
	palette := []rune(" .:-=+*#%@")
	got := Mandelbrot(21, 11, 50, palette)
	want := []string{
		"              .      ",
		"             @@      ",
		"           :=@@@:    ",
		"       ....@@@@@@.   ",
		"       .@@:@@@@@@    ",
		"   @@@@@@@@@@@@@.    ",
		"       .@@:@@@@@@    ",
		"       ....@@@@@@.   ",
		"           :=@@@:    ",
		"             @@      ",
		"              .      ",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d rows, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d:\n got %q\nwant %q", i, got[i], want[i])
		}
	}
	for i, row := range got {
		if w := len([]rune(row)); w != 21 {
			t.Errorf("row %d width = %d, want 21", i, w)
		}
	}
}

// The point (-0.5, 0) is deep inside the Mandelbrot set, so the grid cell
// nearest it must be in-set and paint the last palette rune '@'.
func TestMandelbrotInSetCellIsAt(t *testing.T) {
	palette := []rune(" .:-=+*#%@")
	width, height := 21, 11
	region := plane.Region{XMin: -2.5, XMax: 1.0, YMin: -1.0, YMax: 1.0}
	bestI, bestJ, best := 0, 0, math.Inf(1)
	for i := 0; i < height; i++ {
		for j := 0; j < width; j++ {
			cx, cy := region.At(i, j, width, height)
			if d := (cx+0.5)*(cx+0.5) + cy*cy; d < best {
				best, bestI, bestJ = d, i, j
			}
		}
	}
	got := Mandelbrot(width, height, 50, palette)
	if c := []rune(got[bestI])[bestJ]; c != '@' {
		t.Errorf("cell nearest (-0.5,0) at (%d,%d) = %q, want '@'", bestI, bestJ, c)
	}
}
```

- [ ] **Step 2: Run it, verify it fails** — run:

```
go test ./internal/escapetime/ -run 'TestMandelbrot'
```

Expected: a build failure because `Mandelbrot` is undefined, e.g.:

```
./escapetime_test.go:XX:YY: undefined: Mandelbrot
FAIL	fractals/internal/escapetime [build failed]
```

- [ ] **Step 3: Implement** — create `internal/escapetime/mandelbrot.go`:

```go
package escapetime

import "fractals/internal/plane"

// Mandelbrot renders the Mandelbrot set: c is the pixel, z0 = 0, z <- z*z + c.
func Mandelbrot(width, height, iterations int, palette []rune) []string {
	region := plane.Region{XMin: -2.5, XMax: 1.0, YMin: -1.0, YMax: 1.0}
	step := func(cx, cy float64) (int, bool) {
		zr, zi := 0.0, 0.0
		for n := 0; n < iterations; n++ {
			zr, zi = zr*zr-zi*zi+cx, 2*zr*zi+cy
			if zr*zr+zi*zi > 4 {
				return n, true
			}
		}
		return iterations, false
	}
	return Render(width, height, iterations, region, palette, step)
}
```

- [ ] **Step 4: Run tests, verify pass** — run:

```
gofmt -l internal/escapetime/mandelbrot.go
go test ./internal/escapetime/ -run 'TestMandelbrot'
```

Expected: `gofmt -l` prints nothing (file is gofmt-clean); tests print `ok  	fractals/internal/escapetime`.

- [ ] **Step 5: Commit** — run:

```
git add internal/escapetime/mandelbrot.go internal/escapetime/escapetime_test.go
git commit -m "Add escapetime.Mandelbrot with golden and in-set cell tests"
```

---

### Task 4: escapetime.Julia

**Files:**
- Create: `internal/escapetime/julia.go` (module `fractals`)
- Modify (Test): `internal/escapetime/escapetime_test.go`

**Interfaces:**
- Consumes: `escapetime.Render(...)` and `plane.Region` (as in Task 3). `Julia` is in package `escapetime`; it calls `Render(...)` unqualified.
- Produces: `func Julia(width, height, iterations int, creal, cimag float64, palette []rune) []string`.

The golden below was computed by running the exact spec algorithm (region `{-1.5,1.5,-1.5,1.5}`, `z0=pixel`, `c=(creal,cimag)`, `z=z*z+c`, escape `|z|^2>4`) through `Render` at width 21, height 11, iterations 50, gradient palette, with the default `c=(-0.8, 0.156)`. The second assertion renders the same grid with `c=(0.285, 0.01)` and requires the output to differ (proves `creal`/`cimag` are wired in).

- [ ] **Step 1: Write the failing test** — append this function to `internal/escapetime/escapetime_test.go` (no new imports needed beyond what Task 3 added):

```go
func TestJuliaGolden(t *testing.T) {
	palette := []rune(" .:-=+*#%@")
	got := Julia(21, 11, 50, -0.8, 0.156, palette)
	want := []string{
		"                     ",
		"                     ",
		"                     ",
		"        ..+.         ",
		"   @@+.#*#@@=  .@    ",
		" +@-@-=#:*@*:#=-@-@+ ",
		"    @.  =@@#*#.+@@   ",
		"         .+..        ",
		"                     ",
		"                     ",
		"                     ",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d rows, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d:\n got %q\nwant %q", i, got[i], want[i])
		}
	}
	for i, row := range got {
		if w := len([]rune(row)); w != 21 {
			t.Errorf("row %d width = %d, want 21", i, w)
		}
	}

	// A different c must produce a different set.
	other := Julia(21, 11, 50, 0.285, 0.01, palette)
	same := len(other) == len(got)
	if same {
		for i := range got {
			if other[i] != got[i] {
				same = false
				break
			}
		}
	}
	if same {
		t.Errorf("Julia output did not change when c changed from (-0.8,0.156) to (0.285,0.01)")
	}
}
```

- [ ] **Step 2: Run it, verify it fails** — run:

```
go test ./internal/escapetime/ -run 'TestJulia'
```

Expected: build failure, `undefined: Julia`, `FAIL	fractals/internal/escapetime [build failed]`.

- [ ] **Step 3: Implement** — create `internal/escapetime/julia.go`:

```go
package escapetime

import "fractals/internal/plane"

// Julia renders a Julia set: z0 is the pixel and c = creal + i*cimag is fixed.
func Julia(width, height, iterations int, creal, cimag float64, palette []rune) []string {
	region := plane.Region{XMin: -1.5, XMax: 1.5, YMin: -1.5, YMax: 1.5}
	step := func(cx, cy float64) (int, bool) {
		zr, zi := cx, cy
		for n := 0; n < iterations; n++ {
			zr, zi = zr*zr-zi*zi+creal, 2*zr*zi+cimag
			if zr*zr+zi*zi > 4 {
				return n, true
			}
		}
		return iterations, false
	}
	return Render(width, height, iterations, region, palette, step)
}
```

- [ ] **Step 4: Run tests, verify pass** — run:

```
gofmt -l internal/escapetime/julia.go
go test ./internal/escapetime/ -run 'TestJulia'
```

Expected: `gofmt -l` prints nothing; tests print `ok  	fractals/internal/escapetime`.

- [ ] **Step 5: Commit** — run:

```
git add internal/escapetime/julia.go internal/escapetime/escapetime_test.go
git commit -m "Add escapetime.Julia with golden and c-sensitivity tests"
```

---

### Task 5: escapetime.BurningShip

**Files:**
- Create: `internal/escapetime/burningship.go` (module `fractals`)
- Modify (Test): `internal/escapetime/escapetime_test.go`

**Interfaces:**
- Consumes: `escapetime.Render(...)` and `plane.Region` (as in Task 3). `BurningShip` is in package `escapetime`; it calls `Render(...)` unqualified and uses `math.Abs`.
- Produces: `func BurningShip(width, height, iterations int, palette []rune) []string`.

Region `{XMin:-2.0, XMax:0.5, YMin:-0.5, YMax:1.3}`. The step negates `cy` first (`cy=-cy`, the conjugate pixel — spec "Orientation") then `a,b=abs(zr),abs(zi); zr,zi=a*a-b*b+cx, 2*a*b+cy`. The golden below was computed by running exactly this algorithm through `Render` at width 21, height 11, iterations 50, gradient palette.

**Orientation is verified two ways.** (1) I confirmed that removing the `cy=-cy` line changes these exact bytes (the vertical mirror), so this golden guards the conjugate line. (2) The recognizable silhouette — hull low, mast/antenna filaments pointing up above a horizontal waterline spar — is a property of the full 80x24 default render; that is asserted by the committed default-render golden in the cli layer (AC2). This small grid guards the exact per-cell bytes and the conjugate orientation, not visual prettiness (the shape is blobby at 21x11).

- [ ] **Step 1: Write the failing test** — append this function to `internal/escapetime/escapetime_test.go` (no new imports needed beyond what Task 3 added):

```go
func TestBurningShipGolden(t *testing.T) {
	palette := []rune(" .:-=+*#%@")
	got := BurningShip(21, 11, 50, palette)
	// Conjugate orientation (cy negated): removing that step changes these
	// bytes, so this golden guards the vertical-mirror line in BurningShip.
	want := []string{
		"                     ",
		"          :      @@@@",
		"        #@=%@@@@@@@@@",
		"        =@@@@@@@@@@@=",
		"       +@@@@@@@@@@@@.",
		"     *@@@@@@@@@@@@@. ",
		"     @@@@@@@@@@@@@@. ",
		"  @+@@@@@@@@@@@@@@@. ",
		"        .....:@@@@@@ ",
		"              ..-@@@ ",
		"                 ..  ",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d rows, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d:\n got %q\nwant %q", i, got[i], want[i])
		}
	}
	for i, row := range got {
		if w := len([]rune(row)); w != 21 {
			t.Errorf("row %d width = %d, want 21", i, w)
		}
	}
}
```

- [ ] **Step 2: Run it, verify it fails** — run:

```
go test ./internal/escapetime/ -run 'TestBurningShip'
```

Expected: build failure, `undefined: BurningShip`, `FAIL	fractals/internal/escapetime [build failed]`.

- [ ] **Step 3: Implement** — create `internal/escapetime/burningship.go`:

```go
package escapetime

import (
	"math"

	"fractals/internal/plane"
)

// BurningShip renders the Burning Ship fractal. It iterates the conjugate
// pixel (cy negated) so the hull sits low with masts pointing up.
func BurningShip(width, height, iterations int, palette []rune) []string {
	region := plane.Region{XMin: -2.0, XMax: 0.5, YMin: -0.5, YMax: 1.3}
	step := func(cx, cy float64) (int, bool) {
		cy = -cy
		zr, zi := 0.0, 0.0
		for n := 0; n < iterations; n++ {
			a, b := math.Abs(zr), math.Abs(zi)
			zr, zi = a*a-b*b+cx, 2*a*b+cy
			if zr*zr+zi*zi > 4 {
				return n, true
			}
		}
		return iterations, false
	}
	return Render(width, height, iterations, region, palette, step)
}
```

- [ ] **Step 4: Run tests, verify pass** — run:

```
gofmt -l internal/escapetime/burningship.go
go test ./internal/escapetime/
```

Expected: `gofmt -l` prints nothing; the full package (Render, Mandelbrot, Julia, BurningShip tests) prints `ok  	fractals/internal/escapetime`.

- [ ] **Step 5: Commit** — run:

```
git add internal/escapetime/burningship.go internal/escapetime/escapetime_test.go
git commit -m "Add escapetime.BurningShip with conjugate-orientation golden test"
```


---

### Task 6: internal/newton — Newton fractal basins for z³ − 1

**Files:**
- Create: `internal/newton/newton.go`
- Test: `internal/newton/newton_test.go`

(Module path is `fractals`; this package imports `fractals/internal/plane`.)

**Interfaces:**
- Consumes (from the plane task):
  - `plane.Region struct{ XMin, XMax, YMin, YMax float64 }`
  - `func (r plane.Region) At(i, j, width, height int) (cx, cy float64)` — row 0 → `YMax`, col 0 → `XMin`, float64 division; `width==1` → `cx=XMin`, `height==1` → `cy=YMax`.
- Produces (relied on by the cli `newton` subcommand task):
  - `func newton.Generate(width, height, iterations int) []string` — one string per output row, each exactly `width` runes wide.

**Algorithm (authoritative, from the spec).** Newton's method on `p(z) = z³ − 1`.
- `region = plane.Region{XMin: -2, XMax: 2, YMin: -2, YMax: 2}`
- `roots = [1+0i, -0.5 + i·√3/2, -0.5 − i·√3/2]` (the cube roots of unity)
- `glyphs = ['.', '+', '@']` (one per basin)
- `eps = 1e-6`
- Per pixel `(i, j)`: `cx, cy := region.At(i, j, width, height)`; `z := complex(cx, cy)`; `ch := ' '`. Loop `n` from `0` to `iterations-1`:
  1. **At the top of the loop**, for `k` in `0..2`: if `cmplx.Abs(z - roots[k]) < eps`, set `ch = glyphs[k]` and break out of the iteration loop.
  2. `z2 := z*z`; if `cmplx.Abs(z2) < 1e-12`, break (z ≈ 0, p'(z) ≈ 0 → leave `ch` as background `' '`).
  3. `z = z - (z*z2 - 1)/(3*z2)` (Newton step `z − p(z)/p'(z)`).
- The pixel's cell is `ch`.

Convergence is tested at the **top** of the loop, so a point that first lands within `eps` on the final update stays background `' '`. At the default 50 iterations this never happens (quadratic convergence).

**Note on `√3/2`.** Use `math.Sqrt(3)/2` — it evaluates to exactly `0.8660254037844386`, which is the value the golden below was computed against.

- [ ] **Step 1: Write the failing test.** Create `internal/newton/newton_test.go` with exactly this content. The 21×21 golden below was computed by running the real algorithm through the real `plane.At`; do not edit its bytes.

```go
package newton

import (
	"strings"
	"testing"
)

// golden21 is the exact Generate(21, 21, 50) render. Row 0 is the top of the
// image. It was produced by running the Newton algorithm through plane.At; do
// not hand-edit. Note the embedded background space in row 10 (the origin).
var golden21 = []string{
	"+++++++++++++++.@....",
	"++++++++++++++.@+....",
	"++++++++++++++@@+....",
	"++++++++++++++@+.....",
	"++++++++++++.........",
	"+++++++++++++@+......",
	"++++++++++++@@.......",
	"+++++++++++.+........",
	"++++++++++@@@........",
	"@@++.++.@+.@.........",
	".......... ..........",
	"++@@.@@.+@.+.........",
	"@@@@@@@@@@+++........",
	"@@@@@@@@@@@.@........",
	"@@@@@@@@@@@@++.......",
	"@@@@@@@@@@@@@+@......",
	"@@@@@@@@@@@@.........",
	"@@@@@@@@@@@@@@+@.....",
	"@@@@@@@@@@@@@@++@....",
	"@@@@@@@@@@@@@@.+@....",
	"@@@@@@@@@@@@@@@.+....",
}

func TestGenerateGolden(t *testing.T) {
	got := Generate(21, 21, 50)
	if len(got) != len(golden21) {
		t.Fatalf("got %d rows, want %d", len(got), len(golden21))
	}
	for i := range golden21 {
		if got[i] != golden21[i] {
			t.Errorf("row %d:\n got %q\nwant %q", i, got[i], golden21[i])
		}
	}
}

func TestGenerateRowWidth(t *testing.T) {
	got := Generate(21, 21, 50)
	for i, row := range got {
		if n := len([]rune(row)); n != 21 {
			t.Errorf("row %d width = %d, want 21", i, n)
		}
	}
}

// The plane point (1.0, 0.0) is exactly root 0, whose glyph is '.'. In a 21×21
// render of the region [-2,2]×[-2,2] that point is cell (row 10, col 15).
func TestRootOneMapsToDot(t *testing.T) {
	got := Generate(21, 21, 50)
	if c := []rune(got[10])[15]; c != '.' {
		t.Errorf("cell (10,15) = %q, want '.'", c)
	}
}

// The origin (0,0) is cell (row 10, col 10). p'(0) = 0, so Newton's step is
// undefined there and the pixel stays background ' '.
func TestOriginIsBackground(t *testing.T) {
	got := Generate(21, 21, 50)
	if c := []rune(got[10])[10]; c != ' ' {
		t.Errorf("cell (10,10) = %q, want ' '", c)
	}
}

func TestAllThreeBasinsAppear(t *testing.T) {
	joined := strings.Join(Generate(21, 21, 50), "\n")
	for _, g := range []rune{'.', '+', '@'} {
		if !strings.ContainsRune(joined, g) {
			t.Errorf("glyph %q missing from render", g)
		}
	}
}
```

- [ ] **Step 2: Run it, verify it fails.** From the module root:

```
go test ./internal/newton/
```

Expected: a build failure because `Generate` does not exist yet, e.g.:

```
# fractals/internal/newton [fractals/internal/newton.test]
internal/newton/newton_test.go:29:9: undefined: Generate
FAIL	fractals/internal/newton [build failed]
```

- [ ] **Step 3: Implement.** Create `internal/newton/newton.go` with exactly this content:

```go
package newton

import (
	"math"
	"math/cmplx"

	"fractals/internal/plane"
)

// Generate renders the Newton fractal for p(z) = z^3 - 1. Each pixel is a
// start point iterated by Newton's method; its glyph is chosen by which cube
// root of unity it converges to, producing distinct interlocking basins.
// Points that never converge (notably the origin, where p'(z) = 0) render as
// a background space.
func Generate(width, height, iterations int) []string {
	region := plane.Region{XMin: -2, XMax: 2, YMin: -2, YMax: 2}
	roots := [3]complex128{
		complex(1, 0),
		complex(-0.5, math.Sqrt(3)/2),
		complex(-0.5, -math.Sqrt(3)/2),
	}
	glyphs := [3]rune{'.', '+', '@'}
	const eps = 1e-6

	rows := make([]string, height)
	for i := 0; i < height; i++ {
		row := make([]rune, width)
		for j := 0; j < width; j++ {
			cx, cy := region.At(i, j, width, height)
			z := complex(cx, cy)
			ch := ' '
			for n := 0; n < iterations; n++ {
				converged := false
				for k := 0; k < 3; k++ {
					if cmplx.Abs(z-roots[k]) < eps {
						ch = glyphs[k]
						converged = true
						break
					}
				}
				if converged {
					break
				}
				z2 := z * z
				if cmplx.Abs(z2) < 1e-12 {
					break
				}
				z = z - (z*z2-1)/(3*z2)
			}
			row[j] = ch
		}
		rows[i] = string(row)
	}
	return rows
}
```

- [ ] **Step 4: Run tests, verify pass.**

```
gofmt -l internal/newton/newton.go internal/newton/newton_test.go
go test ./internal/newton/
```

Expected: `gofmt -l` prints nothing (files are already formatted), and:

```
ok  	fractals/internal/newton
```

- [ ] **Step 5: Commit.**

```
git add internal/newton/newton.go internal/newton/newton_test.go
git commit -m "Add newton package: root-basin coloring for z^3 - 1"
```


---

### Task 7: internal/fern — Barnsley fern chaos game

**Files:**
- Create: `internal/fern/fern.go` (module `fractals`, package `fern`)
- Test: `internal/fern/fern_test.go`
- Test data (generated by `-update`): `internal/fern/testdata/fern_small.golden`

**Interfaces:**
- Consumes: nothing from other project packages — only stdlib `math` and `math/rand`.
- Produces: `func fern.Generate(width, height, points int, seed int64, char rune) []string`. The `cli` fern subcommand (later task) calls this exact signature. Returns exactly `height` strings, each exactly `width` runes wide; a marked cell is `char`, an empty cell is `' '`.

**Algorithm (from spec `## fern`):** starting at `(0,0)`, draw `points` samples. Each iteration draws one `rng.Float64()` and picks one of four affine maps by cumulative probability (`r<0.01`, `r<0.86`, `r<0.93`, else), applies it with **simultaneous** (old-value) evaluation, maps the new `(x,y)` to a grid cell, and marks it if in half-open bounds. Mapping constants: `xmin,xmax,ymin,ymax = -2.65, 2.65, 0.0, 10.0`. The PRNG is `rand.New(rand.NewSource(seed))` (math/rand v1) so output is byte-identical for a fixed seed. Exact bytes depend on Go's `math/rand` sequence and cannot be precomputed in Python — hence a `-update` golden FILE plus property assertions rather than a hand-computed inline golden.

---

- [ ] **Step 1: Write the failing test.** Create `internal/fern/fern_test.go` with exactly this content:

```go
package fern

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "update golden files")

func TestGenerateGolden(t *testing.T) {
	rows := Generate(20, 20, 5000, 1, '*')
	got := strings.Join(rows, "\n") + "\n"
	path := filepath.Join("testdata", "fern_small.golden")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden (run once with -update): %v", err)
	}
	if got != string(want) {
		t.Errorf("golden mismatch:\n got:\n%s\nwant:\n%s", got, want)
	}
}

func TestGenerateDeterministic(t *testing.T) {
	a := strings.Join(Generate(40, 50, 50000, 1, '*'), "\n")
	b := strings.Join(Generate(40, 50, 50000, 1, '*'), "\n")
	if a != b {
		t.Fatal("same seed produced different output")
	}
}

func TestGenerateSeedSensitive(t *testing.T) {
	a := strings.Join(Generate(40, 50, 50000, 1, '*'), "\n")
	b := strings.Join(Generate(40, 50, 50000, 2, '*'), "\n")
	if a == b {
		t.Fatal("different seeds produced identical output; --seed not wired in")
	}
}

func TestGenerateStemCellMarked(t *testing.T) {
	rows := Generate(40, 50, 50000, 1, '*')
	bottom := []rune(rows[len(rows)-1])
	const centerCol = 20
	if bottom[centerCol] != '*' {
		t.Fatalf("expected stem cell marked at bottom row col %d, got %q in %q",
			centerCol, bottom[centerCol], string(bottom))
	}
}

func TestGenerateCharSubstitution(t *testing.T) {
	star := Generate(40, 50, 50000, 1, '*')
	hash := Generate(40, 50, 50000, 1, '#')
	for i := range star {
		want := strings.ReplaceAll(star[i], "*", "#")
		if hash[i] != want {
			t.Fatalf("row %d: char substitution mismatch\n got: %q\nwant: %q", i, hash[i], want)
		}
	}
}

func TestGenerateRowWidths(t *testing.T) {
	const w, h = 40, 50
	rows := Generate(w, h, 50000, 1, '*')
	if len(rows) != h {
		t.Fatalf("expected %d rows, got %d", h, len(rows))
	}
	for i, r := range rows {
		if got := len([]rune(r)); got != w {
			t.Errorf("row %d: expected width %d runes, got %d", i, w, got)
		}
	}
}
```

Notes on why these assertions are correct (verified by running the real algorithm before writing this plan):
- **Stem cell:** center column at width 40 is `round((0-(-2.65))/5.3 * 39) = round(19.5) = 20`; `y≈0` maps to the bottom row (`height-1 = 49`). At 50000 points the base of the stem reliably marks `rows[49][20]`.
- **Seed sensitivity:** seed 1 vs seed 2 at 50000 points produce different renders (confirmed not-equal).
- **Char substitution:** only marked cells change glyph, so replacing `*`→`#` in the seed-1 render equals the seed-1 render made with `'#'`.

- [ ] **Step 2: Run it, verify it fails.** The package has no `Generate` yet, so the run is a compile failure:

```
go test ./internal/fern/
```

Expected output contains:
```
internal/fern/fern_test.go: undefined: Generate
FAIL	fractals/internal/fern [build failed]
```

- [ ] **Step 3: Implement.** Create `internal/fern/fern.go` with exactly this content:

```go
package fern

import (
	"math"
	"math/rand"
)

const (
	xmin = -2.65
	xmax = 2.65
	ymin = 0.0
	ymax = 10.0
)

// Generate renders a Barnsley fern via the chaos game into a width×height grid
// of runes, returning one string per row. Marked cells use char; empty cells
// are spaces. The chaos game is driven by a seeded math/rand source, so output
// is byte-identical for a fixed seed.
func Generate(width, height, points int, seed int64, char rune) []string {
	grid := make([][]bool, height)
	for i := range grid {
		grid[i] = make([]bool, width)
	}

	rng := rand.New(rand.NewSource(seed))
	x, y := 0.0, 0.0
	for p := 0; p < points; p++ {
		r := rng.Float64()
		switch {
		case r < 0.01:
			x, y = 0.0, 0.16*y
		case r < 0.86:
			x, y = 0.85*x+0.04*y, -0.04*x+0.85*y+1.6
		case r < 0.93:
			x, y = 0.20*x-0.26*y, 0.23*x+0.22*y+1.6
		default:
			x, y = -0.15*x+0.28*y, 0.26*x+0.24*y+0.44
		}
		col := int(math.Round((x - xmin) / (xmax - xmin) * float64(width-1)))
		row := int(math.Round((ymax - y) / (ymax - ymin) * float64(height-1)))
		if col >= 0 && col < width && row >= 0 && row < height {
			grid[row][col] = true
		}
	}

	rows := make([]string, height)
	for i := 0; i < height; i++ {
		runes := make([]rune, width)
		for j := 0; j < width; j++ {
			if grid[i][j] {
				runes[j] = char
			} else {
				runes[j] = ' '
			}
		}
		rows[i] = string(runes)
	}
	return rows
}
```

Key correctness points (do not "simplify" these away):
- Go evaluates the entire right-hand side of `x, y = ...` before assigning, so `x` inside the `y` expression is the OLD `x` — this is the required simultaneous evaluation.
- Bounds check is **half-open** (`col < width`, `row < height`); out-of-range points (e.g. the fern tip at `x≈2.6558 > xmax`) are silently skipped, not clamped.
- Exactly one `rng.Float64()` per iteration, in the order shown.

- [ ] **Step 4: Create the golden file, then verify all tests pass.** First materialize the golden with `-update`, then run the suite normally:

```
gofmt -l internal/fern/
go test ./internal/fern/ -run TestGenerateGolden -update
go test ./internal/fern/
```

Expected: `gofmt -l` prints nothing (already formatted). The `-update` run prints `ok  	fractals/internal/fern`. The final run prints:
```
ok  	fractals/internal/fern	0.1XXs
```
(All six tests pass. `internal/fern/testdata/fern_small.golden` now exists — a 20-line file ending in a newline.)

- [ ] **Step 5: Commit.**

```
git add internal/fern/fern.go internal/fern/fern_test.go internal/fern/testdata/fern_small.golden
git commit -m "Add fern package: seeded Barnsley fern chaos game"
```


---

### Task 8: internal/sierpinski — recursive Sierpinski triangle

**Files:**
- Create: `internal/sierpinski/sierpinski.go` (module `fractals`, package `sierpinski`)
- Test: `internal/sierpinski/sierpinski_test.go`

**Interfaces:**
- Consumes: nothing (pure package, standard library `strings` only).
- Produces: `func Generate(size, depth int, char rune) []string` — one string per output row, top (apex) first. Row `r` (0-indexed) is centered by `size-1-r` leading spaces, has `r+1` cells joined by single spaces; a filled cell prints `char`, an empty cell prints a space. Base row (`r == size-1`) is exactly `2*size-1` characters wide. `Generate` assumes validated inputs: `size >= 1`, `depth >= 0`. The `cli` layer (a later task) guarantees this.

This task is TDD: write the failing tests first (Step 1), watch them fail because the package does not exist (Step 2), implement (Step 3), watch them pass (Step 4), commit (Step 5). The `--size 4 --depth 0`, `--size 4 --depth 1`, `--size 8 --depth 3`, and `--char '#'` goldens below were computed by running the exact algorithm and match the spec's verified golden blocks byte-for-byte. They are small illustrative grids, so they are inlined directly in the test (no golden files needed here).

**Algorithm (verified — implement exactly this):**
Build a triangular boolean grid `filled` where `filled[r]` has length `r+1`. A recursive helper fills it:

```
recurse(r0, n, off, d):     # triangle occupies rows [r0, r0+n), in-row column offset off, remaining depth d
    if d == 0 || n <= 1:    # solid: fill every cell of this triangle
        for i in 0..n-1:
            row = r0 + i
            for c in off..off+i:  filled[row][c] = true
        return
    h = n / 2               # integer division
    recurse(r0,   h, off,   d-1)   # top
    recurse(r0+h, h, off,   d-1)   # bottom-left
    recurse(r0+h, h, off+h, d-1)   # bottom-right
```

Call `recurse(0, size, 0, depth)`, then render each row. The depth cap is a natural no-op: once `n` halves down to `<= 1` the solid branch takes over, so any `depth` beyond `ceil(log2(size))-1` produces identical output.

- [ ] **Step 1: Write the failing test.** Create `internal/sierpinski/sierpinski_test.go` with exactly this content:

```go
package sierpinski

import (
	"strings"
	"testing"
)

// joinGen renders Generate's rows into a single newline-joined string for
// byte-exact comparison against an inline golden.
func joinGen(size, depth int, char rune) string {
	return strings.Join(Generate(size, depth, char), "\n")
}

func TestSize4Depth0Solid(t *testing.T) {
	want := "" +
		"   *\n" +
		"  * *\n" +
		" * * *\n" +
		"* * * *"
	if got := joinGen(4, 0, '*'); got != want {
		t.Errorf("Generate(4, 0, '*') mismatch:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestSize4Depth1(t *testing.T) {
	want := "" +
		"   *\n" +
		"  * *\n" +
		" *   *\n" +
		"* * * *"
	if got := joinGen(4, 1, '*'); got != want {
		t.Errorf("Generate(4, 1, '*') mismatch:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestSize8Depth3(t *testing.T) {
	want := "" +
		"       *\n" +
		"      * *\n" +
		"     *   *\n" +
		"    * * * *\n" +
		"   *       *\n" +
		"  * *     * *\n" +
		" *   *   *   *\n" +
		"* * * * * * * *"
	if got := joinGen(8, 3, '*'); got != want {
		t.Errorf("Generate(8, 3, '*') mismatch:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

// At size 4 the depth cap is 1, so the default depth 5 collapses to depth 1.
// This also exercises the --char substitution.
func TestSize4CharHashEqualsDepth1(t *testing.T) {
	want := "" +
		"   #\n" +
		"  # #\n" +
		" #   #\n" +
		"# # # #"
	if got := joinGen(4, 5, '#'); got != want {
		t.Errorf("Generate(4, 5, '#') mismatch:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

// Non-power-of-two size still renders a valid, correctly centered triangle.
func TestSize5Depth1CenteringAndWidth(t *testing.T) {
	rows := Generate(5, 1, '*')
	if len(rows) != 5 {
		t.Fatalf("Generate(5, 1, '*') returned %d rows, want 5", len(rows))
	}
	for r, row := range rows {
		wantLeading := 5 - 1 - r
		gotLeading := len(row) - len(strings.TrimLeft(row, " "))
		if gotLeading != wantLeading {
			t.Errorf("row %d: leading spaces = %d, want %d (row %q)", r, gotLeading, wantLeading, row)
		}
	}
	if w := len(rows[len(rows)-1]); w != 2*5-1 {
		t.Errorf("base row width = %d, want %d", w, 2*5-1)
	}
}

func TestBaseRowWidth(t *testing.T) {
	for _, size := range []int{1, 4, 8, 16, 32} {
		rows := Generate(size, 5, '*')
		want := 2*size - 1
		if got := len(rows[len(rows)-1]); got != want {
			t.Errorf("size %d: base row width = %d, want %d", size, got, want)
		}
	}
}

// The depth cap is a no-op past ceil(log2(size))-1: for size 16 that cap is 3,
// so depth 3, 4, and 100 must all produce identical output.
func TestDepthCapNoOp(t *testing.T) {
	d3 := joinGen(16, 3, '*')
	d4 := joinGen(16, 4, '*')
	d100 := joinGen(16, 100, '*')
	if d3 != d4 {
		t.Errorf("Generate(16, 3) != Generate(16, 4):\nd3:\n%s\nd4:\n%s", d3, d4)
	}
	if d4 != d100 {
		t.Errorf("Generate(16, 4) != Generate(16, 100):\nd4:\n%s\nd100:\n%s", d4, d100)
	}
}
```

- [ ] **Step 2: Run it, verify it fails.** Run:

```
go test ./internal/sierpinski/
```

Expected: a build failure because `sierpinski.go` does not exist yet and `Generate` is undefined, e.g.:

```
# fractals/internal/sierpinski [fractals/internal/sierpinski.test]
internal/sierpinski/sierpinski_test.go:11:17: undefined: Generate
FAIL	fractals/internal/sierpinski [build failed]
```

- [ ] **Step 3: Implement.** Create `internal/sierpinski/sierpinski.go` with exactly this content:

```go
// Package sierpinski renders a Sierpinski triangle as centered ASCII art via
// recursive subdivision.
package sierpinski

import "strings"

// Generate builds a Sierpinski triangle of the given number of rows (size) and
// maximum recursion depth, using char as the fill glyph. It returns one string
// per row, apex first. Row r is centered with size-1-r leading spaces and holds
// r+1 cells joined by single spaces; the base row is 2*size-1 characters wide.
// Inputs are assumed validated (size >= 1, depth >= 0).
func Generate(size, depth int, char rune) []string {
	filled := make([][]bool, size)
	for r := range filled {
		filled[r] = make([]bool, r+1)
	}

	var recurse func(r0, n, off, d int)
	recurse = func(r0, n, off, d int) {
		if d == 0 || n <= 1 {
			for i := 0; i < n; i++ {
				row := r0 + i
				for c := off; c <= off+i; c++ {
					filled[row][c] = true
				}
			}
			return
		}
		h := n / 2
		recurse(r0, h, off, d-1)
		recurse(r0+h, h, off, d-1)
		recurse(r0+h, h, off+h, d-1)
	}
	recurse(0, size, 0, depth)

	rows := make([]string, size)
	for r := 0; r < size; r++ {
		var b strings.Builder
		for s := 0; s < size-1-r; s++ {
			b.WriteRune(' ')
		}
		for c := 0; c <= r; c++ {
			if c > 0 {
				b.WriteRune(' ')
			}
			if filled[r][c] {
				b.WriteRune(char)
			} else {
				b.WriteRune(' ')
			}
		}
		rows[r] = b.String()
	}
	return rows
}
```

- [ ] **Step 4: Run tests, verify pass.** Run:

```
gofmt -l internal/sierpinski/ && go test ./internal/sierpinski/
```

Expected: `gofmt -l` prints nothing (files are already formatted), and the tests pass:

```
ok  	fractals/internal/sierpinski	0.XXXs
```

- [ ] **Step 5: Commit.** Run:

```
git add internal/sierpinski/sierpinski.go internal/sierpinski/sierpinski_test.go
git commit -m "Add internal/sierpinski recursive triangle generator"
```


---

### Task 9: Flag validators (`internal/cli/validate.go`)

**Files:**
- Create: `internal/cli/validate.go` (package `cli`, module `fractals`)
- Test: `internal/cli/validate_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks. Requires only that `go.mod` (module `fractals`, Go 1.21+) already exists from the project-setup task; this task adds the first files in the `internal/cli` package.
- Produces (relied on by every later `cli` subcommand task):
  - `func positiveInt(name string, v int) error`      — `v >= 1` else error
  - `func nonNegativeInt(name string, v int) error`   — `v >= 0` else error
  - `func finiteFloat(name string, v float64) error`  — reject `NaN` / `±Inf`
  - `func singleChar(name, s string) (rune, error)`   — exactly one printable rune

Validators receive the **BARE** flag name (`"size"`, `"depth"`, `"char"`, …) and own the `--` prefix and the full message. Exact message templates (from the spec's Error Handling table):
- `positiveInt`:    `--<name> must be a positive integer (got <v>)`
- `nonNegativeInt`: `--<name> must be zero or a positive integer (got <v>)`
- `finiteFloat`:    `--<name> must be a finite number`
- `singleChar`:     `--<name> must be a single printable character`

`singleChar` measures length in **runes** (so a multi-byte printable rune like `█` is valid), requires `unicode.IsPrint(r)` (a single space IS allowed), and rejects `""`, `"ab"`, and control/whitespace runes such as `"\n"`, `"\r"`, `"\t"`.

---

- [ ] **Step 1: Confirm the package directory exists** — run:

  ```
  mkdir -p internal/cli
  ```

  Expected: no output (creates the dir if the project-setup task has not already). This is where `validate.go` and `validate_test.go` live.

- [ ] **Step 2: Write the failing test** — create `internal/cli/validate_test.go` with this exact content:

  ```go
  package cli

  import "testing"

  // checkErr asserts that err's message equals want. want == "" means err must be nil.
  func checkErr(t *testing.T, err error, want string) {
  	t.Helper()
  	if want == "" {
  		if err != nil {
  			t.Fatalf("expected nil error, got %q", err.Error())
  		}
  		return
  	}
  	if err == nil {
  		t.Fatalf("expected error %q, got nil", want)
  	}
  	if err.Error() != want {
  		t.Fatalf("wrong error message\n got: %q\nwant: %q", err.Error(), want)
  	}
  }

  func TestPositiveInt(t *testing.T) {
  	tests := []struct {
  		name    string
  		flag    string
  		v       int
  		wantErr string
  	}{
  		{"one is valid", "size", 1, ""},
  		{"large is valid", "width", 80, ""},
  		{"zero rejected", "size", 0, "--size must be a positive integer (got 0)"},
  		{"negative rejected", "width", -3, "--width must be a positive integer (got -3)"},
  	}
  	for _, tt := range tests {
  		t.Run(tt.name, func(t *testing.T) {
  			checkErr(t, positiveInt(tt.flag, tt.v), tt.wantErr)
  		})
  	}
  }

  func TestNonNegativeInt(t *testing.T) {
  	tests := []struct {
  		name    string
  		flag    string
  		v       int
  		wantErr string
  	}{
  		{"zero is valid", "depth", 0, ""},
  		{"positive is valid", "depth", 5, ""},
  		{"negative rejected", "depth", -1, "--depth must be zero or a positive integer (got -1)"},
  		{"negative rejected large", "depth", -42, "--depth must be zero or a positive integer (got -42)"},
  	}
  	for _, tt := range tests {
  		t.Run(tt.name, func(t *testing.T) {
  			checkErr(t, nonNegativeInt(tt.flag, tt.v), tt.wantErr)
  		})
  	}
  }

  func TestFiniteFloat(t *testing.T) {
  	posInf := math.Inf(1)
  	negInf := math.Inf(-1)
  	nan := math.NaN()
  	tests := []struct {
  		name    string
  		flag    string
  		v       float64
  		wantErr string
  	}{
  		{"zero is valid", "creal", 0, ""},
  		{"negative is valid", "creal", -0.8, ""},
  		{"positive is valid", "cimag", 0.156, ""},
  		{"NaN rejected", "creal", nan, "--creal must be a finite number"},
  		{"+Inf rejected", "creal", posInf, "--creal must be a finite number"},
  		{"-Inf rejected", "cimag", negInf, "--cimag must be a finite number"},
  	}
  	for _, tt := range tests {
  		t.Run(tt.name, func(t *testing.T) {
  			checkErr(t, finiteFloat(tt.flag, tt.v), tt.wantErr)
  		})
  	}
  }

  func TestSingleChar(t *testing.T) {
  	tests := []struct {
  		name     string
  		flag     string
  		in       string
  		wantRune rune
  		wantErr  string
  	}{
  		{"ascii star", "char", "*", '*', ""},
  		{"ascii hash", "char", "#", '#', ""},
  		{"space allowed", "char", " ", ' ', ""},
  		{"multibyte printable", "char", "█", '█', ""},
  		{"empty rejected", "char", "", 0, "--char must be a single printable character"},
  		{"two chars rejected", "char", "ab", 0, "--char must be a single printable character"},
  		{"newline rejected", "char", "\n", 0, "--char must be a single printable character"},
  		{"carriage return rejected", "char", "\r", 0, "--char must be a single printable character"},
  		{"tab rejected", "char", "\t", 0, "--char must be a single printable character"},
  	}
  	for _, tt := range tests {
  		t.Run(tt.name, func(t *testing.T) {
  			got, err := singleChar(tt.flag, tt.in)
  			checkErr(t, err, tt.wantErr)
  			if tt.wantErr == "" && got != tt.wantRune {
  				t.Fatalf("wrong rune: got %q want %q", got, tt.wantRune)
  			}
  		})
  	}
  }
  ```

  Note: the test file imports `math` implicitly through use of `math.Inf`/`math.NaN`; add the import now so the test compiles. Edit the import block at the top of `internal/cli/validate_test.go` to:

  ```go
  import (
  	"math"
  	"testing"
  )
  ```

- [ ] **Step 3: Run the test, verify it fails to compile** — run:

  ```
  go test ./internal/cli/
  ```

  Expected: a build failure, because `positiveInt`, `nonNegativeInt`, `finiteFloat`, and `singleChar` do not exist yet. Sample expected output (names/line numbers may vary):

  ```
  # fractals/internal/cli [fractals/internal/cli.test]
  internal/cli/validate_test.go:XX:XX: undefined: positiveInt
  internal/cli/validate_test.go:XX:XX: undefined: nonNegativeInt
  internal/cli/validate_test.go:XX:XX: undefined: finiteFloat
  internal/cli/validate_test.go:XX:XX: undefined: singleChar
  FAIL	fractals/internal/cli [build failed]
  ```

- [ ] **Step 4: Implement** — create `internal/cli/validate.go` with this exact content:

  ```go
  package cli

  import (
  	"fmt"
  	"math"
  	"unicode"
  	"unicode/utf8"
  )

  // positiveInt requires v >= 1. name is the bare flag name (e.g. "size");
  // this function owns the "--" prefix and the full message.
  func positiveInt(name string, v int) error {
  	if v < 1 {
  		return fmt.Errorf("--%s must be a positive integer (got %d)", name, v)
  	}
  	return nil
  }

  // nonNegativeInt requires v >= 0 (used by --depth).
  func nonNegativeInt(name string, v int) error {
  	if v < 0 {
  		return fmt.Errorf("--%s must be zero or a positive integer (got %d)", name, v)
  	}
  	return nil
  }

  // finiteFloat rejects NaN and ±Inf (used by --creal and --cimag).
  func finiteFloat(name string, v float64) error {
  	if math.IsNaN(v) || math.IsInf(v, 0) {
  		return fmt.Errorf("--%s must be a finite number", name)
  	}
  	return nil
  }

  // singleChar requires s to be exactly one printable rune. A single space is
  // permitted; "", multi-rune strings, and control/whitespace runes such as
  // newline, carriage return, and tab are rejected.
  func singleChar(name, s string) (rune, error) {
  	if utf8.RuneCountInString(s) != 1 {
  		return 0, fmt.Errorf("--%s must be a single printable character", name)
  	}
  	r, _ := utf8.DecodeRuneInString(s)
  	if !unicode.IsPrint(r) {
  		return 0, fmt.Errorf("--%s must be a single printable character", name)
  	}
  	return r, nil
  }
  ```

- [ ] **Step 5: Run tests, verify pass** — run:

  ```
  go test ./internal/cli/
  ```

  Expected output:

  ```
  ok  	fractals/internal/cli	0.0XXs
  ```

  For a per-subtest view, optionally run `go test -v ./internal/cli/` and confirm every `TestPositiveInt/...`, `TestNonNegativeInt/...`, `TestFiniteFloat/...`, and `TestSingleChar/...` subtest reports `--- PASS`.

- [ ] **Step 6: Verify formatting is clean** — run:

  ```
  gofmt -l internal/cli/validate.go internal/cli/validate_test.go
  ```

  Expected: no output (both files are already gofmt-clean; any filename printed means it needs `gofmt -w` on that file).

- [ ] **Step 7: Commit** — run:

  ```
  git add internal/cli/validate.go internal/cli/validate_test.go
  git commit -m "Add cli flag validators (positiveInt, nonNegativeInt, finiteFloat, singleChar)"
  ```

  Expected: a commit is created reporting 2 files changed.


---

### Task 10: CLI scaffold, main entrypoint, and `sierpinski` subcommand

**Files:**
- Modify: `go.mod` (add cobra dependency via `go get`)
- Create: `internal/cli/root.go`
- Create: `internal/cli/sierpinski.go`
- Create: `cmd/fractals/main.go`
- Test: `internal/cli/sierpinski_test.go`

**Interfaces:**
- Consumes: `sierpinski.Generate(size, depth int, char rune) []string` (from the sierpinski package task); `positiveInt(name string, v int) error`, `nonNegativeInt(name string, v int) error`, `singleChar(name, s string) (rune, error)` (from the validators task, same `cli` package).
- Produces: `newRootCmd() *cobra.Command`, `Execute() error`, and the unexported `newSierpinskiCmd() *cobra.Command`. Also produces the test helper `runRoot(t, args...) (stdout, stderr string, err error)` reused by Task 11. Later CLI subcommand tasks call `root.AddCommand(...)` inside `newRootCmd`.

This task assumes earlier tasks already created `go.mod` with module path `fractals` (`go 1.21` or newer) and the `internal/sierpinski` package and `internal/cli/validate.go`. It wires cobra in and adds the first subcommand.

- [ ] **Step 1: Add the cobra dependency** — from the repo root run:
  ```
  go get github.com/spf13/cobra@latest
  ```
  Expected: this resolves and records `github.com/spf13/cobra v1.10.2` (the current latest; if a newer patch has since shipped, record whatever `go get` prints) plus its transitive deps (`github.com/spf13/pflag`, `github.com/inconshreveable/mousetrap`) in `go.mod`/`go.sum`. Confirm with:
  ```
  grep cobra go.mod
  ```
  Expected output (version may differ if a newer release exists):
  ```
  	github.com/spf13/cobra v1.10.2
  ```

- [ ] **Step 2: Write the failing test** — create `internal/cli/sierpinski_test.go` with the shared driver helper and the three sierpinski cases. The golden below was produced by running the spec's recursive-subdivision algorithm for `size 4, depth 1`:
  ```go
  package cli

  import (
  	"bytes"
  	"strings"
  	"testing"
  )

  // runRoot drives newRootCmd() the way the spec prescribes: SetArgs / SetOut /
  // SetErr, then Execute(). Because the root command sets SilenceUsage and
  // SilenceErrors, cobra writes nothing to stderr and nothing to stdout when a
  // RunE returns an error, so an error case leaves stdout empty.
  func runRoot(t *testing.T, args ...string) (stdout, stderr string, err error) {
  	t.Helper()
  	cmd := newRootCmd()
  	var out, errBuf bytes.Buffer
  	cmd.SetOut(&out)
  	cmd.SetErr(&errBuf)
  	cmd.SetArgs(args)
  	err = cmd.Execute()
  	return out.String(), errBuf.String(), err
  }

  func TestSierpinskiGolden(t *testing.T) {
  	stdout, _, err := runRoot(t, "sierpinski", "--size", "4", "--depth", "1")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	want := "   *\n  * *\n *   *\n* * * *\n"
  	if stdout != want {
  		t.Errorf("stdout mismatch\n got: %q\nwant: %q", stdout, want)
  	}
  }

  func TestSierpinskiInvalidSize(t *testing.T) {
  	stdout, _, err := runRoot(t, "sierpinski", "--size", "0")
  	if err == nil {
  		t.Fatalf("expected error, got nil")
  	}
  	if got := err.Error(); got != "--size must be a positive integer (got 0)" {
  		t.Errorf("error mismatch: got %q", got)
  	}
  	if stdout != "" {
  		t.Errorf("stdout should be empty on error, got %q", stdout)
  	}
  }

  func TestRootHelpListsSierpinski(t *testing.T) {
  	stdout, _, err := runRoot(t, "--help")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	if !strings.Contains(stdout, "sierpinski") {
  		t.Errorf("--help output does not mention sierpinski:\n%s", stdout)
  	}
  }
  ```

- [ ] **Step 3: Run it, verify it fails** — run:
  ```
  go test ./internal/cli/
  ```
  Expected: a build failure because the symbols do not exist yet, e.g.:
  ```
  ./sierpinski_test.go:24:9: undefined: newRootCmd
  FAIL	fractals/internal/cli [build failed]
  ```

- [ ] **Step 4: Implement the root command** — create `internal/cli/root.go`:
  ```go
  package cli

  import (
  	"fmt"
  	"os"

  	"github.com/spf13/cobra"
  )

  // newRootCmd builds the top-level `fractals` command with every subcommand
  // attached. Tests drive this directly via SetArgs/SetOut/SetErr.
  func newRootCmd() *cobra.Command {
  	root := &cobra.Command{
  		Use:           "fractals",
  		Short:         "Render ASCII-art fractals to stdout",
  		SilenceUsage:  true,
  		SilenceErrors: true,
  	}
  	root.AddCommand(newSierpinskiCmd())
  	return root
  }

  // Execute runs the root command and prints any error as a bare message to
  // stderr (no cobra "Error:" prefix, no usage dump). main() maps a non-nil
  // return to exit code 1.
  func Execute() error {
  	cmd := newRootCmd()
  	err := cmd.Execute()
  	if err != nil {
  		fmt.Fprintln(os.Stderr, err)
  	}
  	return err
  }
  ```

- [ ] **Step 5: Implement the sierpinski subcommand** — create `internal/cli/sierpinski.go`:
  ```go
  package cli

  import (
  	"fmt"
  	"strings"

  	"github.com/spf13/cobra"

  	"fractals/internal/sierpinski"
  )

  func newSierpinskiCmd() *cobra.Command {
  	var (
  		size  int
  		depth int
  		char  string
  	)
  	cmd := &cobra.Command{
  		Use:   "sierpinski",
  		Short: "Render a Sierpinski triangle",
  		RunE: func(cmd *cobra.Command, args []string) error {
  			if err := positiveInt("size", size); err != nil {
  				return err
  			}
  			if err := nonNegativeInt("depth", depth); err != nil {
  				return err
  			}
  			ch, err := singleChar("char", char)
  			if err != nil {
  				return err
  			}
  			rows := sierpinski.Generate(size, depth, ch)
  			fmt.Fprintln(cmd.OutOrStdout(), strings.Join(rows, "\n"))
  			return nil
  		},
  	}
  	cmd.Flags().IntVar(&size, "size", 32, "number of rows")
  	cmd.Flags().IntVar(&depth, "depth", 5, "maximum recursion depth")
  	cmd.Flags().StringVar(&char, "char", "*", "fill character")
  	return cmd
  }
  ```

- [ ] **Step 6: Implement the process entrypoint** — create `cmd/fractals/main.go`:
  ```go
  package main

  import (
  	"os"

  	"fractals/internal/cli"
  )

  func main() {
  	if cli.Execute() != nil {
  		os.Exit(1)
  	}
  }
  ```

- [ ] **Step 7: Format, build, and run tests** — run:
  ```
  gofmt -w internal/cli/root.go internal/cli/sierpinski.go internal/cli/sierpinski_test.go cmd/fractals/main.go
  go build ./...
  go test ./internal/cli/
  ```
  Expected: `go build ./...` produces no output (success), and:
  ```
  ok  	fractals/internal/cli	0.2s
  ```

- [ ] **Step 8: Commit** — run:
  ```
  git add go.mod go.sum internal/cli/root.go internal/cli/sierpinski.go internal/cli/sierpinski_test.go cmd/fractals/main.go
  git commit -m "Add CLI scaffold, main entrypoint, and sierpinski subcommand"
  ```

---

### Task 11: `fern` subcommand

**Files:**
- Create: `internal/cli/fern.go`
- Modify: `internal/cli/root.go` (register the fern command)
- Test: `internal/cli/fern_test.go`

**Interfaces:**
- Consumes: `fern.Generate(width, height, points int, seed int64, char rune) []string` (from the fern package task); `positiveInt`, `singleChar` validators; the `runRoot` test helper and `newRootCmd` pattern from Task 10.
- Produces: unexported `newFernCmd() *cobra.Command`, registered in `newRootCmd`.

- [ ] **Step 1: Write the failing test** — create `internal/cli/fern_test.go`:
  ```go
  package cli

  import (
  	"strings"
  	"testing"
  )

  // rowCount returns the number of rendered rows in stdout. Fprintln joins the
  // rows with "\n" and appends one trailing "\n"; trimming that trailing newline
  // and splitting on "\n" yields exactly one entry per row.
  func rowCount(stdout string) int {
  	trimmed := strings.TrimSuffix(stdout, "\n")
  	if trimmed == "" {
  		return 0
  	}
  	return len(strings.Split(trimmed, "\n"))
  }

  func TestFernPrintsHeightRows(t *testing.T) {
  	stdout, _, err := runRoot(t, "fern", "--width", "20", "--height", "10", "--points", "1000")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	if got := rowCount(stdout); got != 10 {
  		t.Errorf("row count = %d, want 10", got)
  	}
  }

  func TestFernCharSubstitution(t *testing.T) {
  	stdout, _, err := runRoot(t, "fern", "--width", "20", "--height", "10", "--points", "2000", "--char", "o")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	if !strings.Contains(stdout, "o") {
  		t.Errorf("expected marked cells rendered as 'o', got:\n%s", stdout)
  	}
  	if strings.Contains(stdout, "*") {
  		t.Errorf("default '*' should not appear when --char o is set:\n%s", stdout)
  	}
  }

  func TestFernInvalidPoints(t *testing.T) {
  	stdout, _, err := runRoot(t, "fern", "--points", "0")
  	if err == nil {
  		t.Fatalf("expected error, got nil")
  	}
  	if got := err.Error(); got != "--points must be a positive integer (got 0)" {
  		t.Errorf("error mismatch: got %q", got)
  	}
  	if stdout != "" {
  		t.Errorf("stdout should be empty on error, got %q", stdout)
  	}
  }
  ```

- [ ] **Step 2: Run it, verify it fails** — run:
  ```
  go test ./internal/cli/ -run TestFern
  ```
  Expected: the fern subcommand is not registered yet, so `runRoot` returns cobra's unknown-command error and the tests fail, e.g.:
  ```
  --- FAIL: TestFernPrintsHeightRows (0.00s)
      fern_test.go:27: unexpected error: unknown command "fern" for "fractals"
  --- FAIL: TestFernInvalidPoints (0.00s)
      fern_test.go:51: error mismatch: got "unknown command \"fern\" for \"fractals\""
  FAIL	fractals/internal/cli	0.2s
  ```

- [ ] **Step 3: Implement the fern subcommand** — create `internal/cli/fern.go`:
  ```go
  package cli

  import (
  	"fmt"
  	"strings"

  	"github.com/spf13/cobra"

  	"fractals/internal/fern"
  )

  func newFernCmd() *cobra.Command {
  	var (
  		width  int
  		height int
  		points int
  		seed   int64
  		char   string
  	)
  	cmd := &cobra.Command{
  		Use:   "fern",
  		Short: "Render a Barnsley fern",
  		RunE: func(cmd *cobra.Command, args []string) error {
  			if err := positiveInt("width", width); err != nil {
  				return err
  			}
  			if err := positiveInt("height", height); err != nil {
  				return err
  			}
  			if err := positiveInt("points", points); err != nil {
  				return err
  			}
  			ch, err := singleChar("char", char)
  			if err != nil {
  				return err
  			}
  			rows := fern.Generate(width, height, points, seed, ch)
  			fmt.Fprintln(cmd.OutOrStdout(), strings.Join(rows, "\n"))
  			return nil
  		},
  	}
  	cmd.Flags().IntVar(&width, "width", 40, "output width in columns")
  	cmd.Flags().IntVar(&height, "height", 50, "output height in rows")
  	cmd.Flags().IntVar(&points, "points", 50000, "number of chaos-game iterations")
  	cmd.Flags().Int64Var(&seed, "seed", 1, "PRNG seed")
  	cmd.Flags().StringVar(&char, "char", "*", "fill character")
  	return cmd
  }
  ```

- [ ] **Step 4: Register the fern command** — in `internal/cli/root.go`, add the fern command to `newRootCmd`. Change:
  ```go
  	root.AddCommand(newSierpinskiCmd())
  	return root
  ```
  to:
  ```go
  	root.AddCommand(newSierpinskiCmd())
  	root.AddCommand(newFernCmd())
  	return root
  ```

- [ ] **Step 5: Format, build, and run tests** — run:
  ```
  gofmt -w internal/cli/fern.go internal/cli/fern_test.go internal/cli/root.go
  go build ./...
  go test ./internal/cli/
  ```
  Expected: `go build ./...` produces no output, and all cli tests pass:
  ```
  ok  	fractals/internal/cli	0.3s
  ```

- [ ] **Step 6: Commit** — run:
  ```
  git add internal/cli/fern.go internal/cli/fern_test.go internal/cli/root.go
  git commit -m "Add fern subcommand"
  ```


---

### Task 12: internal/cli — mandelbrot, julia, burningship subcommands

**Files:**
- Create `internal/cli/escape.go` (shared `escapePalette` helper)
- Create `internal/cli/mandelbrot.go`
- Create `internal/cli/julia.go`
- Create `internal/cli/burningship.go`
- Test `internal/cli/escape_test.go` (shared test helpers + behavior tests for all three)

**Interfaces:**
- Consumes:
  - `escapetime.Mandelbrot(width, height, iterations int, palette []rune) []string`
  - `escapetime.Julia(width, height, iterations int, creal, cimag float64, palette []rune) []string`
  - `escapetime.BurningShip(width, height, iterations int, palette []rune) []string`
  - `cli.positiveInt(name string, v int) error` and `cli.finiteFloat(name string, v float64) error` (from the validate.go task)
  - `cli.singleChar(name, s string) (rune, error)` (from the validate.go task)
  - `cli.newRootCmd() *cobra.Command` — this task edits it to register the three new commands via `root.AddCommand` (Step 3e), exactly as Tasks 10–11 do.
  - `runRoot(t, args...) (stdout, stderr string, err error)` test helper — defined ONCE in Task 10's `sierpinski_test.go` and reused here; do NOT redefine it.
- Produces:
  - `escapePalette(cmd *cobra.Command) ([]rune, error)` — gradient when `--char` unchanged, else `[]rune{' ', X}`.
  - `newMandelbrotCmd() *cobra.Command`, `newJuliaCmd() *cobra.Command`, `newBurningShipCmd() *cobra.Command`, registered in `newRootCmd` (Step 3e).
  - `distinctRunes(s string) map[rune]bool` test helper reused by Task 13.

> **Registration:** subcommands are attached with explicit `root.AddCommand(...)`
> calls inside `newRootCmd` (Step 3e), matching how Tasks 10–11 register `sierpinski`
> and `fern`. There is no `init()`/registry indirection.

- [ ] **Step 1: Write the failing tests** — create `internal/cli/escape_test.go`:

```go
package cli

import (
	"strings"
	"testing"
)

// distinctRunes returns the set of runes in s, excluding newlines.
func distinctRunes(s string) map[rune]bool {
	set := map[rune]bool{}
	for _, r := range s {
		if r == '\n' {
			continue
		}
		set[r] = true
	}
	return set
}

func TestMandelbrotSingleChar(t *testing.T) {
	out, _, err := runRoot(t, "mandelbrot", "--char", "#")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.ContainsRune(out, '#') {
		t.Fatalf("expected in-set glyph '#' in output:\n%s", out)
	}
	for r := range distinctRunes(out) {
		if r != ' ' && r != '#' {
			t.Fatalf("single-char mode produced unexpected rune %q; output:\n%s", r, out)
		}
	}
}

func TestMandelbrotGradientDefault(t *testing.T) {
	out, _, err := runRoot(t, "mandelbrot")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n := len(distinctRunes(out)); n <= 2 {
		t.Fatalf("expected gradient palette (>2 distinct glyphs), got %d; output:\n%s", n, out)
	}
	if !strings.ContainsRune(out, '@') {
		t.Fatalf("expected in-set gradient glyph '@' in output:\n%s", out)
	}
}

func TestMandelbrotEmptyChar(t *testing.T) {
	out, _, err := runRoot(t, "mandelbrot", "--char", "")
	if err == nil {
		t.Fatal("expected error for empty --char")
	}
	if err.Error() != "--char must be a single printable character" {
		t.Fatalf("unexpected error message: %q", err.Error())
	}
	if out != "" {
		t.Fatalf("expected empty stdout on error, got:\n%s", out)
	}
}

func TestMandelbrotWidthZero(t *testing.T) {
	out, _, err := runRoot(t, "mandelbrot", "--width", "0")
	if err == nil {
		t.Fatal("expected error for --width 0")
	}
	if err.Error() != "--width must be a positive integer (got 0)" {
		t.Fatalf("unexpected error message: %q", err.Error())
	}
	if out != "" {
		t.Fatalf("expected empty stdout on error, got:\n%s", out)
	}
}

func TestJuliaParamsChangeOutput(t *testing.T) {
	def, _, err := runRoot(t, "julia")
	if err != nil {
		t.Fatalf("default julia error: %v", err)
	}
	alt, _, err := runRoot(t, "julia", "--creal", "0.285", "--cimag", "0.01")
	if err != nil {
		t.Fatalf("parameterized julia error: %v", err)
	}
	if def == alt {
		t.Fatal("expected julia output to change with different --creal/--cimag")
	}
}

func TestBurningShipSingleChar(t *testing.T) {
	out, _, err := runRoot(t, "burningship", "--char", "#")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.ContainsRune(out, '#') {
		t.Fatalf("expected in-set glyph '#' in output:\n%s", out)
	}
	for r := range distinctRunes(out) {
		if r != ' ' && r != '#' {
			t.Fatalf("single-char mode produced unexpected rune %q; output:\n%s", r, out)
		}
	}
}

func TestJuliaSingleChar(t *testing.T) {
	out, _, err := runRoot(t, "julia", "--char", "#")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.ContainsRune(out, '#') {
		t.Fatalf("expected in-set glyph '#' in output:\n%s", out)
	}
	for r := range distinctRunes(out) {
		if r != ' ' && r != '#' {
			t.Fatalf("single-char mode produced unexpected rune %q; output:\n%s", r, out)
		}
	}
}
```

- [ ] **Step 2: Run it, verify it fails** — run:

```
go test ./internal/cli/ -run 'TestMandelbrot|TestJulia|TestBurningShip'
```

Expected: compilation succeeds (helpers and `newRootCmd` exist), tests FAIL at runtime because the subcommands are not registered yet. You will see failures like:

```
--- FAIL: TestMandelbrotSingleChar (0.00s)
    escape_test.go:...: unexpected error: unknown command "mandelbrot" for "fractals"
FAIL
```

- [ ] **Step 3a: Implement the shared palette helper** — create `internal/cli/escape.go`:

```go
package cli

import "github.com/spf13/cobra"

// escapePalette builds the palette for the escape-time subcommands. When --char
// was not supplied it returns the 10-rune gradient; when --char was supplied
// (including --char "") it validates the value via singleChar and returns the
// 2-rune palette {' ', X}. Omission is detected with Flags().Changed, so
// --char "" fails validation instead of silently selecting the gradient.
func escapePalette(cmd *cobra.Command) ([]rune, error) {
	if !cmd.Flags().Changed("char") {
		return []rune(" .:-=+*#%@"), nil
	}
	s, err := cmd.Flags().GetString("char")
	if err != nil {
		return nil, err
	}
	ch, err := singleChar("char", s)
	if err != nil {
		return nil, err
	}
	return []rune{' ', ch}, nil
}
```

- [ ] **Step 3b: Implement mandelbrot** — create `internal/cli/mandelbrot.go`:

```go
package cli

import (
	"fmt"
	"strings"

	"fractals/internal/escapetime"
	"github.com/spf13/cobra"
)

func newMandelbrotCmd() *cobra.Command {
	var width, height, iterations int
	cmd := &cobra.Command{
		Use:   "mandelbrot",
		Short: "Render the Mandelbrot set",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := positiveInt("width", width); err != nil {
				return err
			}
			if err := positiveInt("height", height); err != nil {
				return err
			}
			if err := positiveInt("iterations", iterations); err != nil {
				return err
			}
			palette, err := escapePalette(cmd)
			if err != nil {
				return err
			}
			rows := escapetime.Mandelbrot(width, height, iterations, palette)
			fmt.Fprintln(cmd.OutOrStdout(), strings.Join(rows, "\n"))
			return nil
		},
	}
	cmd.Flags().IntVar(&width, "width", 80, "output width in characters")
	cmd.Flags().IntVar(&height, "height", 24, "output height in rows")
	cmd.Flags().IntVar(&iterations, "iterations", 100, "maximum escape-time iterations")
	cmd.Flags().String("char", "", "single fill character (default: gradient palette)")
	return cmd
}
```

- [ ] **Step 3c: Implement julia** — create `internal/cli/julia.go`:

```go
package cli

import (
	"fmt"
	"strings"

	"fractals/internal/escapetime"
	"github.com/spf13/cobra"
)

func newJuliaCmd() *cobra.Command {
	var width, height, iterations int
	var creal, cimag float64
	cmd := &cobra.Command{
		Use:   "julia",
		Short: "Render a Julia set",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := positiveInt("width", width); err != nil {
				return err
			}
			if err := positiveInt("height", height); err != nil {
				return err
			}
			if err := positiveInt("iterations", iterations); err != nil {
				return err
			}
			if err := finiteFloat("creal", creal); err != nil {
				return err
			}
			if err := finiteFloat("cimag", cimag); err != nil {
				return err
			}
			palette, err := escapePalette(cmd)
			if err != nil {
				return err
			}
			rows := escapetime.Julia(width, height, iterations, creal, cimag, palette)
			fmt.Fprintln(cmd.OutOrStdout(), strings.Join(rows, "\n"))
			return nil
		},
	}
	cmd.Flags().IntVar(&width, "width", 80, "output width in characters")
	cmd.Flags().IntVar(&height, "height", 24, "output height in rows")
	cmd.Flags().IntVar(&iterations, "iterations", 100, "maximum escape-time iterations")
	cmd.Flags().Float64Var(&creal, "creal", -0.8, "real part of the Julia constant c")
	cmd.Flags().Float64Var(&cimag, "cimag", 0.156, "imaginary part of the Julia constant c")
	cmd.Flags().String("char", "", "single fill character (default: gradient palette)")
	return cmd
}
```

- [ ] **Step 3d: Implement burningship** — create `internal/cli/burningship.go`:

```go
package cli

import (
	"fmt"
	"strings"

	"fractals/internal/escapetime"
	"github.com/spf13/cobra"
)

func newBurningShipCmd() *cobra.Command {
	var width, height, iterations int
	cmd := &cobra.Command{
		Use:   "burningship",
		Short: "Render the Burning Ship fractal",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := positiveInt("width", width); err != nil {
				return err
			}
			if err := positiveInt("height", height); err != nil {
				return err
			}
			if err := positiveInt("iterations", iterations); err != nil {
				return err
			}
			palette, err := escapePalette(cmd)
			if err != nil {
				return err
			}
			rows := escapetime.BurningShip(width, height, iterations, palette)
			fmt.Fprintln(cmd.OutOrStdout(), strings.Join(rows, "\n"))
			return nil
		},
	}
	cmd.Flags().IntVar(&width, "width", 80, "output width in characters")
	cmd.Flags().IntVar(&height, "height", 24, "output height in rows")
	cmd.Flags().IntVar(&iterations, "iterations", 100, "maximum escape-time iterations")
	cmd.Flags().String("char", "", "single fill character (default: gradient palette)")
	return cmd
}
```

- [ ] **Step 3e: Register the three commands in the root command** — in `internal/cli/root.go`, extend `newRootCmd` (matching how Tasks 10–11 registered `sierpinski` and `fern`). Change:

```go
	root.AddCommand(newSierpinskiCmd())
	root.AddCommand(newFernCmd())
	return root
```

to:

```go
	root.AddCommand(newSierpinskiCmd())
	root.AddCommand(newFernCmd())
	root.AddCommand(newMandelbrotCmd())
	root.AddCommand(newJuliaCmd())
	root.AddCommand(newBurningShipCmd())
	return root
```

- [ ] **Step 4: Run tests, verify pass** — run:

```
gofmt -l internal/cli/escape.go internal/cli/mandelbrot.go internal/cli/julia.go internal/cli/burningship.go internal/cli/root.go internal/cli/escape_test.go
go build ./...
go test ./internal/cli/ -run 'TestMandelbrot|TestJulia|TestBurningShip'
```

Expected: `gofmt -l` prints nothing (files are formatted). `go test` prints:

```
ok  	fractals/internal/cli	0.0XXs
```

- [ ] **Step 5: Commit** — run:

```
git add internal/cli/escape.go internal/cli/mandelbrot.go internal/cli/julia.go internal/cli/burningship.go internal/cli/root.go internal/cli/escape_test.go
git commit -m "Add mandelbrot, julia, burningship CLI subcommands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: internal/cli — newton subcommand

**Files:**
- Create `internal/cli/newton.go`
- Test `internal/cli/newton_test.go` (reuses `runRoot` from `escape_test.go`)

**Interfaces:**
- Consumes:
  - `newton.Generate(width, height, iterations int) []string`
  - `cli.positiveInt(name string, v int) error`
  - `cli.newRootCmd() *cobra.Command` — this task edits it to register `newNewtonCmd` via `root.AddCommand`.
  - `runRoot(t, args...) (stdout, stderr string, err error)` test helper (defined once in Task 10's `sierpinski_test.go`).
- Produces:
  - `newNewtonCmd() *cobra.Command`, registered in `newRootCmd` (Step 3b). `newton` has NO `--char` flag.

- [ ] **Step 1: Write the failing tests** — create `internal/cli/newton_test.go`:

```go
package cli

import (
	"strings"
	"testing"
)

func TestNewtonDefaultRowCount(t *testing.T) {
	out, _, err := runRoot(t, "newton")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 24 {
		t.Fatalf("expected 24 rows at default height, got %d; output:\n%s", len(lines), out)
	}
}

func TestNewtonIterationsZero(t *testing.T) {
	out, _, err := runRoot(t, "newton", "--iterations", "0")
	if err == nil {
		t.Fatal("expected error for --iterations 0")
	}
	if err.Error() != "--iterations must be a positive integer (got 0)" {
		t.Fatalf("unexpected error message: %q", err.Error())
	}
	if out != "" {
		t.Fatalf("expected empty stdout on error, got:\n%s", out)
	}
}

func TestNewtonRejectsCharFlag(t *testing.T) {
	out, _, err := runRoot(t, "newton", "--char", "x")
	if err == nil {
		t.Fatal("expected unknown-flag error for newton --char")
	}
	if !strings.Contains(err.Error(), "unknown flag") {
		t.Fatalf("expected unknown-flag error, got: %v", err)
	}
	if out != "" {
		t.Fatalf("expected empty stdout on error, got:\n%s", out)
	}
}
```

- [ ] **Step 2: Run it, verify it fails** — run:

```
go test ./internal/cli/ -run TestNewton
```

Expected: compiles (`runRoot` exists from Task 12), tests FAIL at runtime because the `newton` subcommand is not registered. `TestNewtonDefaultRowCount` fails with `unexpected error: unknown command "newton" for "fractals"`; `TestNewtonRejectsCharFlag` fails because the error is `unknown command "newton"...`, not an `unknown flag` error. Example:

```
--- FAIL: TestNewtonDefaultRowCount (0.00s)
    newton_test.go:...: unexpected error: unknown command "newton" for "fractals"
FAIL
```

- [ ] **Step 3: Implement newton** — create `internal/cli/newton.go`:

```go
package cli

import (
	"fmt"
	"strings"

	"fractals/internal/newton"
	"github.com/spf13/cobra"
)

func newNewtonCmd() *cobra.Command {
	var width, height, iterations int
	cmd := &cobra.Command{
		Use:   "newton",
		Short: "Render the Newton fractal for z^3 - 1",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := positiveInt("width", width); err != nil {
				return err
			}
			if err := positiveInt("height", height); err != nil {
				return err
			}
			if err := positiveInt("iterations", iterations); err != nil {
				return err
			}
			rows := newton.Generate(width, height, iterations)
			fmt.Fprintln(cmd.OutOrStdout(), strings.Join(rows, "\n"))
			return nil
		},
	}
	cmd.Flags().IntVar(&width, "width", 80, "output width in characters")
	cmd.Flags().IntVar(&height, "height", 24, "output height in rows")
	cmd.Flags().IntVar(&iterations, "iterations", 50, "maximum Newton iterations")
	return cmd
}
```

- [ ] **Step 3b: Register the newton command** — in `internal/cli/root.go`, add it to `newRootCmd`. Change:

```go
	root.AddCommand(newBurningShipCmd())
	return root
```

to:

```go
	root.AddCommand(newBurningShipCmd())
	root.AddCommand(newNewtonCmd())
	return root
```

- [ ] **Step 4: Run tests, verify pass** — run:

```
gofmt -l internal/cli/newton.go internal/cli/newton_test.go internal/cli/root.go
go build ./...
go test ./internal/cli/
```

Expected: `gofmt -l` prints nothing. `go test ./internal/cli/` runs the full cli package (Task 12 tests + Task 13 tests) and prints:

```
ok  	fractals/internal/cli	0.0XXs
```

- [ ] **Step 5: Commit** — run:

```
git add internal/cli/newton.go internal/cli/newton_test.go internal/cli/root.go
git commit -m "Add newton CLI subcommand

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **Note on default-render goldens:** The byte-for-byte 80x24 default stdout goldens for
> `mandelbrot`, `julia`, `burningship`, and `newton` (AC2) are captured by the dedicated
> golden-file cli task, not here. The tests above deliberately assert behavior/properties
> (single-char vs gradient palette, parameter sensitivity, row count, validation errors,
> unknown-flag rejection) so a hardcoded value cannot pass them.


---

### Task 14: Integration — golden-file helper, default-render goldens, --help coverage, and subprocess exit-code checks

**Files:**
- Create `internal/cli/golden_test.go` (module `fractals`) — the `-update` flag and `goldenCompare` helper, plus `TestDefaults` (captures/compares all six default renders).
- Create `internal/cli/integration_test.go` (module `fractals`) — root `--help` and per-subcommand `--help` tests, the real-binary subprocess tests, and the cli invalid-input matrix (`--height`/`--depth`/`--creal`/`--cimag`), unknown-subcommand / bad-typed-flag, and flag-wiring delta tests (`--iterations`/`--width`/`--points`).
- Create golden files under `internal/cli/testdata/` (generated by the one-time `-update` run below): `sierpinski_default.golden`, `mandelbrot_default.golden`, `julia_default.golden`, `burningship_default.golden`, `newton_default.golden`, `fern_default.golden`.

**Interfaces:**
- Consumes: `cli.newRootCmd() *cobra.Command` (drives every subcommand via `SetArgs`/`SetOut`/`SetErr`). Consumes the `fractals/cmd/fractals` `main` package (built into a temp binary for the subprocess tests). No new exported symbols.
- Produces: nothing other tasks consume. This task is the final integration gate.

This is the last task; it assumes all six subcommands (`sierpinski`, `mandelbrot`, `julia`, `burningship`, `newton`, `fern`), `cmd/fractals/main.go`, and `cli.Execute()`/`newRootCmd()` already exist and their unit tests pass.

---

- [ ] **Step 1: Write the golden-file helper and the `-update` flag** — create `internal/cli/golden_test.go`:

```go
package cli

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// update, when set via `go test ./internal/cli -update`, rewrites golden files
// instead of comparing against them.
var update = flag.Bool("update", false, "update golden files")

// goldenCompare compares got against testdata/<name>.golden. With -update it
// (re)writes the golden file and returns without asserting.
func goldenCompare(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", name+".golden")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatalf("write golden %s: %v", path, err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s: %v (capture it with: go test ./internal/cli -run TestDefaults -update)", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("output for %q does not match %s\n--- got ---\n%s\n--- want ---\n%s", name, path, got, want)
	}
}
```

- [ ] **Step 2: Write `TestDefaults`** — append to `internal/cli/golden_test.go` (same package/file):

```go
// allSubcommands is the canonical list every acceptance criterion enumerates.
var allSubcommands = []string{"sierpinski", "mandelbrot", "julia", "burningship", "newton", "fern"}

// TestDefaults runs each subcommand at its defaults through newRootCmd() and
// compares captured stdout (including the trailing newline) byte-for-byte to a
// committed golden. Capture goldens once with:
//
//	go test ./internal/cli -run TestDefaults -update
func TestDefaults(t *testing.T) {
	for _, sub := range allSubcommands {
		t.Run(sub, func(t *testing.T) {
			cmd := newRootCmd()
			var out, errBuf bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(&errBuf)
			cmd.SetArgs([]string{sub})
			if err := cmd.Execute(); err != nil {
				t.Fatalf("%s at defaults returned error: %v", sub, err)
			}
			if errBuf.Len() != 0 {
				t.Errorf("%s wrote to stderr on success: %q", sub, errBuf.String())
			}
			goldenCompare(t, sub+"_default", out.Bytes())
		})
	}
}
```

- [ ] **Step 3: Run `TestDefaults` WITHOUT `-update`, verify it fails on the missing golden** — the golden files do not exist yet, so this is the failing-test step:

```
go test ./internal/cli -run TestDefaults
```

Expected: FAIL, with messages like
`read golden testdata/sierpinski_default.golden: open testdata/sierpinski_default.golden: no such file or directory (capture it with: go test ./internal/cli -run TestDefaults -update)`.

- [ ] **Step 4: Capture the goldens (one-time) with `-update`** — run the exact capture command the helper message names:

```
go test ./internal/cli -run TestDefaults -update
```

Expected: `ok  	fractals/internal/cli`. This writes all six files under `internal/cli/testdata/`. Confirm they were created:

```
ls internal/cli/testdata
```

Expected output (order may vary):
```
burningship_default.golden	julia_default.golden		newton_default.golden
fern_default.golden		mandelbrot_default.golden	sierpinski_default.golden
```

- [ ] **Step 5: Eyeball two goldens to confirm they render real fractals** — do NOT skip this; a golden that captures garbage will "pass" forever:

```
cat internal/cli/testdata/sierpinski_default.golden
```

Expected: a centered Sierpinski triangle of 32 rows made of `*`, apex at the top, base row `2*32-1 = 63` characters wide.

```
head -6 internal/cli/testdata/fern_default.golden
```

Expected: the top of a Barnsley fern drawn with `*` across a 40-wide grid.

- [ ] **Step 6: Re-run `TestDefaults` WITHOUT `-update`, verify it now passes** —

```
go test ./internal/cli -run TestDefaults -v
```

Expected: `--- PASS: TestDefaults` plus `--- PASS: TestDefaults/sierpinski` … one PASS per subcommand, ending `ok  	fractals/internal/cli`.

- [ ] **Step 7: Write the `--help` and subprocess tests** — create `internal/cli/integration_test.go`:

```go
package cli

import (
	"bytes"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestRootHelpListsSubcommands covers AC1: `fractals --help` names all six
// subcommands.
func TestRootHelpListsSubcommands(t *testing.T) {
	cmd := newRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--help"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("--help returned error: %v", err)
	}
	got := out.String()
	for _, sub := range allSubcommands {
		if !strings.Contains(got, sub) {
			t.Errorf("root --help output missing subcommand %q\n%s", sub, got)
		}
	}
}

// TestSubcommandHelpListsFlags checks each `fractals <sub> --help` lists that
// subcommand's own flags.
func TestSubcommandHelpListsFlags(t *testing.T) {
	cases := map[string][]string{
		"sierpinski":  {"--size", "--depth", "--char"},
		"mandelbrot":  {"--width", "--height", "--iterations", "--char"},
		"julia":       {"--width", "--height", "--iterations", "--creal", "--cimag", "--char"},
		"burningship": {"--width", "--height", "--iterations", "--char"},
		"newton":      {"--width", "--height", "--iterations"},
		"fern":        {"--width", "--height", "--points", "--seed", "--char"},
	}
	for sub, flags := range cases {
		t.Run(sub, func(t *testing.T) {
			cmd := newRootCmd()
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(&out)
			cmd.SetArgs([]string{sub, "--help"})
			if err := cmd.Execute(); err != nil {
				t.Fatalf("%s --help returned error: %v", sub, err)
			}
			got := out.String()
			for _, f := range flags {
				if !strings.Contains(got, f) {
					t.Errorf("%s --help missing flag %q\n%s", sub, f, got)
				}
			}
		})
	}
}

// buildBinary compiles the real cmd/fractals binary into a temp dir and returns
// its path. The module-qualified package path "fractals/cmd/fractals" builds
// regardless of the test's working directory.
func buildBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "fractals")
	out, err := exec.Command("go", "build", "-o", bin, "fractals/cmd/fractals").CombinedOutput()
	if err != nil {
		t.Fatalf("go build fractals/cmd/fractals failed: %v\n%s", err, out)
	}
	return bin
}

// TestBinaryInvalidInput drives the real process: invalid input must exit 1 with
// empty stdout and stderr equal to the bare message plus one newline.
func TestBinaryInvalidInput(t *testing.T) {
	bin := buildBinary(t)
	cmd := exec.Command(bin, "sierpinski", "--size", "0")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("expected *exec.ExitError, got %v", err)
	}
	if code := exitErr.ExitCode(); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout not empty on error: %q", stdout.String())
	}
	if got, want := stderr.String(), "--size must be a positive integer (got 0)\n"; got != want {
		t.Errorf("stderr = %q, want %q", got, want)
	}
}

// TestBinaryValidRun: a valid invocation exits 0 with non-empty stdout.
func TestBinaryValidRun(t *testing.T) {
	bin := buildBinary(t)
	cmd := exec.Command(bin, "sierpinski")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("valid run returned error: %v (stderr: %s)", err, stderr.String())
	}
	if stdout.Len() == 0 {
		t.Error("valid run produced empty stdout")
	}
	if stderr.Len() != 0 {
		t.Errorf("valid run wrote to stderr: %q", stderr.String())
	}
}

// TestCLIInvalidInputMatrix exercises the RunE validation wiring for the flags
// not already covered by the per-subcommand tasks (AC6): --height, negative
// --depth, and non-finite --creal/--cimag. Each returns the exact bare message
// with empty stdout.
func TestCLIInvalidInputMatrix(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"mandelbrot", "--height", "0"}, "--height must be a positive integer (got 0)"},
		{[]string{"sierpinski", "--depth", "-1"}, "--depth must be zero or a positive integer (got -1)"},
		{[]string{"julia", "--creal", "NaN"}, "--creal must be a finite number"},
		{[]string{"julia", "--cimag", "NaN"}, "--cimag must be a finite number"},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			cmd := newRootCmd()
			var out, errBuf bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(&errBuf)
			cmd.SetArgs(tc.args)
			err := cmd.Execute()
			if err == nil {
				t.Fatalf("expected error for %v", tc.args)
			}
			if err.Error() != tc.want {
				t.Errorf("error = %q, want %q", err.Error(), tc.want)
			}
			if out.Len() != 0 {
				t.Errorf("stdout not empty on error: %q", out.String())
			}
		})
	}
}

// TestCLIUnknownSubcommandAndBadFlagValue covers the spec's "unknown subcommand"
// and "invalid value for a typed flag" cases: both surface as a non-nil error
// with empty stdout.
func TestCLIUnknownSubcommandAndBadFlagValue(t *testing.T) {
	for _, args := range [][]string{
		{"bogus"},
		{"mandelbrot", "--width", "abc"},
	} {
		cmd := newRootCmd()
		var out, errBuf bytes.Buffer
		cmd.SetOut(&out)
		cmd.SetErr(&errBuf)
		cmd.SetArgs(args)
		if err := cmd.Execute(); err == nil {
			t.Errorf("expected error for %v", args)
		}
		if out.Len() != 0 {
			t.Errorf("stdout not empty for %v: %q", args, out.String())
		}
	}
}

// markedCells counts non-space, non-newline runes — used to prove --points is
// wired to the fern's density.
func markedCells(s string) int {
	n := 0
	for _, r := range s {
		if r != ' ' && r != '\n' {
			n++
		}
	}
	return n
}

// TestCLIFlagWiringDeltas covers AC3: changing a flag must change output, so a
// hardcoded value cannot pass a single golden.
func TestCLIFlagWiringDeltas(t *testing.T) {
	run := func(args ...string) string {
		cmd := newRootCmd()
		var out, errBuf bytes.Buffer
		cmd.SetOut(&out)
		cmd.SetErr(&errBuf)
		cmd.SetArgs(args)
		if err := cmd.Execute(); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		return out.String()
	}
	if run("mandelbrot", "--iterations", "10") == run("mandelbrot", "--iterations", "200") {
		t.Error("mandelbrot output did not change between --iterations 10 and 200")
	}
	narrow := run("mandelbrot", "--width", "20", "--height", "10")
	wide := run("mandelbrot", "--width", "60", "--height", "10")
	if len(strings.SplitN(narrow, "\n", 2)[0]) == len(strings.SplitN(wide, "\n", 2)[0]) {
		t.Error("mandelbrot first-row length did not change with --width")
	}
	if markedCells(run("fern", "--points", "500")) == markedCells(run("fern", "--points", "20000")) {
		t.Error("fern marked-cell count did not change with --points")
	}
}
```

- [ ] **Step 8: Run the new integration tests, verify they pass** —

```
go test ./internal/cli -run 'TestRootHelpListsSubcommands|TestSubcommandHelpListsFlags|TestBinaryInvalidInput|TestBinaryValidRun|TestCLIInvalidInputMatrix|TestCLIUnknownSubcommandAndBadFlagValue|TestCLIFlagWiringDeltas' -v
```

Expected: `--- PASS` for `TestRootHelpListsSubcommands`, `TestSubcommandHelpListsFlags` (and each `/<sub>` subtest), `TestBinaryInvalidInput`, and `TestBinaryValidRun`, ending `ok  	fractals/internal/cli`.

- [ ] **Step 9: Run the ENTIRE suite gofmt-clean and confirm the whole project is green** —

```
gofmt -l internal/cli
go vet ./...
go test ./...
```

Expected: `gofmt -l` prints nothing (no unformatted files); `go vet` prints nothing; `go test ./...` prints `ok` for every package (`fractals/internal/plane`, `.../escapetime`, `.../newton`, `.../fern`, `.../sierpinski`, `.../cli`) with no `FAIL`. Test output is pristine — no stray error text on stdout/stderr.

- [ ] **Step 10: Commit** —

```
git add internal/cli/golden_test.go internal/cli/integration_test.go internal/cli/testdata
git commit -m "Add cli integration tests: default-render goldens, --help coverage, and subprocess exit-code checks"
```


---

