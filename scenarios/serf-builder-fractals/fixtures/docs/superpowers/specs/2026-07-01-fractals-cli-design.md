# Go Fractals CLI — Design Spec

**Status:** Draft for review
**Date:** 2026-07-01
**Supersedes:** `design.md` (original brainstorm). Where they differ, this spec
wins. Notable refinement: `--size` for `sierpinski` means **number of rows**
here (base width = `2*size - 1`), not "base width in characters" as design.md
phrased it.

## Overview & Goal

**Goal:** A command-line tool, `fractals`, that renders ASCII-art fractals to
stdout. Six subcommands:

| Subcommand     | Family              | What it draws                          |
|----------------|---------------------|----------------------------------------|
| `sierpinski`   | recursive geometry  | Sierpinski triangle                    |
| `mandelbrot`   | escape-time         | The Mandelbrot set                     |
| `julia`        | escape-time         | A Julia set (parameterized by `c`)     |
| `burningship`  | escape-time         | The Burning Ship fractal               |
| `newton`       | root-finding basins | Newton fractal for `z³ − 1`            |
| `fern`         | iterated fn. system | The Barnsley fern                      |

Output is **deterministic given all inputs**: the same flags always produce the
same bytes. The only randomness is the fern's chaos game, which uses an
explicitly seeded PRNG (`--seed`) — never a time-based or unseeded source.

## Global Constraints

Every unit and task inherits these:

- **Go 1.21+**.
- Sole third-party dependency: **`github.com/spf13/cobra`**. Standard library
  `math`, `math/cmplx`, and `math/rand` are used; nothing else.
- Fractal output → **stdout**. Diagnostics/errors → **stderr**.
- Exit code **0** on success, **1** on any validation or usage error. On error,
  **stdout is empty**.
- Determinism: identical inputs (including `--seed`) → identical output. No
  time-based seeds, no unseeded `math/rand`, no goroutine-ordering effects on
  output.
- Error messages are exact and prefix-free (see Error Handling): no cobra
  `Error:` prefix, no usage dump.

## Architecture

Algorithm packages are **pure**: they take validated primitives and return
`[]string` (one entry per output row). They never read flags, never print, never
call `os.Exit`. All flag parsing, validation, printing, and process exit live in
`cli`. Coordinate mapping (grid cell → point in the complex plane) is shared by
every escape-time fractal and Newton, so it lives in its own tiny package.

```
cmd/
  fractals/
    main.go              # func main: os.Exit(0/1) based on cli.Execute()
internal/
  plane/
    plane.go             # Region + At(): grid cell -> complex-plane point
    plane_test.go
  escapetime/
    engine.go            # Render(): the shared escape-time loop + char mapping
    mandelbrot.go        # Mandelbrot(...)  -> region + step, calls Render
    julia.go             # Julia(...)
    burningship.go       # BurningShip(...)
    escapetime_test.go
  newton/
    newton.go            # Generate(): root-basin coloring
    newton_test.go
  fern/
    fern.go              # Generate(): seeded chaos game
    fern_test.go
  sierpinski/
    sierpinski.go        # Generate(): recursive subdivision
    sierpinski_test.go
  cli/
    root.go              # newRootCmd(), Execute()
    sierpinski.go mandelbrot.go julia.go burningship.go newton.go fern.go
    validate.go          # positiveInt, nonNegativeInt, finiteFloat, singleChar
    *_test.go
```

### Data Flow

```
main → cli.Execute():
    cmd := newRootCmd()
    err := cmd.Execute()                 # cobra parses argv, runs subcommand RunE
    if err != nil { fmt.Fprintln(os.Stderr, err) }   # bare message, no prefix
    return err                           # main → os.Exit(1) if non-nil

subcommand RunE(cmd, args):
    read flags → validate (validate.go) → build char/palette/params
    → package Generate/Render(...) → []string rows
    → fmt.Fprintln(cmd.OutOrStdout(), strings.Join(rows, "\n"))
```

Because RunE writes through `cmd.OutOrStdout()` and returns validation errors
(cobra routes nothing to stdout on error), **stdout is empty whenever RunE
returns an error**. The root command sets `SilenceUsage = true` and
`SilenceErrors = true` so cobra neither prints the error itself nor dumps usage;
`Execute()` prints the bare error message to stderr. Tests drive
`newRootCmd()` directly with `SetArgs` / `SetOut` / `SetErr` and assert on the
returned error and captured buffers.

### Interfaces (exact signatures)

```go
// internal/plane
type Region struct{ XMin, XMax, YMin, YMax float64 }
// At maps grid cell (row i, col j) of a width×height image to a plane point
// using float64 division, e.g. cx = XMin + float64(j)/float64(width-1)*(XMax-XMin).
// Row 0 is the TOP of the image and maps to YMax (y increases upward);
// col 0 maps to XMin. Single-row/col images avoid divide-by-zero:
//   width  == 1 → cx = XMin ;  height == 1 → cy = YMax.
func (r Region) At(i, j, width, height int) (cx, cy float64)

// internal/escapetime
// Step reports the iteration at which the pixel escaped and whether it escaped.
// Contract: escaped == true  ⇒ 0 <= count <= maxIter-1
//           escaped == false ⇒ count is ignored (treated as in-set)
type Step func(cx, cy float64) (count int, escaped bool)

// Render requires len(palette) >= 2. In-set points map to palette[len-1];
// escaped points map to a lower index (never the in-set glyph). See engine.
func Render(width, height, maxIter int, region plane.Region, palette []rune, step Step) []string
func Mandelbrot(width, height, iterations int, palette []rune) []string
func Julia(width, height, iterations int, creal, cimag float64, palette []rune) []string
func BurningShip(width, height, iterations int, palette []rune) []string

// internal/newton
func Generate(width, height, iterations int) []string

// internal/fern
func Generate(width, height, points int, seed int64, char rune) []string

// internal/sierpinski
func Generate(size, depth int, char rune) []string

// internal/cli
func Execute() error
func newRootCmd() *cobra.Command
func positiveInt(name string, v int) error       // v >= 1 else error
func nonNegativeInt(name string, v int) error     // v >= 0 else error
func finiteFloat(name string, v float64) error    // reject NaN / ±Inf
func singleChar(name, s string) (rune, error)     // exactly one printable rune

// Validators receive the BARE flag name ("size", "depth", "char", ...) and own
// the "--" prefix and the full message template. So positiveInt("size", 0)
// returns exactly: --size must be a positive integer (got 0)
```

`Generate`/`Render` assume validated inputs (`size >= 1`, `depth >= 0`,
`width/height/iterations/points >= 1`, `palette` length `>= 2`, `creal/cimag`
finite). The `cli` layer guarantees this before calling them.

## The shared escape-time engine

`Render` is the single loop behind `mandelbrot`, `julia`, and `burningship`.
Each of those supplies only a framing `Region` and a `Step` closure.

```
Render(width, height, maxIter, region, palette, step):
    for i in 0..height-1:
        for j in 0..width-1:
            cx, cy := region.At(i, j, width, height)
            count, escaped := step(cx, cy)
            n := maxIter
            if escaped { n = count }              // n < maxIter for escaped pts
            idx := floor( float64(n)/float64(maxIter) * float64(len(palette)-1) )
            clamp idx to [0, len(palette)-1]
            row[j] = palette[idx]
    return rows
```

**All divisions are `float64`, never Go integer division.** With this, an
escaped point (`n < maxIter`) yields a fraction `< 1` and therefore an index in
`[0, len-2]` — it can never land on `palette[len-1]`. An in-set point
(`n = maxIter`) yields index `len-1`. There is no `len(palette)==1` branch: the
cli always passes a palette of length `>= 2` (see Character mapping).

Escape test: a point escapes when `real(z)² + imag(z)² > 4` (i.e. `|z| > 2`).
The step loop is 0-based and breaks the instant it escapes, so the returned
`count` is always `< maxIter`; a point still bounded after `maxIter` updates
returns `escaped == false`. This removes the sentinel collision where an
end-of-loop escape would masquerade as in-set.

### `mandelbrot`

Renders the Mandelbrot set: `c` = pixel, `z₀ = 0`, `z ← z² + c`.

```
region  = {XMin:-2.5, XMax:1.0, YMin:-1.0, YMax:1.0}   # whole set with margin
step(cx,cy):
    zr, zi := 0.0, 0.0
    for n := 0; n < maxIter; n++ {
        zr, zi = zr*zr - zi*zi + cx, 2*zr*zi + cy      # simultaneous assignment
        if zr*zr + zi*zi > 4 { return n, true }
    }
    return maxIter, false
```

The set is symmetric about the real axis, so image orientation is unobservable.

**Flags:** `--width` (80), `--height` (24), `--iterations` (100), `--char`
(default: gradient — see below). All ints must be `>= 1`.

### `julia`

Same iteration as Mandelbrot but `z₀` = pixel and `c` is the fixed parameter
`--creal + i·--cimag`.

```
region  = {XMin:-1.5, XMax:1.5, YMin:-1.5, YMax:1.5}
step(cx,cy):
    zr, zi := cx, cy
    for n := 0; n < maxIter; n++ {
        zr, zi = zr*zr - zi*zi + creal, 2*zr*zi + cimag
        if zr*zr + zi*zi > 4 { return n, true }
    }
    return maxIter, false
```

**Flags:** `--width` (80), `--height` (24), `--iterations` (100),
`--creal` (**default −0.8**), `--cimag` (**default 0.156**), `--char` (gradient).
`creal/cimag` must be finite (reject `NaN`/`Inf`). The default `c` gives a
dragon-like set; different `c` values produce spirals, dendrites, and dust.

### `burningship`

Mandelbrot iteration with the real and imaginary parts folded to their absolute
values before squaring: `z ← (|Re z| + i·|Im z|)² + c`.

```
region  = {XMin:-2.0, XMax:0.5, YMin:-0.5, YMax:1.3}   # frozen — frames the full set
step(cx,cy):
    cy = -cy                        # iterate the conjugate pixel (see Orientation)
    zr, zi := 0.0, 0.0
    for n := 0; n < maxIter; n++ {
        a, b := abs(zr), abs(zi)
        zr, zi = a*a - b*b + cx, 2*a*b + cy
        if zr*zr + zi*zi > 4 { return n, true }
    }
    return maxIter, false
```

**Orientation.** Under the shared `plane.At` mapping (row 0 → YMax) the raw set
renders inverted — solid hull at the top, masts trailing downward. The step
therefore iterates the **conjugate** pixel `c = cx − i·cy`, a vertical mirror
that puts the hull low with the mast/antenna filaments pointing up above a
horizontal "waterline" spar — the recognizable Burning Ship silhouette.

**Framing.** The region above is frozen: it was chosen by rendering the full set
at defaults (real ∈ [−2.0, 0.5], imag ∈ [−0.5, 1.3]) and confirming the framing,
not left as a per-implementation tuning knob. The committed default golden (AC2)
is captured against it.

**Flags:** `--width` (80), `--height` (24), `--iterations` (100), `--char`
(gradient). All ints `>= 1`.

### Character mapping (all three escape-time fractals)

- **Gradient mode** (default; `--char` not supplied): palette
  `" .:-=+*#%@"` (10 runes; index 0 = space … 9 = `@`). Fast escapes → sparse
  glyphs; in-set → `@`.
- **Single-char mode** (`--char X` supplied): the cli builds the 2-rune palette
  `[' ', X]`. The same `Render` formula then paints escaped points with `' '`
  (index 0) and in-set points with `X` (index 1). No special case in `Render`.

**Omission detection:** the cli uses `cmd.Flags().Changed("char")`. If the flag
was not set → gradient. If it was set (including `--char ''`) → run
`singleChar`, so `--char ''` fails validation like everywhere else.

## `sierpinski`

Sierpinski triangle by recursive subdivision, rendered as a centered isosceles
triangle.

**Flags:**

| Flag      | Default | Meaning                                              |
|-----------|---------|------------------------------------------------------|
| `--size`  | `32`    | Number of rows (output resolution). Must be `>= 1`.  |
| `--depth` | `5`     | Maximum recursion depth. Must be `>= 0`.             |
| `--char`  | `*`     | Fill character. Exactly one printable character.     |

**`--size` and `--depth` are orthogonal, not redundant.** `--size` sets output
resolution (row count); `--depth` sets the *maximum* recursion depth. Depth is
naturally capped by resolution: a triangle of `size` rows stops changing once
depth reaches `ceil(log2(size)) - 1` (the finest cut leaves a 2-row solid with
no center cell to remove), so any larger `--depth` adds no detail — e.g. `size 4`
caps at depth 1, `size 8` at 2, `size 16` at 3. Thus design.md's
`sierpinski --size 16 --char '#'` (default depth 5) is not a contradiction:
depth 5 caps at 3 for a 16-row triangle. `--depth 0` produces a fully **solid**
triangle at the requested size.

**Rendering.** Row `r` (0-indexed from the apex, `0 <= r < size`) has `r + 1`
cell positions (`0 <= c <= r`). Each row is centered by prefixing `size-1-r`
spaces; within a row, cells are joined by a single space. A filled cell prints
`--char`; an empty cell prints a space. The base row is `2*size - 1` characters
wide.

**Membership (recursive subdivision).** For a triangle occupying rows
`[r0, r0+n)` with in-row column offset `off`, at remaining depth `d`:

- If `d == 0` **or** `n <= 1`: fill every cell of this triangle (solid). For
  local row `i` in `[0, n)` that is global row `r0+i`, columns `off .. off+i`.
- Otherwise `h = n / 2` (integer division); recurse into three half-triangles at
  depth `d-1`, leaving the central inverted triangle empty:
  `recurse(r0, h, off, d-1)` (top), `recurse(r0+h, h, off, d-1)` (bottom-left),
  `recurse(r0+h, h, off+h, d-1)` (bottom-right).

The whole triangle is `recurse(0, size, 0, depth)`. Non-power-of-two sizes
subdivide with integer halving (mild asymmetry, still a valid triangle).

**Worked examples (golden):**

`sierpinski --size 4 --depth 0` (solid):

```
   *
  * *
 * * *
* * * *
```

`sierpinski --size 4 --depth 1` (one central hole):

```
   *
  * *
 *   *
* * * *
```

`sierpinski --size 8 --depth 3`:

```
       *
      * *
     *   *
    * * * *
   *       *
  * *     * *
 *   *   *   *
* * * * * * * *
```

`sierpinski --size 4 --char '#'` (default depth 5 caps at 1 for a 4-row
triangle, so this equals `--size 4 --depth 1`):

```
   #
  # #
 #   #
# # # #
```

## `newton`

Newton fractal for `p(z) = z³ − 1`. Each pixel is a start point iterated by
Newton's method; its character is chosen by **which root it converges to**. This
reads as distinct interlocking basins rather than a gradient, which survives
ASCII well.

```
region = {XMin:-2, XMax:2, YMin:-2, YMax:2}
roots  = [ 1+0i,  -0.5 + i·√3/2,  -0.5 - i·√3/2 ]     # cube roots of unity
glyphs = [ '.',   '+',            '@' ]                # one per basin
eps    = 1e-6

for each pixel: z := complex(cx, cy); ch := ' '        # ' ' = did not converge
    for n := 0; n < iterations; n++ {
        for k in 0..2: if |z - roots[k]| < eps { ch = glyphs[k]; stop }
        z2 := z*z
        if |z2| < 1e-12 { stop }                       # z ≈ 0: p'(z) ≈ 0 → background
        z = z - (z*z2 - 1) / (3*z2)                     # z - p(z)/p'(z)
    }
    cell = ch
```

**Last-iteration note.** The pseudocode is authoritative: convergence is tested
at the top of the loop, so a point that first lands within `eps` on the final
update falls to background `' '`. At the default `--iterations 50` this is a
no-op — `z³ − 1` converges quadratically, so no pixel is affected; it could only
matter at a very small `--iterations`. No post-loop check is added.

**Flags:** `--width` (80), `--height` (24), `--iterations` (**50** — Newton
converges fast). All ints `>= 1`. `newton` has **no `--char`** flag; it uses the
fixed three-glyph basin palette above. (Basin shading by iteration count is a
deliberate non-goal for v1; flat basins already show the fractal boundary.)

## `fern`

Barnsley fern via the chaos game (an iterated function system). Starting at
`(0,0)`, repeatedly pick one of four affine maps by probability, apply it, and
mark the grid cell the new point lands in. Marked cells render as `--char`.

```
xmin, xmax, ymin, ymax := -2.65, 2.65, 0.0, 10.0        # mapping constants
rng := rand.New(rand.NewSource(seed))                    # math/rand v1, one Float64/iter
x, y := 0.0, 0.0
repeat `points` times:
    r := rng.Float64()
    if      r < 0.01: x, y = 0,                 0.16*y
    else if r < 0.86: x, y = 0.85*x + 0.04*y,  -0.04*x + 0.85*y + 1.6
    else if r < 0.93: x, y = 0.20*x - 0.26*y,   0.23*x + 0.22*y + 1.6
    else:             x, y = -0.15*x + 0.28*y,  0.26*x + 0.24*y + 0.44
    col := int(math.Round( (x - xmin)/(xmax - xmin) * float64(width-1) ))
    row := int(math.Round( (ymax - y)/(ymax - ymin) * float64(height-1) ))  # y-up
    if 0 <= col < width && 0 <= row < height: mark cell    # out-of-range skipped
marked cell → char, else ' '
```

Assignments use simultaneous evaluation (old `x,y` on the right) — using the
updated `x` inside the `y` expression would distort the fern. A fixed `--seed`
makes the output byte-identical run to run. The fern's true tip reaches
`x ≈ 2.6558`, marginally beyond `xmax = 2.65`; such points are dropped by the
half-open bounds check (not clamped), which the mapping relies on rather than
full padding.

**Flags:** `--width` (40), `--height` (50), `--points` (50000), `--seed` (1),
`--char` (`*`). `width/height/points` must be `>= 1`; `--seed` is registered as a
cobra **Int64** flag (any int64, no validation) so it is not truncated on 32-bit
platforms; `--char` is one printable character. Width/height defaults are taller
than wide to suit the fern's aspect; treat them as a tunable default to confirm
visually.

## Error Handling

All user-facing errors are returned from `RunE`. The root command sets
`SilenceUsage = true` and `SilenceErrors = true`; `Execute()` prints the bare
error to stderr via `fmt.Fprintln(os.Stderr, err)`. So stderr is exactly the
message plus one trailing newline — **no `Error:` prefix, no usage dump** — and
the process exits `1`.

| Condition                                              | Message (to stderr)                                   |
|--------------------------------------------------------|-------------------------------------------------------|
| `--size/--width/--height/--iterations/--points` `< 1`  | `--<flag> must be a positive integer (got <v>)`       |
| `--depth < 0`                                           | `--depth must be zero or a positive integer (got <v>)`|
| `--creal/--cimag` is `NaN` or `±Inf`                   | `--<flag> must be a finite number`                    |
| `--char` not exactly one printable character           | `--<flag> must be a single printable character`       |
| Unknown subcommand / flag / invalid value for a typed flag | cobra's parse error (still bare, via Execute)     |

`--char` is measured in **runes**: a single multi-byte printable character (e.g.
`█`) is valid; `""`, `"ab"`, and control/whitespace runes (newline, CR, tab)
are rejected — those would break the "one line per row / exact width" contract.
A single space **is** permitted (renders a blank fractal — the user's choice).
Invalid values for typed flags (`--width abc`, `--iterations 3.5`, `--creal xyz`,
`--seed 9e99`) are rejected by cobra's flag parser and surface the same way: bare
message, exit `1`, empty stdout.

Example exact stderr for `fractals sierpinski --size 0`:

```
--size must be a positive integer (got 0)
```

## Testing Strategy

All output is deterministic (fern given its seed), so tests assert **exact**
output. No mocks — cli tests execute real cobra commands.

- **`internal/plane`** — `At` returns the correct points at multiple indices, not
  just index 0: row 0 → YMax, `height-1` → YMin, col 0 → XMin, `width-1` → XMax,
  plus an interior midpoint (catches a wrong sign, wrong divisor, or transposed
  axis); the `width == 1` and `height == 1` guards return `XMin` / `YMax` and
  never divide by zero. (One place, tested once, covers every escape-time fractal
  + Newton.)
- **`internal/escapetime`** — test `Render` directly with **fake `Step`s** (the
  seam exists for exactly this): a step returning `(maxIter-1, true)` maps to
  `palette[len-2]`, never the in-set glyph (guards the sentinel-collision fix); a
  step returning a mid-range count maps to a middle index (guards the
  float-division fix); a step returning `(_, false)` maps to `palette[len-1]`.
  Then golden small-grid renders for Mandelbrot, Julia, Burning Ship: every row is
  exactly `width` runes; in-set cells use the last palette rune; single-char mode
  `[' ', X]` blanks the exterior; Julia output changes when `creal/cimag` change.
- **`internal/newton`** — golden small grid; a start point within `eps` of root 1
  yields `.`; all three basin glyphs appear in a full render; a near-origin start
  yields background `' '`.
- **`internal/fern`** — with a fixed seed, the small-grid render matches a golden;
  two calls with the same seed are byte-identical; **two calls with different
  seeds (1 vs 2, enough points to diverge) are NOT identical** (proves `--seed` is
  actually wired in, not ignored); a cell on the fern's stem is marked; `--char`
  substitution works.
- **`internal/sierpinski`** — goldens for depth 0 (solid), `size 4 depth 1`,
  `size 8 depth 3`, a non-power-of-two size, and a `--char` substitution; base
  row is `2*size - 1` wide; `Generate(16,4) == Generate(16,100)` and
  `Generate(16,3) == Generate(16,4)` (depth cap is a no-op past `ceil(log2)-1`).
- **`internal/cli/validate.go`** — each validator returns the exact specified
  message for out-of-range input and `nil` for valid input; `singleChar` accepts
  a multi-byte printable rune, accepts a space, and rejects `""`, `"ab"`, and a
  newline; validators emit the `--` prefix from the bare name.
- **`internal/cli`** — drive `newRootCmd()` with `SetArgs`/`SetOut`/`SetErr`:
  - **All six** subcommands at defaults are committed as byte-for-byte stdout
    goldens (including the trailing newline): `sierpinski`, `mandelbrot`, `julia`,
    `burningship`, `newton`, `fern`. This ties AC2 to something machine-checkable
    for every fractal.
  - Escape-time `--char` path (pure cli logic that testing `Render` alone can't
    reach): an escape-time subcommand with `--char X` renders exterior `' '` and
    in-set `X`; the same subcommand **without** `--char` uses the gradient;
    `--char ''` returns the single-printable-character error with empty stdout.
  - Flag-wiring deltas (so a hardcoded value can't pass a single golden):
    `--iterations 10` vs `200` differ; a `--width` change alters row length; a
    `--points` change alters the fern's marked-cell count; `julia --creal/--cimag`
    changes output.
  - Root `fractals --help` output **lists all six subcommand names**; each
    `fractals <sub> --help` lists that subcommand's flag names.
  - Invalid input (parameterized across `--size/--width/--height/--iterations/`
    `--points/--depth/--creal/--cimag/--char`) returns the exact error string and
    leaves captured stdout empty.
  - An unknown subcommand, and an invalid typed-flag value (e.g. `--width abc`),
    each return an error with empty stdout.
- **Exit code (subprocess)** — build the binary (or `go run`) and run it: invalid
  input exits `1` with empty stdout and stderr equal to `message + "\n"`; a valid
  run exits `0`. (In-process cobra tests can't observe `os.Exit`, so this path
  needs a real process.)

Test output must be pristine: error cases capture stderr and assert its exact
content rather than letting it print.

## Acceptance Criteria

1. `fractals --help` lists all six subcommands.
2. Each subcommand run with defaults produces its fractal, matched against a
   committed golden (`sierpinski`, `mandelbrot`, `julia`, `burningship`,
   `newton`, `fern`).
3. `--size`, `--depth`, `--width`, `--height`, `--iterations`, `--points`,
   `--seed`, `--creal`, `--cimag` change output as specified.
4. `--char` customizes the fill character for `sierpinski`, `fern`, and the
   single-char mode of the three escape-time fractals.
5. `julia --creal/--cimag` change the rendered set; the fern is reproducible for
   a fixed `--seed`.
6. Invalid inputs (non-positive sizes/dimensions/iterations/points, negative
   depth, non-finite `creal/cimag`, non-single-printable `--char`) produce the
   specified bare stderr message and exit code `1`, with empty stdout.
7. All tests pass with pristine output.
