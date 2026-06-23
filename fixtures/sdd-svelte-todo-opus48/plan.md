# Svelte Todo List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Svelte 5 + TypeScript todo app with add/complete/delete, All/Active/Completed filtering, clear-completed, a remaining-items count, and localStorage persistence — fully covered by Vitest component/unit tests and a Playwright e2e suite.

**Architecture:** A single writable Svelte store (`store.ts`) owns the todo array and the active filter; it derives `filteredTodos` and `remainingCount`, and persists every change to localStorage via `storage.ts`. Presentational components (`TodoInput`, `TodoItem`, `TodoList`, `FilterBar`) are stateless and communicate upward through callback props (Svelte 5 idiom — no `createEventDispatcher`). `App.svelte` wires store actions to those callbacks.

**Tech Stack:** Svelte 5 (runes mode), TypeScript (strict), Vite 6, Vitest + jsdom + @testing-library/svelte + @testing-library/user-event + @testing-library/jest-dom, Playwright.

## Global Constraints

Every task's requirements implicitly include this section.

- **Svelte version:** Svelte 5, runes mode. Components declare props with `$props()` and local state with `$state(...)`. Use callback props (e.g. `onAdd`, `onToggle`) — do **not** use `createEventDispatcher`.
- **Language:** TypeScript `strict: true`. All `.svelte` `<script>` blocks use `lang="ts"`.
- **Data model (verbatim from design.md):**
  ```typescript
  interface Todo {
    id: string;        // UUID
    text: string;      // Todo text
    completed: boolean;
  }
  type Filter = 'all' | 'active' | 'completed';
  ```
- **localStorage key:** `'svelte-todos'` (exact string, used by storage and asserted in tests).
- **ID generation:** `crypto.randomUUID()`.
- **Dev server / e2e base URL:** `http://localhost:5173` (Vite default port).
- **Empty-state copy (exact):** `Nothing here yet. Add your first todo!`
- **Count copy (exact):** `<n> item left` for n === 1, otherwise `<n> items left`.
- **Accessibility labels (exact, relied on by tests):**
  - New-todo input: `aria-label="New todo"`
  - Toggle checkbox: `aria-label="Toggle <text>"`
  - Delete button: `aria-label="Delete <text>"`
  - Filter buttons (visible text): `All`, `Active`, `Completed`
  - Add button (visible text): `Add`
  - Clear button (visible text): `Clear completed`
- **Vitest scope:** unit/component specs live under `src/**/*.{test,spec}.ts`. Playwright specs live under `e2e/**`. The two runners must not pick up each other's files.
- **Commits:** one commit per task, message provided in the task's final step.

---

## File Structure

| File | Responsibility | Created in |
|------|----------------|------------|
| `package.json`, `tsconfig.json`, `tsconfig.node.json`, `svelte.config.js`, `vite.config.ts`, `vitest-setup.ts`, `playwright.config.ts`, `.gitignore` | Tooling & config | Task 1 |
| `src/sanity.test.ts` | Toolchain smoke test | Task 1 |
| `src/lib/types.ts` | `Todo` interface, `Filter` type | Task 2 |
| `src/lib/storage.ts` | Load/save todos to localStorage | Task 2 |
| `src/lib/store.ts` | Writable + derived stores, mutation actions | Task 3 |
| `src/lib/TodoInput.svelte` | Text input + Add button | Task 4 |
| `src/lib/TodoItem.svelte` | One todo row: checkbox, text, delete | Task 5 |
| `src/lib/TodoList.svelte` | List container + empty state | Task 6 |
| `src/lib/FilterBar.svelte` | Count, filter buttons, clear-completed | Task 7 |
| `src/App.svelte`, `src/main.ts`, `src/app.css`, `index.html` | App shell, entry point, styles, HTML host | Task 8 |
| `e2e/todo.spec.ts` | Full Playwright suite | Task 9 |

---

## Task 1: Project scaffolding & test tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `svelte.config.js`
- Create: `vite.config.ts`
- Create: `vitest-setup.ts`
- Create: `playwright.config.ts`
- Create: `.gitignore`
- Test: `src/sanity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test` (Vitest under jsdom with @testing-library/svelte + jest-dom matchers + globals) and a configured `npm run test:e2e` (Playwright against the Vite dev server). Later tasks rely on: jsdom `localStorage`, Vitest globals (`describe/it/expect/vi/beforeEach` without import), and the `svelteTesting()` auto-cleanup plugin.

- [ ] **Step 1: Initialize the repo and write all config files**

```bash
git init
```

Create `package.json`:

```json
{
  "name": "svelte-todo",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/svelte": "^5.2.0",
    "@testing-library/user-event": "^14.5.0",
    "@tsconfig/svelte": "^5.0.0",
    "@types/node": "^22.9.0",
    "jsdom": "^25.0.0",
    "svelte": "^5.2.0",
    "svelte-check": "^4.1.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "extends": "@tsconfig/svelte/tsconfig.json",
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom", "node"]
  },
  "include": ["src/**/*.ts", "src/**/*.svelte", "vitest-setup.ts"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Create `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "types": ["node"]
  },
  "include": ["vite.config.ts", "playwright.config.ts"]
}
```

Create `svelte.config.js`:

```js
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
};
```

Create `vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest-setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
  },
});
```

Create `vitest-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
test-results/
playwright-report/
playwright/.cache/
*.log
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: completes with no errors; `node_modules/` populated.

- [ ] **Step 3: Write the toolchain sanity test**

Create `src/sanity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs TypeScript tests', () => {
    expect(1 + 1).toBe(2);
  });

  it('provides a jsdom localStorage', () => {
    localStorage.setItem('k', 'v');
    expect(localStorage.getItem('k')).toBe('v');
    localStorage.clear();
  });
});
```

- [ ] **Step 4: Run the sanity test to confirm the toolchain is green**

Run: `npm test`
Expected: PASS — `src/sanity.test.ts` reports 2 passing tests. This confirms Vitest, TypeScript, jsdom, and `localStorage` all work.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold Svelte 5 + TS project with Vitest and Playwright tooling"
```

---

## Task 2: Domain types & localStorage persistence

**Files:**
- Create: `src/lib/types.ts`
- Create: `src/lib/storage.ts`
- Test: `src/lib/storage.test.ts`

**Interfaces:**
- Consumes: jsdom `localStorage` (from Task 1).
- Produces:
  - `src/lib/types.ts`: `export interface Todo { id: string; text: string; completed: boolean }` and `export type Filter = 'all' | 'active' | 'completed'`.
  - `src/lib/storage.ts`: `export function loadTodos(): Todo[]` (returns `[]` on missing/invalid data, filters out malformed entries) and `export function saveTodos(todos: Todo[]): void` (writes JSON under key `'svelte-todos'`).

- [ ] **Step 1: Create the shared types**

Create `src/lib/types.ts`:

```ts
export interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

export type Filter = 'all' | 'active' | 'completed';
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/storage.test.ts`:

```ts
import { beforeEach, describe, it, expect } from 'vitest';
import { loadTodos, saveTodos } from './storage';
import type { Todo } from './types';

beforeEach(() => localStorage.clear());

describe('storage', () => {
  it('returns an empty array when nothing is stored', () => {
    expect(loadTodos()).toEqual([]);
  });

  it('round-trips todos through localStorage', () => {
    const todos: Todo[] = [{ id: '1', text: 'a', completed: false }];
    saveTodos(todos);
    expect(loadTodos()).toEqual(todos);
  });

  it('writes under the "svelte-todos" key', () => {
    saveTodos([{ id: '1', text: 'a', completed: false }]);
    expect(localStorage.getItem('svelte-todos')).toBeTruthy();
  });

  it('returns an empty array when stored JSON is invalid', () => {
    localStorage.setItem('svelte-todos', 'not json');
    expect(loadTodos()).toEqual([]);
  });

  it('filters out malformed entries', () => {
    localStorage.setItem(
      'svelte-todos',
      JSON.stringify([{ id: '1' }, { id: '2', text: 'ok', completed: true }]),
    );
    expect(loadTodos()).toEqual([{ id: '2', text: 'ok', completed: true }]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: FAIL — cannot resolve `./storage` (module does not exist).

- [ ] **Step 4: Write the minimal implementation**

Create `src/lib/storage.ts`:

```ts
import type { Todo } from './types';

const STORAGE_KEY = 'svelte-todos';

function isTodo(value: unknown): value is Todo {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Todo).id === 'string' &&
    typeof (value as Todo).text === 'string' &&
    typeof (value as Todo).completed === 'boolean'
  );
}

export function loadTodos(): Todo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTodo);
  } catch {
    return [];
  }
}

export function saveTodos(todos: Todo[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: PASS — 5 passing tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: add Todo/Filter types and localStorage persistence"
```

---

## Task 3: Todo store (state, actions, derived values)

**Files:**
- Create: `src/lib/store.ts`
- Test: `src/lib/store.test.ts`

**Interfaces:**
- Consumes: `loadTodos`, `saveTodos` from `./storage`; `Todo`, `Filter` from `./types`.
- Produces (all from `src/lib/store.ts`):
  - `export const todos: Writable<Todo[]>` — initialized from `loadTodos()`, auto-persists via `saveTodos` on every change.
  - `export const filter: Writable<Filter>` — initialized to `'all'`.
  - `export function addTodo(text: string): void` — ignores empty/whitespace; appends `{ id: crypto.randomUUID(), text: text.trim(), completed: false }`.
  - `export function toggleTodo(id: string): void`
  - `export function deleteTodo(id: string): void`
  - `export function clearCompleted(): void`
  - `export function setFilter(value: Filter): void`
  - `export const filteredTodos: Readable<Todo[]>` — derived from `todos` + `filter`.
  - `export const remainingCount: Readable<number>` — count of incomplete todos.

- [ ] **Step 1: Write the failing test**

Create `src/lib/store.test.ts`:

```ts
import { get } from 'svelte/store';
import { beforeEach, describe, it, expect } from 'vitest';
import {
  todos,
  filter,
  addTodo,
  toggleTodo,
  deleteTodo,
  clearCompleted,
  setFilter,
  filteredTodos,
  remainingCount,
} from './store';

beforeEach(() => {
  todos.set([]);
  filter.set('all');
  localStorage.clear();
});

describe('store actions', () => {
  it('addTodo appends a trimmed, incomplete todo with an id', () => {
    addTodo('  Buy milk  ');
    const list = get(todos);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('Buy milk');
    expect(list[0].completed).toBe(false);
    expect(typeof list[0].id).toBe('string');
    expect(list[0].id.length).toBeGreaterThan(0);
  });

  it('addTodo ignores empty/whitespace text', () => {
    addTodo('   ');
    expect(get(todos)).toHaveLength(0);
  });

  it('toggleTodo flips completed for the matching id', () => {
    addTodo('a');
    const id = get(todos)[0].id;
    toggleTodo(id);
    expect(get(todos)[0].completed).toBe(true);
    toggleTodo(id);
    expect(get(todos)[0].completed).toBe(false);
  });

  it('deleteTodo removes the matching todo', () => {
    addTodo('a');
    addTodo('b');
    deleteTodo(get(todos)[0].id);
    const list = get(todos);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('b');
  });

  it('clearCompleted removes only completed todos', () => {
    addTodo('a');
    addTodo('b');
    toggleTodo(get(todos)[0].id);
    clearCompleted();
    const list = get(todos);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('b');
  });
});

describe('derived stores', () => {
  it('filteredTodos respects the active filter', () => {
    addTodo('a');
    addTodo('b');
    toggleTodo(get(todos)[0].id); // mark "a" completed
    setFilter('active');
    expect(get(filteredTodos).map((t) => t.text)).toEqual(['b']);
    setFilter('completed');
    expect(get(filteredTodos).map((t) => t.text)).toEqual(['a']);
    setFilter('all');
    expect(get(filteredTodos)).toHaveLength(2);
  });

  it('remainingCount counts incomplete todos', () => {
    addTodo('a');
    addTodo('b');
    expect(get(remainingCount)).toBe(2);
    toggleTodo(get(todos)[0].id);
    expect(get(remainingCount)).toBe(1);
  });
});

describe('persistence', () => {
  it('saves todos to localStorage on change', () => {
    addTodo('persist me');
    const raw = localStorage.getItem('svelte-todos');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)[0].text).toBe('persist me');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/store.test.ts`
Expected: FAIL — cannot resolve `./store` (module does not exist).

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/store.ts`:

```ts
import { writable, derived, get } from 'svelte/store';
import type { Todo, Filter } from './types';
import { loadTodos, saveTodos } from './storage';

export const todos = writable<Todo[]>(loadTodos());
export const filter = writable<Filter>('all');

// Persist on every change.
todos.subscribe((value) => saveTodos(value));

export function addTodo(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  todos.update((list) => [
    ...list,
    { id: crypto.randomUUID(), text: trimmed, completed: false },
  ]);
}

export function toggleTodo(id: string): void {
  todos.update((list) =>
    list.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)),
  );
}

export function deleteTodo(id: string): void {
  todos.update((list) => list.filter((t) => t.id !== id));
}

export function clearCompleted(): void {
  todos.update((list) => list.filter((t) => !t.completed));
}

export function setFilter(value: Filter): void {
  filter.set(value);
}

export const filteredTodos = derived([todos, filter], ([$todos, $filter]) => {
  switch ($filter) {
    case 'active':
      return $todos.filter((t) => !t.completed);
    case 'completed':
      return $todos.filter((t) => t.completed);
    default:
      return $todos;
  }
});

export const remainingCount = derived(
  todos,
  ($todos) => $todos.filter((t) => !t.completed).length,
);

// Re-export get for convenience in case consumers need imperative reads.
export { get };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/store.test.ts`
Expected: PASS — 8 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store.ts src/lib/store.test.ts
git commit -m "feat: add todo store with actions, filtering, count, and persistence"
```

---

## Task 4: TodoInput component

**Files:**
- Create: `src/lib/TodoInput.svelte`
- Test: `src/lib/TodoInput.test.ts`

**Interfaces:**
- Consumes: nothing (presentational).
- Produces: `TodoInput.svelte` with prop `onAdd: (text: string) => void`. Renders a text input (`aria-label="New todo"`) and an `Add` button. Submits on Enter or Add click, calls `onAdd(trimmedText)` only for non-empty input, then clears the field.

- [ ] **Step 1: Write the failing test**

Create `src/lib/TodoInput.test.ts`:

```ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect } from 'vitest';
import TodoInput from './TodoInput.svelte';

describe('TodoInput', () => {
  it('calls onAdd with trimmed text when Enter is pressed, then clears', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(TodoInput, { props: { onAdd } });
    const input = screen.getByLabelText('New todo');
    await user.type(input, '  Buy milk  {Enter}');
    expect(onAdd).toHaveBeenCalledWith('Buy milk');
    expect(input).toHaveValue('');
  });

  it('calls onAdd when the Add button is clicked', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(TodoInput, { props: { onAdd } });
    await user.type(screen.getByLabelText('New todo'), 'Walk dog');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith('Walk dog');
  });

  it('does not call onAdd for empty/whitespace input', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(TodoInput, { props: { onAdd } });
    await user.type(screen.getByLabelText('New todo'), '   {Enter}');
    expect(onAdd).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/TodoInput.test.ts`
Expected: FAIL — cannot resolve `./TodoInput.svelte`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/TodoInput.svelte`:

```svelte
<script lang="ts">
  let { onAdd }: { onAdd: (text: string) => void } = $props();
  let value = $state('');

  function submit() {
    const text = value.trim();
    if (!text) return;
    onAdd(text);
    value = '';
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') submit();
  }
</script>

<div class="todo-input">
  <input
    type="text"
    placeholder="What needs to be done?"
    aria-label="New todo"
    bind:value
    onkeydown={handleKeydown}
  />
  <button onclick={submit}>Add</button>
</div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/TodoInput.test.ts`
Expected: PASS — 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/TodoInput.svelte src/lib/TodoInput.test.ts
git commit -m "feat: add TodoInput component"
```

---

## Task 5: TodoItem component

**Files:**
- Create: `src/lib/TodoItem.svelte`
- Test: `src/lib/TodoItem.test.ts`

**Interfaces:**
- Consumes: `Todo` from `./types`.
- Produces: `TodoItem.svelte` with props `todo: Todo`, `onToggle: (id: string) => void`, `onDelete: (id: string) => void`. Renders an `<li>` containing a checkbox (`aria-label="Toggle <text>"`, `checked` mirrors `todo.completed`), the todo text, and a delete button (`aria-label="Delete <text>"`). Adds class `completed` to the `<li>` when done.

- [ ] **Step 1: Write the failing test**

Create `src/lib/TodoItem.test.ts`:

```ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect } from 'vitest';
import TodoItem from './TodoItem.svelte';
import type { Todo } from './types';

const todo: Todo = { id: '1', text: 'Buy milk', completed: false };

describe('TodoItem', () => {
  it('renders the todo text', () => {
    render(TodoItem, { props: { todo, onToggle: vi.fn(), onDelete: vi.fn() } });
    expect(screen.getByText('Buy milk')).toBeInTheDocument();
  });

  it('reflects completed state in the checkbox', () => {
    render(TodoItem, {
      props: { todo: { ...todo, completed: true }, onToggle: vi.fn(), onDelete: vi.fn() },
    });
    expect(screen.getByRole('checkbox', { name: 'Toggle Buy milk' })).toBeChecked();
  });

  it('calls onToggle with the id when the checkbox is clicked', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(TodoItem, { props: { todo, onToggle, onDelete: vi.fn() } });
    await user.click(screen.getByRole('checkbox', { name: 'Toggle Buy milk' }));
    expect(onToggle).toHaveBeenCalledWith('1');
  });

  it('calls onDelete with the id when the delete button is clicked', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(TodoItem, { props: { todo, onToggle: vi.fn(), onDelete } });
    await user.click(screen.getByRole('button', { name: 'Delete Buy milk' }));
    expect(onDelete).toHaveBeenCalledWith('1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/TodoItem.test.ts`
Expected: FAIL — cannot resolve `./TodoItem.svelte`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/TodoItem.svelte`:

```svelte
<script lang="ts">
  import type { Todo } from './types';

  let {
    todo,
    onToggle,
    onDelete,
  }: {
    todo: Todo;
    onToggle: (id: string) => void;
    onDelete: (id: string) => void;
  } = $props();
</script>

<li class="todo-item" class:completed={todo.completed}>
  <input
    type="checkbox"
    checked={todo.completed}
    aria-label={`Toggle ${todo.text}`}
    onchange={() => onToggle(todo.id)}
  />
  <span class="todo-text">{todo.text}</span>
  <button
    class="delete"
    aria-label={`Delete ${todo.text}`}
    onclick={() => onDelete(todo.id)}>×</button
  >
</li>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/TodoItem.test.ts`
Expected: PASS — 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/TodoItem.svelte src/lib/TodoItem.test.ts
git commit -m "feat: add TodoItem component"
```

---

## Task 6: TodoList component

**Files:**
- Create: `src/lib/TodoList.svelte`
- Test: `src/lib/TodoList.test.ts`

**Interfaces:**
- Consumes: `Todo` from `./types`; `TodoItem.svelte` from Task 5.
- Produces: `TodoList.svelte` with props `todos: Todo[]`, `onToggle: (id: string) => void`, `onDelete: (id: string) => void`. Renders the empty-state paragraph (`Nothing here yet. Add your first todo!`) when `todos` is empty, otherwise a `<ul>` of `TodoItem`s keyed by `todo.id`, forwarding `onToggle`/`onDelete`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/TodoList.test.ts`:

```ts
import { render, screen } from '@testing-library/svelte';
import { vi, describe, it, expect } from 'vitest';
import TodoList from './TodoList.svelte';
import type { Todo } from './types';

const todos: Todo[] = [
  { id: '1', text: 'Buy milk', completed: false },
  { id: '2', text: 'Walk dog', completed: true },
];

describe('TodoList', () => {
  it('shows the empty state when there are no todos', () => {
    render(TodoList, { props: { todos: [], onToggle: vi.fn(), onDelete: vi.fn() } });
    expect(
      screen.getByText('Nothing here yet. Add your first todo!'),
    ).toBeInTheDocument();
  });

  it('renders one list item per todo', () => {
    render(TodoList, { props: { todos, onToggle: vi.fn(), onDelete: vi.fn() } });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Buy milk')).toBeInTheDocument();
    expect(screen.getByText('Walk dog')).toBeInTheDocument();
  });

  it('does not show the empty state when todos exist', () => {
    render(TodoList, { props: { todos, onToggle: vi.fn(), onDelete: vi.fn() } });
    expect(
      screen.queryByText('Nothing here yet. Add your first todo!'),
    ).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/TodoList.test.ts`
Expected: FAIL — cannot resolve `./TodoList.svelte`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/TodoList.svelte`:

```svelte
<script lang="ts">
  import type { Todo } from './types';
  import TodoItem from './TodoItem.svelte';

  let {
    todos,
    onToggle,
    onDelete,
  }: {
    todos: Todo[];
    onToggle: (id: string) => void;
    onDelete: (id: string) => void;
  } = $props();
</script>

{#if todos.length === 0}
  <p class="empty-state">Nothing here yet. Add your first todo!</p>
{:else}
  <ul class="todo-list">
    {#each todos as todo (todo.id)}
      <TodoItem {todo} {onToggle} {onDelete} />
    {/each}
  </ul>
{/if}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/TodoList.test.ts`
Expected: PASS — 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/TodoList.svelte src/lib/TodoList.test.ts
git commit -m "feat: add TodoList component with empty state"
```

---

## Task 7: FilterBar component

**Files:**
- Create: `src/lib/FilterBar.svelte`
- Test: `src/lib/FilterBar.test.ts`

**Interfaces:**
- Consumes: `Filter` from `./types`.
- Produces: `FilterBar.svelte` with props `filter: Filter`, `remaining: number`, `onSetFilter: (filter: Filter) => void`, `onClearCompleted: () => void`. Renders the count text (`<n> item(s) left`), three filter buttons (`All`/`Active`/`Completed`) with class `active` on the current one (calling `onSetFilter` with the lowercase filter), and a `Clear completed` button (calling `onClearCompleted`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/FilterBar.test.ts`:

```ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect } from 'vitest';
import FilterBar from './FilterBar.svelte';

describe('FilterBar', () => {
  it('shows the remaining count with plural copy', () => {
    render(FilterBar, {
      props: { filter: 'all', remaining: 2, onSetFilter: vi.fn(), onClearCompleted: vi.fn() },
    });
    expect(screen.getByText('2 items left')).toBeInTheDocument();
  });

  it('uses singular copy for one item', () => {
    render(FilterBar, {
      props: { filter: 'all', remaining: 1, onSetFilter: vi.fn(), onClearCompleted: vi.fn() },
    });
    expect(screen.getByText('1 item left')).toBeInTheDocument();
  });

  it('calls onSetFilter with the chosen filter', async () => {
    const onSetFilter = vi.fn();
    const user = userEvent.setup();
    render(FilterBar, {
      props: { filter: 'all', remaining: 0, onSetFilter, onClearCompleted: vi.fn() },
    });
    await user.click(screen.getByRole('button', { name: 'Active' }));
    expect(onSetFilter).toHaveBeenCalledWith('active');
  });

  it('marks the current filter button active', () => {
    render(FilterBar, {
      props: { filter: 'completed', remaining: 0, onSetFilter: vi.fn(), onClearCompleted: vi.fn() },
    });
    expect(screen.getByRole('button', { name: 'Completed' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'All' })).not.toHaveClass('active');
  });

  it('calls onClearCompleted when the clear button is clicked', async () => {
    const onClearCompleted = vi.fn();
    const user = userEvent.setup();
    render(FilterBar, {
      props: { filter: 'all', remaining: 0, onSetFilter: vi.fn(), onClearCompleted },
    });
    await user.click(screen.getByRole('button', { name: 'Clear completed' }));
    expect(onClearCompleted).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/FilterBar.test.ts`
Expected: FAIL — cannot resolve `./FilterBar.svelte`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/FilterBar.svelte`:

```svelte
<script lang="ts">
  import type { Filter } from './types';

  let {
    filter,
    remaining,
    onSetFilter,
    onClearCompleted,
  }: {
    filter: Filter;
    remaining: number;
    onSetFilter: (filter: Filter) => void;
    onClearCompleted: () => void;
  } = $props();

  const filters: Filter[] = ['all', 'active', 'completed'];

  function label(f: Filter): string {
    return f.charAt(0).toUpperCase() + f.slice(1);
  }
</script>

<div class="filter-bar">
  <span class="count">{remaining} {remaining === 1 ? 'item' : 'items'} left</span>
  <div class="filters">
    {#each filters as f}
      <button class:active={filter === f} onclick={() => onSetFilter(f)}>
        {label(f)}
      </button>
    {/each}
  </div>
  <button class="clear-completed" onclick={onClearCompleted}>Clear completed</button>
</div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/FilterBar.test.ts`
Expected: PASS — 5 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/FilterBar.svelte src/lib/FilterBar.test.ts
git commit -m "feat: add FilterBar component"
```

---

## Task 8: App shell, entry point, and integration test

**Files:**
- Create: `src/App.svelte`
- Create: `src/main.ts`
- Create: `src/app.css`
- Create: `index.html`
- Test: `src/App.test.ts`

**Interfaces:**
- Consumes: everything — `TodoInput`, `TodoList`, `FilterBar` components, and the store exports (`filteredTodos`, `filter`, `remainingCount`, `addTodo`, `toggleTodo`, `deleteTodo`, `clearCompleted`, `setFilter`).
- Produces: a mounted application. `App.svelte` subscribes to the store (`$filteredTodos`, `$filter`, `$remainingCount`) and binds store actions to the child callback props. `main.ts` mounts `App` into `#app` using Svelte 5's `mount`. After this task `npm run dev`, `npm run build`, and the e2e suite (Task 9) can run.

- [ ] **Step 1: Write the failing test**

Create `src/App.test.ts`:

```ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, it, expect } from 'vitest';
import App from './App.svelte';
import { todos, filter } from './lib/store';

beforeEach(() => {
  todos.set([]);
  filter.set('all');
  localStorage.clear();
});

describe('App integration', () => {
  it('renders the title and empty state on first load', () => {
    render(App);
    expect(screen.getByText('Svelte Todos')).toBeInTheDocument();
    expect(
      screen.getByText('Nothing here yet. Add your first todo!'),
    ).toBeInTheDocument();
  });

  it('adds a todo and updates the count', async () => {
    const user = userEvent.setup();
    render(App);
    await user.type(screen.getByLabelText('New todo'), 'Buy milk{Enter}');
    expect(screen.getByText('Buy milk')).toBeInTheDocument();
    expect(screen.getByText('1 item left')).toBeInTheDocument();
  });

  it('toggles, filters, and clears completed todos', async () => {
    const user = userEvent.setup();
    render(App);
    const input = screen.getByLabelText('New todo');
    await user.type(input, 'a{Enter}');
    await user.type(input, 'b{Enter}');

    await user.click(screen.getByRole('checkbox', { name: 'Toggle a' }));
    expect(screen.getByText('1 item left')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Active' }));
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.click(screen.getByRole('button', { name: 'Clear completed' }));
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
  });

  it('deletes a todo', async () => {
    const user = userEvent.setup();
    render(App);
    await user.type(screen.getByLabelText('New todo'), 'delete me{Enter}');
    await user.click(screen.getByRole('button', { name: 'Delete delete me' }));
    expect(screen.queryByText('delete me')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/App.test.ts`
Expected: FAIL — cannot resolve `./App.svelte`.

- [ ] **Step 3: Write the App component**

Create `src/App.svelte`:

```svelte
<script lang="ts">
  import TodoInput from './lib/TodoInput.svelte';
  import TodoList from './lib/TodoList.svelte';
  import FilterBar from './lib/FilterBar.svelte';
  import {
    filteredTodos,
    filter,
    remainingCount,
    addTodo,
    toggleTodo,
    deleteTodo,
    clearCompleted,
    setFilter,
  } from './lib/store';
</script>

<main class="app">
  <h1>Svelte Todos</h1>
  <TodoInput onAdd={addTodo} />
  <TodoList todos={$filteredTodos} onToggle={toggleTodo} onDelete={deleteTodo} />
  <FilterBar
    filter={$filter}
    remaining={$remainingCount}
    onSetFilter={setFilter}
    onClearCompleted={clearCompleted}
  />
</main>
```

- [ ] **Step 4: Write the entry point, styles, and HTML host**

Create `src/main.ts`:

```ts
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const app = mount(App, { target: document.getElementById('app')! });

export default app;
```

Create `src/app.css`:

```css
:root {
  font-family: system-ui, -apple-system, sans-serif;
}

body {
  margin: 0;
  background: #f4f4f5;
}

.app {
  max-width: 480px;
  margin: 2rem auto;
  padding: 1rem;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}

h1 {
  font-size: 1.5rem;
  text-align: center;
}

.todo-input {
  display: flex;
  gap: 0.5rem;
}

.todo-input input {
  flex: 1;
  padding: 0.5rem;
}

.todo-list {
  list-style: none;
  padding: 0;
  margin: 1rem 0;
}

.todo-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid #eee;
}

.todo-item.completed .todo-text {
  text-decoration: line-through;
  color: #999;
}

.todo-text {
  flex: 1;
}

.delete {
  background: none;
  border: none;
  cursor: pointer;
  color: #c00;
  font-size: 1.2rem;
}

.empty-state {
  text-align: center;
  color: #888;
}

.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.filters button.active {
  font-weight: bold;
}
```

Create `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Svelte Todos</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `npx vitest run src/App.test.ts`
Expected: PASS — 4 passing tests.

- [ ] **Step 6: Run the full unit/component suite and a production build**

Run: `npm test`
Expected: PASS — all spec files green (`sanity`, `storage`, `store`, `TodoInput`, `TodoItem`, `TodoList`, `FilterBar`, `App`).

Run: `npm run build`
Expected: Vite build completes with no errors and emits `dist/`.

- [ ] **Step 7: Commit**

```bash
git add src/App.svelte src/main.ts src/app.css index.html src/App.test.ts
git commit -m "feat: wire App shell, entry point, and styles with integration tests"
```

---

## Task 9: Playwright end-to-end suite

**Files:**
- Create: `e2e/todo.spec.ts`
- (Config `playwright.config.ts` already created in Task 1.)

**Interfaces:**
- Consumes: the running app served by `npm run dev` (auto-started by Playwright's `webServer`), exercised through the accessible labels listed in Global Constraints.
- Produces: an e2e suite covering empty state, add (Enter + button), complete, delete, filter, clear-completed, and persistence-across-reload — satisfying acceptance criterion 10 (`npx playwright test` passes).

- [ ] **Step 1: Install the Playwright browser**

Run: `npx playwright install chromium`
Expected: Chromium downloads successfully (one-time setup).

- [ ] **Step 2: Write the failing e2e suite**

Create `e2e/todo.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Start from a clean slate: clear persisted state, then reload the app.
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
});

test('shows the empty state initially', async ({ page }) => {
  await expect(
    page.getByText('Nothing here yet. Add your first todo!'),
  ).toBeVisible();
});

test('adds a todo by pressing Enter', async ({ page }) => {
  const input = page.getByLabel('New todo');
  await input.fill('Buy groceries');
  await input.press('Enter');
  await expect(page.getByText('Buy groceries')).toBeVisible();
  await expect(page.getByText('1 item left')).toBeVisible();
});

test('adds a todo by clicking Add', async ({ page }) => {
  await page.getByLabel('New todo').fill('Walk the dog');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Walk the dog')).toBeVisible();
});

test('completes a todo', async ({ page }) => {
  const input = page.getByLabel('New todo');
  await input.fill('Write code');
  await input.press('Enter');
  const checkbox = page.getByRole('checkbox', { name: 'Toggle Write code' });
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await expect(page.getByText('0 items left')).toBeVisible();
});

test('deletes a todo', async ({ page }) => {
  const input = page.getByLabel('New todo');
  await input.fill('Delete me');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Delete Delete me' }).click();
  await expect(page.getByText('Delete me')).toHaveCount(0);
  await expect(
    page.getByText('Nothing here yet. Add your first todo!'),
  ).toBeVisible();
});

test('filters todos by All/Active/Completed', async ({ page }) => {
  const input = page.getByLabel('New todo');
  await input.fill('Active task');
  await input.press('Enter');
  await input.fill('Done task');
  await input.press('Enter');
  await page.getByRole('checkbox', { name: 'Toggle Done task' }).check();

  await page.getByRole('button', { name: 'Active' }).click();
  await expect(page.getByText('Active task')).toBeVisible();
  await expect(page.getByText('Done task')).toHaveCount(0);

  await page.getByRole('button', { name: 'Completed' }).click();
  await expect(page.getByText('Done task')).toBeVisible();
  await expect(page.getByText('Active task')).toHaveCount(0);

  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.getByText('Active task')).toBeVisible();
  await expect(page.getByText('Done task')).toBeVisible();
});

test('clears completed todos', async ({ page }) => {
  const input = page.getByLabel('New todo');
  await input.fill('Keep me');
  await input.press('Enter');
  await input.fill('Remove me');
  await input.press('Enter');
  await page.getByRole('checkbox', { name: 'Toggle Remove me' }).check();
  await page.getByRole('button', { name: 'Clear completed' }).click();
  await expect(page.getByText('Remove me')).toHaveCount(0);
  await expect(page.getByText('Keep me')).toBeVisible();
});

test('persists todos across reload', async ({ page }) => {
  const input = page.getByLabel('New todo');
  await input.fill('Persistent task');
  await input.press('Enter');
  await page.getByRole('checkbox', { name: 'Toggle Persistent task' }).check();

  await page.reload();

  await expect(page.getByText('Persistent task')).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Toggle Persistent task' }),
  ).toBeChecked();
});
```

- [ ] **Step 3: Run the e2e suite to verify it passes**

Run: `npx playwright test`
Expected: PASS — 8 e2e tests pass. (Playwright auto-starts `npm run dev` on port 5173 via the `webServer` config, runs against Chromium, and shuts the server down afterward.)

- [ ] **Step 4: Run the complete test suite (unit/component + e2e) one final time**

Run: `npm test && npx playwright test`
Expected: PASS — all Vitest specs green, then all 8 Playwright tests green. This satisfies acceptance criteria 9 and 10.

- [ ] **Step 5: Commit**

```bash
git add e2e/todo.spec.ts
git commit -m "test: add Playwright e2e suite covering add, complete, delete, filter, clear, persistence"
```

---

## Self-Review

**1. Spec coverage** (design.md acceptance criteria → task):

| # | Criterion | Covered by |
|---|-----------|-----------|
| 1 | Add via Enter or Add button | Task 4 (TodoInput), Task 3 (`addTodo`), Task 9 |
| 2 | Toggle completion via checkbox | Task 5 (TodoItem), Task 3 (`toggleTodo`), Task 9 |
| 3 | Delete via X button | Task 5 (TodoItem), Task 3 (`deleteTodo`), Task 9 |
| 4 | Filter buttons show correct subset | Task 3 (`filteredTodos`), Task 7 (FilterBar), Task 8, Task 9 |
| 5 | "X items left" count | Task 3 (`remainingCount`), Task 7, Task 9 |
| 6 | Clear completed | Task 3 (`clearCompleted`), Task 7, Task 9 |
| 7 | Persist across refresh | Task 2 (storage), Task 3 (auto-persist subscribe), Task 9 (reload) |
| 8 | Empty state message | Task 6 (TodoList), Task 9 |
| 9 | All tests pass | Task 8 Step 6, Task 9 Step 4 |
| 10 | Playwright e2e (add/complete/delete/filter/persistence) passes | Task 9 |

Components from design.md file map — `App.svelte` (T8), `TodoInput.svelte` (T4), `TodoList.svelte` (T6), `TodoItem.svelte` (T5), `FilterBar.svelte` (T7), `store.ts` (T3), `storage.ts` (T2) — all covered. `types.ts` added (T2) to hold the shared `Todo`/`Filter` definitions and avoid a store↔storage import cycle.

**2. Placeholder scan:** No `TBD`/`...`/"similar to"/"add error handling" placeholders — every code and test block is written in full.

**3. Type consistency:** `Todo`/`Filter` defined once in `types.ts` (T2) and imported everywhere. Store signatures (`addTodo`, `toggleTodo`, `deleteTodo`, `clearCompleted`, `setFilter`, `filteredTodos`, `remainingCount`, `todos`, `filter`) declared in T3's Interfaces match T8's App usage. Component callback prop names (`onAdd`, `onToggle`, `onDelete`, `onSetFilter`, `onClearCompleted`) and accessible labels are identical between component definitions, component tests, the App integration test, and the e2e suite. localStorage key `'svelte-todos'` consistent across storage, store test, and persistence behavior.
