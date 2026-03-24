import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { Dialog, ISplashScreen } from '@jupyterlab/apputils';
import { Throttler } from '@lumino/polling';
import { DisposableDelegate } from '@lumino/disposable';

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

    let dialog: Dialog<unknown> | null;
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
  activate: () => {

    const cleanTabs = () => {
      document.querySelectorAll(".jp-SideBar.jp-mod-left ul.lm-TabBar-content li.lm-TabBar-tab")
        .forEach(tab => {
          const title = tab.getAttribute("title") || "";
          if (title.toLowerCase().includes("commands")) {
            (tab as HTMLElement).style.display = "none";
          }
        });
    };

    const tryInject = () => {
      const tabBar = document.querySelector(".jp-SideBar.jp-mod-left ul.lm-TabBar-content");
      if (!tabBar) return;

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

      /* ---------------- Pinned Popup ---------------- */
      (function () {
        const popup = document.createElement("div");
        popup.id = "icos-pinned-popup";
        popup.innerHTML = `
          <div style="font-weight:600; margin-bottom:3px;">
            Click here to return to environment selection:
          </div>
          <div style="font-size:10px; opacity:0.85;">
            ⏹ <strong>Stop My Server</strong> → ▶ <strong>Start My Server</strong>
          </div>
        `;
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

        setTimeout(positionPopup, 0);
        window.addEventListener("resize", positionPopup);
        window.addEventListener("scroll", positionPopup);

        popup.addEventListener("click", () => popup.style.display = "none");

        let popupTimeout = setTimeout(() => popup.style.display = "none", 3000);

        popup.addEventListener("mouseenter", () => clearTimeout(popupTimeout));
        popup.addEventListener("mouseleave", () => {
          if (popup.style.display !== "none") {
            popupTimeout = setTimeout(() => popup.style.display = "none", 1500);
          }
        });
      })();

      /* ---------------- Tooltip ---------------- */
      (function () {
        const tooltip = document.createElement("div");
        tooltip.innerHTML = `
          <div style="font-weight:600; margin-bottom:3px;">
            Click here to return to environment selection:
          </div>
          <div style="font-size:10px; opacity:0.85;">
            ⏹ <strong>Stop My Server</strong> → ▶ <strong>Start My Server</strong>
          </div>
        `;
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
    };

    let t = setInterval(() => {
      tryInject();
      cleanTabs();
      if (document.getElementById("icos-tab")) clearInterval(t);
    }, 400);
  }
};


export default [splash, sidebar];
