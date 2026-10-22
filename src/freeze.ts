import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';

import { Dialog, InputDialog, showDialog } from '@jupyterlab/apputils';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { Widget } from '@lumino/widgets';
import { PageConfig } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { IStateDB } from '@jupyterlab/statedb';

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

interface IFreezeUnusedPackage {
  name: string;
  version: string | null;
}

type FreezeFileKind = 'notebook' | 'requirements' | 'local_code' | 'other';

interface IFreezeFile {
  path: string;
  size: number;
  kind: FreezeFileKind;
  recommended: boolean;
}

interface IFreezeUnreadable {
  path: string;
  reason: string;
}

interface IFreezeLeftOut {
  path: string;
  reason: string;
}

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
  dockerfile?: string | null;
  bundle_available?: boolean;
  files?: IFreezeFile[];
  include?: string[];
  local_modules?: string[];
  unreadable_notebooks?: IFreezeUnreadable[];
  files_truncated?: boolean;
  left_out?: IFreezeLeftOut[];
  unused_installed?: IFreezeUnusedPackage[];
}

interface IFreezeFolder {
  name: string;
  path: string;
  folders: Map<string, IFreezeFolder>;
  files: IFreezeFile[];
}

interface ISavedSelection {
  excluded: string[];
  added: string[];
}

interface IFileSelection {
  node: HTMLDivElement;
  include: () => string[];
  saved: () => ISavedSelection;
  setStatus: (text: string, warn?: boolean) => void;
}

interface IPackageSection {
  node: HTMLDivElement;
  setAvailable: (available: boolean) => void;
  setPending: (pending: boolean) => void;
}

interface IDownloadedPackage {
  filename: string;
  saved: boolean;
}

interface IFreezeBundleBlocked {
  reason?: string;
}

interface IFreezeOverlay {
  node: HTMLDivElement;
  text: HTMLDivElement;
}

type Tone = 'warning' | 'error' | 'success';

interface IReport {
  node: HTMLDivElement;
  addLine: (text: string, tone?: Tone) => void;
  addIssue: (text: string, tone: Tone) => void;
  addHeading: (text: string, tone?: Tone) => void;
  addList: (items: string[], tone?: Tone) => void;
  append: (child: HTMLElement) => void;
}

// The server's `provenance_method` is either this, an exact baseline
// recorded at image build, or a guess read from file timestamps.
const BASELINE_PROVENANCE = 'baseline';

const WARNING_CLASS = 'icos-freeze-warning';

const TONE_CLASSES: Record<Tone, string> = {
  warning: WARNING_CLASS,
  error: 'icos-freeze-error',
  success: 'icos-freeze-success'
};

const RECHECK_DELAY_MS = 400;

const SELECTION_KEY = 'icos-freeze:excluded:';

const KIND_LABELS: Record<FreezeFileKind, string | null> = {
  notebook: 'notebook',
  requirements: 'requirements',
  local_code: 'local code',
  other: null
};

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
  optional: [IStateDB],
  activate: activateFreeze
};

function activateFreeze(
  app: JupyterFrontEnd,
  fileBrowser: IDefaultFileBrowser,
  state: IStateDB | null
): void {
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
    const saved = await loadSelection(state, path);
    const first = await restoredSnapshot(path, saved);
    if (typeof first === 'string') {
      await showFreezeError(first);
      return;
    }

    const container = document.createElement('div');
    container.className = 'icos-freeze-report';

    // The report scrolls but often holds nothing focusable, so without this
    // a keyboard user cannot reach the scroll container.
    container.tabIndex = 0;

    // Only what follows the file tree is re-rendered on each change of
    // selection; above it, a change in height would shift the tree under
    // the pointer.
    const selection = createFileSelection(
      first,
      initialSelection(first, saved.excluded),
      onSelectionChange
    );
    const leftOut = createReport();
    const issues = createReport();
    const packageSection = createPackageSection(path, selection.include);
    container.append(
      createStep(
        '1. Review the selection',
        'Clear any file that should not be included in the package.',
        selection.node,
        leftOut.node
      ),
      createStep(
        '2. Resolve the reported issues',
        'Problems in red prevent the package from being created. Warnings do not.',
        issues.node
      ),
      createStep(
        '3. Create the package',
        'Enter a package name and select Download package.',
        packageSection.node
      )
    );

    const details = { open: false };
    const render = (snapshot: IFreezeSnapshot): void => {
      const scroll = container.scrollTop;
      leftOut.node.replaceChildren();
      issues.node.replaceChildren();
      renderLeftOut(leftOut, snapshot.left_out ?? []);
      renderIssues(issues, snapshot, freezeFolder(path), details);
      packageSection.setAvailable(snapshot.bundle_available === true);
      container.scrollTop = scroll;
    };
    render(first);

    let generation = 0;
    let timer: number | undefined;

    function onSelectionChange(): void {
      void saveSelection(state, path, selection.saved());
      generation += 1;
      const current = generation;
      packageSection.setPending(true);
      selection.setStatus('Updating the report...');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void recheck(current), RECHECK_DELAY_MS);
    }

    async function recheck(current: number): Promise<void> {
      if (!container.isConnected) {
        return;
      }
      const result = await requestSnapshot(path, selection.include(), []);
      if (current !== generation) {
        return;
      }
      packageSection.setPending(false);
      if (typeof result === 'string') {
        selection.setStatus(
          `The report could not be updated: ${result} It still shows the previous selection.`,
          true
        );
        return;
      }
      selection.setStatus('');
      render(result);
    }

    // The freeze is over once the report is ready, so the button resets
    // here rather than when the dialog is dismissed.
    setFreezeBusy(false);

    await showDialog({
      title: `Freeze: ${displayPath(path)}`,
      body: new Widget({ node: container }),
      buttons: [Dialog.cancelButton({ label: 'Close' })]
    });
    window.clearTimeout(timer);
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

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

// Hidden files are never recommended, so the server's exclude cannot add
// them back; a second request with the full list does.
async function restoredSnapshot(
  path: string,
  saved: ISavedSelection
): Promise<IFreezeSnapshot | string> {
  const first = await requestSnapshot(path, null, saved.excluded);
  if (typeof first === 'string') {
    return first;
  }

  const listed = new Set((first.files ?? []).map(file => file.path));
  const added = saved.added.filter(file => listed.has(file));
  if (added.length === 0) {
    return first;
  }

  const include = new Set([...initialSelection(first, saved.excluded), ...added]);
  const second = await requestSnapshot(path, [...include].sort(), []);
  return typeof second === 'string' ? first : second;
}

// The server reports the selection it used; if it does not, the same rule
// is applied here.
function initialSelection(snapshot: IFreezeSnapshot, excluded: string[]): string[] {
  if (snapshot.include) {
    return snapshot.include;
  }
  const skip = new Set(excluded);
  return (snapshot.files ?? [])
    .filter(file => file.recommended && !skip.has(file.path))
    .map(file => file.path);
}

async function loadSelection(state: IStateDB | null, path: string): Promise<ISavedSelection> {
  const empty = { excluded: [], added: [] };
  if (!state) {
    return empty;
  }
  try {
    const value = await state.fetch(SELECTION_KEY + path);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return empty;
    }
    return {
      excluded: 'excluded' in value ? stringList(value.excluded) : [],
      added: 'added' in value ? stringList(value.added) : []
    };
  } catch (error) {
    console.error('Freeze: could not read the saved file selection', error);
    return empty;
  }
}

// A selection equal to the recommended one is removed rather than saved,
// which is also how "Reset to recommended" forgets it.
async function saveSelection(
  state: IStateDB | null,
  path: string,
  saved: ISavedSelection
): Promise<void> {
  if (!state) {
    return;
  }
  const key = SELECTION_KEY + path;
  try {
    if (saved.excluded.length === 0 && saved.added.length === 0) {
      await state.remove(key);
    } else {
      await state.save(key, { excluded: saved.excluded, added: saved.added });
    }
  } catch (error) {
    console.error('Freeze: could not save the file selection', error);
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

// Resolves to the snapshot, or to a message saying why there is none.
async function requestSnapshot(
  path: string,
  include: string[] | null,
  exclude: string[]
): Promise<IFreezeSnapshot | string> {
  const url = `${PageConfig.getBaseUrl()}icos-ext/freeze`;

  const response = await freezeRequest(url, jsonPost({ path, include, exclude }));
  if (!response) {
    return unreachableMessage('freeze', path);
  }

  if (!response.ok) {
    logHttpFailure(url, response);
    return httpFailureMessage('freeze', path, response);
  }

  try {
    return (await response.json()) as IFreezeSnapshot;
  } catch (error) {
    logUnreadable(url, error);
    return 'The server sent a response that could not be read.';
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
  container.className = 'icos-freeze-report-section';

  function addLine(text: string, tone?: Tone): void {
    const line = document.createElement('div');
    if (tone) {
      line.className = TONE_CLASSES[tone];
    }
    line.textContent = text;
    container.appendChild(line);
  }

  function addIssue(text: string, tone: Tone): void {
    const line = document.createElement('div');
    line.className = `icos-freeze-issue ${TONE_CLASSES[tone]}`;
    line.textContent = text;
    container.appendChild(line);
  }

  function addHeading(text: string, tone?: Tone): void {
    const heading = document.createElement('h4');
    heading.className = 'icos-freeze-report-heading';
    if (tone) {
      heading.classList.add(TONE_CLASSES[tone]);
    }
    heading.textContent = text;
    container.appendChild(heading);
  }

  function addList(items: string[], tone?: Tone): void {
    const list = document.createElement('ul');
    list.className = 'icos-freeze-report-list';
    if (tone) {
      list.classList.add(TONE_CLASSES[tone]);
    }
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

  return { node: container, addLine, addIssue, addHeading, addList, append };
}

function createStep(title: string, instruction: string, ...children: HTMLElement[]): HTMLElement {
  const step = document.createElement('section');
  step.className = 'icos-freeze-step';

  const heading = document.createElement('h3');
  heading.className = 'icos-freeze-step-heading';
  heading.textContent = title;

  const text = document.createElement('div');
  text.className = 'icos-freeze-step-instruction';
  text.textContent = instruction;

  step.append(heading, text, ...children);
  return step;
}

function renderIssues(
  report: IReport,
  snapshot: IFreezeSnapshot,
  folder: string,
  details: { open: boolean }
): void {
  const conflicts = snapshot.conflicts ?? [];
  if (snapshot.bundle_available === true && conflicts.length === 0) {
    report.addIssue('Nothing prevents the package from being created.', 'success');
  } else {
    renderBlocking(report, snapshot, conflicts);
  }

  renderMissing(report, snapshot.missing ?? []);
  renderUnreadable(report, snapshot.unreadable_notebooks ?? []);
  renderRequirementsWarnings(report, snapshot.requirements_warnings ?? []);
  renderUnusedInstalled(report, snapshot.unused_installed ?? []);
  report.append(createDetails(snapshot, folder, details));
}

function createDetails(
  snapshot: IFreezeSnapshot,
  folder: string,
  state: { open: boolean }
): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'icos-freeze-details';
  details.open = state.open;
  details.addEventListener('toggle', () => {
    state.open = details.open;
  });

  const summary = document.createElement('summary');
  summary.textContent = 'Details';

  const report = createReport();
  renderDockerfile(report, snapshot, folder);
  renderEnvironment(report, snapshot);
  renderNotebooks(report, snapshot.notebooks ?? []);
  renderDependencyFiles(report, snapshot.requirements ?? []);
  renderLocalModules(report, snapshot.local_modules ?? []);

  details.append(summary, report.node);
  return details;
}

function createFileSelection(
  snapshot: IFreezeSnapshot,
  initial: string[],
  onChange: () => void
): IFileSelection {
  const files = snapshot.files ?? [];
  const recommended = (): string[] => files.filter(file => file.recommended).map(file => file.path);
  const selected = new Set(initial);

  const fileBoxes = new Map<string, HTMLInputElement>();
  const folderBoxes: { box: HTMLInputElement; paths: string[] }[] = [];

  const node = document.createElement('div');
  node.className = 'icos-freeze-files';
  const section = createReport();
  node.append(section.node);

  if (files.length === 0) {
    section.addLine('No files found in this directory.');
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'icos-freeze-files-toolbar';
  const total = document.createElement('span');
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'jp-mod-styled icos-freeze-files-reset';
  reset.textContent = 'Reset to recommended';
  toolbar.append(total, reset);

  const tree = document.createElement('ul');
  tree.className = 'icos-freeze-tree';
  renderFolder(buildTree(files), tree, fileBoxes, folderBoxes);

  const status = document.createElement('div');
  status.className = 'icos-freeze-report-status';
  status.setAttribute('role', 'status');

  if (files.length > 0) {
    node.append(toolbar, tree);
  }
  if (snapshot.files_truncated) {
    const cut = document.createElement('div');
    cut.className = WARNING_CLASS;
    cut.textContent =
      `The listing was cut off at ${files.length} files, ` +
      'so files past that point are not shown and cannot be packaged.';
    node.append(cut);
  }
  node.append(status);

  function refresh(): void {
    fileBoxes.forEach((box, path) => {
      box.checked = selected.has(path);
    });
    folderBoxes.forEach(({ box, paths }) => {
      const count = paths.filter(path => selected.has(path)).length;
      box.checked = count === paths.length;
      box.indeterminate = count > 0 && count < paths.length;
    });

    const size = files
      .filter(file => selected.has(file.path))
      .reduce((sum, file) => sum + file.size, 0);
    total.textContent = `${selected.size} of ${files.length} files selected, ${formatSize(size)}`;
  }

  function changed(): void {
    refresh();
    onChange();
  }

  fileBoxes.forEach((box, path) => {
    box.addEventListener('change', () => {
      if (box.checked) {
        selected.add(path);
      } else {
        selected.delete(path);
      }
      changed();
    });
  });

  folderBoxes.forEach(({ box, paths }) => {
    box.addEventListener('change', () => {
      paths.forEach(path => (box.checked ? selected.add(path) : selected.delete(path)));
      changed();
    });
  });

  reset.addEventListener('click', () => {
    selected.clear();
    recommended().forEach(path => selected.add(path));
    changed();
  });

  refresh();

  return {
    node,
    include: () => [...selected].sort(),
    saved: () => ({
      excluded: recommended().filter(path => !selected.has(path)),
      added: files
        .filter(file => !file.recommended && selected.has(file.path))
        .map(file => file.path)
    }),
    setStatus: statusWriter(status)
  };
}

function buildTree(files: IFreezeFile[]): IFreezeFolder {
  const root: IFreezeFolder = { name: '', path: '', folders: new Map(), files: [] };

  files.forEach(file => {
    const parts = file.path.split('/');
    let folder = root;
    parts.slice(0, -1).forEach(part => {
      let child = folder.folders.get(part);
      if (!child) {
        const childPath = folder.path === '' ? part : `${folder.path}/${part}`;
        child = { name: part, path: childPath, folders: new Map(), files: [] };
        folder.folders.set(part, child);
      }
      folder = child;
    });
    folder.files.push(file);
  });

  return root;
}

function folderFiles(folder: IFreezeFolder): IFreezeFile[] {
  const nested = [...folder.folders.values()].flatMap(folderFiles);
  return [...nested, ...folder.files];
}

function renderFolder(
  folder: IFreezeFolder,
  list: HTMLUListElement,
  fileBoxes: Map<string, HTMLInputElement>,
  folderBoxes: { box: HTMLInputElement; paths: string[] }[]
): void {
  folder.folders.forEach(child => {
    const contents = folderFiles(child);

    const item = document.createElement('li');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'icos-freeze-tree-toggle';
    toggle.setAttribute('aria-label', `Show or hide ${child.name}`);
    toggle.setAttribute('aria-expanded', 'false');

    const box = document.createElement('input');
    box.type = 'checkbox';
    folderBoxes.push({ box, paths: contents.map(file => file.path) });

    const children = document.createElement('ul');
    children.hidden = true;
    renderFolder(child, children, fileBoxes, folderBoxes);

    toggle.addEventListener('click', () => {
      children.hidden = !children.hidden;
      toggle.setAttribute('aria-expanded', String(!children.hidden));
    });

    const size = contents.reduce((sum, file) => sum + file.size, 0);
    item.append(treeRow(toggle, box, `${child.name}/`, null, size), children);
    list.append(item);
  });

  folder.files.forEach(file => {
    const item = document.createElement('li');

    const spacer = document.createElement('span');
    spacer.className = 'icos-freeze-tree-toggle';

    const box = document.createElement('input');
    box.type = 'checkbox';
    fileBoxes.set(file.path, box);

    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    item.append(treeRow(spacer, box, name, KIND_LABELS[file.kind] ?? null, file.size));
    list.append(item);
  });
}

function treeRow(
  toggle: HTMLElement,
  box: HTMLInputElement,
  name: string,
  kind: string | null,
  size: number
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'icos-freeze-tree-row';

  const label = document.createElement('label');
  label.className = 'icos-freeze-tree-name';
  label.append(box, name);
  row.append(toggle, label);

  if (kind) {
    const badge = document.createElement('span');
    badge.className = 'icos-freeze-tree-badge';
    badge.textContent = kind;
    row.append(badge);
  }

  const sizeNode = document.createElement('span');
  sizeNode.className = 'icos-freeze-tree-size';
  sizeNode.textContent = formatSize(size);
  row.append(sizeNode);

  return row;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Nothing is sent to the server: picking a version only prints an edit.
function addConflictBlock(report: IReport, conflict: IFreezeConflict): void {
  const block = document.createElement('div');
  block.className = 'icos-freeze-conflict';

  const summary = document.createElement('div');
  summary.className = TONE_CLASSES.error;
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

function renderDockerfile(report: IReport, snapshot: IFreezeSnapshot, folder: string): void {
  if (!snapshot.dockerfile) {
    return;
  }

  report.addHeading('Dockerfile');
  report.addLine(
    'Nothing has been written yet: the Dockerfile and the selected files go into ' +
      `"${folder}" when the package is downloaded. ` +
      'The folder is hidden, so the file browser does not show it.'
  );

  const code = document.createElement('pre');
  code.className = 'icos-freeze-dockerfile';
  code.textContent = snapshot.dockerfile;
  report.append(code);
}

function renderBlocking(
  report: IReport,
  snapshot: IFreezeSnapshot,
  conflicts: IFreezeConflict[]
): void {
  const notebookInstalls = snapshot.notebook_installs ?? [];

  // Conflicts are checked first because _dockerfile_block_reason checks
  // them first: a directory with both is blocked on the conflict.
  if (conflicts.length === 0 && notebookInstalls.length > 0) {
    report.addIssue('Changes needed before this can be frozen:', 'error');

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

  report.addIssue(
    snapshot.dockerfile_blocked ?? 'The server reported that this directory cannot be packaged.',
    'error'
  );
  if (conflicts.length > 0) {
    report.addHeading(`Conflicts (${conflicts.length})`, 'error');
    conflicts.forEach(conflict => addConflictBlock(report, conflict));
  }
  report.addLine(
    'Fix the files in this directory and freeze again, or change the selection in step 1, ' +
      'to get a Dockerfile.'
  );
}

function renderRequirementsWarnings(report: IReport, warnings: string[]): void {
  if (warnings.length > 0) {
    report.addHeading(`Differences from your environment (${warnings.length})`, 'warning');
    report.addList(warnings, 'warning');
  }
}

function renderUnusedInstalled(report: IReport, packages: IFreezeUnusedPackage[]): void {
  if (packages.length > 0) {
    report.addHeading(`Installed but not used (${packages.length})`, 'warning');
    report.addList(
      packages.map(pkg => (pkg.version !== null ? `${pkg.name}==${pkg.version}` : pkg.name)),
      'warning'
    );
    report.addLine(
      'These are installed in your environment, but no selected file imports them, so they are not included. ' +
        'If the notebooks need one (for example through a !command), add it to requirements.txt as name==version.'
    );
  }
}

function createPackageSection(path: string, include: () => string[]): IPackageSection {
  const report = createReport();

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'jp-mod-styled';
  nameInput.placeholder = 'e.g. co2_station_demo';

  const nameLabel = document.createElement('label');
  nameLabel.className = 'icos-freeze-package-name';
  nameLabel.append('Package name', nameInput);

  const packageButton = document.createElement('button');
  packageButton.type = 'button';
  packageButton.className = 'jp-Dialog-button jp-mod-accept jp-mod-styled';
  packageButton.textContent = 'Download package';

  const row = document.createElement('div');
  row.className = 'icos-freeze-package-row';
  row.append(nameLabel, packageButton);

  const hint = document.createElement('div');
  hint.className = 'icos-freeze-package-hint';

  const packageStatus = document.createElement('div');
  packageStatus.className = 'icos-freeze-report-status';
  packageStatus.setAttribute('role', 'status');

  const nextSteps = document.createElement('div');
  nextSteps.className = 'icos-freeze-next-steps';
  nextSteps.setAttribute('role', 'status');
  nextSteps.hidden = true;

  report.append(row);
  report.append(hint);
  report.append(packageStatus);
  report.append(nextSteps);

  const setPackageStatus = statusWriter(packageStatus);
  const setHint = statusWriter(hint);
  const packageName = (): string => nameInput.value.trim();

  let available = false;
  let pending = false;
  let downloading = false;

  // While a re-check is pending the report may not match the ticks, so
  // the button waits for it rather than package a selection unseen.
  function refresh(): void {
    nameInput.disabled = !available || downloading;
    packageButton.disabled = !available || pending || downloading || packageName() === '';

    if (!available) {
      setHint('The package cannot be created until the problem in step 2 is resolved.', true);
    } else if (pending) {
      setHint('Waiting for the report to update.');
    } else if (packageName() === '' && !downloading) {
      setHint('Type a name to enable the download.');
    } else {
      setHint('');
    }
  }

  nameInput.addEventListener('input', refresh);

  // `finally` brings the controls back however the attempt ended.
  const startDownload = (): void => {
    downloading = true;
    nextSteps.hidden = true;
    refresh();
    void downloadBundle(path, packageName(), include(), setPackageStatus)
      .then(result => {
        if (result) {
          setPackageStatus('');
          showNextSteps(nextSteps, result, freezeFolder(path));
        }
      })
      .finally(() => {
        downloading = false;
        refresh();
      });
  };

  packageButton.addEventListener('click', startDownload);

  // The Dialog catches Enter in the capture phase on its own node and
  // closes itself, so the field has to claim the key on the document,
  // above the Dialog, while it holds focus.
  const onEnter = (event: KeyboardEvent): void => {
    if (!nameInput.isConnected) {
      document.removeEventListener('keydown', onEnter, true);
      return;
    }
    if (event.key !== 'Enter' || event.target !== nameInput) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!packageButton.disabled) {
      startDownload();
    }
  };
  nameInput.addEventListener('focus', () => {
    document.addEventListener('keydown', onEnter, true);
  });
  nameInput.addEventListener('blur', () => {
    document.removeEventListener('keydown', onEnter, true);
  });

  refresh();

  return {
    node: report.node,
    setAvailable: value => {
      available = value;
      refresh();
    },
    setPending: value => {
      pending = value;
      // A package made before the selection changed no longer matches it.
      if (value) {
        nextSteps.hidden = true;
      }
      refresh();
    }
  };
}

async function downloadBundle(
  path: string,
  name: string,
  include: string[],
  setStatus: (text: string, warn?: boolean) => void
): Promise<IDownloadedPackage | null> {
  setStatus('Preparing the package.');

  const bundleUrl = `${PageConfig.getBaseUrl()}icos-ext/bundle`;

  const response = await freezeRequest(bundleUrl, jsonPost({ path, name, include }));
  if (!response) {
    setStatus(unreachableMessage('package', path), true);
    return null;
  }

  // 409: the directory cannot be packaged. 400: the name cleaned to nothing.
  if (response.status === 409 || response.status === 400) {
    let blocked: IFreezeBundleBlocked;
    try {
      blocked = (await response.json()) as IFreezeBundleBlocked;
    } catch (error) {
      logUnreadable(bundleUrl, error);
      setStatus(
        'The server refused to make the package and sent a reason that could not be read.',
        true
      );
      return null;
    }

    setStatus(blocked.reason ?? 'The server cannot package this directory.', true);
    return null;
  }

  if (!response.ok) {
    logHttpFailure(bundleUrl, response);
    setStatus(httpFailureMessage('package', path, response), true);
    return null;
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (error) {
    console.error(`Freeze: could not read the package sent by ${bundleUrl}`, error);
    setStatus('The package could not be read from the server response.', true);
    return null;
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

  return { filename, saved: savedCopy !== null };
}

function showNextSteps(node: HTMLElement, result: IDownloadedPackage, folder: string): void {
  const heading = document.createElement('div');
  heading.className = 'icos-freeze-next-steps-heading';
  heading.textContent = 'Next steps';

  const savedNote = result.saved ? ` A copy is also in "${folder}".` : '';
  const list = document.createElement('ul');
  [
    `"${result.filename}" was downloaded.${savedNote}`,
    'Give the zip to the tester.',
    'The HOW_TO_RUN.md inside the zip explains how to build and run it.'
  ].forEach(text => {
    const item = document.createElement('li');
    item.textContent = text;
    list.append(item);
  });

  node.replaceChildren(heading, list);
  node.hidden = false;
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
    report.addHeading(`Not installed (${missing.length})`, 'warning');
    report.addList(missing, 'warning');
    report.addLine(
      'These packages are imported by the selected notebooks but are not installed in this environment, ' +
        'so the build cannot reproduce them.'
    );
  }
}

function renderLocalModules(report: IReport, modules: string[]): void {
  if (modules.length > 0) {
    report.addHeading('Local code, copied with the notebooks');
    report.addList(modules);
  }
}

function renderLeftOut(report: IReport, files: IFreezeLeftOut[]): void {
  if (files.length > 0) {
    report.addHeading(`Left out (${files.length})`, 'warning');
    report.addList(
      files.map(file => `${file.path}: ${file.reason}`),
      'warning'
    );
  }
}

function renderUnreadable(report: IReport, notebooks: IFreezeUnreadable[]): void {
  if (notebooks.length > 0) {
    report.addHeading(`Notebooks not checked (${notebooks.length})`, 'warning');
    report.addList(
      notebooks.map(notebook => `${notebook.path}: ${notebook.reason}`),
      'warning'
    );
    report.addLine(
      'These notebooks are copied into the package, but their imports were not checked.'
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
