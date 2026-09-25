import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import {
  Dialog,
  InputDialog,
  ISplashScreen,
  showDialog
} from '@jupyterlab/apputils';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { Widget } from '@lumino/widgets';
import { Throttler } from '@lumino/polling';
import { DisposableDelegate } from '@lumino/disposable';
import { INotebookTracker, NotebookActions } from '@jupyterlab/notebook';
import { PageConfig } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/* ------------------------------------------
   Splash Screen
------------------------------------------- */

const SPLASH_RECOVER_TIMEOUT = 12000;

namespace CommandIDs {
  export const loadState = 'apputils:load-statedb';
  export const print = 'apputils:print';
  export const reset = 'apputils:reset';
  export const resetOnLoad = 'apputils:reset-on-load';
  export const runFirstEnabled = 'apputils:run-first-enabled';
}

const splash: JupyterFrontEndPlugin<ISplashScreen> = {
  id: '@icos-ext/splash',
  autoStart: true,
  provides: ISplashScreen,
  activate: (app: JupyterFrontEnd) => {
    const { commands, restored } = app;

    const splash = document.createElement('div');
    splash.id = 'icos-splash';
    splash.innerHTML = 'ICOS';

    const verticalLine = document.createElement('div');
    verticalLine.classList.add('vertical-line');
    splash.appendChild(verticalLine);

    const leftSide = document.createElement('div');
    splash.appendChild(leftSide);

    const circleContainer = document.createElement('div');
    circleContainer.id = 'circle-container';
    leftSide.appendChild(circleContainer);

    const leftSideText = document.createElement('div');
    leftSideText.id = 'left-side-text';
    leftSideText.innerHTML = 'CARBON<br>PORTAL';
    leftSide.appendChild(leftSideText);

    ['circle-1', 'circle-2', 'circle-3'].forEach(id => {
      const c = document.createElement('div');
      c.id = id;
      circleContainer.appendChild(c);
    });

    let dialog: Dialog<unknown> | null = null;
    const recovery = new Throttler(
      async () => {
        if (dialog) return;
        dialog = new Dialog({
          title: 'Loading...',
          body: `The loading screen is taking a long time.
Would you like to clear the workspace or keep waiting?`,
          buttons: [
            Dialog.cancelButton({ label: 'Keep Waiting' }),
            Dialog.warnButton({ label: 'Clear Workspace' })
          ]
        });

        try {
          const result = await dialog.launch();
          dialog.dispose();
          dialog = null;
          if (result.button.accept && commands.hasCommand(CommandIDs.reset)) {
            return commands.execute(CommandIDs.reset);
          }
          requestAnimationFrame(() => void recovery.invoke().catch(() => undefined));
        } catch { /* no-op */ }
      },
      { limit: SPLASH_RECOVER_TIMEOUT, edge: 'trailing' }
    );

    let splashCount = 0;
    return {
      show: () => {
        splash.classList.remove('splash-fade');
        splashCount++;
        document.body.appendChild(splash);
        void recovery.invoke().catch(() => undefined);
        return new DisposableDelegate(async () => {
          const minDisplay = new Promise<void>(resolve =>
            setTimeout(resolve, 1500)
          );
          await Promise.all([restored, minDisplay]);
          if (--splashCount === 0) {
            void recovery.stop();
            if (dialog) { dialog.dispose(); dialog = null; }
            splash.classList.add('splash-fade');
            setTimeout(() => document.body.removeChild(splash), 200);
          }
        });
      }
    };
  }
};

/* ------------------------------------------
  Sidebar ICOS HUB + Popup + Tooltip
------------------------------------------- */

const sidebar: JupyterFrontEndPlugin<void> = {
  id: '@icos-ext/sidebar',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {

    const cleanTabs = () => {
      document.querySelectorAll(".jp-SideBar.jp-mod-left ul.lm-TabBar-content li.lm-TabBar-tab")
        .forEach(tab => {
          const title = tab.getAttribute("title") || "";
          if (title.toLowerCase().includes("commands")) {
            (tab as HTMLElement).style.display = "none";
          }
        });
    };

    const tryInject = (): boolean => {
      const tabBar = document.querySelector(".jp-SideBar.jp-mod-left ul.lm-TabBar-content");
      if (!tabBar) return false;

      tabBar.querySelectorAll("#icos-tab").forEach(el => el.remove());

      const tab = document.createElement("li");
      tab.className = "lm-TabBar-tab";
      tab.id = "icos-tab";
      tab.setAttribute("role", "tab");
      tab.style.cursor = "pointer";
      tab.title = "Open Hub";

      const label = document.createElement("div");
      label.className = "lm-TabBar-tabLabel";
      label.textContent = "ICOS HUB";
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.justifyContent = "center";
      label.style.width = "100%";
      label.style.textAlign = "center";
      label.style.fontSize = "11px";
      label.style.fontWeight = "bold";
      label.style.padding = "0 4px";
      tab.appendChild(label);
      tabBar.appendChild(tab);
      tab.classList.add("icos-tab-highlight");
      tab.addEventListener("animationend", () => tab.classList.remove("icos-tab-highlight"), { once: true });

      /* ---------------- Pinned Popup ---------------- */
      const isExplore = window.location.hostname.includes("exploredata") || window.location.hostname.includes("exploretest");
      const hubContent = isExplore
        ? `<div style="font-weight:600; margin-bottom:3px;">Click here to return to environment selection:</div>
           <div style="font-size:10px; opacity:0.85;">⏹ <strong>Stop My Server</strong> → ▶ <strong>Start My Server</strong></div>`
        : `<div style="font-weight:600;">Click here to manage your environment.</div>`;

      (function () {
        const popup = document.createElement("div");
        popup.id = "icos-pinned-popup";
        popup.innerHTML = hubContent;
        Object.assign(popup.style, {
          position: "fixed",
          fontSize: "11px",
          padding: "8px 10px",
          background: "var(--jp-layout-color1)",
          color: "var(--jp-ui-font-color1)",
          border: "1px solid var(--jp-border-color2)",
          borderRadius: "6px",
          boxShadow: "0 1px 4px rgba(0,0,0,.2)",
          zIndex: "99999",
          whiteSpace: "normal",
          maxWidth: "210px",
          cursor: "default"
        });
        popup.style.display = "none";

        const arrow = document.createElement("div");
        Object.assign(arrow.style, {
          position: "absolute",
          width: "0",
          height: "0",
          borderTop: "6px solid transparent",
          borderBottom: "6px solid transparent",
          borderRight: "6px solid var(--jp-layout-color1)",
          filter: "drop-shadow(0px 0px 2px rgba(0,0,0,.2))"
        });
        popup.appendChild(arrow);
        document.body.appendChild(popup);

        const positionPopup = () => {
          const r = tab.getBoundingClientRect();
          const pr = popup.getBoundingClientRect();
          const centerY = r.top + (r.height / 2) - (pr.height / 2);
          popup.style.top = Math.max(centerY, 0) + "px";
          popup.style.left = (r.right + 12) + "px";
          arrow.style.top = ((pr.height / 2) - 6) + "px";
          arrow.style.left = "-6px";
        };

        window.addEventListener("resize", positionPopup);
        window.addEventListener("scroll", positionPopup);

        const revealPopup = () => {
          popup.classList.add("icos-popup-live");
          popup.style.display = "";
          requestAnimationFrame(() => requestAnimationFrame(() => positionPopup()));
          popup.addEventListener("click", () => { popup.style.display = "none"; });
          let popupTimeout = setTimeout(() => { popup.style.display = "none"; }, 3000);
          popup.addEventListener("mouseenter", () => clearTimeout(popupTimeout));
          popup.addEventListener("mouseleave", () => {
            if (popup.style.display !== "none") {
              popupTimeout = setTimeout(() => { popup.style.display = "none"; }, 1500);
            }
          });
        };

        if (!document.getElementById("icos-splash")) {
          revealPopup();
        } else {
          const obs = new MutationObserver(() => {
            if (!document.getElementById("icos-splash")) {
              obs.disconnect();
              revealPopup();
            }
          });
          obs.observe(document.body, { childList: true });
        }
      })();

      /* ---------------- Tooltip ---------------- */
      (function () {
        const tooltip = document.createElement("div");
        tooltip.innerHTML = hubContent;
        Object.assign(tooltip.style, {
          position: "fixed",
          fontSize: "11px",
          padding: "8px 10px",
          background: "var(--jp-layout-color1)",
          color: "var(--jp-ui-font-color1)",
          border: "1px solid var(--jp-border-color2)",
          borderRadius: "6px",
          boxShadow: "0 1px 4px rgba(0,0,0,.2)",
          zIndex: "99999",
          whiteSpace: "normal",
          maxWidth: "210px",
          cursor: "default",
          display: "none"
        });

        const tipArrow = document.createElement("div");
        Object.assign(tipArrow.style, {
          position: "absolute",
          width: "0",
          height: "0",
          borderTop: "6px solid transparent",
          borderBottom: "6px solid transparent",
          borderRight: "6px solid var(--jp-layout-color1)",
          filter: "drop-shadow(0px 0px 2px rgba(0,0,0,.2))"
        });
        tooltip.appendChild(tipArrow);
        document.body.appendChild(tooltip);

        const positionTooltip = () => {
          const r = tab.getBoundingClientRect();
          const t = tooltip.getBoundingClientRect();
          const centerY = r.top + (r.height / 2) - (t.height / 2);
          tooltip.style.top = Math.max(centerY, 0) + "px";
          tooltip.style.left = (r.right + 12) + "px";
          tipArrow.style.top = ((t.height / 2) - 6) + "px";
          tipArrow.style.left = "-6px";
        };

        tab.addEventListener("mouseenter", () => {
          tooltip.style.display = "block";
          positionTooltip();
        });
        tab.addEventListener("mouseleave", () => tooltip.style.display = "none");

        window.addEventListener("resize", () => {
          if (tooltip.style.display !== "none") positionTooltip();
        });
        window.addEventListener("scroll", () => {
          if (tooltip.style.display !== "none") positionTooltip();
        });
      })();

      tab.addEventListener("click", () => {
        window.open(window.location.origin + '/hub/home');
      });

      cleanTabs();
      return true;
    };

    void app.restored.then(() => {
      if (!tryInject()) {
        const t = setInterval(() => {
          if (tryInject()) clearInterval(t);
        }, 100);
      }
    });
  }
};


/* ------------------------------------------
   Cell Execution Tracker
------------------------------------------- */

const tracker: JupyterFrontEndPlugin<void> = {
  id: '@icos-ext/tracker',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, notebooks: INotebookTracker) => {
    // The server settings, the endpoint and the Hub user are fixed for
    // the lifetime of the page, so they are read once here instead of
    // on every cell execution.
    const settings = ServerConnection.makeSettings();
    const trackUrl = PageConfig.getBaseUrl() + 'icos-ext/track';
    const username = PageConfig.getOption('hubUser') || '';

    NotebookActions.executed.connect((_, args) => {
      const panel = notebooks.find(p => p.content === args.notebook);
      if (!panel) {
        return;
      }
      const notebookPath = panel.context.path;
      ServerConnection.makeRequest(
        trackUrl,
        {
          method: 'POST',
          body: JSON.stringify({ notebook: notebookPath, username, url: window.location.href })
        },
        settings
      ).catch(() => undefined);
    });
  }
};

/* ------------------------------------------
   Freeze (top menu bar item)
------------------------------------------- */

const freeze: JupyterFrontEndPlugin<void> = {
  id: '@icos-ext/freeze',
  autoStart: true,
  requires: [IDefaultFileBrowser],
  activate: (app: JupyterFrontEnd, fileBrowser: IDefaultFileBrowser) => {
    interface IFreezeRequirement {
      name: string;
      content: string;
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
      import_name: string | null;
      installed_version: string | null;
      manager: string | null;
      provenance: string;
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
      environment?: IFreezeEnvPackage[];
      user_installed?: IFreezeEnvPackage[];
      missing?: string[];
      dockerfile_written?: string | null;
      bundle_available?: boolean;
    }

    interface IFreezeBundleBlocked {
      status?: string;
      reason?: string;
    }

    const showFreezeError = (message: string) =>
      showDialog({
        title: 'Freeze',
        body: message,
        buttons: [Dialog.okButton()]
      });

    // The freeze and the package each report the same two failures in
    // the same words — only the verb and the directory change — so that
    // wording is written once here.
    const unreachableMessage = (verb: string, target: string) =>
      'Could not reach the server to ' +
      verb +
      ' "' +
      (target || '/') +
      '". Check that you are still connected and try again.';

    const httpFailureMessage = (
      verb: string,
      target: string,
      response: Response
    ) =>
      'The server could not ' +
      verb +
      ' "' +
      (target || '/') +
      '" (HTTP ' +
      response.status +
      ' ' +
      response.statusText +
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

        overlay.hidden = false;

        // The node is reused between freezes, so the line is redrawn
        // each time rather than only when it is built.
        if (freezeOverlayTextNode) {
          freezeOverlayTextNode.textContent = freezePhrase();
        }

        document.body.setAttribute('aria-busy', 'true');

        // The class has to land in a later frame than the insert. In the
        // same frame the browser has no earlier opacity to transition
        // from, so the ice would snap in instead of fading.
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

      const body = document.createElement('div');
      body.style.maxHeight = '300px';
      body.style.overflow = 'auto';
      body.style.whiteSpace = 'pre-wrap';

      const addLine = (text: string) => {
        const line = document.createElement('div');
        line.textContent = text;
        body.appendChild(line);
      };

      const warnColor = 'var(--jp-warn-color1, #d9822b)';

      const addHeading = (text: string, color?: string) => {
        const heading = document.createElement('div');
        heading.textContent = text;
        heading.style.fontWeight = 'bold';
        heading.style.marginTop = body.firstChild ? '12px' : '0';
        heading.style.marginBottom = '2px';
        heading.style.borderBottom =
          '1px solid var(--jp-border-color2, #bdbdbd)';
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

      // Both buttons further down report into a status line under
      // themselves, in the same two looks: plain while something is
      // happening, bold warn colour when it failed.
      const statusWriter =
        (node: HTMLElement) => (text: string, warn?: boolean) => {
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
          packages.slice(0, -1).join(', ') +
          ' and ' +
          packages[packages.length - 1]
        );
      };

      // Renders one conflict as a summary line, a button per candidate
      // version, and — once a candidate is picked — the exact edit that
      // makes the conflict go away. Nothing is sent to the server and no
      // file is touched; this is advice for the user to apply by hand.
      const addConflictBlock = (conflict: IFreezeConflict) => {
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

        block.appendChild(summary);
        block.appendChild(choices);
        block.appendChild(instruction);
        body.appendChild(block);

        const choiceButtons: HTMLButtonElement[] = [];

        const addChoice = (
          version: string,
          fromFile: string,
          otherFile: string
        ) => {
          const button = document.createElement('button');
          button.className = 'jp-mod-styled';
          button.textContent = 'Keep ' + version + ' (' + fromFile + ')';
          button.addEventListener('click', () => {
            choiceButtons.forEach(other => {
              other.style.color = '';
              other.style.fontWeight = '';
              other.style.borderColor = '';
            });
            button.style.color = 'var(--jp-brand-color1)';
            button.style.fontWeight = 'bold';
            button.style.borderColor = 'var(--jp-brand-color1)';
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

      const conflicts = snapshot.conflicts || [];
      const notebooks = snapshot.notebooks || [];

      if (conflicts.length === 0) {
        addHeading('Conflicts');
        addLine('No version conflicts found.');
      } else {
        addHeading('Conflicts (' + conflicts.length + ')', warnColor);
        conflicts.forEach(conflict => addConflictBlock(conflict));
      }

      addHeading('Dockerfile');

      // The server echoes back the directory it actually walked, so
      // that is what every message and both follow-up requests use,
      // falling back to the requested path and then to the root.
      const snapshotPath = snapshot.path || path;
      const directory = snapshotPath || '/';
      const dockerfileWritten = snapshot.dockerfile_written;

      if (dockerfileWritten === 'written') {
        addLine('The Dockerfile was written into "' + directory + '".');
      } else if (dockerfileWritten === 'unchanged') {
        addLine(
          'The Dockerfile in "' +
            directory +
            '" is already up to date, so nothing was rewritten.'
        );
      } else if (dockerfileWritten === 'skipped_foreign') {
        addConflictLine(
          '"' +
            directory +
            '" already has a hand-written Dockerfile, which was left ' +
            'alone. The generated Dockerfile was not saved.'
        );
      } else if (dockerfileWritten === 'error') {
        addConflictLine(
          'The Dockerfile could not be written into "' +
            directory +
            '". The server log has the reason.'
        );
      } else {
        const notebookInstalls = snapshot.notebook_installs || [];

        if (notebookInstalls.length > 0) {
          // The block was caused by notebooks installing their own
          // packages, and the server has named every one of them. That
          // is a to-do list — one edit per notebook — so it is rendered
          // as a list. The prose sentence below would make the user
          // reread it to work out which file to open first.
          addConflictLine('Changes needed before this can be frozen:');

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

            body.appendChild(line);
          });

          addLine('Install them in this environment, then freeze again.');
        } else {
          // Everything else the server refuses on — a version conflict,
          // a missing image spec — is a single sentence it already
          // wrote, and there is no per-file list to draw.
          addConflictLine(
            snapshot.dockerfile_blocked ||
              'The server did not generate a Dockerfile for this directory.'
          );
          addLine(
            'Fix the files in this directory and freeze again to get a ' +
              'Dockerfile.'
          );
        }
      }

      addHeading('Package');

      if (snapshot.bundle_available === true) {
        addLine(
          'The package holds the Dockerfile, the notebooks, the dependency ' +
            'files and instructions for a tester.'
        );

        const packageButton = document.createElement('button');
        packageButton.type = 'button';
        packageButton.className =
          'jp-Dialog-button jp-mod-accept jp-mod-styled';
        packageButton.textContent = 'Download package';
        body.appendChild(packageButton);

        const packageStatus = document.createElement('div');
        packageStatus.style.marginTop = '4px';
        body.appendChild(packageStatus);

        const setPackageStatus = statusWriter(packageStatus);

        // The server names the file in Content-Disposition so the tester
        // gets the name the instructions mention. Anything unexpected in
        // that header falls back to a plain name rather than failing.
        const filenameFrom = (disposition: string | null) => {
          const match = /filename="?([^";]+)"?/i.exec(disposition || '');
          const name = match ? match[1].trim() : '';
          return name || 'frozen-package.zip';
        };

        // The dialog stays open and usable while this runs: the click
        // handler returns immediately and this writes into the status
        // line once the server answers.
        const downloadPackage = async () => {
          packageButton.disabled = true;
          setPackageStatus('Preparing the package.');

          const bundleUrl =
            PageConfig.getBaseUrl() +
            'icos-ext/bundle?path=' +
            encodeURIComponent(snapshotPath);

          const response = await freezeRequest(bundleUrl, { method: 'GET' });
          if (!response) {
            setPackageStatus(unreachableMessage('package', snapshotPath), true);
            packageButton.disabled = false;
            return;
          }

          if (response.status === 409) {
            let blocked: IFreezeBundleBlocked;
            try {
              blocked = (await response.json()) as IFreezeBundleBlocked;
            } catch (error) {
              logUnreadable(bundleUrl, error);
              setPackageStatus(
                'The server refused to make the package and sent a reason ' +
                  'that could not be read.',
                true
              );
              packageButton.disabled = false;
              return;
            }

            setPackageStatus(
              blocked.reason || 'The server cannot package this directory.'
            );
            packageButton.disabled = false;
            return;
          }

          if (!response.ok) {
            logHttpFailure(bundleUrl, response);
            setPackageStatus(
              httpFailureMessage('package', snapshotPath, response),
              true
            );
            packageButton.disabled = false;
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
            setPackageStatus(
              'The package could not be read from the server response.',
              true
            );
            packageButton.disabled = false;
            return;
          }

          const filename = filenameFrom(
            response.headers.get('Content-Disposition')
          );
          const savedCopy = response.headers.get('X-Icos-Freeze-Saved');

          // A throwaway link is the only way to hand a blob to the
          // browser's own download machinery; it never joins the layout.
          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = objectUrl;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          URL.revokeObjectURL(objectUrl);
          link.remove();

          // Downloading a second time is harmless and people do retry,
          // so the button stays enabled.
          setPackageStatus(
            'Downloaded "' +
              filename +
              '".' +
              (savedCopy ? ' A copy was also saved into the directory.' : '')
          );
          packageButton.disabled = false;
        };

        packageButton.addEventListener('click', () => {
          void downloadPackage();
        });
      } else {
        addLine(
          'No package can be made until the Dockerfile problem above is ' +
            'fixed.'
        );
      }

      const missing = snapshot.missing || [];
      if (missing.length > 0) {
        addHeading('Not installed (' + missing.length + ')', warnColor);
        missing.forEach(name => addConflictLine('  ' + name));
        addLine(
          'These packages are imported by the notebooks but are not ' +
            'installed in this environment, so the build cannot reproduce ' +
            'them.'
        );
      }

      addHeading('Environment');
      addLine(
        snapshot.image
          ? 'Image: ' + snapshot.image
          : 'No image spec reported by the server'
      );
      if (snapshot.python_version) {
        addLine('Python: ' + snapshot.python_version);
      }

      const userInstalled = snapshot.user_installed || [];
      if (userInstalled.length === 0) {
        addLine(
          'Nothing was installed on top of the image, so the image digest ' +
            'alone reproduces this environment.'
        );
      } else {
        addLine(
          userInstalled.length +
            ' package' +
            (userInstalled.length === 1 ? '' : 's') +
            ' installed on top of the image:'
        );
        userInstalled.forEach(pkg =>
          addLine(
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

      addHeading('Dependency files');
      const requirements = snapshot.requirements || [];
      if (requirements.length === 0) {
        addLine('No dependency files found in this directory.');
      } else {
        requirements.forEach(file => addLine('  ' + file.name));
      }

      addHeading('Notebooks');
      if (notebooks.length === 0) {
        addLine('No notebooks found in this directory.');
      } else {
        notebooks.forEach(notebook => {
          const title = document.createElement('div');
          title.textContent = notebook.name;
          title.style.fontWeight = '600';
          title.style.marginTop = '4px';
          body.appendChild(title);

          const packages = notebook.packages || [];
          if (packages.length === 0) {
            addLine('  no packages found');
          } else {
            packages.forEach(pkg =>
              addLine(
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

      // The freeze itself is finished the moment the report is ready, so
      // the button stops reading "Freezing…" here rather than waiting for
      // the dialog to be dismissed. The wrapper clears it again in its
      // finally, which is harmless.
      setFreezeBusy(false);

      await showDialog({
        title: 'Freeze: ' + directory,
        body: new Widget({ node: body }),
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

    button.addEventListener('click', () => {
      void captureSnapshot(fileBrowser.model.path);
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

export default [splash, sidebar, tracker, freeze];
