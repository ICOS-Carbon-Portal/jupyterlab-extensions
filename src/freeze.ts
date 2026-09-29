import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { Dialog, InputDialog, showDialog } from '@jupyterlab/apputils';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { Widget } from '@lumino/widgets';
import { PageConfig } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

interface IFreezeRequirement {
  name: string;
}

interface IFreezePackage {
  name: string;
  version: string | null;
  source: string;
}

interface IFreezeNotebook {
  name: string;
  packages?: IFreezePackage[];
}

interface IFreezeNotebookInstall {
  name: string;
  packages?: string[];
}

interface IFreezeConflict {
  package: string;
  notebook: string;
  notebook_version: string | null;
  requirements_file: string;
  requirements_version: string | null;
}

interface IFreezeEnvPackage {
  name: string;
  installed_version: string | null;
  manager: string | null;
}

interface IFreezeSnapshot {
  path: string;
  image: string | null;
  requirements?: IFreezeRequirement[];
  notebooks?: IFreezeNotebook[];
  conflicts?: IFreezeConflict[];
  dockerfile_blocked?: string | null;
  notebook_installs?: IFreezeNotebookInstall[];
  python_version?: string;
  provenance_method?: string;
  user_installed?: IFreezeEnvPackage[];
  missing?: string[];
  dockerfile_written?: string | null;
  bundle_available?: boolean;
}

interface IFreezeBundleBlocked {
  reason?: string;
}

interface IReport {
  node: HTMLDivElement;
  addLine: (text: string) => void;
  addHeading: (text: string, color?: string) => void;
  addConflictLine: (text: string) => void;
  append: (child: HTMLElement) => void;
}

// The server's `provenance_method` is either this, an exact baseline
// recorded at image build, or a guess read from file timestamps.
const BASELINE_PROVENANCE = 'baseline';

const warnColor = 'var(--jp-warn-color1, #d9822b)';

const unreachableMessage = (verb: string, target: string) =>
  'Could not reach the server to ' +
  verb +
  ' "' +
  (target || '/') +
  '". Check that you are still connected and try again.';

// HTTP/2 dropped the reason phrase, so statusText is usually empty and
// appending it unconditionally would give "(HTTP 500 )".
const httpFailureMessage = (verb: string, target: string, response: Response) =>
  'The server could not ' +
  verb +
  ' "' +
  (target || '/') +
  '" (HTTP ' +
  response.status +
  (response.statusText ? ' ' + response.statusText : '') +
  ').';

const logUnreadable = (url: string, error: unknown) =>
  console.error('Freeze: could not read the response from ' + url, error);

const logHttpFailure = (url: string, response: Response) =>
  console.error(
    'Freeze: ' +
      url +
      ' returned ' +
      response.status +
      ' ' +
      response.statusText
  );

const freezeRequest = async (
  url: string,
  init: RequestInit
): Promise<Response | null> => {
  try {
    return await ServerConnection.makeRequest(
      url,
      init,
      ServerConnection.makeSettings()
    );
  } catch (error) {
    console.error('Freeze: could not reach ' + url, error);
    return null;
  }
};

const statusWriter = (node: HTMLElement) => (text: string, warn?: boolean) => {
  node.textContent = text;
  node.style.color = warn ? warnColor : '';
  node.style.fontWeight = warn ? 'bold' : '';
};

const formatVersion = (value: string | null) => value || 'unspecified';

const formatPackageList = (packages: string[]): string => {
  if (packages.length === 0) {
    return 'its packages';
  }
  if (packages.length === 1) {
    return packages[0];
  }
  return (
    packages.slice(0, -1).join(', ') + ' and ' + packages[packages.length - 1]
  );
};

// The server names the zip in Content-Disposition; an unparseable header
// falls back to a plain name rather than failing the download.
const filenameFrom = (disposition: string | null) => {
  const match = /filename="?([^";]+)"?/i.exec(disposition || '');
  const name = match ? match[1].trim() : '';
  return name || 'frozen-package.zip';
};

const createReport = (): IReport => {
  const body = document.createElement('div');
  body.style.maxHeight = '300px';
  body.style.overflow = 'auto';
  body.style.whiteSpace = 'pre-wrap';

  // The report scrolls but often holds nothing focusable, so without this
  // a keyboard user cannot reach the scroll container.
  body.tabIndex = 0;

  const addLine = (text: string) => {
    const line = document.createElement('div');
    line.textContent = text;
    body.appendChild(line);
  };

  const addHeading = (text: string, color?: string) => {
    const heading = document.createElement('div');
    heading.textContent = text;
    heading.style.fontWeight = 'bold';
    heading.style.marginTop = body.firstChild ? '12px' : '0';
    heading.style.marginBottom = '2px';
    heading.style.borderBottom = '1px solid var(--jp-border-color2, #bdbdbd)';
    if (color) {
      heading.style.color = color;
    }
    body.appendChild(heading);
  };

  const addConflictLine = (text: string) => {
    const line = document.createElement('div');
    line.textContent = text;
    line.style.color = warnColor;
    line.style.fontWeight = 'bold';
    body.appendChild(line);
  };

  return {
    node: body,
    addLine,
    addHeading,
    addConflictLine,
    append: (child: HTMLElement) => body.appendChild(child)
  };
};

// Nothing is sent to the server: picking a version only prints an edit.
const addConflictBlock = (report: IReport, conflict: IFreezeConflict) => {
  const block = document.createElement('div');
  block.style.marginBottom = '8px';

  const summary = document.createElement('div');
  summary.textContent =
    conflict.package +
    ' — ' +
    conflict.notebook +
    ' wants ' +
    formatVersion(conflict.notebook_version) +
    ', ' +
    conflict.requirements_file +
    ' wants ' +
    formatVersion(conflict.requirements_version);
  summary.style.color = warnColor;
  summary.style.fontWeight = 'bold';

  const choices = document.createElement('div');
  choices.style.display = 'flex';
  choices.style.flexWrap = 'wrap';
  choices.style.gap = '6px';
  choices.style.marginTop = '4px';

  const instruction = document.createElement('div');
  instruction.style.marginTop = '4px';
  instruction.setAttribute('role', 'status');

  block.appendChild(summary);
  block.appendChild(choices);
  block.appendChild(instruction);
  report.append(block);

  const choiceButtons: HTMLButtonElement[] = [];

  const addChoice = (version: string, fromFile: string, otherFile: string) => {
    const button = document.createElement('button');
    button.className = 'jp-mod-styled';
    button.textContent = 'Keep ' + version + ' (' + fromFile + ')';
    button.setAttribute('aria-pressed', 'false');

    button.addEventListener('click', () => {
      choiceButtons.forEach(other => {
        other.style.color = '';
        other.style.fontWeight = '';
        other.style.borderColor = '';
        other.setAttribute('aria-pressed', 'false');
      });
      button.style.color = 'var(--jp-brand-color1)';
      button.style.fontWeight = 'bold';
      button.style.borderColor = 'var(--jp-brand-color1)';
      button.setAttribute('aria-pressed', 'true');
      instruction.textContent =
        'To keep ' +
        version +
        ': edit ' +
        otherFile +
        ' and change the ' +
        conflict.package +
        ' pin to ' +
        version;
    });
    choiceButtons.push(button);
    choices.appendChild(button);
  };

  if (conflict.notebook_version) {
    addChoice(
      conflict.notebook_version,
      conflict.notebook,
      conflict.requirements_file
    );
  }

  if (conflict.requirements_version) {
    addChoice(
      conflict.requirements_version,
      conflict.requirements_file,
      conflict.notebook
    );
  }
};

const renderConflicts = (report: IReport, conflicts: IFreezeConflict[]) => {
  if (conflicts.length === 0) {
    report.addHeading('Conflicts');
    report.addLine('No version conflicts found.');
  } else {
    report.addHeading('Conflicts (' + conflicts.length + ')', warnColor);
    conflicts.forEach(conflict => addConflictBlock(report, conflict));
  }
};

const renderDockerfile = (
  report: IReport,
  snapshot: IFreezeSnapshot,
  directory: string,
  conflicts: IFreezeConflict[]
) => {
  report.addHeading('Dockerfile');

  const dockerfileWritten = snapshot.dockerfile_written;

  if (dockerfileWritten === 'written') {
    report.addLine('The Dockerfile was written into "' + directory + '".');
  } else if (dockerfileWritten === 'unchanged') {
    report.addLine(
      'The Dockerfile in "' +
        directory +
        '" is already up to date, so nothing was rewritten.'
    );
  } else if (dockerfileWritten === 'skipped_foreign') {
    report.addConflictLine(
      '"' +
        directory +
        '" already has a hand-written Dockerfile, which was left ' +
        'alone. The generated Dockerfile was not saved.'
    );
  } else if (dockerfileWritten === 'error') {
    report.addConflictLine(
      'The Dockerfile could not be written into "' +
        directory +
        '". The server log has the reason.'
    );
  } else {
    const notebookInstalls = snapshot.notebook_installs || [];

    // Conflicts are checked first because _dockerfile_block_reason checks
    // them first: a directory with both is blocked on the conflict.
    if (conflicts.length === 0 && notebookInstalls.length > 0) {
      report.addConflictLine('Changes needed before this can be frozen:');

      notebookInstalls.forEach(install => {
        const line = document.createElement('div');
        line.style.color = warnColor;

        const name = document.createElement('span');
        name.textContent = install.name;
        name.style.fontWeight = '600';
        line.appendChild(name);

        line.appendChild(
          document.createTextNode(
            ' — move ' +
              formatPackageList(install.packages || []) +
              ' into requirements.txt'
          )
        );

        report.append(line);
      });

      report.addLine('Install them in this environment, then freeze again.');
    } else {
      // The server leaves dockerfile_written null only when it refused,
      // and every refusal carries its reason.
      if (snapshot.dockerfile_blocked) {
        report.addConflictLine(snapshot.dockerfile_blocked);
      }
      report.addLine(
        'Fix the files in this directory and freeze again to get a ' +
          'Dockerfile.'
      );
    }
  }
};

// The caller owns the button and re-enables it when this settles.
const downloadBundle = async (
  path: string,
  setStatus: (text: string, warn?: boolean) => void
) => {
  setStatus('Preparing the package.');

  const bundleUrl =
    PageConfig.getBaseUrl() +
    'icos-ext/bundle?path=' +
    encodeURIComponent(path);

  const response = await freezeRequest(bundleUrl, { method: 'GET' });
  if (!response) {
    setStatus(unreachableMessage('package', path), true);
    return;
  }

  if (response.status === 409) {
    let blocked: IFreezeBundleBlocked;
    try {
      blocked = (await response.json()) as IFreezeBundleBlocked;
    } catch (error) {
      logUnreadable(bundleUrl, error);
      setStatus(
        'The server refused to make the package and sent a reason ' +
          'that could not be read.',
        true
      );
      return;
    }

    setStatus(
      blocked.reason || 'The server cannot package this directory.',
      true
    );
    return;
  }

  if (!response.ok) {
    logHttpFailure(bundleUrl, response);
    setStatus(httpFailureMessage('package', path, response), true);
    return;
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (error) {
    console.error(
      'Freeze: could not read the package sent by ' + bundleUrl,
      error
    );
    setStatus('The package could not be read from the server response.', true);
    return;
  }

  const filename = filenameFrom(response.headers.get('Content-Disposition'));
  const savedCopy = response.headers.get('X-Icos-Freeze-Saved');

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoking in the same task has been enough to abort the queued
  // download in Firefox and Safari, so the URL is released in a later one.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);

  setStatus(
    'Downloaded "' +
      filename +
      '".' +
      (savedCopy ? ' A copy was also saved into the directory.' : '')
  );
};

const renderPackage = (
  report: IReport,
  bundleAvailable: boolean | undefined,
  snapshotPath: string
) => {
  report.addHeading('Package');

  if (bundleAvailable === true) {
    report.addLine(
      'The package holds the Dockerfile, the notebooks, the dependency ' +
        'files and instructions for a tester.'
    );

    const packageButton = document.createElement('button');
    packageButton.type = 'button';
    packageButton.className = 'jp-Dialog-button jp-mod-accept jp-mod-styled';
    packageButton.textContent = 'Download package';
    report.append(packageButton);

    const packageStatus = document.createElement('div');
    packageStatus.style.marginTop = '4px';
    packageStatus.setAttribute('role', 'status');
    report.append(packageStatus);

    const setPackageStatus = statusWriter(packageStatus);

    // `finally` brings the button back however the attempt ended.
    packageButton.addEventListener('click', () => {
      packageButton.disabled = true;
      void downloadBundle(snapshotPath, setPackageStatus).finally(() => {
        packageButton.disabled = false;
      });
    });
  } else {
    report.addLine(
      'No package can be made until the Dockerfile problem above is fixed.'
    );
  }
};

const renderMissing = (report: IReport, missing: string[]) => {
  if (missing.length > 0) {
    report.addHeading('Not installed (' + missing.length + ')', warnColor);
    missing.forEach(name => report.addConflictLine('  ' + name));
    report.addLine(
      'These packages are imported by the notebooks but are not ' +
        'installed in this environment, so the build cannot reproduce ' +
        'them.'
    );
  }
};

const renderEnvironment = (report: IReport, snapshot: IFreezeSnapshot) => {
  report.addHeading('Environment');
  report.addLine(
    snapshot.image
      ? 'Image: ' + snapshot.image
      : 'No image spec reported by the server'
  );
  if (snapshot.python_version) {
    report.addLine('Python: ' + snapshot.python_version);
  }

  const userInstalled = snapshot.user_installed || [];
  if (userInstalled.length === 0) {
    report.addLine(
      'Nothing was installed on top of the image, so the image digest ' +
        'alone reproduces this environment.'
    );
  } else {
    report.addLine(
      userInstalled.length +
        ' package' +
        (userInstalled.length === 1 ? '' : 's') +
        ' installed on top of the image:'
    );
    userInstalled.forEach(pkg =>
      report.addLine(
        '  ' +
          pkg.name +
          ' ' +
          (pkg.installed_version || 'unknown') +
          ' (' +
          (pkg.manager || 'unknown') +
          ')'
      )
    );
  }

  // Timestamps cannot tell a late layer of the image's own build from a
  // user install, so the generated Dockerfile's caveat is repeated here.
  if (
    snapshot.provenance_method &&
    snapshot.provenance_method !== BASELINE_PROVENANCE
  ) {
    report.addLine(
      'This was read from file timestamps rather than a package baseline, ' +
        'so it may include packages the image already ships and miss some ' +
        'that were installed on top of it.'
    );
  }
};

const renderDependencyFiles = (
  report: IReport,
  requirements: IFreezeRequirement[]
) => {
  report.addHeading('Dependency files');
  if (requirements.length === 0) {
    report.addLine('No dependency files found in this directory.');
  } else {
    requirements.forEach(file => report.addLine('  ' + file.name));
  }
};

const renderNotebooks = (report: IReport, notebooks: IFreezeNotebook[]) => {
  report.addHeading('Notebooks');
  if (notebooks.length === 0) {
    report.addLine('No notebooks found in this directory.');
  } else {
    notebooks.forEach(notebook => {
      const title = document.createElement('div');
      title.textContent = notebook.name;
      title.style.fontWeight = '600';
      title.style.marginTop = '4px';
      report.append(title);

      const packages = notebook.packages || [];
      if (packages.length === 0) {
        report.addLine('  no packages found');
      } else {
        packages.forEach(pkg =>
          report.addLine(
            '  ' +
              pkg.name +
              (pkg.version ? ' ' + pkg.version : '') +
              ' (' +
              pkg.source +
              ')'
          )
        );
      }
    });
  }
};

const freeze: JupyterFrontEndPlugin<void> = {
  id: '@icos-ext/freeze',
  autoStart: true,
  requires: [IDefaultFileBrowser],
  activate: (app: JupyterFrontEnd, fileBrowser: IDefaultFileBrowser) => {
    // The button is built at the end of this activate, so these stay
    // null-checked: a palette freeze can run before the button exists.
    let freezeButtonNode: HTMLButtonElement | null = null;
    let freezeLabelNode: HTMLSpanElement | null = null;
    let freezeInFlight = false;

    // The ice is the primary signal that a freeze is running: the button's
    // own busy state is up in the top bar, out of view after a click.
    let freezeOverlayNode: HTMLDivElement | null = null;
    let freezeOverlayTextNode: HTMLDivElement | null = null;
    let freezeOverlayTimer: number | null = null;

    const FREEZE_PHRASES = [
      'Putting your notebooks on ice...',
      'Cryogenically preserving your code...',
      'Please remain calm. We are freezing it.',
      'Making these notebooks future-proof-ish...',
      'Teaching your notebooks to survive winter...',
      'Preserving bugs for future generations...',
      'Saving the chaos...',
      "Making 'works on my machine' everyone's problem...",
      'Putting the environment in a time capsule...',
      'Preparing for future archaeologists...',
      'No sudden movements. Dependencies are fragile.',
      'Preparing your notebooks for immortality...',
      'Your notebooks are entering the freezer.',
      'Do not disturb. Notebooks hibernating.'
    ];

    const freezePhrase = (): string =>
      FREEZE_PHRASES[Math.floor(Math.random() * FREEZE_PHRASES.length)];

    const ensureFreezeOverlay = (): HTMLDivElement => {
      if (freezeOverlayNode) {
        return freezeOverlayNode;
      }

      const overlay = document.createElement('div');
      overlay.id = 'icos-freeze-overlay';
      overlay.setAttribute('role', 'status');
      overlay.setAttribute('aria-live', 'polite');

      const frost = document.createElement('div');
      frost.className = 'icos-freeze-overlay-frost';
      frost.setAttribute('aria-hidden', 'true');
      overlay.appendChild(frost);

      // One node, drift entirely in the stylesheet: nothing runs per frame.
      const blizzard = document.createElement('div');
      blizzard.className = 'icos-freeze-overlay-blizzard';
      blizzard.setAttribute('aria-hidden', 'true');
      overlay.appendChild(blizzard);

      const text = document.createElement('div');
      text.className = 'icos-freeze-overlay-text';
      text.textContent = freezePhrase();
      overlay.appendChild(text);
      freezeOverlayTextNode = text;

      freezeOverlayNode = overlay;
      return overlay;
    };

    // transitionend is not guaranteed: the stylesheet drops the transition
    // under prefers-reduced-motion, a background tab may never run it, and
    // an interrupted one is dropped — so a timeout backs it up.
    const cancelFreezeOverlayTeardown = () => {
      if (freezeOverlayTimer !== null) {
        window.clearTimeout(freezeOverlayTimer);
        freezeOverlayTimer = null;
      }
      if (freezeOverlayNode) {
        freezeOverlayNode.removeEventListener(
          'transitionend',
          onFreezeOverlayTransitionEnd
        );
      }
    };

    const removeFreezeOverlay = () => {
      cancelFreezeOverlayTeardown();

      // A freeze started again during the fade out re-adds the class.
      if (
        freezeOverlayNode &&
        !freezeOverlayNode.classList.contains('is-visible')
      ) {
        freezeOverlayNode.remove();
      }
    };

    // One function for the life of the plugin: re-registering the same
    // listener on the same node is a no-op, and the node is reused.
    const onFreezeOverlayTransitionEnd = (event: TransitionEvent) => {
      if (
        event.target === freezeOverlayNode &&
        event.propertyName === 'opacity'
      ) {
        removeFreezeOverlay();
      }
    };

    const setFreezeOverlay = (visible: boolean) => {
      // Any pending teardown from the previous freeze is now stale.
      cancelFreezeOverlayTeardown();

      if (visible) {
        const overlay = ensureFreezeOverlay();

        if (!overlay.isConnected) {
          // document.body, not the shell: the ice covers the menu bar too.
          document.body.appendChild(overlay);
        }

        // The node is reused between freezes, so the line is redrawn here.
        if (freezeOverlayTextNode) {
          freezeOverlayTextNode.textContent = freezePhrase();
        }

        document.body.setAttribute('aria-busy', 'true');

        // In the insert's own frame there is no earlier opacity to
        // transition from and the ice would snap in, so the class lands later.
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (freezeOverlayNode === overlay && overlay.isConnected) {
              overlay.classList.add('is-visible');
            }
          });
        });
        return;
      }

      document.body.removeAttribute('aria-busy');

      const overlay = freezeOverlayNode;
      if (!overlay) {
        return;
      }

      // Dropping the class stops the overlay taking the pointer: for the
      // 320ms of the fade it is a full-window sheet over live UI.
      overlay.classList.remove('is-visible');

      if (!overlay.isConnected) {
        return;
      }

      overlay.addEventListener('transitionend', onFreezeOverlayTransitionEnd);
      freezeOverlayTimer = window.setTimeout(removeFreezeOverlay, 600);
    };

    const setFreezeBusy = (busy: boolean) => {
      if (freezeButtonNode) {
        freezeButtonNode.classList.toggle('is-freezing', busy);
        freezeButtonNode.disabled = busy;
      }
      if (freezeLabelNode) {
        freezeLabelNode.textContent = busy ? 'Freezing…' : 'Freeze';
      }

      setFreezeOverlay(busy);
    };

    // The ice comes down before the dialog goes up: JupyterLab draws
    // dialogs at z-index 10000 and the overlay sits at 100000, so an error
    // shown while still busy would sit behind the frost, unclickable.
    const showFreezeError = (message: string) => {
      setFreezeBusy(false);

      return showDialog({
        title: 'Freeze',
        body: message,
        buttons: [Dialog.okButton()]
      });
    };

    const performSnapshot = async (path: string) => {
      const url =
        PageConfig.getBaseUrl() +
        'icos-ext/freeze?path=' +
        encodeURIComponent(path);

      const response = await freezeRequest(url, { method: 'GET' });
      if (!response) {
        await showFreezeError(unreachableMessage('freeze', path));
        return;
      }

      if (!response.ok) {
        logHttpFailure(url, response);
        await showFreezeError(httpFailureMessage('freeze', path, response));
        return;
      }

      let snapshot: IFreezeSnapshot;
      try {
        snapshot = (await response.json()) as IFreezeSnapshot;
      } catch (error) {
        logUnreadable(url, error);
        await showFreezeError(
          'The server sent a response that could not be read.'
        );
        return;
      }

      // The server echoes back the path it was asked for, not the directory
      // it walked, so this falls back to the requested path and then root.
      const snapshotPath = snapshot.path || path;
      const directory = snapshotPath || '/';
      const conflicts = snapshot.conflicts || [];

      const report = createReport();
      renderConflicts(report, conflicts);
      renderDockerfile(report, snapshot, directory, conflicts);
      renderPackage(report, snapshot.bundle_available, snapshotPath);
      renderMissing(report, snapshot.missing || []);
      renderEnvironment(report, snapshot);
      renderDependencyFiles(report, snapshot.requirements || []);
      renderNotebooks(report, snapshot.notebooks || []);

      // The freeze is over once the report is ready, so the button resets
      // here rather than when the dialog is dismissed.
      setFreezeBusy(false);

      await showDialog({
        title: 'Freeze: ' + directory,
        body: new Widget({ node: report.node }),
        buttons: [Dialog.okButton()]
      });
    };

    // The button and both palette commands all funnel through here, so a
    // second request cannot start while one is running. The finally is a
    // backstop: a throw would otherwise leave the button on "Freezing…".
    const captureSnapshot = async (path: string) => {
      if (freezeInFlight) {
        return;
      }

      freezeInFlight = true;
      setFreezeBusy(true);

      try {
        await performSnapshot(path);
      } finally {
        freezeInFlight = false;
        setFreezeBusy(false);
      }
    };

    app.commands.addCommand('icos-freeze:from-current', {
      label: 'Freeze from current directory',
      execute: () => captureSnapshot(fileBrowser.model.path)
    });

    app.commands.addCommand('icos-freeze:from-selected', {
      label: 'Freeze from selected directory',
      execute: async () => {
        const result = await InputDialog.getText({
          title: 'Freeze from selected directory',
          label: 'Directory path:',
          text: fileBrowser.model.path
        });
        if (result.button.accept && result.value !== null) {
          await captureSnapshot(result.value.trim());
        }
      }
    });

    // A real <button>: focus and Enter/Space activation come for free.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icos-freeze-button';
    button.title = 'Freeze the current file browser directory';

    const label = document.createElement('span');
    label.className = 'icos-freeze-label';
    label.textContent = 'Freeze';
    button.appendChild(label);

    freezeButtonNode = button;
    freezeLabelNode = label;

    // captureSnapshot dialogs everything it expects to go wrong; without
    // this, anything it did not would be a silent unhandled rejection.
    button.addEventListener('click', () => {
      void captureSnapshot(fileBrowser.model.path).catch(error =>
        console.error('Freeze: the freeze failed', error)
      );
    });

    const freezeButton = new Widget({ node: button });
    freezeButton.id = 'icos-freeze-button';

    // The shell adds the main menu bar to the top area at rank 100
    // (@jupyterlab/application/lib/shell.js), and the top area inserts with
    // ArrayExt.upperBound, so equal ranks land after. Rank 101 puts Freeze
    // right of the menu bar, well ahead of the shell's DEFAULT_RANK of 900.
    app.shell.add(freezeButton, 'top', { rank: 101 });
  }
};

export default freeze;
