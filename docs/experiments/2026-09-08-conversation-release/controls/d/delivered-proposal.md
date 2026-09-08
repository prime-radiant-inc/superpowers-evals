# Proposal delivered to the user

Use a small title-only task list with Active and Completed sections. A task starts
in Active. Its completion checkbox moves it into Completed and shows a brief
in-page message with Undo. Undo restores it to Active. An All/Active/Completed
filter controls which section is visible; the Active section is the set currently
being monitored. Repeated completion of an already completed task emits nothing.

Store task ids, titles, and completed status in browser-local storage. If storage
is unavailable, retain them in memory until refresh and show that limitation.
The filter changes visibility only. Use keyboard-operable controls and a polite
live region for messages. The exact auto-dismiss duration is an open presentation
choice; grouping several rapid notices could be added later.

No backend, accounts, or OS notifications are needed. This is a proposal for
approval; the current page is unchanged and none of the proposed behavior has
been implemented or tested.
