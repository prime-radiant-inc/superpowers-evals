# Svelte Todo List — Implementation Plan

Execute this plan using the `superpowers:subagent-driven-development` skill.

## Global Constraints

- Framework: Svelte (with TypeScript)
- Build tool: Vite (`npm create vite@latest` with `svelte-ts` template)
- Data model: `interface Todo { id: string; text: string; completed: boolean }`
- Filter type: `type Filter = 'all' | 'active' | 'completed'`
- `id` must be a UUID (use `crypto.randomUUID()`)
- localStorage key: `svelte-todos`
- File structure exactly as specified: `App.svelte`, `lib/TodoInput.svelte`, `lib/TodoList.svelte`, `lib/TodoItem.svelte`, `lib/FilterBar.svelte`, `lib/store.ts`, `lib/storage.ts`
- Unit tests: Vitest + `@testing-library/svelte`
- E2E tests: Playwright — `npx playwright test` must pass
- App title text: `Svelte Todos`
- Empty state must show a helpful message
- Remaining count copy: `N items left` (counts incomplete todos)

## File Structure

| File | Responsibility |
|------|----------------|
| `src/lib/storage.ts` | Read/write `Todo[]` to localStorage under key `svelte-todos` |
| `src/lib/store.ts` | Svelte writable store of todos + derived helpers; mutation functions (add, toggle, delete, clearCompleted); persists via storage.ts |
| `src/lib/TodoItem.svelte` | Renders one todo: checkbox, text, delete button; emits events |
| `src/lib/TodoList.svelte` | Renders list of `TodoItem`; shows empty state message |
| `src/lib/TodoInput.svelte` | Text input + Add button; emits `add` with text |
| `src/lib/FilterBar.svelte` | Filter buttons, items-left count, clear-completed button |
| `src/App.svelte` | Wires store + components, holds current filter, computes visible todos |
| `src/lib/*.test.ts` / `*.spec.ts` | Vitest unit/component tests |
| `e2e/todo.spec.ts` | Playwright end-to-end tests |
| `vitest.config.ts` / `vite.config.ts` | Test + build config |
| `playwright.config.ts` | Playwright config |

---

### Task 1: Project scaffold and tooling

**Files:** `package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `src/vitest-setup.ts`, `src/App.svelte` (placeholder), `src/main.ts`

**Interfaces:**
- Produces: a runnable Svelte+TS+Vite app with `npm run dev`, `npm test` (Vitest), and a working `App.svelte` mount point.

- [ ] Scaffold the project in the current directory:
  ```bash
  npm create vite@latest . -- --template svelte-ts
  npm install
  ```
  If prompted about a non-empty directory, choose to ignore/continue.

- [ ] Install test dependencies:
  ```bash
  npm install -D vitest @testing-library/svelte @testing-library/jest-dom jsdom @vitest/ui
  ```

- [ ] Create `src/vitest-setup.ts`:
  ```ts
  import '@testing-library/jest-dom/vitest';
  ```

- [ ] Create `vitest.config.ts`:
  ```ts
  import { defineConfig } from 'vitest/config';
  import { svelte } from '@sveltejs/vite-plugin-svelte';

  export default defineConfig({
    plugins: [svelte({ hot: false })],
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/vitest-setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,js}'],
    },
  });
  ```

- [ ] Add scripts to `package.json` (merge into existing `"scripts"`):
  ```json
  "test": "vitest run",
  "test:watch": "vitest"
  ```

- [ ] Replace `src/App.svelte` with a minimal placeholder:
  ```svelte
  <main>
    <h1>Svelte Todos</h1>
  </main>
  ```

- [ ] Verify the app builds and dev server starts:
  ```bash
  npm run build
  ```
  Expected: build completes with no errors.

- [ ] Verify Vitest runs (no tests yet is OK):
  ```bash
  npm test
  ```
  Expected output includes `No test files found` or `0 passed` — exit code 0.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Scaffold Svelte+TS+Vite project with Vitest"
  ```

---

### Task 2: localStorage persistence (`storage.ts`)

**Files:** `src/lib/types.ts`, `src/lib/storage.ts`, `src/lib/storage.test.ts`

**Interfaces:**
- Produces:
  - `src/lib/types.ts`: `export interface Todo { id: string; text: string; completed: boolean }` and `export type Filter = 'all' | 'active' | 'completed'`
  - `src/lib/storage.ts`:
    - `export const STORAGE_KEY = 'svelte-todos'`
    - `export function loadTodos(): Todo[]`
    - `export function saveTodos(todos: Todo[]): void`
  - `loadTodos` returns `[]` when key absent or JSON invalid.

- [ ] Create `src/lib/types.ts`:
  ```ts
  export interface Todo {
    id: string;
    text: string;
    completed: boolean;
  }

  export type Filter = 'all' | 'active' | 'completed';
  ```

- [ ] Write failing test `src/lib/storage.test.ts`:
  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { loadTodos, saveTodos, STORAGE_KEY } from './storage';
  import type { Todo } from './types';

  const sample: Todo[] = [
    { id: '1', text: 'a', completed: false },
    { id: '2', text: 'b', completed: true },
  ];

  describe('storage', () => {
    beforeEach(() => localStorage.clear());

    it('returns [] when nothing stored', () => {
      expect(loadTodos()).toEqual([]);
    });

    it('returns [] when stored value is invalid JSON', () => {
      localStorage.setItem(STORAGE_KEY, 'not json');
      expect(loadTodos()).toEqual([]);
    });

    it('round-trips todos through save/load', () => {
      saveTodos(sample);
      expect(loadTodos()).toEqual(sample);
    });
  });
  ```

- [ ] Run the test, expect failure:
  ```bash
  npm test
  ```
  Expected: fails because `./storage` does not exist.

- [ ] Implement `src/lib/storage.ts`:
  ```ts
  import type { Todo } from './types';

  export const STORAGE_KEY = 'svelte-todos';

  export function loadTodos(): Todo[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as Todo[];
    } catch {
      return [];
    }
  }

  export function saveTodos(todos: Todo[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }
  ```

- [ ] Run the test, expect pass:
  ```bash
  npm test
  ```
  Expected: `3 passed`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Add types and localStorage persistence"
  ```

---

### Task 3: Todo store (`store.ts`)

**Files:** `src/lib/store.ts`, `src/lib/store.test.ts`

**Interfaces:**
- Consumes: `Todo` from `./types`; `loadTodos`, `saveTodos` from `./storage`.
- Produces `src/lib/store.ts`:
  - `export const todos: Writable<Todo[]>` (initialized from `loadTodos()`, auto-saves on every change via `todos.subscribe(saveTodos)`)
  - `export function addTodo(text: string): void` — trims text; ignores empty; prepends new todo with `crypto.randomUUID()`, `completed: false`
  - `export function toggleTodo(id: string): void`
  - `export function deleteTodo(id: string): void`
  - `export function clearCompleted(): void`

- [ ] Write failing test `src/lib/store.test.ts`:
  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { get } from 'svelte/store';
  import { todos, addTodo, toggleTodo, deleteTodo, clearCompleted } from './store';

  describe('store', () => {
    beforeEach(() => {
      localStorage.clear();
      todos.set([]);
    });

    it('adds a trimmed todo', () => {
      addTodo('  Buy milk  ');
      const list = get(todos);
      expect(list).toHaveLength(1);
      expect(list[0].text).toBe('Buy milk');
      expect(list[0].completed).toBe(false);
      expect(typeof list[0].id).toBe('string');
    });

    it('ignores empty/whitespace todos', () => {
      addTodo('   ');
      expect(get(todos)).toHaveLength(0);
    });

    it('toggles completion', () => {
      addTodo('x');
      const id = get(todos)[0].id;
      toggleTodo(id);
      expect(get(todos)[0].completed).toBe(true);
      toggleTodo(id);
      expect(get(todos)[0].completed).toBe(false);
    });

    it('deletes a todo', () => {
      addTodo('x');
      const id = get(todos)[0].id;
      deleteTodo(id);
      expect(get(todos)).toHaveLength(0);
    });

    it('clears completed todos', () => {
      addTodo('keep');
      addTodo('remove');
      const removeId = get(todos)[0].id; // most recent prepended
      toggleTodo(removeId);
      clearCompleted();
      const list = get(todos);
      expect(list).toHaveLength(1);
      expect(list[0].text).toBe('keep');
    });

    it('persists to localStorage on change', () => {
      addTodo('persisted');
      expect(localStorage.getItem('svelte-todos')).toContain('persisted');
    });
  });
  ```

- [ ] Run the test, expect failure:
  ```bash
  npm test
  ```
  Expected: fails because `./store` does not exist.

- [ ] Implement `src/lib/store.ts`:
  ```ts
  import { writable } from 'svelte/store';
  import type { Todo } from './types';
  import { loadTodos, saveTodos } from './storage';

  export const todos = writable<Todo[]>(loadTodos());

  todos.subscribe(saveTodos);

  export function addTodo(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const todo: Todo = {
      id: crypto.randomUUID(),
      text: trimmed,
      completed: false,
    };
    todos.update((list) => [todo, ...list]);
  }

  export function toggleTodo(id: string): void {
    todos.update((list) =>
      list.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t))
    );
  }

  export function deleteTodo(id: string): void {
    todos.update((list) => list.filter((t) => t.id !== id));
  }

  export function clearCompleted(): void {
    todos.update((list) => list.filter((t) => !t.completed));
  }
  ```

- [ ] Run the test, expect pass:
  ```bash
  npm test
  ```
  Expected: `store` suite `6 passed`, plus storage `3 passed`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Add todos store with mutations and persistence"
  ```

---

### Task 4: `TodoItem.svelte`

**Files:** `src/lib/TodoItem.svelte`, `src/lib/TodoItem.test.ts`

**Interfaces:**
- Consumes: `Todo` from `./types`.
- Produces component with props `export let todo: Todo;` that dispatches:
  - `toggle` event with `detail: { id: string }`
  - `remove` event with `detail: { id: string }`
- Markup: a checkbox (`role="checkbox"` via `<input type="checkbox">`), the todo text, and a delete button with accessible name `Delete`.

- [ ] Write failing test `src/lib/TodoItem.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { render, screen, fireEvent } from '@testing-library/svelte';
  import TodoItem from './TodoItem.svelte';
  import type { Todo } from './types';

  const todo: Todo = { id: 'abc', text: 'Walk the dog', completed: false };

  describe('TodoItem', () => {
    it('renders text and checkbox state', () => {
      render(TodoItem, { props: { todo } });
      expect(screen.getByText('Walk the dog')).toBeInTheDocument();
      expect(screen.getByRole('checkbox')).not.toBeChecked();
    });

    it('dispatches toggle with id on checkbox click', async () => {
      const { component } = render(TodoItem, { props: { todo } });
      const handler = vi.fn();
      component.$on('toggle', handler);
      await fireEvent.click(screen.getByRole('checkbox'));
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].detail).toEqual({ id: 'abc' });
    });

    it('dispatches remove with id on delete click', async () => {
      const { component } = render(TodoItem, { props: { todo } });
      const handler = vi.fn();
      component.$on('remove', handler);
      await fireEvent.click(screen.getByRole('button', { name: /delete/i }));
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].detail).toEqual({ id: 'abc' });
    });
  });
  ```

- [ ] Run the test, expect failure:
  ```bash
  npm test
  ```
  Expected: fails because `TodoItem.svelte` does not exist.

- [ ] Implement `src/lib/TodoItem.svelte`:
  ```svelte
  <script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import type { Todo } from './types';

    export let todo: Todo;

    const dispatch = createEventDispatcher<{
      toggle: { id: string };
      remove: { id: string };
    }>();
  </script>

  <li class="todo-item" class:completed={todo.completed}>
    <input
      type="checkbox"
      checked={todo.completed}
      on:change={() => dispatch('toggle', { id: todo.id })}
    />
    <span class="text">{todo.text}</span>
    <button class="delete" aria-label="Delete" on:click={() => dispatch('remove', { id: todo.id })}>
      x
    </button>
  </li>

  <style>
    .todo-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0;
    }
    .text { flex: 1; }
    .completed .text { text-decoration: line-through; opacity: 0.6; }
    .delete { cursor: pointer; }
  </style>
  ```

- [ ] Run the test, expect pass:
  ```bash
  npm test
  ```
  Expected: `TodoItem` suite `3 passed`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Add TodoItem component"
  ```

---

### Task 5: `TodoList.svelte`

**Files:** `src/lib/TodoList.svelte`, `src/lib/TodoList.test.ts`

**Interfaces:**
- Consumes: `Todo` from `./types`; `TodoItem` from `./TodoItem.svelte`.
- Produces component with prop `export let todos: Todo[];` that:
  - Renders one `TodoItem` per todo inside a `<ul>`.
  - Forwards each `TodoItem`'s `toggle` and `remove` events upward (re-dispatch).
  - When `todos` is empty, renders a helpful empty-state message containing the text `Nothing here yet`.

- [ ] Write failing test `src/lib/TodoList.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { render, screen, fireEvent } from '@testing-library/svelte';
  import TodoList from './TodoList.svelte';
  import type { Todo } from './types';

  const todos: Todo[] = [
    { id: '1', text: 'one', completed: false },
    { id: '2', text: 'two', completed: true },
  ];

  describe('TodoList', () => {
    it('shows empty state when no todos', () => {
      render(TodoList, { props: { todos: [] } });
      expect(screen.getByText(/nothing here yet/i)).toBeInTheDocument();
    });

    it('renders one item per todo', () => {
      render(TodoList, { props: { todos } });
      expect(screen.getByText('one')).toBeInTheDocument();
      expect(screen.getByText('two')).toBeInTheDocument();
    });

    it('forwards toggle events', async () => {
      const { component } = render(TodoList, { props: { todos } });
      const handler = vi.fn();
      component.$on('toggle', handler);
      await fireEvent.click(screen.getAllByRole('checkbox')[0]);
      expect(handler.mock.calls[0][0].detail).toEqual({ id: '1' });
    });

    it('forwards remove events', async () => {
      const { component } = render(TodoList, { props: { todos } });
      const handler = vi.fn();
      component.$on('remove', handler);
      await fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0]);
      expect(handler.mock.calls[0][0].detail).toEqual({ id: '1' });
    });
  });
  ```

- [ ] Run the test, expect failure:
  ```bash
  npm test
  ```
  Expected: fails because `TodoList.svelte` does not exist.

- [ ] Implement `src/lib/TodoList.svelte`:
  ```svelte
  <script lang="ts">
    import type { Todo } from './types';
    import TodoItem from './TodoItem.svelte';

    export let todos: Todo[];
  </script>

  {#if todos.length === 0}
    <p class="empty">Nothing here yet — add your first todo!</p>
  {:else}
    <ul class="todo-list">
      {#each todos as todo (todo.id)}
        <TodoItem {todo} on:toggle on:remove />
      {/each}
    </ul>
  {/if}

  <style>
    .todo-list { list-style: none; padding: 0; margin: 0; }
    .empty { color: #888; text-align: center; padding: 1rem 0; }
  </style>
  ```

- [ ] Run the test, expect pass:
  ```bash
  npm test
  ```
  Expected: `TodoList` suite `4 passed`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Add TodoList component with empty state"
  ```

---

### Task 6: `TodoInput.svelte`

**Files:** `src/lib/TodoInput.svelte`, `src/lib/TodoInput.test.ts`

**Interfaces:**
- Produces component that dispatches `add` event with `detail: string` (the trimmed-by-store text — pass raw text, store trims) when:
  - Enter is pressed in the text input, OR
  - the `Add` button is clicked.
  - After dispatching, the input is cleared.
  - Does not dispatch when input is empty/whitespace.

- [ ] Write failing test `src/lib/TodoInput.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { render, screen, fireEvent } from '@testing-library/svelte';
  import TodoInput from './TodoInput.svelte';

  describe('TodoInput', () => {
    it('dispatches add on Add button click and clears input', async () => {
      const { component } = render(TodoInput);
      const handler = vi.fn();
      component.$on('add', handler);
      const input = screen.getByRole('textbox') as HTMLInputElement;
      await fireEvent.input(input, { target: { value: 'New task' } });
      await fireEvent.click(screen.getByRole('button', { name: /add/i }));
      expect(handler.mock.calls[0][0].detail).toBe('New task');
      expect(input.value).toBe('');
    });

    it('dispatches add on Enter key', async () => {
      const { component } = render(TodoInput);
      const handler = vi.fn();
      component.$on('add', handler);
      const input = screen.getByRole('textbox');
      await fireEvent.input(input, { target: { value: 'Via enter' } });
      await fireEvent.keyDown(input, { key: 'Enter' });
      expect(handler.mock.calls[0][0].detail).toBe('Via enter');
    });

    it('does not dispatch when empty', async () => {
      const { component } = render(TodoInput);
      const handler = vi.fn();
      component.$on('add', handler);
      await fireEvent.click(screen.getByRole('button', { name: /add/i }));
      expect(handler).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] Run the test, expect failure:
  ```bash
  npm test
  ```
  Expected: fails because `TodoInput.svelte` does not exist.

- [ ] Implement `src/lib/TodoInput.svelte`:
  ```svelte
  <script lang="ts">
    import { createEventDispatcher } from 'svelte';

    const dispatch = createEventDispatcher<{ add: string }>();
    let value = '';

    function submit() {
      if (!value.trim()) return;
      dispatch('add', value);
      value = '';
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter') submit();
    }
  </script>

  <div class="todo-input">
    <input
      type="text"
      placeholder="What needs to be done?"
      bind:value
      on:keydown={onKeyDown}
    />
    <button on:click={submit}>Add</button>
  </div>

  <style>
    .todo-input { display: flex; gap: 0.5rem; }
    .todo-input input { flex: 1; }
  </style>
  ```

- [ ] Run the test, expect pass:
  ```bash
  npm test
  ```
  Expected: `TodoInput` suite `3 passed`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Add TodoInput component"
  ```

---

### Task 7: `FilterBar.svelte`

**Files:** `src/lib/FilterBar.svelte`, `src/lib/FilterBar.test.ts`

**Interfaces:**
- Consumes: `Filter` from `./types`.
- Produces component with props:
  - `export let filter: Filter;` (current selection)
  - `export let remaining: number;` (incomplete count)
  - dispatches `filterChange` with `detail: Filter` when a filter button is clicked
  - dispatches `clearCompleted` (no detail) when Clear button is clicked
  - renders `${remaining} items left`
  - renders three buttons named `All`, `Active`, `Completed`, and a `Clear completed` button
  - marks the active filter button with `aria-pressed="true"`

- [ ] Write failing test `src/lib/FilterBar.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { render, screen, fireEvent } from '@testing-library/svelte';
  import FilterBar from './FilterBar.svelte';

  describe('FilterBar', () => {
    it('renders remaining count', () => {
      render(FilterBar, { props: { filter: 'all', remaining: 2 } });
      expect(screen.getByText(/2 items left/i)).toBeInTheDocument();
    });

    it('marks active filter with aria-pressed', () => {
      render(FilterBar, { props: { filter: 'active', remaining: 0 } });
      expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('dispatches filterChange', async () => {
      const { component } = render(FilterBar, { props: { filter: 'all', remaining: 0 } });
      const handler = vi.fn();
      component.$on('filterChange', handler);
      await fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
      expect(handler.mock.calls[0][0].detail).toBe('completed');
    });

    it('dispatches clearCompleted', async () => {
      const { component } = render(FilterBar, { props: { filter: 'all', remaining: 0 } });
      const handler = vi.fn();
      component.$on('clearCompleted', handler);
      await fireEvent.click(screen.getByRole('button', { name: /clear completed/i }));
      expect(handler).toHaveBeenCalled();
    });
  });
  ```

- [ ] Run the test, expect failure:
  ```bash
  npm test
  ```
  Expected: fails because `FilterBar.svelte` does not exist.

- [ ] Implement `src/lib/FilterBar.svelte`:
  ```svelte
  <script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import type { Filter } from './types';

    export let filter: Filter;
    export let remaining: number;

    const dispatch = createEventDispatcher<{
      filterChange: Filter;
      clearCompleted: void;
    }>();

    const filters: { value: Filter; label: string }[] = [
      { value: 'all', label: 'All' },
      { value: 'active', label: 'Active' },
      { value: 'completed', label: 'Completed' },
    ];
  </script>

  <div class="filter-bar">
    <span class="count">{remaining} items left</span>
    <div class="filters">
      {#each filters as f}
        <button
          aria-pressed={filter === f.value}
          class:active={filter === f.value}
          on:click={() => dispatch('filterChange', f.value)}
        >
          {f.label}
        </button>
      {/each}
    </div>
    <button class="clear" on:click={() => dispatch('clearCompleted')}>Clear completed</button>
  </div>

  <style>
    .filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .filters { display: flex; gap: 0.25rem; }
    .active { font-weight: bold; }
  </style>
  ```

- [ ] Run the test, expect pass:
  ```bash
  npm test
  ```
  Expected: `FilterBar` suite `4 passed`.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Add FilterBar component"
  ```

---

### Task 8: Wire everything in `App.svelte`

**Files:** `src/App.svelte`, `src/lib/App.test.ts`

**Interfaces:**
- Consumes: `todos`, `addTodo`, `toggleTodo`, `deleteTodo`, `clearCompleted` from `./lib/store`; `Filter` from `./lib/types`; all four components.
- Produces: rendered app with heading `Svelte Todos` that:
  - holds local `filter: Filter = 'all'`
  - computes `visible` todos by filter and `remaining = todos with completed === false`
  - wires `TodoInput` `add` → `addTodo`
  - wires `TodoList` `toggle` → `toggleTodo`, `remove` → `deleteTodo`
  - wires `FilterBar` `filterChange` → set filter, `clearCompleted` → `clearCompleted`

- [ ] Write failing integration test `src/lib/App.test.ts`:
  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { render, screen, fireEvent } from '@testing-library/svelte';
  import App from '../App.svelte';
  import { todos } from './store';

  async function addTodo(text: string) {
    const input = screen.getByRole('textbox');
    await fireEvent.input(input, { target: { value: text } });
    await fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
  }

  describe('App integration', () => {
    beforeEach(() => {
      localStorage.clear();
      todos.set([]);
    });

    it('adds todos and updates count', async () => {
      render(App);
      await addTodo('Task A');
      await addTodo('Task B');
      expect(screen.getByText('Task A')).toBeInTheDocument();
      expect(screen.getByText('Task B')).toBeInTheDocument();
      expect(screen.getByText(/2 items left/i)).toBeInTheDocument();
    });

    it('toggles completion and updates remaining count', async () => {
      render(App);
      await addTodo('Task A');
      await fireEvent.click(screen.getByRole('checkbox'));
      expect(screen.getByText(/0 items left/i)).toBeInTheDocument();
    });

    it('filters to active and completed', async () => {
      render(App);
      await addTodo('Active task');
      await addTodo('Done task');
      // "Done task" is first (prepended); complete it
      const checkboxes = screen.getAllByRole('checkbox');
      await fireEvent.click(checkboxes[0]);
      await fireEvent.click(screen.getByRole('button', { name: 'Active' }));
      expect(screen.queryByText('Done task')).not.toBeInTheDocument();
      expect(screen.getByText('Active task')).toBeInTheDocument();
      await fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
      expect(screen.getByText('Done task')).toBeInTheDocument();
      expect(screen.queryByText('Active task')).not.toBeInTheDocument();
    });

    it('clears completed todos', async () => {
      render(App);
      await addTodo('Keep');
      await addTodo('Remove');
      await fireEvent.click(screen.getAllByRole('checkbox')[0]); // Remove
      await fireEvent.click(screen.getByRole('button', { name: /clear completed/i }));
      expect(screen.queryByText('Remove')).not.toBeInTheDocument();
      expect(screen.getByText('Keep')).toBeInTheDocument();
    });

    it('deletes a todo', async () => {
      render(App);
      await addTodo('Delete me');
      await fireEvent.click(screen.getByRole('button', { name: /delete/i }));
      expect(screen.queryByText('Delete me')).not.toBeInTheDocument();
    });
  });
  ```

- [ ] Run the test, expect failure:
  ```bash
  npm test
  ```
  Expected: fails because `App.svelte` is still the placeholder.

- [ ] Implement `src/App.svelte`:
  ```svelte
  <script lang="ts">
    import { todos, addTodo, toggleTodo, deleteTodo, clearCompleted } from './lib/store';
    import type { Filter } from './lib/types';
    import TodoInput from './lib/TodoInput.svelte';
    import TodoList from './lib/TodoList.svelte';
    import FilterBar from './lib/FilterBar.svelte';

    let filter: Filter = 'all';

    $: visible = $todos.filter((t) => {
      if (filter === 'active') return !t.completed;
      if (filter === 'completed') return t.completed;
      return true;
    });

    $: remaining = $todos.filter((t) => !t.completed).length;
  </script>

  <main>
    <h1>Svelte Todos</h1>
    <TodoInput on:add={(e) => addTodo(e.detail)} />
    <TodoList
      todos={visible}
      on:toggle={(e) => toggleTodo(e.detail.id)}
      on:remove={(e) => deleteTodo(e.detail.id)}
    />
    <FilterBar
      {filter}
      {remaining}
      on:filterChange={(e) => (filter = e.detail)}
      on:clearCompleted={clearCompleted}
    />
  </main>

  <style>
    main {
      max-width: 480px;
      margin: 2rem auto;
      font-family: system-ui, sans-serif;
    }
    h1 { text-align: center; }
  </style>
  ```

- [ ] Run all tests, expect pass:
  ```bash
  npm test
  ```
  Expected: every suite passes (storage 3, store 6, TodoItem 3, TodoList 4, TodoInput 3, FilterBar 4, App 5).

- [ ] Verify build:
  ```bash
  npm run build
  ```
  Expected: build succeeds.

- [ ] Commit:
  ```bash
  git add -A && git commit -m "Wire components together in App with filtering"
  ```

---

### Task 9: Playwright end-to-end tests

**Files:** `playwright.config.ts`, `e2e/todo.spec.ts`, `package.json`

**Interfaces:**
- Consumes: the running app served by `npm run dev` (Vite default port 5173).
- Produces: Playwright config with `webServer` auto-starting the dev server; E2E spec covering add, complete, delete, filter, and persistence-across-reload.

- [ ] Install Playwright:
  ```bash
  npm install -D @playwright/test
  npx playwright install --with-deps chromium
  ```

- [ ] Add an e2e script to `package.json` `"scripts"`:
  ```json
  "