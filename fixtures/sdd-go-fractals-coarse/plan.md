# Go Fractals CLI - Implementation Plan

Execute this plan using the `superpowers:subagent-driven-development` skill.

## Global Constraints

- Go 1.21+
- CLI library: `github.com/spf13/cobra`
- Binary name: `fractals`
- Module path: `github.com/example/fractals`
- Sierpinski defaults: `--size 32`, `--depth 5`, `--char '*'`
- Mandelbrot defaults: `--width 80`, `--height 24`, `--iterations 100`, `--char` omitted = gradient `" .:-=+*#%@"`
- Invalid inputs produce clear error messages
- All algorithm packages have tests; all tests pass

## File Structure

| Path | Responsibility |
|------|----------------|
| `go.mod` / `go.sum` | Module definition, cobra dependency |
| `internal/sierpinski/sierpinski.go` | Sierpinski triangle generation algorithm |
| `internal/sierpinski/sierpinski_test.go` | Tests for sierpinski algorithm |
| `internal/mandelbrot/mandelbrot.go` | Mandelbrot set rendering algorithm |
| `internal/mandelbrot/mandelbrot_test.go` | Tests for mandelbrot algorithm |
| `internal/cli/root.go` | Root cobra command, help wiring, Execute entrypoint |
| `internal/cli/sierpinski.go` | `sierpinski` subcommand, flag parsing, output |
| `internal/cli/mandelbrot.go` | `mandelbrot` subcommand, flag parsing, output |
| `internal/cli/cli_test.go` | Integration tests for CLI commands |
| `cmd/fractals/main.go` | Entry point calling cli.Execute |

---

### Task 1: Project scaffolding and dependency

**Files:** `go.mod`, `go.sum`

**Interfaces:**
- Produces: Go module `github.com/example/fractals` with `github.com/spf13/cobra` available.

- [ ] Initialize the module and add cobra, then verify.

  ```bash
  go mod init github.com/example/fractals
  go get github.com/spf13/cobra@latest
  ```

  Expected: `go.mod` exists containing `module github.com/example/fractals`, `go 1.21` (or higher), and a `require github.com/spf13/cobra` line. `go.sum` is populated.

  Verify:

  ```bash
  go mod verify
  grep -q 'spf13/cobra' go.mod && echo OK
  ```

  Expected output:
  ```
  all modules verified
  OK
  ```

  Commit:

  ```bash
  git add go.mod go.sum && git commit -m "Initialize module with cobra dependency"
  ```

---

### Task 2: Sierpinski algorithm

**Files:** `internal/sierpinski/sierpinski.go`, `internal/sierpinski/sierpinski_test.go`

**Interfaces:**
- Produces: `func Generate(size, depth int, char rune) ([]string, error)` — returns the triangle as a slice of strings (one per row, top row first). Returns an error if `size < 1` or `depth < 0`.

Algorithm note: Use the bitwise Sierpinski rule. For a triangle of the given `size` (number of rows), row `y` (0-indexed from top) has `2*y+1` relevant cells centered; a cell at column `x` within the row's local coordinate is filled when `(x & y) == 0`. Render into a grid of width `2*size` so rows are visually centered: for row `y`, print `size-1-y` leading spaces, then for `x` from `0..y`, print `char` if `(x & y) == 0` else space, each cell followed by a space. `depth` caps the effective recursion: clamp the rendered rows to `min(size, 2^depth)` rows.

- [ ] Write failing tests, implement, run, commit.

  `internal/sierpinski/sierpinski_test.go`:

  ```go
  package sierpinski

  import (
  	"strings"
  	"testing"
  )

  func TestGenerateRowCount(t *testing.T) {
  	rows, err := Generate(8, 5, '*')
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	if len(rows) != 8 {
  		t.Fatalf("want 8 rows, got %d", len(rows))
  	}
  }

  func TestGenerateTopRowSingleChar(t *testing.T) {
  	rows, _ := Generate(8, 5, '*')
  	if strings.Count(rows[0], "*") != 1 {
  		t.Fatalf("top row should have exactly one '*', got %q", rows[0])
  	}
  }

  func TestGenerateUsesChar(t *testing.T) {
  	rows, _ := Generate(8, 5, '#')
  	if !strings.Contains(rows[0], "#") {
  		t.Fatalf("expected '#' in output, got %q", rows[0])
  	}
  	if strings.Contains(rows[0], "*") {
  		t.Fatalf("did not expect '*' in output, got %q", rows[0])
  	}
  }

  func TestGenerateDepthClampsRows(t *testing.T) {
  	// depth 2 => max 2^2 = 4 rows even if size is larger
  	rows, _ := Generate(8, 2, '*')
  	if len(rows) != 4 {
  		t.Fatalf("want 4 rows with depth 2, got %d", len(rows))
  	}
  }

  func TestGenerateSierpinskiPattern(t *testing.T) {
  	// Row index 1 (y=1): cells x=0 ((0&1)==0 filled), x=1 ((1&1)!=0 empty)
  	rows, _ := Generate(4, 5, '*')
  	filled := strings.Count(rows[1], "*")
  	if filled != 1 {
  		t.Fatalf("row 1 should have 1 filled cell, got %d in %q", filled, rows[1])
  	}
  	// Row index 3 (y=3): x=0..3, (x&3)==0 only for x=0 => 1 filled
  	filled3 := strings.Count(rows[3], "*")
  	if filled3 != 1 {
  		t.Fatalf("row 3 should have 1 filled cell, got %d in %q", filled3, rows[3])
  	}
  	// Row index 2 (y=2): x=0..2, (x&2)==0 for x=0,1 => 2 filled
  	filled2 := strings.Count(rows[2], "*")
  	if filled2 != 2 {
  		t.Fatalf("row 2 should have 2 filled cells, got %d in %q", filled2, rows[2])
  	}
  }

  func TestGenerateInvalidSize(t *testing.T) {
  	if _, err := Generate(0, 5, '*'); err == nil {
  		t.Fatal("expected error for size < 1")
  	}
  }

  func TestGenerateInvalidDepth(t *testing.T) {
  	if _, err := Generate(8, -1, '*'); err == nil {
  		t.Fatal("expected error for depth < 0")
  	}
  }
  ```

  `internal/sierpinski/sierpinski.go`:

  ```go
  // Package sierpinski generates Sierpinski triangles as ASCII art.
  package sierpinski

  import (
  	"fmt"
  	"strings"
  )

  // Generate returns a Sierpinski triangle rendered as rows of text, one
  // string per row from top to bottom. size is the number of rows; depth
  // caps the rows to min(size, 2^depth). char fills set cells. An error is
  // returned for size < 1 or depth < 0.
  func Generate(size, depth int, char rune) ([]string, error) {
  	if size < 1 {
  		return nil, fmt.Errorf("size must be >= 1, got %d", size)
  	}
  	if depth < 0 {
  		return nil, fmt.Errorf("depth must be >= 0, got %d", depth)
  	}

  	maxRows := 1 << uint(depth) // 2^depth
  	rowCount := size
  	if maxRows < rowCount {
  		rowCount = maxRows
  	}

  	rows := make([]string, 0, rowCount)
  	for y := 0; y < rowCount; y++ {
  		var b strings.Builder
  		for s := 0; s < rowCount-1-y; s++ {
  			b.WriteRune(' ')
  		}
  		for x := 0; x <= y; x++ {
  			if x&y == 0 {
  				b.WriteRune(char)
  			} else {
  				b.WriteRune(' ')
  			}
  			b.WriteRune(' ')
  		}
  		rows = append(rows, strings.TrimRight(b.String(), " ")+strings.Repeat(" ", trailingPad(b.String())))
  		rows[len(rows)-1] = b.String()
  	}
  	return rows, nil
  }

  func trailingPad(string) int { return 0 }
  ```

  Note to implementer: the two final lines inside the loop simplify to `rows = append(rows, b.String())`. Replace the `append` line and remove the `rows[len(rows)-1]` line and the unused `trailingPad` helper:

  ```go
  		rows = append(rows, b.String())
  	}
  	return rows, nil
  }
  ```

  Run:

  ```bash
  go test ./internal/sierpinski/...
  ```

  Expected output:
  ```
  ok  	github.com/example/fractals/internal/sierpinski	0.00...s
  ```

  Commit:

  ```bash
  git add internal/sierpinski && git commit -m "Add sierpinski algorithm"
  ```

---

### Task 3: Mandelbrot algorithm

**Files:** `internal/mandelbrot/mandelbrot.go`, `internal/mandelbrot/mandelbrot_test.go`

**Interfaces:**
- Produces: `func Render(width, height, iterations int, char rune) ([]string, error)` — returns the set as `height` strings each of length `width`. If `char == 0` (zero rune), use the gradient `" .:-=+*#%@"` mapping iteration count to gradient index; otherwise fill escaped/in-set cells with `char`. Returns an error if `width < 1`, `height < 1`, or `iterations < 1`.

Algorithm note: Map each cell `(px, py)` to complex `c = (cx, cy)` where `cx = -2.5 + (px/(width-1))*3.5` (range -2.5..1.0) and `cy = -1.25 + (py/(height-1))*2.5` (range -1.25..1.25). Iterate `z = z*z + c` from `z=0`; escape when `|z|^2 > 4`. Let `n` be the iteration count at escape (or `iterations` if never escaped — point is in the set). For the gradient: `idx = n * (len(gradient)-1) / iterations`, clamped to last index; points in the set (`n == iterations`) use the last gradient char `'@'`. When `char != 0`: in-set points (`n == iterations`) print `char`, escaped points print a space. Guard division by zero when `width == 1` or `height == 1` by treating the denominator as 1.

- [ ] Write failing tests, implement, run, commit.

  `internal/mandelbrot/mandelbrot_test.go`:

  ```go
  package mandelbrot

  import "testing"

  func TestRenderDimensions(t *testing.T) {
  	rows, err := Render(40, 12, 50, 0)
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	if len(rows) != 12 {
  		t.Fatalf("want 12 rows, got %d", len(rows))
  	}
  	for i, r := range rows {
  		if len([]rune(r)) != 40 {
  			t.Fatalf("row %d width want 40, got %d", i, len([]rune(r)))
  		}
  	}
  }

  func TestRenderGradientContainsInSetChar(t *testing.T) {
  	// The center region of the Mandelbrot set is in-set, mapping to '@'.
  	rows, _ := Render(80, 24, 100, 0)
  	found := false
  	for _, r := range rows {
  		for _, c := range r {
  			if c == '@' {
  				found = true
  			}
  		}
  	}
  	if !found {
  		t.Fatal("expected at least one '@' (in-set) cell in gradient render")
  	}
  }

  func TestRenderCustomChar(t *testing.T) {
  	rows, _ := Render(80, 24, 100, '#')
  	foundHash := false
  	for _, r := range rows {
  		for _, c := range r {
  			if c == '#' {
  				foundHash = true
  			}
  			if c != '#' && c != ' ' {
  				t.Fatalf("custom-char render must only contain '#' or space, got %q", c)
  			}
  		}
  	}
  	if !foundHash {
  		t.Fatal("expected at least one '#' cell")
  	}
  }

  func TestRenderInvalidWidth(t *testing.T) {
  	if _, err := Render(0, 12, 50, 0); err == nil {
  		t.Fatal("expected error for width < 1")
  	}
  }

  func TestRenderInvalidHeight(t *testing.T) {
  	if _, err := Render(40, 0, 50, 0); err == nil {
  		t.Fatal("expected error for height < 1")
  	}
  }

  func TestRenderInvalidIterations(t *testing.T) {
  	if _, err := Render(40, 12, 0, 0); err == nil {
  		t.Fatal("expected error for iterations < 1")
  	}
  }
  ```

  `internal/mandelbrot/mandelbrot.go`:

  ```go
  // Package mandelbrot renders the Mandelbrot set as ASCII art.
  package mandelbrot

  import (
  	"fmt"
  	"strings"
  )

  const gradient = " .:-=+*#%@"

  // Render returns the Mandelbrot set as height strings each width runes
  // wide. If char is the zero rune, an iteration-count gradient is used;
  // otherwise in-set cells are filled with char and escaped cells with a
  // space. Errors are returned for width < 1, height < 1, or iterations < 1.
  func Render(width, height, iterations int, char rune) ([]string, error) {
  	if width < 1 {
  		return nil, fmt.Errorf("width must be >= 1, got %d", width)
  	}
  	if height < 1 {
  		return nil, fmt.Errorf("height must be >= 1, got %d", height)
  	}
  	if iterations < 1 {
  		return nil, fmt.Errorf("iterations must be >= 1, got %d", iterations)
  	}

  	denomX := float64(width - 1)
  	if denomX == 0 {
  		denomX = 1
  	}
  	denomY := float64(height - 1)
  	if denomY == 0 {
  		denomY = 1
  	}

  	grad := []rune(gradient)
  	rows := make([]string, 0, height)

  	for py := 0; py < height; py++ {
  		cy := -1.25 + (float64(py)/denomY)*2.5
  		var b strings.Builder
  		for px := 0; px < width; px++ {
  			cx := -2.5 + (float64(px)/denomX)*3.5
  			n := escapeCount(cx, cy, iterations)
  			b.WriteRune(cell(n, iterations, char, grad))
  		}
  		rows = append(rows, b.String())
  	}
  	return rows, nil
  }

  func escapeCount(cx, cy float64, iterations int) int {
  	var zx, zy float64
  	for n := 0; n < iterations; n++ {
  		zx2 := zx*zx - zy*zy + cx
  		zy = 2*zx*zy + cy
  		zx = zx2
  		if zx*zx+zy*zy > 4 {
  			return n
  		}
  	}
  	return iterations
  }

  func cell(n, iterations int, char rune, grad []rune) rune {
  	inSet := n >= iterations
  	if char != 0 {
  		if inSet {
  			return char
  		}
  		return ' '
  	}
  	if inSet {
  		return grad[len(grad)-1]
  	}
  	idx := n * (len(grad) - 1) / iterations
  	if idx >= len(grad) {
  		idx = len(grad) - 1
  	}
  	return grad[idx]
  }
  ```

  Run:

  ```bash
  go test ./internal/mandelbrot/...
  ```

  Expected output:
  ```
  ok  	github.com/example/fractals/internal/mandelbrot	0.00...s
  ```

  Commit:

  ```bash
  git add internal/mandelbrot && git commit -m "Add mandelbrot algorithm"
  ```

---

### Task 4: CLI commands

**Files:** `internal/cli/root.go`, `internal/cli/sierpinski.go`, `internal/cli/mandelbrot.go`, `internal/cli/cli_test.go`

**Interfaces:**
- Consumes: `sierpinski.Generate(size, depth int, char rune) ([]string, error)`, `mandelbrot.Render(width, height, iterations int, char rune) ([]string, error)`.
- Produces:
  - `func NewRootCmd() *cobra.Command` — builds root command with `sierpinski` and `mandelbrot` subcommands; root and subcommand output/error streams are set by the caller via cobra's `SetOut`/`SetErr`.
  - `func Execute() error` — builds the root command and runs it against `os.Args`, writing to `os.Stdout`/`os.Stderr`.

Implementation notes:
- The `--char` flag is a `string`. For sierpinski, default is `"*"`; convert to its first rune. For mandelbrot, default is `""` (empty) meaning gradient; convert non-empty to its first rune, empty to rune `0`.
- Validate that a provided `--char` is exactly one rune; otherwise return a clear error.
- Print each returned row followed by a newline to the command's `OutOrStdout()`.

- [ ] Write failing tests, implement all three files, run, commit.

  `internal/cli/cli_test.go`:

  ```go
  package cli

  import (
  	"bytes"
  	"strings"
  	"testing"
  )

  func runCmd(args ...string) (string, string, error) {
  	cmd := NewRootCmd()
  	var out, errOut bytes.Buffer
  	cmd.SetOut(&out)
  	cmd.SetErr(&errOut)
  	cmd.SetArgs(args)
  	err := cmd.Execute()
  	return out.String(), errOut.String(), err
  }

  func TestRootHelp(t *testing.T) {
  	out, _, err := runCmd("--help")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	if !strings.Contains(out, "sierpinski") || !strings.Contains(out, "mandelbrot") {
  		t.Fatalf("help should list subcommands, got:\n%s", out)
  	}
  }

  func TestSierpinskiDefault(t *testing.T) {
  	out, _, err := runCmd("sierpinski")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	if !strings.Contains(out, "*") {
  		t.Fatalf("expected '*' in output, got:\n%s", out)
  	}
  }

  func TestSierpinskiSizeAndDepthFlags(t *testing.T) {
  	out, _, err := runCmd("sierpinski", "--size", "4", "--depth", "5")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
  	if len(lines) != 4 {
  		t.Fatalf("want 4 rows, got %d:\n%s", len(lines), out)
  	}
  }

  func TestSierpinskiCharFlag(t *testing.T) {
  	out, _, err := runCmd("sierpinski", "--char", "#")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	if !strings.Contains(out, "#") || strings.Contains(out, "*") {
  		t.Fatalf("expected '#' and no '*', got:\n%s", out)
  	}
  }

  func TestSierpinskiInvalidChar(t *testing.T) {
  	_, _, err := runCmd("sierpinski", "--char", "ab")
  	if err == nil {
  		t.Fatal("expected error for multi-rune char")
  	}
  }

  func TestSierpinskiInvalidSize(t *testing.T) {
  	_, _, err := runCmd("sierpinski", "--size", "0")
  	if err == nil {
  		t.Fatal("expected error for size 0")
  	}
  }

  func TestMandelbrotDefault(t *testing.T) {
  	out, _, err := runCmd("mandelbrot")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
  	if len(lines) != 24 {
  		t.Fatalf("want 24 rows, got %d", len(lines))
  	}
  	if !strings.Contains(out, "@") {
  		t.Fatalf("expected gradient '@' in default output")
  	}
  }

  func TestMandelbrotDimensionFlags(t *testing.T) {
  	out, _, err := runCmd("mandelbrot", "--width", "40", "--height", "10")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
  	if len(lines) != 10 {
  		t.Fatalf("want 10 rows, got %d", len(lines))
  	}
  	if len([]rune(lines[0])) != 40 {
  		t.Fatalf("want width 40, got %d", len([]rune(lines[0])))
  	}
  }

  func TestMandelbrotCharFlag(t *testing.T) {
  	out, _, err := runCmd("mandelbrot", "--char", "#")
  	if err != nil {
  		t.Fatalf("unexpected error: %v", err)
  	}
  	for _, c := range out {
  		if c != '#' && c != ' ' && c != '\n' {
  			t.Fatalf("custom-char output must only contain '#', space, newline; got %q", c)
  		}
  	}
  }

  func TestMandelbrotInvalidIterations(t *testing.T) {
  	_, _, err := runCmd("mandelbrot", "--iterations", "0")
  	if err == nil {
  		t.Fatal("expected error for iterations 0")
  	}
  }
  ```

  `internal/cli/root.go`:

  ```go
  // Package cli wires the fractals command-line interface.
  package cli

  import (
  	"fmt"
  	"unicode/utf8"

  	"github.com/spf13/cobra"
  )

  // NewRootCmd builds the root fractals command with its subcommands.
  func NewRootCmd() *cobra.Command {
  	root := &cobra.Command{
  		Use:   "fractals",
  		Short: "Generate ASCII art fractals",
  		Long:  "fractals generates ASCII art fractals such as the Sierpinski triangle and the Mandelbrot set.",
  	}
  	root.SilenceUsage = true
  	root.AddCommand(newSierpinskiCmd())
  	root.AddCommand(newMandelbrotCmd())
  	return root
  }

  // Execute runs the fractals CLI against os.Args.
  func Execute() error {
  	return NewRootCmd().Execute()
  }

  // singleRune validates that s is exactly one rune and returns it.
  func singleRune(flag, s string) (rune, error) {
  	if utf8.RuneCountInString(s) != 1 {
  		return 0, fmt.Errorf("--%s must be a single character, got %q", flag, s)
  	}
  	r, _ := utf8.DecodeRuneInString(s)
  	return r, nil
  }
  ```

  `internal/cli/sierpinski.go`:

  ```go
  package cli

  import (
  	"fmt"

  	"github.com/example/fractals/internal/sierpinski"
  	"github.com/spf13/cobra"
  )

  func newSierpinskiCmd() *cobra.Command {
  	var (
  		size  int
  		depth int
  		char  string
  	)
  	cmd := &cobra.Command{
  		Use:   "sierpinski",
  		Short: "Generate a Sierpinski triangle",
  		RunE: func(cmd *cobra.Command, args []string) error {
  			r, err := singleRune("char", char)
  			if err != nil {
  				return err
  			}
  			rows, err := sierpinski.Generate(size, depth, r)
  			if err != nil {
  				return err
  			}
  			out := cmd.OutOrStdout()
  			for _, line := range rows {
  				fmt.Fprintln(out, line)
  			}
  			return nil
  		},
  	}
  	cmd.Flags().IntVar(&size, "size", 32, "Width of the triangle base in characters")
  	cmd.Flags().IntVar(&depth, "depth", 5, "Recursion depth")
  	cmd.Flags().StringVar(&char, "char", "*", "Character to use for filled points")
  	return cmd
  }
  ```

  `internal/cli/mandelbrot.go`:

  ```go
  package cli

  import (
  	"fmt"

  	"github.com/example/fractals/internal/mandelbrot"
  	"github.com/spf13/cobra"
  )

  func newMandelbrotCmd() *cobra.Command {
  	var (
  		width      int
  		height     int
  		iterations int
  		char       string
  	)
  	cmd := &cobra.Command{
  		Use:   "mandelbrot",
  		Short: "Render the Mandelbrot set",
  		RunE: func(cmd *cobra.Command, args []string) error {
  			var r rune
  			if char != "" {
  				var err error
  				r, err = singleRune("char", char)
  				if err != nil {
  					return err
  				}
  			}
  			rows, err := mandelbrot.Render(width, height, iterations, r)
  			if err != nil {
  				return err
  			}
  			out := cmd.OutOrStdout()
  			for _, line := range rows {
  				fmt.Fprintln(out, line)
  			}
  			return nil
  		},
  	}
  	cmd.Flags().IntVar(&width, "width", 80, "Output width in characters")
  	cmd.Flags().IntVar(&height, "height", 24, "Output height in characters")
  	cmd.Flags().IntVar(&iterations, "iterations", 100, "Maximum iterations for escape calculation")
  	cmd.Flags().StringVar(&char, "char", "", "Single character, or omit for gradient \" .:-=+*#%@\"")
  	return cmd
  }
  ```

  Run:

  ```bash
  go test ./internal/cli/...
  ```

  Expected output:
  ```
  ok  	github.com/example/fractals/internal/cli	0.0...s
  ```

  Commit:

  ```bash
  git add internal/cli && git commit -m "Add CLI commands"
  ```

---

### Task 5: Entry point and end-to-end verification

**Files:** `cmd/fractals/main.go`

**Interfaces:**
- Consumes: `cli.Execute() error`.
- Produces: buildable `fractals` binary.

- [ ] Write the entry point, build, run acceptance checks, commit.

  `cmd/fractals/main.go`:

  ```go
  // Command fractals generates ASCII art fractals from the command line.
  package main

  import (
  	"os"

  	"github.com/example/fractals/internal/cli"
  )

  func main() {
  	if err := cli.Execute(); err != nil {
  		os.Exit(1)
  	}
  }
  ```

  Build:

  ```bash
  go build -o fractals ./cmd/fractals
  ```

  Expected: no output, exit code 0, `fractals` binary present.

  Acceptance checks (criteria 1–6):

  ```bash
  ./fractals --help
  ./fractals sierpinski --size 16 --depth 5
  ./fractals mandelbrot --width 80 --height 24 --iterations 100
  ./fractals sierpinski --size 16 --char '#'
  ./fractals mandelbrot --char '#'
  ./fractals sierpinski --size 0; echo "exit=$?"
  ./fractals mandelbrot --iterations 0; echo "exit=$?"
  ```

  Expected:
  - `--help` lists `sierpinski` and `mandelbrot`.
  - First sierpinski prints a centered triangle of `*`.
  - Mandelbrot prints an 80x24 rectangle containing gradient chars including `@`.
  - Char sierpinski prints a triangle of `#` (no `*`).
  - Char mandelbrot prints only `#` and spaces.
  - The two invalid commands print an error message (e.g. `Error: size must be >= 1, got 0`) and report `exit=1`.

  Full test suite (criterion 7):

  ```bash
  go test ./...
  ```

  Expected output:
  ```
  ok  	github.com/example/fractals/internal/cli	0.0...s
  ok  	github.com/example/fractals/internal/mandelbrot	0.0...s
  ok  	github.com/example/fractals/internal/sierpinski	0.0...s
  ```

  (The `cmd/fractals` package has no tests and is reported as `no test files`.)

  Commit:

  ```bash
  echo 'fractals' > .gitignore
  git add cmd/fractals/main.go .gitignore && git commit -m "Add entry point and gitignore built binary"
  ```

---

## Self-Review

- **Spec coverage:**
  - Criterion 1 (`--help`) — Task 4 `TestRootHelp`, Task 5 acceptance. ✓
  - Criterion 2 (sierpinski triangle) — Task 2 pattern tests, Task 4 `TestSierpinskiDefault`, Task 5. ✓
  - Criterion 3 (mandelbrot set) — Task 3 `TestRenderGradientContainsInSetChar`, Task 4 `TestMandelbrotDefault`, Task 5. ✓
  - Criterion 4 (size/width/height/depth/iterations flags) — Task 4 flag tests. ✓
  - Criterion 5 (`--char`) — Task 4 `TestSierpinskiCharFlag`, `TestMandelbrotCharFlag`. ✓
  - Criterion 6 (clear errors) — validation in algorithm packages + `singleRune`; tested in Tasks 2, 3, 4 and Task 5 acceptance. ✓
  - Criterion 7 (tests pass) — Task 5 `go test ./...`. ✓
- **All flags and defaults** match the spec verbatim (sierpinski: size 32, depth 5, char `*`; mandelbrot: width 80, height 24, iterations 100, char gradient `" .:-=+*#%@"`). ✓
- **Placeholder scan:** Task 2's `sierpinski.go` initial code block intentionally contained a redundant `append`/`trailingPad` artifact; an explicit implementer note replaces it with the clean `rows = append(rows, b.String())` and removes the unused helper. No other placeholders or TODOs remain.
- **Type consistency:** `Generate(int, int, rune) ([]string, error)` and `Render(int, int, int, rune) ([]string, error)` signatures in the Interfaces blocks match their definitions and their CLI call sites. `--char` flags are `string` and converted to `rune` (zero rune meaning gradient for mandelbrot) consistently. ✓
- **Module path** `github.com/example/fractals` is used consistently in imports across Tasks 4 and 5 and matches Task 1's `go mod init`. ✓