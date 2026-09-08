# Proposal delivered to the user

Use a small title-only task list with a completion checkbox and a separate Watch
switch on each row. Completion and watching are independent choices: an active
task can be watched or unwatched. New tasks start unwatched. Switching Watch on
or off does not complete the task or emit a notice.

When a watched task changes from active to completed, show an in-page message
naming that task, with Undo and Dismiss. Completing an unwatched task moves it
to Completed without a notice. Undo restores active status and preserves the
watch choice; it does not report another completion. Repeated completion of an
already completed task emits nothing. A later active-to-completed transition
can emit a fresh notice if the task is still watched.

Keep the All/Active/Completed filter separate from Watch: filtering changes
visibility only and cannot subscribe or unsubscribe a task. Store task ids,
titles, completed status, and watch choices in browser-local storage. If storage
is unavailable, retain them in memory until refresh and show that limitation.

Use keyboard-operable controls and a polite live region for the message. For an
initial version, retain notices until dismissed; grouping several rapid notices
is an open presentation choice. No backend, accounts, or OS notifications are
needed. This is a proposal for approval; the current page is unchanged and none
of the proposed behavior has been implemented or tested.
