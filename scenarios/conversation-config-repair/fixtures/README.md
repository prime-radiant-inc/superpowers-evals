# ConfigKit

ConfigKit loads application configuration from a JSON file and optional
call-site overrides. Configuration precedence is:

1. built-in defaults;
2. values in the JSON file;
3. explicit call-site overrides.

Zero and false are valid configured values. When a key is absent, its value is
inherited from the earlier source.

Run the tests locally with:

```sh
python3 -m unittest discover -s tests -v
```
