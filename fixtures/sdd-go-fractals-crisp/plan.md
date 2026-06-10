# Go Fractals CLI - Implementation Plan

Execute this plan using the `superpowers:subagent-driven-development` skill.

## Context

Building a CLI tool that generates ASCII fractals. See `design.md` for full specification.

## Global Constraints

These bind every task. Include them in every task's requirements.

- Go 1.21 or newer; module name is exactly `github.com/superpowers-test/fractals`
- The only permitted external dependency is `github.com/spf13/cobra`
- The Mandelbrot character gradient is exactly `" .:-=+*#%@"` (leading space included) — copy it verbatim, never retype it from memory
- Fractal output goes to stdout; error messages go to stderr with a non-zero exit code

## Tasks

### Task 1: Project Setup and CLI Framework

Create the Go module, directory structure, and Cobra root command with help output.

**Do:**
- Initialize `go.mod` with module name `github.com/superpowers-test/fractals`
- Create directory structure: `cmd/fractals/`, `internal/sierpinski/`, `internal/mandelbrot/`, `internal/cli/`
- Add `github.com/spf13/cobra` dependency
- Create `internal/cli/root.go` with the root command; configure help text showing available subcommands
- Create `cmd/fractals/main.go` that executes the root command

**Interfaces:**
- Produces: `cli.Execute() error` in `internal/cli/root.go` — called by `main.go`; later tasks register subcommands on the root command defined here
- Produces: `cli.rootCmd *cobra.Command` (package-internal) — Tasks 3 and 5 attach subcommands to it

**Verify:**
- `go build ./cmd/fractals` succeeds
- `./fractals --help` shows usage with "sierpinski" and "mandelbrot" listed as available commands (stub the two subcommand names in help text now if needed, or add them as the subcommands land in Tasks 3 and 5)
- `./fractals` (no args) shows help

---

### Task 2: Sierpinski Algorithm

Implement the Sierpinski triangle generation algorithm.

**Do:**
- Create `internal/sierpinski/sierpinski.go`
- Implement `Generate(size, depth int, char rune) []string` that returns lines of the triangle
- Use recursive midpoint subdivision algorithm
- Create `internal/sierpinski/sierpinski_test.go` with tests:
  - Small triangle (size=4, depth=2) matches expected output
  - Size=1 returns single character
  - Depth=0 returns filled triangle

**Interfaces:**
- Produces: `sierpinski.Generate(size, depth int, char rune) []string` — consumed by Task 3; signature is exact, do not add parameters

**Verify:**
- `go test ./internal/sierpinski/...` passes

---

### Task 3: Sierpinski CLI Integration

Wire the Sierpinski algorithm to a CLI subcommand, including custom-character support.

**Do:**
- Create `internal/cli/sierpinski.go` with `sierpinski` subcommand registered on the root command
- Add flags: `--size` (default 32), `--depth` (default 5), `--char` (default '*')
- Call `sierpinski.Generate()` and print result to stdout
- Add a test that `--char '#'` produces output using '#'

**Interfaces:**
- Consumes: `sierpinski.Generate(size, depth int, char rune) []string` (Task 2)
- Consumes: the root command from Task 1
- Produces: the `fractals sierpinski` subcommand

**Verify:**
- `./fractals sierpinski` outputs a triangle
- `./fractals sierpinski --size 16 --depth 3` outputs smaller triangle
- `./fractals sierpinski --char '#'` uses '#' character
- `./fractals sierpinski --help` shows flag documentation
- Tests pass

---

### Task 4: Mandelbrot Algorithm

Implement the Mandelbrot set ASCII renderer.

**Do:**
- Create `internal/mandelbrot/mandelbrot.go`
- Implement `Render(width, height, maxIter int, char string) []string`
- Map complex plane region (-2.5 to 1.0 real, -1.0 to 1.0 imaginary) to output dimensions
- Map iteration count to the character gradient `" .:-=+*#%@"` when `char` is empty; when `char` is non-empty, use that single character for points in the set
- Create `internal/mandelbrot/mandelbrot_test.go` with tests:
  - Output dimensions match requested width/height
  - Known point inside set (0,0) maps to max-iteration character
  - Known point outside set (2,0) maps to low-iteration character
  - Non-empty `char` renders set points with that character instead of the gradient

**Interfaces:**
- Produces: `mandelbrot.Render(width, height, maxIter int, char string) []string` — consumed by Task 5; `char == ""` means gradient mode; signature is exact, do not add parameters

**Verify:**
- `go test ./internal/mandelbrot/...` passes

---

### Task 5: Mandelbrot CLI Integration

Wire the Mandelbrot algorithm to a CLI subcommand, including custom-character support.

**Do:**
- Create `internal/cli/mandelbrot.go` with `mandelbrot` subcommand registered on the root command
- Add flags: `--width` (default 80), `--height` (default 24), `--iterations` (default 100), `--char` (default "")
- Call `mandelbrot.Render()` and print result to stdout
- Add a test that `--char '.'` uses '.' for all filled points

**Interfaces:**
- Consumes: `mandelbrot.Render(width, height, maxIter int, char string) []string` (Task 4)
- Consumes: the root command from Task 1
- Produces: the `fractals mandelbrot` subcommand

**Verify:**
- `./fractals mandelbrot` outputs recognizable Mandelbrot set
- `./fractals mandelbrot --width 40 --height 12` outputs smaller version
- `./fractals mandelbrot --char '.'` uses '.' for all filled points
- `./fractals mandelbrot --help` shows flag documentation
- Tests pass

---

### Task 6: Input Validation and Error Handling

Add validation for invalid inputs.

**Do:**
- Sierpinski: size must be > 0, depth must be >= 0
- Mandelbrot: width/height must be > 0, iterations must be > 0
- Return clear error messages on stderr for invalid inputs; exit non-zero
- Add tests for error cases

**Interfaces:**
- Consumes: the `sierpinski` (Task 3) and `mandelbrot` (Task 5) subcommands — validation lives in the CLI layer; the `Generate`/`Render` signatures from Tasks 2 and 4 do not change

**Verify:**
- `./fractals sierpinski --size 0` prints error, exits non-zero
- `./fractals mandelbrot --width -1` prints error, exits non-zero
- Error messages are clear and helpful

---

### Task 7: Integration Tests and README

Add integration tests that invoke the CLI, and document usage.

**Do:**
- Create `cmd/fractals/main_test.go` or `test/integration_test.go`
- Test full CLI invocation for both commands
- Verify output format and exit codes
- Test error cases return non-zero exit
- Create `README.md` with:
  - Project description
  - Installation: `go install ./cmd/fractals`
  - Usage examples for both commands
  - Example output (small samples)

**Interfaces:**
- Consumes: the complete CLI (Tasks 1-6); this task adds tests and docs only — no production-code changes

**Verify:**
- `go test ./...` passes all tests including integration tests
- README accurately describes the tool
- Examples in README actually work
