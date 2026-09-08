# Constructed dialogue

User: I'd like task completion notifications on this local browser Tasks page.
Before writing application code, help me settle the important choices and give
me a short proposal.

Coding-Agent: The page is an empty shell. Should the proposal include a minimal
task list, and should notices stay in the page or use operating-system alerts?

User: Include a minimal task list. Notices should stay inside this browser page.
There is no backend or account system. This is a proposal only.

Coding-Agent: After a task finishes, should it remain in Active, move to Completed,
or disappear?

User: Move it to Completed, and provide a way to undo an accidental completion.

Coding-Agent: Should browser-local storage retain task state after refresh?

User: Yes, if available. An in-memory fallback is fine for this first version.

Coding-Agent: Here is the complete proposal in `delivered-proposal.md` for your
review. I have not implemented it or changed the application page.
