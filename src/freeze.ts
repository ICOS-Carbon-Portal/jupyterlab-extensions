import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { Dialog, InputDialog, showDialog } from '@jupyterlab/apputils';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { Widget } from '@lumino/widgets';
import { PageConfig } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/* ------------------------------------------
   Freeze (top menu bar item)
------------------------------------------- */

interface IFreezeRequirement {
  name: string;
}

interface IFreezePackage {
  name: string;
  version: string | null;
  source: string;
}

// The optional members below are the ones the report reads with a
// `|| []` guard: they mirror a server payload, so the guard is real
// rather than dead code.
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

// The report the freeze dialog shows. Each section below is rendered
// by its own function, and they all only ever add to the end, so this
// is what they are handed instead of the element itself: the three
// line helpers are then written once rather than once per section.
// `append` is for the few places that build a node of their own.
interface IReport {
  node: HTMLDivElement;
  addLine: (text: string) => void;
  addHeading: (text: string, color?: string) => void;
  addConflictLine: (text: string) => void;
  append: (child: HTMLElement) => void;
}

// The server says a package was installed by the user either from the
// baseline the image build recorded, which is exact, or — when the
// image has no baseline — from file timestamps, which is a guess. The
// report has to say which, so this is the value that means "exact".
const BASELINE_PROVENANCE = 'baseline';

const warnColor = 'var(--jp-warn-color1, #d9822b)';

// The freeze and the package each report the same two failures in
// the same words — only the verb and the directory change — so that
// wording is written once here.
const unreachableMessage = (verb: string, target: string) =>
  'Could not reach the server to ' +
  verb +
  ' "' +
  (target || '/') +
  '". Check that you are still connected and try again.';

// HTTP/2 dropped the reason phrase, so statusText is an empty string
// on most servers now and appending it unconditionally would leave a
// dangling space inside the brackets: "(HTTP 500 )".
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

// Returns null when the request never reached the server. Where
// that gets reported is the caller's business: the freeze itself
// uses a dialog, the button in the report writes into its own
// status line.
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

// Both buttons further down report into a status line under
// themselves, in the same two looks: plain while something is
// happening, bold warn colour when it failed.
const statusWriter = (node: HTMLElement) => (text: string, warn?: boolean) => {
  node.textContent = text;
  node.style.color = warn ? warnColor : '';
  node.style.fontWeight = warn ? 'bold' : '';
};

const formatVersion = (value: string | null) => value || 'unspecified';

// "cartopy and pandas", "netCDF4, scipy and xarray". The user is
// being told to go and move these by hand, so the list is written
// the way the instruction would be spoken rather than as a bare
// comma-separated run.
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

// The server names the file in Content-Disposition so the tester
// gets the name the instructions mention. Anything unexpected in
// that header falls back to a plain name rather than failing.
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

  // A long report scrolls, and unless the dialog happens to offer a
  // download button it holds nothing focusable, so without this a
  // keyboard user cannot reach the scroll container to read past the
  // first screenful.
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

// Renders one conflict as a summary line, a button per candidate
// version, and — once a candidate is picked — the exact edit that
// makes the conflict go away. Nothing is sent to the server and no
// file is touched; this is advice for the user to apply by hand.
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

  // The edit to make appears here only once a version is picked, so
  // it is new text arriving in a place the user is not looking at.
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

    // Which version is picked is otherwise said only in colour and
    // weight, neither of which is announced.
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

    // The conflict check has to come first here because it comes
    // first on the server: a directory with both a conflict and a
    // notebook install is blocked on the conflict, and the sentence
    // the server wrote says so. Asking for the installs to be moved
    // instead would send the user off to edit every notebook and
    // leave them blocked by the same conflict afterwards.
    if (conflicts.length === 0 && notebookInstalls.length > 0) {
      // The block was caused by notebooks installing their own
      // packages, and the server has named every one of them. That
      // is a to-do list — one edit per notebook — so it is rendered
      // as a list. The prose sentence below would make the user
      // reread it to work out which file to open first.
      report.addConflictLine('Changes needed before this can be frozen:');

      notebookInstalls.forEach(install => {
        const line = document.createElement('div');
        line.style.color = warnColor;

        // The notebook name carries the same weight it has in the
        // Notebooks section, so a user scanning for a filename
        // finds it in the same shape in both places.
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
      // Everything else the server refuses on — a version conflict,
      // a missing image spec — is a single sentence it already
      // wrote, and there is no per-file list to draw. There is
      // always a sentence: the Dockerfile goes unwritten only when
      // the server refused, and a refusal always carries its reason.
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

// Fetches the handover package and hands it to the browser. Every
// outcome, good or bad, is written into the caller's status line; the
// caller owns the button and re-enables it when this settles.
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

    // A refusal is a failure like any other here, so it is written
    // in the same warn colour rather than reading as progress.
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

  // A throwaway link is the only way to hand a blob to the
  // browser's own download machinery; it never joins the layout.
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // The click only queues the download. Revoking in the same task
  // has been enough to abort it in Firefox and Safari, so the URL is
  // released in a later one, once the browser has taken the blob.
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

    // Everything this line ever says arrives after a click, well away
    // from where the user is looking.
    packageStatus.setAttribute('role', 'status');
    report.append(packageStatus);

    const setPackageStatus = statusWriter(packageStatus);

    // The dialog stays open and usable while this runs: the click
    // handler returns immediately and the download writes into the
    // status line once the server answers. Downloading a second time
    // is harmless and people do retry, so the button comes back
    // however the attempt ended — including a throw, which the
    // separate re-enables on each failure path could not cover.
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

  // Without a baseline the server works the list out from file
  // timestamps, which cannot tell a late layer of the image's own
  // build from something the user installed. Both branches above then
  // state as fact what was inferred, so the generated Dockerfile's own
  // caveat is repeated here rather than left for whoever opens it.
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
    // The button is built at the end of this activate, well after the
    // snapshot code that has to drive it, so the nodes are parked here
    // and every use below is null-safe: a freeze started from the
    // command palette before the shell has added the button simply has
    // nothing to update.
    let freezeButtonNode: HTMLButtonElement | null = null;
    let freezeLabelNode: HTMLSpanElement | null = null;
    let freezeInFlight = false;

    // While a freeze runs the whole window ices over and stops taking
    // clicks. This is the primary signal that something is happening:
    // the button's own busy state is up in the top bar, which is not
    // where the user is looking after they click. The overlay is parked
    // here and built on first use, then reused.
    let freezeOverlayNode: HTMLDivElement | null = null;
    let freezeOverlayTextNode: HTMLDivElement | null = null;
    let freezeOverlayTimer: number | null = null;

    // A freeze takes a few seconds and the wait is the same every time,
    // so the overlay says something different on each run. The line is
    // picked when the ice comes up and holds until it thaws.
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

      // The ice is decorative and has nothing to say to a screen
      // reader, which should only hear the word below it.
      const frost = document.createElement('div');
      frost.className = 'icos-freeze-overlay-frost';
      frost.setAttribute('aria-hidden', 'true');
      overlay.appendChild(frost);

      // Snow over the ice. It is one node and the drift is entirely in
      // the stylesheet — no flake is its own element and nothing here
      // runs per frame, so a freeze that takes half a minute costs the
      // same as one that takes a second. Inserted before the text so it
      // paints under the plate.
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

    // transitionend is the natural cue to take the node back out, but
    // it is not guaranteed: reduced motion turns the transition off,
    // a background tab may never run it, and an interrupted one is
    // simply dropped. Any of those would leave the screen iced over
    // with every click swallowed, which locks the user out of Lab
    // entirely. The timeout is the way out of that; whichever of the
    // two lands first cancels the other, and so does a freeze that
    // starts while the ice is still fading.
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

      // A freeze started again during the fade out re-adds the class,
      // and in that case the node has to stay.
      if (
        freezeOverlayNode &&
        !freezeOverlayNode.classList.contains('is-visible')
      ) {
        freezeOverlayNode.remove();
      }
    };

    // One listener for the life of the plugin rather than one per
    // teardown: re-registering the same function on the same node does
    // nothing, so an interrupted teardown cannot leave a stale one
    // behind on the node, which is reused between freezes.
    const onFreezeOverlayTransitionEnd = (event: TransitionEvent) => {
      if (
        event.target === freezeOverlayNode &&
        event.propertyName === 'opacity'
      ) {
        removeFreezeOverlay();
      }
    };

    const setFreezeOverlay = (visible: boolean) => {
      // Whichever direction we are going, any pending teardown from the
      // previous freeze is now stale.
      cancelFreezeOverlayTeardown();

      if (visible) {
        const overlay = ensureFreezeOverlay();

        if (!overlay.isConnected) {
          // document.body, not the shell, so the ice also covers the
          // menu bar and both sidebars.
          document.body.appendChild(overlay);
        }

        // The node is reused between freezes, so the line is redrawn
        // each time rather than only when it is built.
        if (freezeOverlayTextNode) {
          freezeOverlayTextNode.textContent = freezePhrase();
        }

        document.body.setAttribute('aria-busy', 'true');

        // The class has to land in a later frame than the insert. In the
        // same frame the browser has no earlier opacity to transition
        // from, so the ice would snap in instead of fading. Until it
        // lands the overlay is transparent and, by the stylesheet, lets
        // the pointer through, so these two frames block nothing.
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

      // No node yet means no freeze has ever been shown, so there is
      // nothing to fade out and nothing to build here either.
      const overlay = freezeOverlayNode;
      if (!overlay) {
        return;
      }

      // Dropping the class both starts the fade and, by the stylesheet,
      // stops the overlay taking the pointer: for the third of a second
      // it spends fading it is a full-window sheet at z-index 100000
      // that must not swallow clicks on whatever is underneath.
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

      // One place knows about the busy state, so the ice and the button
      // can never disagree about whether a freeze is running.
      setFreezeOverlay(busy);
    };

    // The ice comes down before the dialog goes up. JupyterLab draws
    // dialogs at z-index 10000 and the overlay sits at 100000, so an
    // error raised while a freeze is still marked busy would render
    // behind the frost with every click on it swallowed — and the
    // freeze is over by then anyway. Clearing it twice is harmless:
    // captureSnapshot clears it again in its finally.
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

      // The server echoes back the path it was asked for, not the
      // directory it actually walked, so that is what every message and
      // both follow-up requests use, falling back to the requested path
      // and then to the root.
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

      // The freeze itself is finished the moment the report is ready, so
      // the button stops reading "Freezing…" here rather than waiting for
      // the dialog to be dismissed. The wrapper clears it again in its
      // finally, which is harmless.
      setFreezeBusy(false);

      await showDialog({
        title: 'Freeze: ' + directory,
        body: new Widget({ node: report.node }),
        buttons: [Dialog.okButton()]
      });
    };

    // A freeze makes the server scan the whole environment, which takes
    // a few seconds. Every entry point goes through here — the button
    // and both palette commands — so a second request cannot start
    // while one is still running, whichever way it was asked for. The
    // busy state is cleared in a finally, so a thrown request can never
    // leave the button stuck on "Freezing…", and because the result
    // dialog is awaited inside, the button only comes back once that
    // dialog is dismissed.
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

    // A real <button>, not a div with role="button": the browser then
    // gives focus, Enter and Space activation and the correct screen
    // reader announcement for free, with no key handling of our own.
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

    // Everything captureSnapshot expects to go wrong is reported in a
    // dialog, but anything it did not expect would otherwise be an
    // unhandled rejection with nothing on screen and nothing in the
    // console to explain the button that just stopped responding.
    button.addEventListener('click', () => {
      void captureSnapshot(fileBrowser.model.path).catch(error =>
        console.error('Freeze: the freeze failed', error)
      );
    });

    const freezeButton = new Widget({ node: button });
    freezeButton.id = 'icos-freeze-button';

    // The shell puts the main menu bar in the top area at rank 100
    // (`this.add(this._menuHandler.panel, 'top', { rank: 100 })` in
    // @jupyterlab/application/lib/shell.js), and the top area's
    // PanelHandler inserts with ArrayExt.upperBound, so equal ranks land
    // after what is already there. Rank 101 therefore puts Freeze
    // immediately to the right of the menu bar and still well ahead of
    // the shell's DEFAULT_RANK of 900.
    app.shell.add(freezeButton, 'top', { rank: 101 });
  }
};

export default freeze;
