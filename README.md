# icos-ext

A JupyterLab extension for the ICOS Carbon Portal.

## What it does

- **Splash** (`@icos-ext/splash`): replaces the JupyterLab startup
  screen with an animated ICOS Carbon Portal one.
- **Sidebar** (`@icos-ext/sidebar`): adds an "ICOS HUB" tab to the
  left sidebar that opens the hub home page in a new tab, with a short
  popup pointing at it.
- **Tracker** (`@icos-ext/tracker`): reports every notebook cell run
  to Matomo, so the portal can see how notebooks are used.
- **Freeze** (`@icos-ext/freeze`): a Freeze button in the top bar
  turns a notebook directory into a package someone else can build and
  run. See [Freezing a notebook directory](docs/freeze.md).

## Requirements

- Python >= 3.8
- JupyterLab >= 4.0, < 5
- `jupyter_server` >= 2.0

## Install

```bash
pip install git+https://github.com/ICOS-Carbon-Portal/jupyterlab-extensions.git
```

## Local development

### With Docker

This builds a Lab container from the source in this repository and
mounts `demo/` at `/home/jovyan/freeze_demo`, so there is something to
freeze:

```bash
docker compose up --build
```

Lab is then at `http://localhost:8888/lab`. It asks for no token, and
it is bound to the loopback, so only this machine can reach it.

### Without Docker

You need Node.js 20.19 or newer and JupyterLab 4. The build fails on
older Node versions, such as 18. JupyterLab brings `jlpm`, its pinned
copy of Yarn; the build uses it, and so does your editor to find the
extension's types. The JupyterLab version below matches the one the
ICOS hub image runs.

```bash
pip install "jupyterlab==4.5.6"
jlpm install
pip install -e "."
jupyter labextension develop . --overwrite
jlpm build
```

To rebuild as you edit, run `jlpm watch` in one terminal and
`jupyter lab` in another.
