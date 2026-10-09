---
"eharness": patch
---

permissions: the built-in `Read(.env*)` ask no longer makes a recursive directory read such as `grep -rn export src` ask; it still covers globs and explicit paths, and user `Read` rules still cover subtrees.
