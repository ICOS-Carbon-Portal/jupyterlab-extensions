import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';

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

type DockerfileOutcome = 'written' | 'unchanged' | 'skipped_foreign' | 'error';

interface IFreezeSnapshot {
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
  requirements_warnings?: string[];
  dockerfile_written: DockerfileOutcome | null;
  bundle_available?: boolean;
}

interface IFreezeBundleBlocked {
  reason?: string;
}

interface IFreezeOverlay {
  node: HTMLDivElement;
  text: HTMLDivElement;
}

interface IReport {
  node: HTMLDivElement;
  addLine: (text: string) => void;
  addWarningLine: (text: string) => void;
  addHeading: (text: string, warning?: boolean) => void;
  addList: (items: string[], warning?: boolean) => void;
  append: (child: HTMLElement) => void;
}

// The server's `provenance_method` is either this, an exact baseline
// recorded at image build, or a guess read from file timestamps.
const BASELINE_PROVENANCE = 'baseline';

const WARNING_CLASS = 'icos-freeze-warning';

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

const freeze: JupyterFrontEndPlugin<void> = {
  id: '@icos-ext/freeze',
  autoStart: true,
  requires: [IDefaultFileBrowser],
  activate: activateFreeze
};

function activateFreeze(app: JupyterFrontEnd, fileBrowser: IDefaultFileBrowser): void {
  // A real <button>: focus and Enter/Space activation come for free.
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icos-freeze-button';
  button.title = 'Freeze the current file browser directory';

  const label = document.createElement('span');
  label.className = 'icos-freeze-label';
  label.textContent = 'Freeze';
  button.appendChild(label);

  // The ice is the primary signal that a freeze is running: the button's
  // own busy state is up in the top bar, out of view after a click.
  // It stays in the page between freezes, invisible and click-through
  // without `is-visible`, so toggling the class is enough to fade it
  // either way. document.body, not the shell: the ice covers the menu bar.
  const overlay = createFreezeOverlay();
  document.body.appendChild(overlay.node);

  let freezeInFlight = false;

  function setFreezeBusy(busy: boolean): void {
    button.classList.toggle('is-freezing', busy);
    button.disabled = busy;
    label.textContent = busy ? 'Freezing...' : 'Freeze';

    if (busy) {
      overlay.text.textContent = freezePhrase();
      document.body.setAttribute('aria-busy', 'true');
    } else {
      document.body.removeAttribute('aria-busy');
    }
    overlay.node.classList.toggle('is-visible', busy);
  }

  // The ice comes down before the dialog goes up: JupyterLab draws
  // dialogs at z-index 10000 and the overlay sits at 100000, so an error
  // shown while still busy would sit behind the frost, unclickable.
  function showFreezeError(message: string) {
    setFreezeBusy(false);

    return showDialog({
      title: 'Freeze',
      body: message,
      buttons: [Dialog.okButton()]
    });
  }

  async function performSnapshot(path: string): Promise<void> {
    const query = encodeURIComponent(path);
    const url = `${PageConfig.getBaseUrl()}icos-ext/freeze?path=${query}`;

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
      await showFreezeError('The server sent a response that could not be read.');
      return;
    }

    const directory = displayPath(path);
    const conflicts = snapshot.conflicts ?? [];

    const report = createReport();
    renderConflicts(report, conflicts);
    renderDockerfile(report, snapshot, freezeFolder(path), conflicts);
    renderRequirementsWarnings(report, snapshot.requirements_warnings ?? []);
    renderPackage(report, snapshot.bundle_available, path);
    renderMissing(report, snapshot.missing ?? []);
    renderEnvironment(report, snapshot);
    renderDependencyFiles(report, snapshot.requirements ?? []);
    renderNotebooks(report, snapshot.notebooks ?? []);

    // The freeze is over once the report is ready, so the button resets
    // here rather than when the dialog is dismissed.
    setFreezeBusy(false);

    await showDialog({
      title: `Freeze: ${directory}`,
      body: new Widget({ node: report.node }),
      buttons: [Dialog.okButton()]
    });
  }

  // The button and both palette commands all funnel through here, so a
  // second request cannot start while one is running. The finally is a
  // backstop: a throw would otherwise leave the button on "Freezing...".
  async function captureSnapshot(path: string): Promise<void> {
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
  }

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

function createFreezeOverlay(): IFreezeOverlay {
  const node = document.createElement('div');
  node.id = 'icos-freeze-overlay';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');

  const frost = document.createElement('div');
  frost.className = 'icos-freeze-overlay-frost';
  frost.setAttribute('aria-hidden', 'true');
  node.appendChild(frost);

  // One node, drift entirely in the stylesheet: nothing runs per frame.
  const blizzard = document.createElement('div');
  blizzard.className = 'icos-freeze-overlay-blizzard';
  blizzard.setAttribute('aria-hidden', 'true');
  node.appendChild(blizzard);

  const text = document.createElement('div');
  text.className = 'icos-freeze-overlay-text';
  node.appendChild(text);

  return { node, text };
}

function freezePhrase(): string {
  return FREEZE_PHRASES[Math.floor(Math.random() * FREEZE_PHRASES.length)];
}

async function freezeRequest(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await ServerConnection.makeRequest(url, init, ServerConnection.makeSettings());
  } catch (error) {
    console.error(`Freeze: could not reach ${url}`, error);
    return null;
  }
}

function unreachableMessage(verb: string, target: string): string {
  return (
    `Could not reach the server to ${verb} "${displayPath(target)}". ` +
    'Check that you are still connected and try again.'
  );
}

function httpFailureMessage(verb: string, target: string, response: Response): string {
  // HTTP/2 dropped the reason phrase, so statusText is usually empty and
  // appending it unconditionally would give "(HTTP 500 )".
  const reason = response.statusText ? ` ${response.statusText}` : '';
  const status = `HTTP ${response.status}${reason}`;
  return `The server could not ${verb} "${displayPath(target)}" (${status}).`;
}

// The file browser gives its root directory as the empty path.
function displayPath(path: string): string {
  return path === '' ? '/' : path;
}

// The server writes everything it generates into this hidden sub-folder.
function freezeFolder(path: string): string {
  return path === '' ? '/.icos-freeze' : `${path}/.icos-freeze`;
}

function logUnreadable(url: string, error: unknown): void {
  console.error(`Freeze: could not read the response from ${url}`, error);
}

function logHttpFailure(url: string, response: Response): void {
  console.error(`Freeze: ${url} returned ${response.status} ${response.statusText}`);
}

function createReport(): IReport {
  const container = document.createElement('div');
  container.className = 'icos-freeze-report';

  // The report scrolls but often holds nothing focusable, so without this
  // a keyboard user cannot reach the scroll container.
  container.tabIndex = 0;

  function addLine(text: string): void {
    const line = document.createElement('div');
    line.textContent = text;
    container.appendChild(line);
  }

  function addWarningLine(text: string): void {
    const line = document.createElement('div');
    line.className = WARNING_CLASS;
    line.textContent = text;
    container.appendChild(line);
  }

  function addHeading(text: string, warning = false): void {
    const heading = document.createElement('h3');
    heading.className = 'icos-freeze-report-heading';
    heading.classList.toggle(WARNING_CLASS, warning);
    heading.textContent = text;
    container.appendChild(heading);
  }

  function addList(items: string[], warning = false): void {
    const list = document.createElement('ul');
    list.className = 'icos-freeze-report-list';
    list.classList.toggle(WARNING_CLASS, warning);
    items.forEach(item => {
      const listItem = document.createElement('li');
      listItem.textContent = item;
      list.appendChild(listItem);
    });
    container.appendChild(list);
  }

  function append(child: HTMLElement): void {
    container.appendChild(child);
  }

  return { node: container, addLine, addWarningLine, addHeading, addList, append };
}

function renderConflicts(report: IReport, conflicts: IFreezeConflict[]): void {
  if (conflicts.length === 0) {
    report.addHeading('Conflicts');
    report.addLine('No version conflicts found.');
  } else {
    report.addHeading(`Conflicts (${conflicts.length})`, true);
    conflicts.forEach(conflict => addConflictBlock(report, conflict));
  }
}

// Nothing is sent to the server: picking a version only prints an edit.
function addConflictBlock(report: IReport, conflict: IFreezeConflict): void {
  const block = document.createElement('div');
  block.className = 'icos-freeze-conflict';

  const summary = document.createElement('div');
  summary.className = WARNING_CLASS;
  const notebookVersion = formatVersion(conflict.notebook_version);
  const requirementsVersion = formatVersion(conflict.requirements_version);
  summary.textContent =
    `${conflict.package}: ${conflict.notebook} wants ${notebookVersion}, ` +
    `${conflict.requirements_file} wants ${requirementsVersion}`;

  const choices = document.createElement('div');
  choices.className = 'icos-freeze-conflict-choices';

  const instruction = document.createElement('div');
  instruction.className = 'icos-freeze-conflict-instruction';
  instruction.setAttribute('role', 'status');

  block.appendChild(summary);
  block.appendChild(choices);
  block.appendChild(instruction);
  report.append(block);

  const choiceButtons: HTMLButtonElement[] = [];

  function addChoice(version: string, fromFile: string, otherFile: string): void {
    const button = document.createElement('button');
    button.className = 'jp-mod-styled icos-freeze-conflict-choice';
    button.textContent = `Keep ${version} (${fromFile})`;
    button.setAttribute('aria-pressed', 'false');

    button.addEventListener('click', () => {
      choiceButtons.forEach(other => other.setAttribute('aria-pressed', 'false'));
      button.setAttribute('aria-pressed', 'true');
      instruction.textContent =
        `To keep ${version}: edit ${otherFile} and change the ` +
        `${conflict.package} pin to ${version}`;
    });
    choiceButtons.push(button);
    choices.appendChild(button);
  }

  if (conflict.notebook_version) {
    addChoice(conflict.notebook_version, conflict.notebook, conflict.requirements_file);
  }

  if (conflict.requirements_version) {
    addChoice(conflict.requirements_version, conflict.requirements_file, conflict.notebook);
  }
}

function renderDockerfile(
  report: IReport,
  snapshot: IFreezeSnapshot,
  folder: string,
  conflicts: IFreezeConflict[]
): void {
  report.addHeading('Dockerfile');

  switch (snapshot.dockerfile_written) {
    case 'written':
      report.addLine(
        `The Dockerfile was written into "${folder}". ` +
          'The folder is hidden, so the file browser does not show it.'
      );
      break;
    case 'unchanged':
      report.addLine(
        `The Dockerfile in "${folder}" is already up to date, so nothing was rewritten.`
      );
      break;
    case 'skipped_foreign':
      report.addWarningLine(
        `"${folder}" has a Dockerfile that freeze did not generate, which was left alone. ` +
          'The generated Dockerfile was not saved.'
      );
      break;
    case 'error':
      report.addWarningLine(
        `The Dockerfile could not be written into "${folder}". The server log has the reason.`
      );
      break;
    default:
      // The server leaves dockerfile_written null only when it refused,
      // and every refusal carries its reason.
      renderDockerfileBlocked(report, snapshot, conflicts);
  }
}

function renderDockerfileBlocked(
  report: IReport,
  snapshot: IFreezeSnapshot,
  conflicts: IFreezeConflict[]
): void {
  const notebookInstalls = snapshot.notebook_installs ?? [];

  // Conflicts are checked first because _dockerfile_block_reason checks
  // them first: a directory with both is blocked on the conflict.
  if (conflicts.length === 0 && notebookInstalls.length > 0) {
    report.addWarningLine('Changes needed before this can be frozen:');

    notebookInstalls.forEach(install => {
      const line = document.createElement('div');
      line.className = 'icos-freeze-install';

      const name = document.createElement('span');
      name.className = 'icos-freeze-install-name';
      name.textContent = install.name;
      line.appendChild(name);

      const packages = formatPackageList(install.packages ?? []);
      line.appendChild(document.createTextNode(`: move ${packages} into requirements.txt`));

      report.append(line);
    });

    report.addLine('Install them in this environment, then freeze again.');
    return;
  }

  if (snapshot.dockerfile_blocked) {
    report.addWarningLine(snapshot.dockerfile_blocked);
  }
  report.addLine('Fix the files in this directory and freeze again to get a Dockerfile.');
}

function renderRequirementsWarnings(report: IReport, warnings: string[]): void {
  if (warnings.length > 0) {
    report.addHeading(`Differences from your session (${warnings.length})`, true);
    report.addList(warnings, true);
  }
}

function renderPackage(report: IReport, bundleAvailable: boolean | undefined, path: string): void {
  report.addHeading('Package');

  if (bundleAvailable === true) {
    report.addLine(
      'The package holds the Dockerfile, the notebooks, the dependency files and ' +
        'instructions for a tester.'
    );

    const packageButton = document.createElement('button');
    packageButton.type = 'button';
    packageButton.className = 'jp-Dialog-button jp-mod-accept jp-mod-styled';
    packageButton.textContent = 'Download package';
    report.append(packageButton);

    const packageStatus = document.createElement('div');
    packageStatus.className = 'icos-freeze-report-status';
    packageStatus.setAttribute('role', 'status');
    report.append(packageStatus);

    const setPackageStatus = statusWriter(packageStatus);

    // `finally` brings the button back however the attempt ended.
    packageButton.addEventListener('click', () => {
      packageButton.disabled = true;
      void downloadBundle(path, setPackageStatus).finally(() => {
        packageButton.disabled = false;
      });
    });
  } else {
    report.addLine('No package can be made until the Dockerfile problem above is fixed.');
  }
}

// The caller owns the button and re-enables it when this settles.
async function downloadBundle(
  path: string,
  setStatus: (text: string, warn?: boolean) => void
): Promise<void> {
  setStatus('Preparing the package.');

  const query = encodeURIComponent(path);
  const bundleUrl = `${PageConfig.getBaseUrl()}icos-ext/bundle?path=${query}`;

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
        'The server refused to make the package and sent a reason that could not be read.',
        true
      );
      return;
    }

    setStatus(blocked.reason ?? 'The server cannot package this directory.', true);
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
    console.error(`Freeze: could not read the package sent by ${bundleUrl}`, error);
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

  const savedNote = savedCopy ? ` A copy was also saved into "${freezeFolder(path)}".` : '';
  setStatus(`Downloaded "${filename}".${savedNote}`);
}

function statusWriter(node: HTMLElement): (text: string, warn?: boolean) => void {
  return (text, warn = false) => {
    node.textContent = text;
    node.classList.toggle(WARNING_CLASS, warn);
  };
}

// The server names the zip in Content-Disposition; an unparseable header
// falls back to a plain name rather than failing the download.
function filenameFrom(disposition: string | null): string {
  const match = /filename="?([^";]+)"?/i.exec(disposition ?? '');
  const name = match ? match[1].trim() : '';
  return name !== '' ? name : 'frozen-package.zip';
}

function renderMissing(report: IReport, missing: string[]): void {
  if (missing.length > 0) {
    report.addHeading(`Not installed (${missing.length})`, true);
    report.addList(missing, true);
    report.addLine(
      'These packages are imported by the notebooks but are not installed in this environment, ' +
        'so the build cannot reproduce them.'
    );
  }
}

function renderEnvironment(report: IReport, snapshot: IFreezeSnapshot): void {
  report.addHeading('Environment');
  report.addLine(
    snapshot.image ? `Image: ${snapshot.image}` : 'No image spec reported by the server'
  );
  if (snapshot.python_version) {
    report.addLine(`Python: ${snapshot.python_version}`);
  }

  const userInstalled = snapshot.user_installed ?? [];
  if (userInstalled.length === 0) {
    report.addLine(
      'Nothing was installed on top of the image, ' +
        'so the image digest alone reproduces this environment.'
    );
  } else {
    const plural = userInstalled.length === 1 ? '' : 's';
    report.addLine(`${userInstalled.length} package${plural} installed on top of the image:`);
    report.addList(
      userInstalled.map(pkg => {
        const version = pkg.installed_version ?? 'unknown';
        const manager = pkg.manager ?? 'unknown';
        return `${pkg.name} ${version} (${manager})`;
      })
    );
  }

  // Timestamps cannot tell a late layer of the image's own build from a
  // user install, so the generated Dockerfile's caveat is repeated here.
  if (snapshot.provenance_method && snapshot.provenance_method !== BASELINE_PROVENANCE) {
    report.addLine(
      'This was read from file timestamps rather than a package baseline, so it may include ' +
        'packages the image already ships and miss some that were installed on top of it.'
    );
  }
}

function renderDependencyFiles(report: IReport, requirements: IFreezeRequirement[]): void {
  report.addHeading('Dependency files');
  if (requirements.length === 0) {
    report.addLine('No dependency files found in this directory.');
  } else {
    report.addList(requirements.map(file => file.name));
  }
}

function renderNotebooks(report: IReport, notebooks: IFreezeNotebook[]): void {
  report.addHeading('Notebooks');
  if (notebooks.length === 0) {
    report.addLine('No notebooks found in this directory.');
    return;
  }

  notebooks.forEach(notebook => {
    const title = document.createElement('div');
    title.className = 'icos-freeze-report-notebook';
    title.textContent = notebook.name;
    report.append(title);

    const packages = notebook.packages ?? [];
    if (packages.length === 0) {
      report.addList(['no packages found']);
    } else {
      report.addList(
        packages.map(pkg => {
          const version = pkg.version ? ` ${pkg.version}` : '';
          return `${pkg.name}${version} (${pkg.source})`;
        })
      );
    }
  });
}

function formatVersion(value: string | null): string {
  return value ?? 'unspecified';
}

function formatPackageList(packages: string[]): string {
  if (packages.length === 0) {
    return 'its packages';
  }
  if (packages.length === 1) {
    return packages[0];
  }
  const allButLast = packages.slice(0, -1).join(', ');
  return `${allButLast} and ${packages[packages.length - 1]}`;
}

export default freeze;
