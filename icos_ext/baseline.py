"""Record what the image ships, so a user install can be told apart.

The freeze feature has to separate the packages a user installed at
runtime from the ones the image was built with. File timestamps cannot
do that: the repository's own Dockerfile installs its build toolchain
and the extension itself in a pip layer that runs after the base
image's conda packages, so those carry later mtimes than everything
around them and look exactly like a runtime install.

Writing down what is installed at the end of the image build removes
the guesswork. Anything present later that the record does not have, or
has at a different version, was put there by the user.

This module deliberately imports nothing beyond the standard library:
"python -m icos_ext.baseline" runs during the image build, and must not
depend on jupyter_server or tornado being importable at that point.
"""

import datetime
import importlib.metadata
import json
import logging
import os
import platform
import re
import sys
from pathlib import Path

log = logging.getLogger(__name__)

# Bumped whenever the document written below changes shape. A baseline
# carrying any other version is ignored rather than misread.
BASELINE_SCHEMA_VERSION = 1

# Lets a deployment relocate the baseline, for instance when the
# environment prefix is read-only at build time.
BASELINE_ENV_VAR = "ICOS_EXT_BASELINE"

# Relative to the environment prefix; see baseline_path().
BASELINE_RELATIVE_PATH = ("share", "icos-ext", "baseline.json")

# Where conda records what it linked into the running environment.
CONDA_META_DIRNAME = "conda-meta"


def _normalise_name(name):
    """Return *name* the way Python packaging compares project names."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _utc_now():
    """Return the current UTC time as a second-resolution ISO-8601 stamp."""
    now = datetime.datetime.now(datetime.timezone.utc)
    return now.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _path_mtime(path):
    """Return the mtime of *path*, or None when it cannot be read."""
    if path is None:
        return None
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _conda_records(conda_meta):
    """Return {normalised name: (version, mtime)} for conda-linked packages.

    Every package conda links into an environment leaves one
    "<name>-<version>-<build>.json" record in conda-meta/. Only the file
    name and its mtime are read: the records themselves run to tens of
    megabytes on a data-science image, and the "timestamp" field inside
    one is when the package was built upstream, not when it was
    installed here — on conda-forge certifi 2026.2.25 that field says
    2026-02-25 while the record was written on 2026-03-31.

    Returns None when the directory cannot be listed, which means the
    interpreter is not running inside a conda environment.
    """
    records = {}
    try:
        with os.scandir(conda_meta) as entries:
            for entry in entries:
                if not entry.name.endswith(".json"):
                    continue
                # Build strings never contain "-", so splitting from the
                # right keeps hyphenated names such as "scikit-learn".
                parts = entry.name[: -len(".json")].rsplit("-", 2)
                if len(parts) != 3:
                    continue
                name, version, _build = parts
                try:
                    mtime = entry.stat().st_mtime
                except OSError:
                    mtime = None
                records[_normalise_name(name)] = (version, mtime)
    except OSError as e:
        log.warning("Freeze: cannot read %s: %s", conda_meta, e)
        return None

    return records


def _installed_distributions():
    """Return {normalised name: (name, version, mtime)} for installed packages.

    The mtime is that of the ".dist-info" directory, which is when pip
    or conda wrote the package into this environment. Reading it needs
    importlib.metadata's private "_path", so it degrades to None rather
    than failing when a distribution does not expose one.
    """
    distributions = getattr(importlib.metadata, "distributions", None)
    if distributions is None:
        log.warning("Freeze: this runtime cannot list installed packages")
        return {}

    found = {}
    for dist in distributions():
        try:
            name = dist.metadata["Name"]
            version = dist.version
        except Exception as e:
            # One unreadable or half-removed distribution must not cost
            # us the whole scan.
            log.warning("Freeze: skipping an unreadable package: %s", e)
            continue

        if not isinstance(name, str) or not name:
            continue

        key = _normalise_name(name)
        if key in found:
            continue
        found[key] = (
            name,
            version if isinstance(version, str) else None,
            _path_mtime(getattr(dist, "_path", None)),
        )

    return found


def environment_prefix():
    """Return the prefix of the environment this interpreter runs in.

    CONDA_PREFIX is only exported once an environment has been
    activated, which a plain Docker "RUN" step does not do, so
    sys.prefix carries it there.
    """
    return Path(os.environ.get("CONDA_PREFIX") or sys.prefix)


def scan_packages():
    """Return what is installed in the environment, in one pass.

    The result has three keys:

    "packages"   — {normalised name: {"name", "version", "manager",
                    "mtime"}}, one entry per installed distribution.
                    "manager" is "conda" when conda linked the package
                    into the environment and "pip" otherwise.
    "timestamps" — every mtime seen, including those of conda packages
                    that ship no Python metadata, for the caller that
                    still has to date the image from them.
    "conda_meta" — the conda-meta directory that was read.

    The walk over conda-meta/ and every ".dist-info" directory is the
    expensive part of a freeze, so it is done once here and the result
    passed around rather than repeated per package.
    """
    conda_meta = environment_prefix() / CONDA_META_DIRNAME

    records = _conda_records(conda_meta)
    if records is None:
        log.warning(
            "Freeze: no conda records under %s, every package will be "
            "reported as pip-managed",
            conda_meta,
        )
        records = {}

    distributions = _installed_distributions()

    timestamps = [mtime for _, mtime in records.values()]
    timestamps.extend(mtime for _, _, mtime in distributions.values())

    packages = {}
    for key, (name, version, dist_mtime) in distributions.items():
        record = records.get(key)
        if record is None:
            manager = "pip"
            mtime = dist_mtime
        else:
            manager = "conda"
            mtime = record[1]

        packages[key] = {
            "name": name,
            "version": version,
            "manager": manager,
            "mtime": mtime,
        }

    return {
        "packages": packages,
        "timestamps": timestamps,
        "conda_meta": conda_meta,
    }


def baseline_path():
    """Return the file the baseline is written to and read from.

    The default sits under the environment prefix — /opt/conda on the
    deployed image. That directory is baked into the image, is not a
    bind mount and is not a named volume, so a baseline written during
    the build is still there, unchanged, in every container started from
    the image. The user's own storage (/home/jovyan/work) is mounted
    over at runtime and /tmp does not survive a restart, so neither can
    hold it.

    ICOS_EXT_BASELINE overrides the whole path for deployments that keep
    the environment read-only or lay it out differently.
    """
    override = os.environ.get(BASELINE_ENV_VAR)
    if override:
        return Path(override)
    return environment_prefix().joinpath(*BASELINE_RELATIVE_PATH)


def capture():
    """Return the baseline document for what is installed right now.

    Versions come from the same scan the freeze endpoint uses, so a
    package that has not been touched compares equal on both sides.
    """
    packages = {
        key: {
            "name": package["name"],
            "version": package["version"],
            "manager": package["manager"],
        }
        for key, package in scan_packages()["packages"].items()
    }

    return {
        "schema_version": BASELINE_SCHEMA_VERSION,
        "captured": _utc_now(),
        "python_version": platform.python_version(),
        "packages": packages,
    }


def write_baseline(document, path=None):
    """Write *document* as JSON to *path*; return the path written.

    Raises OSError when the file cannot be written, so the image build
    that calls this fails instead of shipping without a baseline.
    """
    target = Path(path) if path is not None else baseline_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(document, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return target


def read_baseline(path=None):
    """Return the baseline document, or None when there is not a usable one.

    A missing file is the normal case for an image built before this
    existed, and a corrupt or unknown-schema file must not take the
    freeze down with it: both come back as None with a "Freeze:"
    warning, and the caller falls back to the timestamp heuristic.
    """
    target = Path(path) if path is not None else baseline_path()

    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        log.warning(
            "Freeze: no package baseline at %s, falling back to timestamps",
            target,
        )
        return None
    except (OSError, ValueError) as e:
        log.warning("Freeze: cannot read the package baseline: %s", e)
        return None

    try:
        document = json.loads(raw)
    except ValueError as e:
        log.warning("Freeze: the package baseline is not valid JSON: %s", e)
        return None

    if not isinstance(document, dict):
        log.warning("Freeze: the package baseline is not a JSON object")
        return None

    version = document.get("schema_version")
    if version != BASELINE_SCHEMA_VERSION:
        log.warning(
            "Freeze: the package baseline has schema version %r, expected %r",
            version,
            BASELINE_SCHEMA_VERSION,
        )
        return None

    packages = document.get("packages")
    if not isinstance(packages, dict) or not packages:
        log.warning("Freeze: the package baseline lists no packages")
        return None

    known = {}
    for key, package in packages.items():
        if not isinstance(key, str) or not isinstance(package, dict):
            continue
        known[_normalise_name(key)] = {
            "name": package.get("name"),
            "version": package.get("version"),
            "manager": package.get("manager"),
        }

    if not known:
        log.warning("Freeze: the package baseline holds no readable entries")
        return None

    document["packages"] = known
    return document


def main():
    """Write the baseline; return a shell exit status."""
    try:
        document = capture()
    except OSError as e:
        print(f"Freeze: cannot scan the environment: {e}", file=sys.stderr)
        return 1

    count = len(document["packages"])
    if not count:
        # An empty baseline would classify the whole image as
        # user-installed, which is worse than having none at all.
        print(
            "Freeze: found no installed packages, refusing to write an "
            "empty baseline",
            file=sys.stderr,
        )
        return 1

    try:
        target = write_baseline(document)
    except OSError as e:
        print(f"Freeze: cannot write the baseline: {e}", file=sys.stderr)
        return 1

    print(f"Freeze: wrote {target} with {count} packages.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
