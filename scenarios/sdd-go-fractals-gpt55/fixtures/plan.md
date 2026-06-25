# Go Fractals CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Go command-line tool named `fractals` that renders Sierpinski triangle and Mandelbrot set ASCII art with configurable flags.

**Architecture:** Use Cobra for command routing and keep rendering logic in pure internal packages that return `[]string`. CLI files parse flags, call the rendering packages, and write output to injected writers so command behavior is testable without spawning the binary for normal unit tests. Validation lives at the boundary that owns the value: numeric rendering constraints in renderer packages, CLI-only string-to-rune parsing in `internal/cli`.

**Tech Stack:** Go 1.21+, `github.com/spf13/cobra`, Go standard library tests.

## Global Constraints

- Go version floor: `Go 1.21+`.
- CLI dependency: `github.com/spf13/cobra` for CLI.
- `sierpinski` command flags: `--size` default `32`, `--depth` default `5`, `--char` default `'*'`.
- `mandelbrot` command flags: `--width` default `80`, `--height` default `24`, `--iterations` default `100`, `--char` default gradient.
- Mandelbrot gradient when `--char` is omitted: `" .:-=+*#%@"`.
- `sierpinski` output: triangle printed to stdout, one line per row.
- `mandelbrot` output: rectangle printed to stdout.
- Invalid inputs produce clear error messages.
- All tests pass.

---

## File Structure

- `go.mod`: module declaration, Go version, and Cobra dependency.
- `go.sum`: generated module checksums from `go mod tidy`.
- `cmd/fractals/main.go`: binary entry point; calls `internal/cli.Execute`.
- `internal/cli/root.go`: root Cobra command, command wiring, and testable `Execute` helper.
- `internal/cli/root_test.go`: root help behavior.
- `internal/cli/char.go`: shared CLI parser for single-character flags.
- `internal/cli/sierpinski.go`: Cobra subcommand for Sierpinski flags and output.
- `internal/cli/sierpinski_test.go`: Sierpinski command behavior and CLI-level char validation.
- `internal/cli/mandelbrot.go`: Cobra subcommand for Mandelbrot flags and output.
- `internal/cli/mandelbrot_test.go`: Mandelbrot command behavior, root command listing, and CLI-level invalid input behavior.
- `internal/sierpinski/sierpinski.go`: pure Sierpinski renderer and renderer validation.
- `internal/sierpinski/sierpinski_test.go`: Sierpinski renderer behavior and validation.
- `internal/mandelbrot/mandelbrot.go`: pure Mandelbrot renderer, gradient mapping, and renderer validation.
- `internal/mandelbrot/mandelbrot_test.go`: Mandelbrot renderer dimensions, character mapping, and validation.

### Task 1: Go Module and Root CLI Skeleton

**Files:**
- Create: `go.mod`
- Create: `cmd/fractals/main.go`
- Create: `internal/cli/root.go`
- Test: `internal/cli/root_test.go`

**Interfaces:**
- Consumes: none.
- Produces: `func NewRootCommand(out io.Writer, errOut io.Writer) *cobra.Command`
- Produces: `func Execute(args []string, out io.Writer, errOut io.Writer) error`
- Produces: binary entry point at `cmd/fractals/main.go` that passes `os.Args[1:]`, `os.Stdout`, and `os.Stderr` into `cli.Execute`.

- [ ] **Step 1: Write the failing root help test**

Create `go.mod` so the test package can run:

```go
module fractals

go 1.21
```

Create `internal/cli/root_test.go`:

```go
package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestRootHelpShowsUsage(t *testing.T) {
	var out bytes.Buffer
	var errOut bytes.Buffer

	err := Execute([]string{"--help"}, &out, &errOut)
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}

	stdout := out.String()
	for _, want := range []string{"fractals", "ASCII art fractals", "Usage:"} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("help output missing %q:\n%s", want, stdout)
		}
	}

	if errOut.Len() != 0 {
		t.Fatalf("expected no stderr for help, got %q", errOut.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
go test ./internal/cli -run TestRootHelpShowsUsage -count=1
```

Expected: FAIL with compiler output containing `undefined: Execute`.

- [ ] **Step 3: Write the minimal root CLI implementation**

Update `go.mod`:

```go
module fractals

go 1.21

require github.com/spf13/cobra v1.9.1
```

Create `internal/cli/root.go`:

```go
package cli

import (
	"io"

	"github.com/spf13/cobra"
)

func NewRootCommand(out io.Writer, errOut io.Writer) *cobra.Command {
	cmd := &cobra.Command{
		Use:          "fractals",
		Short:        "Generate ASCII art fractals",
		Long:         "Generate ASCII art fractals from the command line.",
		SilenceUsage: true,
	}

	cmd.SetOut(out)
	cmd.SetErr(errOut)

	return cmd
}

func Execute(args []string, out io.Writer, errOut io.Writer) error {
	cmd := NewRootCommand(out, errOut)
	cmd.SetArgs(args)
	return cmd.Execute()
}
```

Create `cmd/fractals/main.go`:

```go
package main

import (
	"fmt"
	"os"

	"fractals/internal/cli"
)

func main() {
	if err := cli.Execute(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
```

- [ ] **Step 4: Resolve module checksums**

Run:

```bash
go mod tidy
```

Expected: exit 0 and a new `go.sum` containing checksums for Cobra and its transitive dependencies.

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
go test ./internal/cli -run TestRootHelpShowsUsage -count=1
```

Expected: PASS.

- [ ] **Step 6: Run all tests**

Run:

```bash
go test ./...
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add go.mod go.sum cmd/fractals/main.go internal/cli/root.go internal/cli/root_test.go
git commit -m "feat: add fractals CLI skeleton" -m "Creates the Go module, Cobra root command, testable Execute helper, and cmd/fractals entry point. This establishes the command surface required for later Sierpinski and Mandelbrot subcommands while keeping output streams injectable for unit tests."
```

### Task 2: Sierpinski Renderer

**Files:**
- Create: `internal/sierpinski/sierpinski.go`
- Test: `internal/sierpinski/sierpinski_test.go`

**Interfaces:**
- Consumes: none.
- Produces: `func Render(size int, depth int, fill rune) ([]string, error)`
- Produces renderer errors with exact messages `size must be at least 3`, `depth must be at least 0`, and `char must be a single-line rune`.

- [ ] **Step 1: Write the failing renderer tests**

Create `internal/sierpinski/sierpinski_test.go`:

```go
package sierpinski

import (
	"reflect"
	"strings"
	"testing"
)

func TestRenderUsesSizeDepthAndChar(t *testing.T) {
	lines, err := Render(8, 3, '#')
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}

	want := []string{
		"   #    ",
		"  # #   ",
		" #   #  ",
		"# # # # ",
	}

	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("Render() mismatch\nwant: %#v\n got: %#v", want, lines)
	}
}

func TestRenderDepthLimitsRows(t *testing.T) {
	lines, err := Render(16, 2, '*')
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}

	if len(lines) != 4 {
		t.Fatalf("depth 2 should render 4 rows, got %d", len(lines))
	}

	lines, err = Render(16, 3, '*')
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}

	if len(lines) != 8 {
		t.Fatalf("depth 3 should render 8 rows, got %d", len(lines))
	}
}

func TestRenderRejectsInvalidInputs(t *testing.T) {
	tests := []struct {
		name    string
		size    int
		depth   int
		fill    rune
		wantErr string
	}{
		{name: "small size", size: 2, depth: 1, fill: '*', wantErr: "size must be at least 3"},
		{name: "negative depth", size: 8, depth: -1, fill: '*', wantErr: "depth must be at least 0"},
		{name: "newline char", size: 8, depth: 1, fill: '\n', wantErr: "char must be a single-line rune"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Render(test.size, test.depth, test.fill)
			if err == nil {
				t.Fatal("Render returned nil error")
			}
			if !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("error %q does not contain %q", err.Error(), test.wantErr)
			}
		})
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
go test ./internal/sierpinski -count=1
```

Expected: FAIL with compiler output containing `undefined: Render`.

- [ ] **Step 3: Write the minimal Sierpinski implementation**

Create `internal/sierpinski/sierpinski.go`:

```go
package sierpinski

import "fmt"

func Render(size int, depth int, fill rune) ([]string, error) {
	if size < 3 {
		return nil, fmt.Errorf("size must be at least 3")
	}
	if depth < 0 {
		return nil, fmt.Errorf("depth must be at least 0")
	}
	if fill == 0 || fill == '\n' || fill == '\r' {
		return nil, fmt.Errorf("char must be a single-line rune")
	}

	baseHeight := (size + 1) / 2
	height := 1
	for level := 0; level < depth && height < baseHeight; level++ {
		height *= 2
	}
	if height > baseHeight {
		height = baseHeight
	}

	center := (size - 1) / 2
	lines := make([]string, height)
	for row := 0; row < height; row++ {
		cells := make([]rune, size)
		for column := range cells {
			cells[column] = ' '
		}

		for position := 0; position <= row; position++ {
			if position&(row-position) != 0 {
				continue
			}

			column := center - row + 2*position
			if column >= 0 && column < size {
				cells[column] = fill
			}
		}

		lines[row] = string(cells)
	}

	return lines, nil
}
```

- [ ] **Step 4: Run renderer tests to verify they pass**

Run:

```bash
go test ./internal/sierpinski -count=1
```

Expected: PASS.

- [ ] **Step 5: Run all tests**

Run:

```bash
go test ./...
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/sierpinski/sierpinski.go internal/sierpinski/sierpinski_test.go
git commit -m "feat: add Sierpinski renderer" -m "Adds the pure Sierpinski renderer used by the CLI. The renderer returns padded lines, uses the requested fill rune, limits output height by recursion depth, and reports explicit validation errors for invalid size, depth, and fill runes."
```

### Task 3: Sierpinski CLI Command

**Files:**
- Modify: `internal/cli/root.go`
- Create: `internal/cli/char.go`
- Create: `internal/cli/sierpinski.go`
- Test: `internal/cli/sierpinski_test.go`

**Interfaces:**
- Consumes: `func Execute(args []string, out io.Writer, errOut io.Writer) error`
- Consumes: `func Render(size int, depth int, fill rune) ([]string, error)` from `fractals/internal/sierpinski`
- Produces: `func NewSierpinskiCommand(out io.Writer) *cobra.Command`
- Produces: `func parseSingleLineRune(value string, flagName string) (rune, error)` for reuse by later CLI commands.
- Produces CLI char parsing errors with exact messages `--char must be exactly one character` and `--char must be a single-line character`.

- [ ] **Step 1: Write the failing Sierpinski command tests**

Create `internal/cli/sierpinski_test.go`:

```go
package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestSierpinskiCommandUsesFlags(t *testing.T) {
	var out bytes.Buffer
	var errOut bytes.Buffer

	err := Execute([]string{"sierpinski", "--size", "8", "--depth", "3", "--char", "#"}, &out, &errOut)
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}

	want := "   #    \n  # #   \n #   #  \n# # # # \n"
	if out.String() != want {
		t.Fatalf("stdout mismatch\nwant:\n%q\n got:\n%q", want, out.String())
	}

	if errOut.Len() != 0 {
		t.Fatalf("expected no stderr, got %q", errOut.String())
	}
}

func TestSierpinskiCommandRejectsInvalidChar(t *testing.T) {
	var out bytes.Buffer
	var errOut bytes.Buffer

	err := Execute([]string{"sierpinski", "--char", "##"}, &out, &errOut)
	if err == nil {
		t.Fatal("Execute returned nil error")
	}
	if !strings.Contains(err.Error(), "--char must be exactly one character") {
		t.Fatalf("error %q does not contain expected char validation message", err.Error())
	}
	if out.Len() != 0 {
		t.Fatalf("expected no stdout, got %q", out.String())
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
go test ./internal/cli -run 'TestSierpinskiCommand' -count=1
```

Expected: FAIL with output containing `unknown command "sierpinski" for "fractals"`.

- [ ] **Step 3: Write the Sierpinski command implementation**

Replace `internal/cli/root.go` with:

```go
package cli

import (
	"io"

	"github.com/spf13/cobra"
)

func NewRootCommand(out io.Writer, errOut io.Writer) *cobra.Command {
	cmd := &cobra.Command{
		Use:          "fractals",
		Short:        "Generate ASCII art fractals",
		Long:         "Generate ASCII art fractals from the command line.",
		SilenceUsage: true,
	}

	cmd.SetOut(out)
	cmd.SetErr(errOut)
	cmd.AddCommand(NewSierpinskiCommand(out))

	return cmd
}

func Execute(args []string, out io.Writer, errOut io.Writer) error {
	cmd := NewRootCommand(out, errOut)
	cmd.SetArgs(args)
	return cmd.Execute()
}
```

Create `internal/cli/char.go`:

```go
package cli

import "fmt"

func parseSingleLineRune(value string, flagName string) (rune, error) {
	runes := []rune(value)
	if len(runes) != 1 {
		return 0, fmt.Errorf("%s must be exactly one character", flagName)
	}
	if runes[0] == '\n' || runes[0] == '\r' {
		return 0, fmt.Errorf("%s must be a single-line character", flagName)
	}
	return runes[0], nil
}
```

Create `internal/cli/sierpinski.go`:

```go
package cli

import (
	"fmt"
	"io"

	"fractals/internal/sierpinski"

	"github.com/spf13/cobra"
)

func NewSierpinskiCommand(out io.Writer) *cobra.Command {
	var size int
	var depth int
	var charValue string

	cmd := &cobra.Command{
		Use:   "sierpinski",
		Short: "Generate a Sierpinski triangle",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			fill, err := parseSingleLineRune(charValue, "--char")
			if err != nil {
				return err
			}

			lines, err := sierpinski.Render(size, depth, fill)
			if err != nil {
				return err
			}

			for _, line := range lines {
				fmt.Fprintln(out, line)
			}

			return nil
		},
	}

	cmd.Flags().IntVar(&size, "size", 32, "Width of the triangle base in characters")
	cmd.Flags().IntVar(&depth, "depth", 5, "Recursion depth")
	cmd.Flags().StringVar(&charValue, "char", "*", "Character to use for filled points")

	return cmd
}
```

- [ ] **Step 4: Run Sierpinski command tests to verify they pass**

Run:

```bash
go test ./internal/cli -run 'TestSierpinskiCommand' -count=1
```

Expected: PASS.

- [ ] **Step 5: Run all tests**

Run:

```bash
go test ./...
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/cli/root.go internal/cli/char.go internal/cli/sierpinski.go internal/cli/sierpinski_test.go
git commit -m "feat: add Sierpinski CLI command" -m "Wires the Sierpinski renderer into the Cobra command tree with size, depth, and char flags. Adds shared single-character parsing for CLI flags so later commands can reuse the same validation behavior."
```

### Task 4: Mandelbrot Renderer

**Files:**
- Create: `internal/mandelbrot/mandelbrot.go`
- Test: `internal/mandelbrot/mandelbrot_test.go`

**Interfaces:**
- Consumes: none.
- Produces: `const Gradient = " .:-=+*#%@"`
- Produces: `func Render(width int, height int, maxIterations int, fill rune) ([]string, error)`
- Produces renderer errors with exact messages `width must be at least 1`, `height must be at least 1`, `iterations must be at least 1`, and `char must be a single-line rune`.
- Produces behavior where `fill == 0` uses `Gradient`, and any non-zero `fill` renders set points with that rune and escaped points with spaces.

- [ ] **Step 1: Write the failing Mandelbrot renderer tests**

Create `internal/mandelbrot/mandelbrot_test.go`:

```go
package mandelbrot

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestRenderWithCustomCharacterReturnsRectangle(t *testing.T) {
	lines, err := Render(12, 6, 20, '#')
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}

	if len(lines) != 6 {
		t.Fatalf("expected 6 lines, got %d", len(lines))
	}

	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "#") {
		t.Fatalf("expected custom character in output:\n%s", joined)
	}
	if !strings.Contains(joined, " ") {
		t.Fatalf("expected spaces for escaped points:\n%s", joined)
	}

	for index, line := range lines {
		if got := utf8.RuneCountInString(line); got != 12 {
			t.Fatalf("line %d width = %d, want 12: %q", index, got, line)
		}
		for _, char := range line {
			if char != '#' && char != ' ' {
				t.Fatalf("line %d contains unexpected rune %q in %q", index, char, line)
			}
		}
	}
}

func TestRenderWithGradientUsesGradientCharacters(t *testing.T) {
	lines, err := Render(20, 8, 30, 0)
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}

	seen := map[rune]bool{}
	for _, line := range lines {
		for _, char := range line {
			if !strings.ContainsRune(Gradient, char) {
				t.Fatalf("gradient output contains unexpected rune %q", char)
			}
			seen[char] = true
		}
	}

	if len(seen) < 3 {
		t.Fatalf("expected at least 3 gradient runes, got %d from %#v", len(seen), seen)
	}
}

func TestRenderRejectsInvalidInputs(t *testing.T) {
	tests := []struct {
		name          string
		width         int
		height        int
		maxIterations int
		fill          rune
		wantErr       string
	}{
		{name: "zero width", width: 0, height: 6, maxIterations: 20, fill: 0, wantErr: "width must be at least 1"},
		{name: "zero height", width: 12, height: 0, maxIterations: 20, fill: 0, wantErr: "height must be at least 1"},
		{name: "zero iterations", width: 12, height: 6, maxIterations: 0, fill: 0, wantErr: "iterations must be at least 1"},
		{name: "newline char", width: 12, height: 6, maxIterations: 20, fill: '\n', wantErr: "char must be a single-line rune"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Render(test.width, test.height, test.maxIterations, test.fill)
			if err == nil {
				t.Fatal("Render returned nil error")
			}
			if !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("error %q does not contain %q", err.Error(), test.wantErr)
			}
		})
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
go test ./internal/mandelbrot -count=1
```

Expected: FAIL with compiler output containing `undefined: Render` and `undefined: Gradient`.

- [ ] **Step 3: Write the minimal Mandelbrot implementation**

Create `internal/mandelbrot/mandelbrot.go`:

```go
package mandelbrot

import "fmt"

const Gradient = " .:-=+*#%@"

func Render(width int, height int, maxIterations int, fill rune) ([]string, error) {
	if width < 1 {
		return nil, fmt.Errorf("width must be at least 1")
	}
	if height < 1 {
		return nil, fmt.Errorf("height must be at least 1")
	}
	if maxIterations < 1 {
		return nil, fmt.Errorf("iterations must be at least 1")
	}
	if fill == '\n' || fill == '\r' {
		return nil, fmt.Errorf("char must be a single-line rune")
	}

	lines := make([]string, height)
	for py := 0; py < height; py++ {
		imaginary := scale(py, height, 1.0, -1.0)
		cells := make([]rune, width)

		for px := 0; px < width; px++ {
			real := scale(px, width, -2.0, 1.0)
			escapedAt := escapeIterations(real, imaginary, maxIterations)
			cells[px] = runeForIterations(escapedAt, maxIterations, fill)
		}

		lines[py] = string(cells)
	}

	return lines, nil
}

func scale(index int, count int, min float64, max float64) float64 {
	if count == 1 {
		return (min + max) / 2
	}
	return min + (max-min)*float64(index)/float64(count-1)
}

func escapeIterations(cReal float64, cImaginary float64, maxIterations int) int {
	zReal := 0.0
	zImaginary := 0.0

	for iteration := 0; iteration < maxIterations; iteration++ {
		if zReal*zReal+zImaginary*zImaginary > 4.0 {
			return iteration
		}

		nextReal := zReal*zReal - zImaginary*zImaginary + cReal
		zImaginary = 2*zReal*zImaginary + cImaginary
		zReal = nextReal
	}

	return maxIterations
}

func runeForIterations(iteration int, maxIterations int, fill rune) rune {
	if fill != 0 {
		if iteration == maxIterations {
			return fill
		}
		return ' '
	}

	gradient := []rune(Gradient)
	index := iteration * (len(gradient) - 1) / maxIterations
	return gradient[index]
}
```

- [ ] **Step 4: Run Mandelbrot renderer tests to verify they pass**

Run:

```bash
go test ./internal/mandelbrot -count=1
```

Expected: PASS.

- [ ] **Step 5: Run all tests**

Run:

```bash
go test ./...
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/mandelbrot/mandelbrot.go internal/mandelbrot/mandelbrot_test.go
git commit -m "feat: add Mandelbrot renderer" -m "Adds the pure Mandelbrot renderer with default gradient output and custom-character output. The renderer validates dimensions, iteration count, and single-line fill runes before returning fixed-width ASCII lines."
```

### Task 5: Mandelbrot CLI Command and Final Acceptance

**Files:**
- Modify: `internal/cli/root.go`
- Create: `internal/cli/mandelbrot.go`
- Test: `internal/cli/mandelbrot_test.go`

**Interfaces:**
- Consumes: `func Execute(args []string, out io.Writer, errOut io.Writer) error`
- Consumes: `func parseSingleLineRune(value string, flagName string) (rune, error)`
- Consumes: `const Gradient = " .:-=+*#%@"` from `fractals/internal/mandelbrot`
- Consumes: `func Render(width int, height int, maxIterations int, fill rune) ([]string, error)` from `fractals/internal/mandelbrot`
- Produces: `func NewMandelbrotCommand(out io.Writer) *cobra.Command`
- Produces root help listing both `sierpinski` and `mandelbrot`.

- [ ] **Step 1: Write the failing Mandelbrot command tests**

Create `internal/cli/mandelbrot_test.go`:

```go
package cli

import (
	"bytes"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestMandelbrotCommandUsesFlags(t *testing.T) {
	var out bytes.Buffer
	var errOut bytes.Buffer

	err := Execute([]string{"mandelbrot", "--width", "12", "--height", "6", "--iterations", "20", "--char", "#"}, &out, &errOut)
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}

	output := strings.TrimSuffix(out.String(), "\n")
	lines := strings.Split(output, "\n")
	if len(lines) != 6 {
		t.Fatalf("expected 6 output lines, got %d:\n%s", len(lines), out.String())
	}

	if !strings.Contains(output, "#") {
		t.Fatalf("expected custom character in Mandelbrot output:\n%s", out.String())
	}

	for index, line := range lines {
		if got := utf8.RuneCountInString(line); got != 12 {
			t.Fatalf("line %d width = %d, want 12: %q", index, got, line)
		}
	}

	if errOut.Len() != 0 {
		t.Fatalf("expected no stderr, got %q", errOut.String())
	}
}

func TestMandelbrotCommandRejectsInvalidWidth(t *testing.T) {
	var out bytes.Buffer
	var errOut bytes.Buffer

	err := Execute([]string{"mandelbrot", "--width", "0"}, &out, &errOut)
	if err == nil {
		t.Fatal("Execute returned nil error")
	}
	if !strings.Contains(err.Error(), "width must be at least 1") {
		t.Fatalf("error %q does not contain width validation message", err.Error())
	}
	if out.Len() != 0 {
		t.Fatalf("expected no stdout, got %q", out.String())
	}
}

func TestRootHelpListsFractalCommands(t *testing.T) {
	var out bytes.Buffer
	var errOut bytes.Buffer

	err := Execute([]string{"--help"}, &out, &errOut)
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}

	stdout := out.String()
	for _, want := range []string{"sierpinski", "mandelbrot"} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("root help missing %q:\n%s", want, stdout)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
go test ./internal/cli -run 'TestMandelbrotCommand|TestRootHelpListsFractalCommands' -count=1
```

Expected: FAIL with output containing `unknown command "mandelbrot" for "fractals"` or root help missing `mandelbrot`.

- [ ] **Step 3: Write the Mandelbrot command implementation**

Replace `internal/cli/root.go` with:

```go
package cli

import (
	"io"

	"github.com/spf13/cobra"
)

func NewRootCommand(out io.Writer, errOut io.Writer) *cobra.Command {
	cmd := &cobra.Command{
		Use:          "fractals",
		Short:        "Generate ASCII art fractals",
		Long:         "Generate ASCII art fractals from the command line.",
		SilenceUsage: true,
	}

	cmd.SetOut(out)
	cmd.SetErr(errOut)
	cmd.AddCommand(NewSierpinskiCommand(out))
	cmd.AddCommand(NewMandelbrotCommand(out))

	return cmd
}

func Execute(args []string, out io.Writer, errOut io.Writer) error {
	cmd := NewRootCommand(out, errOut)
	cmd.SetArgs(args)
	return cmd.Execute()
}
```

Create `internal/cli/mandelbrot.go`:

```go
package cli

import (
	"fmt"
	"io"

	"fractals/internal/mandelbrot"

	"github.com/spf13/cobra"
)

func NewMandelbrotCommand(out io.Writer) *cobra.Command {
	var width int
	var height int
	var iterations int
	var charValue string

	cmd := &cobra.Command{
		Use:   "mandelbrot",
		Short: "Generate a Mandelbrot set",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			fill := rune(0)
			if charValue != "" {
				parsed, err := parseSingleLineRune(charValue, "--char")
				if err != nil {
					return err
				}
				fill = parsed
			}

			lines, err := mandelbrot.Render(width, height, iterations, fill)
			if err != nil {
				return err
			}

			for _, line := range lines {
				fmt.Fprintln(out, line)
			}

			return nil
		},
	}

	cmd.Flags().IntVar(&width, "width", 80, "Output width in characters")
	cmd.Flags().IntVar(&height, "height", 24, "Output height in characters")
	cmd.Flags().IntVar(&iterations, "iterations", 100, "Maximum iterations for escape calculation")
	cmd.Flags().StringVar(&charValue, "char", "", "Single character to use instead of the default gradient")

	return cmd
}
```

- [ ] **Step 4: Run Mandelbrot command tests to verify they pass**

Run:

```bash
go test ./internal/cli -run 'TestMandelbrotCommand|TestRootHelpListsFractalCommands' -count=1
```

Expected: PASS.

- [ ] **Step 5: Run all tests**

Run:

```bash
go test ./...
```

Expected: PASS.

- [ ] **Step 6: Verify root help from the binary entry point**

Run:

```bash
go run ./cmd/fractals --help
```

Expected: exit 0; stdout contains `Usage:`, `sierpinski`, and `mandelbrot`.

- [ ] **Step 7: Verify Sierpinski binary output**

Run:

```bash
go run ./cmd/fractals sierpinski --size 8 --depth 3 --char '#'
```

Expected stdout exactly:

```text
   #    
  # #   
 #   #  
# # # # 
```

- [ ] **Step 8: Verify Mandelbrot binary dimensions**

Run:

```bash
go run ./cmd/fractals mandelbrot --width 12 --height 6 --iterations 20 --char '#'
```

Expected: exit 0; stdout has 6 newline-terminated rows, every row is 12 characters wide, and at least one row contains `#`.

- [ ] **Step 9: Verify invalid input error from the binary entry point**

Run:

```bash
go run ./cmd/fractals mandelbrot --width 0
```

Expected: non-zero exit; stderr contains `width must be at least 1`.

- [ ] **Step 10: Commit**

```bash
git add internal/cli/root.go internal/cli/mandelbrot.go internal/cli/mandelbrot_test.go
git commit -m "feat: add Mandelbrot CLI command" -m "Wires the Mandelbrot renderer into the Cobra command tree with width, height, iterations, and optional char flags. Verifies both fractal commands through unit tests and binary-level smoke commands for help, successful output, and invalid input handling."
```

## Execution Handoff

Plan complete and saved to `plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

If Subagent-Driven is chosen, REQUIRED SUB-SKILL: use superpowers:subagent-driven-development with a fresh subagent per task and two-stage review.

If Inline Execution is chosen, REQUIRED SUB-SKILL: use superpowers:executing-plans with batch execution and checkpoints for review.
