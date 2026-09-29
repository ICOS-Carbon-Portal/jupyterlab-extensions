# CLAUDE.md — icos-ext

Reference for Claude Code sessions in this repository.

## Project overview

A JupyterLab 4.x extension for the ICOS Carbon Portal, packaged as
`icos_ext`. It ships four plugins:

| Plugin ID           | Purpose                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@icos-ext/splash`  | Replaces the default splash screen with a branded ICOS animation (pulsing circles, "ICOS / CARBON PORTAL" text)                                                                                              |
| `@icos-ext/sidebar` | Injects an "ICOS HUB" tab into the left sidebar; opens `/hub/home` on the current origin and shows a popup guiding users back to environment selection                                                       |
| `@icos-ext/tracker` | Hybrid (frontend + server) plugin that tracks notebook execution for analytics                                                                                                                               |
| `@icos-ext/freeze`  | Hybrid (frontend + server) plugin that turns a notebook directory into a rebuildable package: a Freeze button in the top bar, a report, a build context written beside the notebooks, and a downloadable zip |

### `@icos-ext/tracker` details

**Frontend** (`src/tracker.ts`): listens to `NotebookActions.executed` and
POSTs `{ notebook, username, url }` to `/icos-ext/track` via
`ServerConnection.makeRequest`.

**Backend** (`icos_ext/handlers.py`): `TrackHandler` registered at
`POST /icos-ext/track`. On each request it calls Matomo
(site ID 10, `https://matomo.icos-cp.eu/matomo.php`) with
`action_name=username:notebook`, `ua`, and `url`. No authentication token
or IP override is used — IP geolocation is not tracked.

### `@icos-ext/freeze` details

**Frontend** (`src/freeze.ts`): adds the Freeze button to the shell's top
area at rank 101 (right of the menu bar) plus the commands
`icos-freeze:from-current` and `icos-freeze:from-selected`. It GETs
`/icos-ext/freeze?path=...` for the report and `/icos-ext/bundle?path=...`
for the handover zip.

**Backend** (`icos_ext/handlers.py`): `FreezeHandler` at
`GET /icos-ext/freeze` returns the snapshot and, when nothing blocks the
freeze, writes `Dockerfile`, `.dockerignore` and `icos-freeze.json` beside
the notebooks. `BundleHandler` at `GET /icos-ext/bundle` serves that
directory as a zip.

**Baseline** (`icos_ext/baseline.py`): standard library only, run once
during the image build as `python -m icos_ext.baseline`. It records what
the image ships so a later freeze can tell user installs apart from the
image's own packages.

User-facing documentation for freeze is `docs/freeze.md`.

`setup_handlers` in `icos_ext/handlers.py` registers all three routes
(`icos-ext/track`, `icos-ext/freeze`, `icos-ext/bundle`). The server
extension is enabled via
`jupyter-config/jupyter_server_config.d/icos-ext.json`.

Target environment: `quay.io/jupyter/datascience-notebook@sha256:8040395c8534cdf96388c20a85a2e89a259dbce057e67d6fd7577c2a9beea5c3`
(JupyterLab 4.5.6, Python 3.13.12).

## Tech stack

- **Frontend:** TypeScript, built with `jlpm` (JupyterLab's pinned Yarn) and `tsc`
- **Python packaging:** Hatchling + `hatch-nodejs-version` (version sourced from `package.json`)
- **Linting:** ESLint, Prettier, Stylelint

## Key files and directories

```text
src/index.ts                   — imports the plugins and exports the array
src/splash.ts                  — splash screen plugin
src/sidebar.ts                 — ICOS HUB sidebar plugin
src/tracker.ts                 — notebook execution tracking plugin
src/freeze.ts                  — freeze plugin (button, overlay, report)
style/index.css                — CSS for the splash, sidebar and freeze UI
schema/plugin.json             — JupyterLab settings schema
docs/freeze.md                 — user-facing documentation for freeze
icos_ext/                      — Python package (import name)
  __init__.py
  handlers.py                  — server routes: track, freeze, bundle
  baseline.py                  — records what the image ships; run at build time
  _version.py                  — AUTO-GENERATED — do not edit
  labextension/                — BUILD ARTIFACT — do not edit
Dockerfile                     — dev image; builds and installs the extension
docker-compose.yml             — local dev stack, Lab on port 8888
pyproject.toml                 — Python package config (Hatchling)
package.json                   — npm manifest; authoritative version source
```

## Naming conventions

- Directories: kebab-case — exception: `icos_ext/` uses underscores
  because Python import names cannot contain hyphens.
- Files: snake_case.
- The DOM identifier `icos-splash` (used in `src/splash.ts`,
  `src/sidebar.ts` and `style/index.css`) is intentionally kept as-is; do
  not rename it.

## Common commands

```bash
# Local development in Docker — Lab at http://localhost:8888/lab
docker compose up --build

# Install in dev mode
pip install -e "."
jupyter labextension develop . --overwrite

# Install npm dependencies
jlpm install

# Build
jlpm build           # dev build (with source maps)
jlpm build:prod      # production build

# Watch mode — run in two separate terminals
jlpm watch
jupyter lab

# Lint
jlpm lint            # fix lint issues
jlpm lint:check      # check only (no writes)

# Bump version (syncs package.json <-> _version.py via hatch-nodejs-version)
hatch version <new-version>

# Build distributable wheel and sdist
jlpm clean:all
python -m build      # outputs dist/icos_ext-*.whl and .tar.gz
```

## Hard rules

- **Never edit `icos_ext/_version.py`** — it is auto-generated by
  Hatchling on every build.
- **Never edit files inside `icos_ext/labextension/`** — this
  directory is a build artifact regenerated by `jlpm build:prod`.
- **Always bump the version via `hatch version`**, not by editing
  `package.json` or `_version.py` directly.
- **`jlpm` is not on `PATH` in every environment** — it comes with a
  JupyterLab install. Where it is missing, run the local binaries under
  `./node_modules/.bin/` (`tsc`, `eslint`, `prettier`, `stylelint`,
  `webpack`) directly.
- Plugin IDs follow the `@icos-ext/<plugin-name>` convention.

## Commit messages

One line, and nothing else. Lowercase `area - summary`, under 72
characters, no body, no bullet list, no trailers — including no
AI-attribution line. Recent examples:

```text
tsconfig - drop the unused jsx option
docker - open lab without a token, on localhost only
```

## Comments

A comment earns its place only if deleting it would let a later edit
re-break something, or if it records a fact from outside the file — a
browser quirk, a JupyterLab or Lumino internal, a value in
`style/index.css`, something the server does or does not send. Anything
that restates the code is deleted, however well written.

- No section banner comments at the top of a file. The filename says it.
- No archaeology. Describe the constraint that holds now, not a bug that
  used to exist, and put the comment on the line it concerns.
- `src/` sits at roughly 7% comment-to-code. That is the intended level.

## Documentation

No em dashes in anything a reader opens: `README.md`, `docs/freeze.md`,
and the README, compose file, `.dockerignore` and Dockerfile comments
that a freeze package generates. Use a colon, a comma or a second
sentence instead, never `--`. Code comments and docstrings keep the em
dash.

Keep `README.md` short. Detail belongs in `docs/`.
