def canonical_string:
  . as $raw
  | if type == "string" then
      (try fromjson catch $raw)
    else
      .
    end
  | tostring;

def tool_path:
  (
    .args.file_path //
    .args.path //
    .args.TargetFile //
    .args.target_file //
    .args.filePath //
    .args.AbsolutePath //
    .args.Path //
    .args.TargetPath //
    ""
  )
  | canonical_string;

def implementation_relpath:
  (tool_path) as $path
  | if $path == "" then
      ""
    elif ($path | contains("/coding-agent-workdir/")) then
      ($path | split("/coding-agent-workdir/") | last)
    elif ($path | startswith("/")) then
      ""
    else
      $path
    end;

def is_implementation_path:
  (implementation_relpath) as $rel
  | ($rel != "")
  and (
    (
      $rel
      | test(
          "(^|/)\\.git(/|$)|(^|/)node_modules(/|$)|^docs/superpowers/|^\\.gitignore$|^\\.antigravitycli(/|$)"
        )
    )
    | not
  );
