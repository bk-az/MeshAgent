# Development Guide

This is a fork of [Ylianst/MeshAgent](https://github.com/Ylianst/MeshAgent).

## Branches

- **`develop`** — default working branch. All custom changes go here.
- **`master`** — kept in sync with upstream only. Never commit custom changes to it.

## Remotes

```
origin     git@github.com:bk-az/MeshAgent.git
upstream   git@github.com:Ylianst/MeshAgent.git
```

If `upstream` is missing:

```sh
git remote add upstream git@github.com:Ylianst/MeshAgent.git
```

## Making changes

```sh
git checkout develop
# edit, then
git commit -am "..."
git push origin develop
```

## Upgrading from upstream

Sync `master` with upstream, then merge `master` into `develop`:

```sh
git fetch upstream
git checkout master
git merge --ff-only upstream/master
git push origin master

git checkout develop
git merge master
# resolve conflicts if any, then
git push origin develop
```

If `git merge --ff-only upstream/master` fails, `master` has drifted (a commit was made
on it by mistake). Move that commit to `develop` and reset `master`:

```sh
git checkout master
git reset --hard upstream/master
git push --force-with-lease origin master
```

## OpenSSL

The agent links a vendored, statically built OpenSSL (currently 3.5.9 LTS). Headers live in
`openssl/include/openssl`, libraries in `openssl/libstatic`. How to rebuild them, which
Configure options are required, and the three small version-guarded source changes that
keep the tree buildable against both OpenSSL 1.1.1 (upstream) and 3.x/4.x are documented
in [openssl/BUILDING.md](openssl/BUILDING.md).

```sh
./openssl/libstatic/macos/build-openssl-macos.sh 3.5.9 --refresh-headers   # macOS libs + headers
```
