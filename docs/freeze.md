# Freezing a notebook directory

Freeze turns a directory of notebooks into a package someone else can
build and run. They get your notebooks, your dependency files, and a
recipe that rebuilds the environment those notebooks ran in. They do not
need an ICOS hub account.

You describe what to install with a `requirements.txt` beside your
notebooks. See [requirements.txt is the contract](#requirementstxt-is-the-contract).

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
- whether the build files were written to `.icos-freeze/`, or why not
- a Download package button, once nothing is blocking the freeze, with
  a Package name field next to it where you make up a name for the
  package (see [The package name](#the-package-name))
- warnings where the image will differ from your session
- packages your notebooks import that are not installed here
- the base image and Python version this session runs on
- what you installed on top of that image, with versions
- the dependency files found, and each notebook with its packages

## requirements.txt is the contract

The `requirements.txt` in the folder you freeze says what goes on top
of the base image. The base image is the image your session runs on.

The Dockerfile starts from the base image and runs
`pip install -r requirements.txt`. The image gets exactly the versions
you pinned. What you happen to have installed in your session does not
matter to the build.

### The rules

Freeze is blocked until all of these hold:

- **The file exists.** No `requirements.txt` means no freeze. An empty
  file is fine: it means nothing goes on top of the image.
- **Every line is an exact pin.** Write `name==version`. Extras are
  fine, as in `pkg[extra]==1.0`. These are refused, and the report
  names the lines:
  - a name with no version, such as `seaborn`
  - ranges, such as `numpy>=1.26`
  - `-r`, `-e` and other options
  - URLs
  - environment markers, such as `; python_version < "3.12"`
- **Each package appears once.** A package pinned twice is refused.
- **What you installed yourself is listed.** If you ran `pip install`
  in your session, that package must be in the file. Packages it pulled
  in as dependencies do not need a line: pip installs them.
- **Changed image packages your notebooks use are listed.** If a
  notebook imports a package the image ships, and your session has a
  different version, pin it. This happens after something like
  `pip install -U numpy`.

The report says what to add. For example:

```text
rich is installed but not in requirements.txt. Add rich==13.7.0 and
freeze again.
```

```text
numpy 2.4.2 is newer than the image's 2.3.1, and analysis.ipynb imports
it. Add numpy==2.4.2 to requirements.txt and freeze again.
```

### Warnings

Some differences only warn. The freeze still goes ahead:

- a pinned version differs from the one in your session
- a pinned package is not installed in your session

For example:

```text
pandas: requirements.txt pins 2.3.1, but your notebooks ran with 3.0.1.
The image will have 2.3.1.
```

Warnings show in the freeze report, in `icos-freeze.json` under
`requirements_warnings`, and in the package README. If a result does
not reproduce, look there first.

### Other dependency files

Other files such as `environment.yml` or `requirements-dev.txt` are
still found, listed and packaged. They do not decide what gets
installed. Only `requirements.txt` does.

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

The fix is to move those packages into `requirements.txt` beside your
notebooks, as exact `name==version` pins, install them into your
environment, and freeze again.

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

- `Dockerfile`: the base image plus `requirements.txt`
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

## Where freeze writes

Freeze leaves your own files alone. Everything it makes goes into a
hidden folder, `.icos-freeze/`, inside the directory you froze:

- the `Dockerfile`, `.dockerignore` and `icos-freeze.json`
- copies of your notebooks and dependency files
- every zip you download, so you can hand one on again later without
  freezing a second time. Downloading again under the same name replaces
  that zip

That folder holds the same files as the zip, so the image can be built
straight from it:

```bash
docker build .icos-freeze
```

Each freeze refreshes the folder. A notebook you deleted from your
directory is removed from it too. Zips under other names are kept.

The file browser does not list folders whose names start with a dot,
so your directory looks unchanged. To see the folder, open a terminal
in that directory and run `ls -a`. JupyterLab also has View > Show
Hidden Files, but that item only appears when the server allows hidden
files.

## The package name

Type a name in the Package name field next to Download package. The
field starts empty, and you make the name up. The button stays disabled
until there is a name, and pressing Enter in the field also downloads.
The name becomes both the zip name, `<name>.zip`, and the Docker image
tag, `icos-frozen:<name>`, used in the package's compose file and README.

Because it is an image tag, the name is cleaned up: capitals become
lowercase, anything other than letters, digits and underscores becomes
`_`, and it is cut to 64 characters. `My Run 2` becomes `my_run_2`.

Neither the zip nor the tag carries a date or time. To keep two builds
apart, give them different names.

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

Then they compare `requirements.txt` against what the image reports:

```bash
docker run --rm <tag> pip list
```

The README writes the real image tag, `icos-frozen:<name>`, into that
command, so it can be pasted as it stands. The tester reads `requirements.txt` from the
unpacked package on their own machine. Every package in it should be in
that list, at the version it pins.
