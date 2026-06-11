# Go Fractals CLI - Implementation Plan

## Global Constraints

- Go 1.21+ (set `go 1.21` in `go.mod`)
- CLI library: `github.com/spf13/cobra`
- Binary name: `fractals`
- Sierpinski default char: `*`
- Mandelbrot default gradient: `" .:-=+*#%@"` (10 characters, space first)
- All output goes to stdout; errors to stderr with non-zero exit
- Module path: `github.com/example/fractals`

## File Structure

| File | Responsibility |
|------|----------------|
| `go.mod` / `go.sum` | Module definition and dependencies |
| `internal/sierpinski/sierpinski.go` | Sierpinski triangle generation algorithm |
| `internal/sierpinski/sierpinski_test.go` | Tests for Sierpinski algorithm |
| `internal/mandelbrot/mandelbrot.go` | Mandelbrot set rendering algorithm |
| `internal/mandelbrot/mandelbrot_test.go` | Tests for Mandelbrot algorithm |
| `internal/cli/root.go` | Root cobra command, help wiring |
| `internal/cli/sierpinski.go` | `sierpinski` subcommand, flag parsing, validation |
| `internal/cli/mandelbrot.go` | `mandelbrot` subcommand, flag parsing, validation |
| `internal/cli/root_test.go` | Tests for CLI commands and error handling |
| `cmd/fractals/main.go` | Entry point; calls `cli.Execute()` |

---

### Task 1: Project scaffolding and module setup

**Files:** `go.mod`, `cmd/fractals/main.go`

**Interfaces:**
- Consumes: nothing
- Produces: a module `github.com/example/fractals`; `main.go` that will later call `cli.Execute() error`. For this task `main.go` is a stub printing nothing so the project compiles.

- [ ] Initialize the module:
  ```bash
  go mod init github.com/example/fractals
  ```
  Expected: creates `go.mod` containing `module github.com/example/fractals` and `go 1.21` (or your local patch version — ensure the line reads at least `go 1.21`).

- [ ] If the `go` line is higher than `1.21`, leave it; if lower, edit it to `go 1.21`. Verify:
  ```bash
  grep '^go ' go.mod
  ```
  Expected: `go 1.21` (or higher).

- [ ] Add cobra dependency:
  ```bash
  go get github.com/spf13/cobra@latest
  ```
  Expected: `go.mod` now lists `require github.com/spf13/cobra ...`; `go.sum` created.

- [ ] Create `cmd/fractals/main.go` as a temporary stub:
  ```go
  package main

  func main() {
  }
  ```

- [ ] Verify it builds:
  ```bash
  go build ./...
  ```
  Expected: no output, exit code 0.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Scaffold module and cobra dependency"
  ```

---

### Task 2: Sierpinski algorithm

**Files:** `internal/sierpinski/sierpinski.go`, `internal/sierpinski/sierpinski_test.go`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```go
  // Generate returns the Sierpinski triangle as a slice of strings,
  // one entry per row. size is the base width in characters, depth is
  // recursion depth, char is the fill character for filled points.
  // Unfilled points are spaces.
  func Generate(size, depth int, char rune) ([]string, error)
  ```
  Rules: returns an error if `size < 1` or `depth < 0`. The triangle uses the classic bitwise rule: a cell at (row `y`, column `x`) is filled when `(x & y) == 0`, mapped onto a triangle of `size` rows where each row `y` has leading spaces so the apex is centered. Number of rows equals `size`.

- [ ] Write the failing test in `internal/sierpinski/sierpinski_test.go`:
  *(Write this code yourself, test-first — the interfaces block and step description define what it must do.)*

- [ ] Run the test to see it fail:
  ```bash
  go test ./internal/sierpinski/
  ```
  Expected: compile error (`undefined: Generate`).

- [ ] Implement `internal/sierpinski/sierpinski.go`:
  *(Write this code yourself, test-first — the interfaces block and step description define what it must do.)*
  Note: `depth` is validated and accepted per the spec/flags; the bitwise rule produces the canonical fractal independent of depth granularity, satisfying the "recognizable triangle" criterion.

- [ ] Run the test to see it pass:
  ```bash
  go test ./internal/sierpinski/
  ```
  Expected: `ok  github.com/example/fractals/internal/sierpinski`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Add sierpinski generation algorithm"
  ```

---

### Task 3: Mandelbrot algorithm

**Files:** `internal/mandelbrot/mandelbrot.go`, `internal/mandelbrot/mandelbrot_test.go`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```go
  // DefaultGradient is the character ramp used when no custom char is given.
  const DefaultGradient = " .:-=+*#%@"

  // Generate renders the Mandelbrot set as ASCII art. width and height are
  // output dimensions in characters; iterations is the escape cap. ramp is
  // the character ramp: each cell maps its iteration count onto a ramp index.
  // A single-character ramp produces a 1-color render (filled for in-set).
  func Generate(width, height, iterations int, ramp []rune) ([]string, error)
  ```
  Rules: error if `width < 1`, `height < 1`, `iterations < 1`, or `len(ramp) == 0`. Returns exactly `height` rows, each exactly `width` runes wide. Complex plane mapped to real ∈ [-2.5, 1.0], imag ∈ [-1.0, 1.0].

- [ ] Write the failing test in `internal/mandelbrot/mandelbrot_test.go`:
  *(Write this code yourself, test-first — the interfaces block and step description define what it must do.)*

- [ ] Run the test to see it fail:
  ```bash
  go test ./internal/mandelbrot/
  ```
  Expected: compile error (`undefined: DefaultGradient`, `undefined: Generate`).

- [ ] Implement `internal/mandelbrot/mandelbrot.go`:
  *(Write this code yourself, test-first — the interfaces block and step description define what it must do.)*

- [ ] Run the test to see it pass:
  ```bash
  go test ./internal/mandelbrot/
  ```
  Expected: `ok  github.com/example/fractals/internal/mandelbrot`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Add mandelbrot rendering algorithm"
  ```

---

### Task 4: CLI root command

**Files:** `internal/cli/root.go`, `internal/cli/root_test.go`

**Interfaces:**
- Consumes: nothing (subcommands added in Tasks 5 & 6 via `newSierpinskiCmd`/`newMandelbrotCmd`)
- Produces:
  ```go
  // Execute runs the root command and returns any error.
  func Execute() error

  // newRootCmd builds the root command with subcommands attached.
  func newRootCmd() *cobra.Command
  ```
  The root command uses `Use: "fractals"`, a short description, and SilenceUsage so error messages are clean. `newRootCmd` attaches `newSierpinskiCmd()` and `newMandelbrotCmd()` (defined in later tasks; reference them here).

> Note: this task references `newSierpinskiCmd()` and `newMandelbrotCmd()`, which do not yet exist, so the package will not compile until Tasks 5 and 6 are done. To keep TDD green per-task, add temporary stub functions in this task (see steps) and replace their bodies in Tasks 5 & 6.

- [ ] Create temporary stubs so the package compiles. Create `internal/cli/sierpinski.go`:
  *(Write this code yourself, test-first — the interfaces block and step description define what it must do.)*

- [ ] Create `internal/cli/mandelbrot.go`:
  *(Write this code yourself, test-first — the interfaces block and step description define what it must do.)*

- [ ] Write the failing test in `internal/cli/root_test.go`:
  *(Write this code yourself, test-first — the interfaces block and step description define what it must do.)*

- [ ] Run the test to see it fail:
  ```bash
  go test ./internal/cli/
  ```
  Expected: compile error (`undefined: newRootCmd`).

- [ ] Implement `internal/cli/root.go`:
  *(Write this code yourself, test-first — the interfaces block and step description define what it must do.)*

- [ ] Run the test to see it pass:
  ```bash
  go test ./internal/cli/
  ```
  Expected: `ok  github.com/example/fractals/internal/cli`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Add CLI root command with help"
  ```

---

### Task 5: Sierpinski subcommand

**Files:** `internal/cli/sierpinski.go`, `internal/cli/root_test.go`

**Interfaces:**
- Consumes: `sierpinski.Generate(size, depth int, char rune) ([]string, error)` (Task 2); `newRootCmd()` (Task 4)
- Produces: `newSierpinskiCmd() *cobra.Command` — replaces the Task 4 stub. Flags: `--size` (int, default 32), `--depth` (int, default 5), `--char` (string, default `"*"`). Validates that `--char` is exactly one rune; on bad char or algorithm error, returns an error.

- [ ] Add tests to `internal/cli/root_test.go` (append to the file):
  ```go
  func TestSierpinskiDefault(t *testing.T) {
  	out, err := run("sierpinski")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	if !strings.Contains(out, "*") {
  		t.Fatalf("expected '*' in output: %q", out)
  	}
  	// Default size 32 -> 32 rows.
  	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
  	if len(lines) != 32 {
  		t.Fatalf("expected 32 lines, got %d", len(lines))
  	}
  }

  func TestSierpinskiCustomChar(t *testing.T) {
  	out, err := run("sierpinski", "--size", "8", "--char", "#")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	if !strings.Contains(out, "#") {
  		t.Fatalf("expected '#' in output: %q", out)
  	}
  	if strings.Contains(out, "*") {
  		t.Fatalf("did not expect '*' in output: %q", out)
  	}
  }

  func TestSierpinskiBadChar(t *testing.T) {
  	_, err := run("sierpinski", "--char", "ab")
  	if err == nil {
  		t.Fatal("expected error for multi-rune char")
  	}
  }

  func TestSierpinskiBadSize(t *testing.T) {
  	_, err := run("sierpinski", "--size", "0")
  	if err == nil {
  		t.Fatal("expected error for size 0")
  	}
  }
  ```

- [ ] Run the tests to see them fail:
  ```bash
  go test ./internal/cli/ -run Sierpinski
  ```
  Expected: failures (stub command ignores flags and produces no output; `TestSierpinskiDefault` fails on missing `*`/line count).

- [ ] Replace `internal/cli/sierpinski.go` with the real implementation:
  *(Write this code yourself, test-first — the interfaces block and step description define what it must do.)*

- [ ] Run the tests to see them pass:
  ```bash
  go test ./internal/cli/ -run Sierpinski
  ```
  Expected: `ok`.

- [ ] Run the full package suite:
  ```bash
  go test ./internal/cli/
  ```
  Expected: `ok`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Implement sierpinski subcommand"
  ```

---

### Task 6: Mandelbrot subcommand

**Files:** `internal/cli/mandelbrot.go`, `internal/cli/root_test.go`

**Interfaces:**
- Consumes: `mandelbrot.Generate(width, height, iterations int, ramp []rune) ([]string, error)` and `mandelbrot.DefaultGradient` (Task 3); `newRootCmd()` (Task 4)
- Produces: `newMandelbrotCmd() *cobra.Command` — replaces the Task 4 stub. Flags: `--width` (int, default 80), `--height` (int, default 24), `--iterations` (int, default 100), `--char` (string, default `""`). Empty `--char` → use `DefaultGradient`; a non-empty `--char` must be exactly one rune and is used as a single-char ramp.

- [ ] Add tests to `internal/cli/root_test.go` (append to the file):
  ```go
  func TestMandelbrotDefault(t *testing.T) {
  	out, err := run("mandelbrot", "--width", "40", "--height", "12")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
  	if len(lines) != 12 {
  		t.Fatalf("expected 12 lines, got %d", len(lines))
  	}
  	for i, line := range lines {
  		if len([]rune(line)) != 40 {
  			t.Fatalf("line %d width = %d, want 40", i, len([]rune(line)))
  		}
  	}
  }

  func TestMandelbrotCustomChar(t *testing.T) {
  	out, err := run("mandelbrot", "--width", "20", "--height", "8", "--char", "@")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	for _, r := range out {
  		if r != '@' && r != ' ' && r != '\n' {
  			t.Fatalf("unexpected rune %q with single-char ramp", r)
  		}
  	}
  }

  func TestMandelbrotBadChar(t *testing.T) {
  	_, err := run("mandelbrot", "--char", "ab")
  	if err == nil {
  		t.Fatal("expected error for multi-rune char")
  	}
  }

  func TestMandelbrotBadWidth(t *testing.T) {
  	_, err := run("mandelbrot", "--width", "0")
  	if err == nil {
  		t.Fatal("expected error for width 0")
  	}
  }
  ```

- [ ] Run the tests to see them fail:
  ```bash
  go test ./internal/cli/ -run Mandelbrot
  ```
  Expected: failures (stub command produces no output).

- [ ] Replace `internal/cli/mandelbrot.go` with the real implementation:
  *(Write this code yourself, test-first — the interfaces block and step description define what it must do.)*

- [ ] Run the tests to see them pass:
  ```bash
  go test ./internal/cli/ -run Mandelbrot
  ```
  Expected: `ok`.

- [ ] Run the full package suite:
  ```bash
  go test ./internal/cli/
  ```
  Expected: `ok`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Implement mandelbrot subcommand"
  ```

---

### Task 7: Wire up main entry point and end-to-end verification

**Files:** `cmd/fractals/main.go`

**Interfaces:**
- Consumes: `cli.Execute() error` (Task 4)
- Produces: a runnable `fractals` binary. `main` calls `cli.Execute()`; on error prints to stderr and exits with status 1.

- [ ] Replace `cmd/fractals/main.go`:
  ```go
  package main

  import (
  	"fmt"
  	"os"

  	"github.com/example/fractals/internal/cli"
  )

  func main() {
  	if err := cli.Execute(); err != nil {
  		fmt.Fprintln(os.Stderr, "Error:", err)
  		os.Exit(1)
  	}
  }
  ```

- [ ] Build the binary:
  ```bash
  go build -o fractals ./cmd/fractals
  ```
  Expected: no output; `fractals` binary created.

- [ ] Verify help (Acceptance #1):
  ```bash
  ./fractals --help
  ```
  Expected: usage text containing `fractals`, `sierpinski`, `mandelbrot`.

- [ ] Verify Sierpinski (Acceptance #2):
  ```bash
  ./fractals sierpinski --size 16 --depth 4
  ```
  Expected: a centered triangle of `*` characters, 16 lines.

- [ ] Verify Mandelbrot (Acceptance #3):
  ```bash
  ./fractals mandelbrot --width 60 --height 20
  ```
  Expected: a 20-line, 60-column gradient render with a recognizable bulb shape.

- [ ] Verify custom char (Acceptance #5):
  ```bash
  ./fractals sierpinski --size 8 --char '#'
  ```
  Expected: triangle drawn with `#` instead of `*`.

- [ ] Verify error handling (Acceptance #6):
  ```bash
  ./fractals sierpinski --size 0; echo "exit=$?"
  ```
  Expected: `Error: size must be at least 1, got 0` on stderr and `exit=1`.

- [ ] Run the entire test suite (Acceptance #7):
  ```bash
  go test ./...
  ```
  Expected: `ok` for `internal/sierpinski`, `internal/mandelbrot`, `internal/cli`.

- [ ] Run go vet:
  ```bash
  go vet ./...
  ```
  Expected: no output.

- [ ] Add the binary to gitignore and commit:
  ```bash
  echo '/fractals' >> .gitignore
  git add -A && git commit -m "Wire up main entry point"
  ```

---

## Self-Review

**Spec coverage:**
- Acceptance #1 (`--help`): Task 4 test + Task 