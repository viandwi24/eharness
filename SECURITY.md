# Security policy

## Supported versions

`eharness` is pre-1.0. Only the latest minor release receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub Private Vulnerability Reporting: go to the
repository's **Security** tab and choose **Report a vulnerability**. Include the affected version,
a reproduction and the impact you see.

You can expect an acknowledgement within a few days. Fixes ship as a patch release of the latest
minor, with a GitHub security advisory.

## Scope

The library's guard, permissions, shell and filesystem plugins are security-relevant: reports about
bypasses of path protection, permission rules, tool approval or the shell sandbox are in scope.
Example applications under `examples/` are not production code.
