# Freezing a notebook directory

Freeze turns a directory of notebooks into a package someone else can
build and run. They get your notebooks, your dependency files, and a
recipe that rebuilds the environment those notebooks ran in. They need
neither an ICOS hub account nor a list of what you installed.

## Freezing

The Freeze button sits in the top bar, just right of the menu bar. It
freezes whatever directory the file browser is showing.

Two commands do the same job under the names "Freeze from current
directory" and "Freeze from selected directory". The second one asks you
for a directory path first. They are registered but not listed in the
command palette yet, so for now the button is the way in.

While a freeze runs, the screen ices over and stops taking clicks. This
is normal: the server is reading every package in your environment, which
takes a few seconds. The ice clears when the report opens.

The report tells you:

- version conflicts between your notebooks and your dependency files
- whether the Dockerfile was written, or why it was refused
- a Download package button, once nothing is blocking the freeze
- packages your notebooks import that are not installed here
- the base image and Python version this session runs on
- what was installed on top of that image, with versions
- the dependency files found, and each notebook with its packages

## Install cells stop a freeze

Freeze refuses to run when a notebook installs packages from inside a
cell. This is the most common reason a freeze is blocked.

A cell line is caught when it starts with `!` or `%`, then `pip`, `pip3`,
`conda` or `mamba`, then `install`. For example:

```text
!pip install pandas
%conda install xarray
```

A package installed from inside a notebook is invisible to anyone
rebuilding the environment. The image and the requirement files no longer
describe what the notebook needs, so the person you hand it to would
build something that cannot run your work.

The fix is to move those packages into a `requirements.txt` beside your
notebooks, pinned to a version, install them into your environment, and
freeze again.

Before, in a notebook cell:

```text
!pip install pandas==2.2.2
```

After, in `requirements.txt`:

```text
pandas==2.2.2
```

Be aware of what the check does not see. It reads the text of your
notebooks and nothing else. An install hidden behind `subprocess`, one
written as `!python -m pip install`, or a command assembled in a variable
all slip past it, and it does not care whether the cell was ever run.
Those installs still break a rebuild. They are simply not caught.

The report lists one line per notebook, naming the packages to move.

## Other reasons a freeze is refused

A version conflict stops a freeze: a notebook pins a package to one exact
version and a dependency file in the same directory pins it to another.
The report shows each conflict with a button per version, so you can see
the exact edit that settles it.

A server that does not report which image it is running also stops a
freeze. Without the base image there is nothing to build on. If you see
this on the ICOS hub, report it.

## What you get

The package is a zip holding:

- `Dockerfile`: rebuilds the environment
- `.dockerignore`: what to leave out of the build
- `docker-compose.yml`: builds and runs it with one command
- `icos-freeze.json`: what was frozen, and from which image
- `README.md`: the commands the tester runs
- your notebooks
- your dependency files

The image that gets built holds only the notebooks and their dependency
files. The `Dockerfile`, the `.dockerignore`, `docker-compose.yml`,
`icos-freeze.json`, the README and any zip are all kept out of it: they
say how the image is built, or record what was frozen, so they mean
nothing to anything running inside it.

The same zip is saved into the frozen directory, so you can hand it on
again later without freezing a second time. The `Dockerfile`, the
`.dockerignore` and `icos-freeze.json` are also left beside your
notebooks, so the image can be built straight from that directory.

## Giving it to a tester

Send the zip. The tester unpacks it and runs this from the unpacked
directory:

```bash
docker compose up --build
```

JupyterLab is then at `http://localhost:8899/lab`. It asks for no
token, and it listens on this machine only. The notebooks are at
`/home/jovyan/work` inside the container.

The check itself is done by hand, and the README in the package spells
it out. The tester opens the notebooks in the running container and runs
each one top to bottom. Nothing should have to be installed along the
way: an install line such as `%pip install ...` that actually fetches a
package means the image is missing it, and the freeze needs doing again.

Then they compare the packages listed under `user_installed` in
`icos-freeze.json` against what the image reports:

```bash
docker run --rm <tag> pip list
```

The README writes the real image tag into that command, so it can be
pasted as it stands. The manifest is read from the unpacked package on
the tester's own machine, not from inside the container. The image does
not carry it. Every package under `user_installed` should be in that
list, at the version the manifest records.
