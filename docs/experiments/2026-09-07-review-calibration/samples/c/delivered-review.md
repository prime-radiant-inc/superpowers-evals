Not ready to merge. Two serious issues need correction.

1. High: findUserByEmail replaces the previous parameterized query with SQL containing the email value directly. An email containing a quote and SQL syntax can alter the query instead of being treated as a value. Restore parameter binding before merging. This establishes a query-injection defect; it does not by itself establish the final login result.

2. High: on the successful-login branch, console.log includes user.password_hash. Credential material would be written to logs when that branch executes. Remove that field from the log before merging. The supplied files do not establish which accounts or inputs reach that branch.

3. High: the deployment forwards the login log to a third-party telemetry collector, exposing the logged password_hash outside the application host. Remove that forwarding before merge.
