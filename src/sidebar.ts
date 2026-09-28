import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

/* ------------------------------------------
  Sidebar ICOS HUB + Popup + Tooltip
------------------------------------------- */

const POPUP_ID = 'icos-pinned-popup';
const TOOLTIP_ID = 'icos-hub-tooltip';

// How long to wait for the left sidebar before giving up. JupyterLab
// builds it during startup, so a second is generous; polling past that
// means it is never coming and the timer would otherwise run for the
// life of the page.
const INJECT_RETRY_MS = 100;
const INJECT_MAX_ATTEMPTS = 100;

const sidebar: JupyterFrontEndPlugin<void> = {
  id: '@icos-ext/sidebar',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    const cleanTabs = () => {
      document
        .querySelectorAll(
          '.jp-SideBar.jp-mod-left ul.lm-TabBar-content li.lm-TabBar-tab'
        )
        .forEach(tab => {
          const title = tab.getAttribute('title') || '';
          if (title.toLowerCase().includes('commands')) {
            (tab as HTMLElement).style.display = 'none';
          }
        });
    };

    // Aborted at the start of each injection, so the window listeners
    // from a previous one go with it rather than piling up.
    let injection: AbortController | null = null;

    const tryInject = (): boolean => {
      const tabBar = document.querySelector(
        '.jp-SideBar.jp-mod-left ul.lm-TabBar-content'
      );
      if (!tabBar) {
        return false;
      }

      injection?.abort();
      injection = new AbortController();
      const { signal } = injection;

      tabBar.querySelectorAll('#icos-tab').forEach(el => el.remove());
      document
        .querySelectorAll('#' + POPUP_ID + ', #' + TOOLTIP_ID)
        .forEach(el => el.remove());

      const tab = document.createElement('li');
      tab.className = 'lm-TabBar-tab';
      tab.id = 'icos-tab';
      tab.setAttribute('role', 'tab');
      tab.style.cursor = 'pointer';
      tab.title = 'Open Hub';

      const label = document.createElement('div');
      label.className = 'lm-TabBar-tabLabel';
      label.textContent = 'ICOS HUB';
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.justifyContent = 'center';
      label.style.width = '100%';
      label.style.textAlign = 'center';
      label.style.fontSize = '11px';
      label.style.fontWeight = 'bold';
      label.style.padding = '0 4px';
      tab.appendChild(label);
      tabBar.appendChild(tab);
      tab.classList.add('icos-tab-highlight');
      tab.addEventListener(
        'animationend',
        () => tab.classList.remove('icos-tab-highlight'),
        { once: true }
      );

      /* ---------------- Pinned Popup ---------------- */
      const isExplore =
        window.location.hostname.includes('exploredata') ||
        window.location.hostname.includes('exploretest');
      const hubContent = isExplore
        ? `<div style="font-weight:600; margin-bottom:3px;">Click here to return to environment selection:</div>
           <div style="font-size:10px; opacity:0.85;">⏹ <strong>Stop My Server</strong> → ▶ <strong>Start My Server</strong></div>`
        : '<div style="font-weight:600;">Click here to manage your environment.</div>';

      // The popup and the tooltip are the same panel: same styling,
      // same arrow, same placement beside the tab. Only what makes them
      // appear differs, so the panel is built once here and each of the
      // two is that panel plus its own trigger.
      const createHubPanel = (id: string) => {
        const panel = document.createElement('div');
        panel.id = id;
        panel.innerHTML = hubContent;
        Object.assign(panel.style, {
          position: 'fixed',
          fontSize: '11px',
          padding: '8px 10px',
          background: 'var(--jp-layout-color1)',
          color: 'var(--jp-ui-font-color1)',
          border: '1px solid var(--jp-border-color2)',
          borderRadius: '6px',
          boxShadow: '0 1px 4px rgba(0,0,0,.2)',
          zIndex: '99999',
          whiteSpace: 'normal',
          maxWidth: '210px',
          cursor: 'default',
          display: 'none'
        });

        const arrow = document.createElement('div');
        Object.assign(arrow.style, {
          position: 'absolute',
          width: '0',
          height: '0',
          borderTop: '6px solid transparent',
          borderBottom: '6px solid transparent',
          borderRight: '6px solid var(--jp-layout-color1)',
          filter: 'drop-shadow(0px 0px 2px rgba(0,0,0,.2))'
        });
        panel.appendChild(arrow);
        document.body.appendChild(panel);

        const position = () => {
          const r = tab.getBoundingClientRect();
          const pr = panel.getBoundingClientRect();
          const centerY = r.top + r.height / 2 - pr.height / 2;
          panel.style.top = Math.max(centerY, 0) + 'px';
          panel.style.left = r.right + 12 + 'px';
          arrow.style.top = pr.height / 2 - 6 + 'px';
          arrow.style.left = '-6px';
        };

        // Repositioning only matters while the panel is on screen, and
        // the listeners carry the injection's abort signal so a second
        // injection cannot leave the first one's handlers behind.
        const reposition = () => {
          if (panel.style.display !== 'none') {
            position();
          }
        };
        window.addEventListener('resize', reposition, { signal });
        window.addEventListener('scroll', reposition, { signal });

        return { panel, position };
      };

      /* ---------------- Pinned Popup ---------------- */
      (function () {
        const { panel: popup, position } = createHubPanel(POPUP_ID);

        const revealPopup = () => {
          popup.classList.add('icos-popup-live');
          popup.style.display = '';
          requestAnimationFrame(() => requestAnimationFrame(() => position()));
          popup.addEventListener('click', () => {
            popup.style.display = 'none';
          });
          let popupTimeout = setTimeout(() => {
            popup.style.display = 'none';
          }, 3000);
          popup.addEventListener('mouseenter', () =>
            clearTimeout(popupTimeout)
          );
          popup.addEventListener('mouseleave', () => {
            if (popup.style.display !== 'none') {
              popupTimeout = setTimeout(() => {
                popup.style.display = 'none';
              }, 1500);
            }
          });
        };

        if (!document.getElementById('icos-splash')) {
          revealPopup();
        } else {
          const obs = new MutationObserver(() => {
            if (!document.getElementById('icos-splash')) {
              obs.disconnect();
              revealPopup();
            }
          });
          obs.observe(document.body, { childList: true });
        }
      })();

      /* ---------------- Tooltip ---------------- */
      (function () {
        const { panel: tooltip, position } = createHubPanel(TOOLTIP_ID);

        tab.addEventListener('mouseenter', () => {
          tooltip.style.display = 'block';
          position();
        });
        tab.addEventListener(
          'mouseleave',
          () => (tooltip.style.display = 'none')
        );
      })();

      tab.addEventListener('click', () => {
        window.open(window.location.origin + '/hub/home', '_blank', 'noopener');
      });

      cleanTabs();
      return true;
    };

    void app.restored.then(() => {
      if (tryInject()) {
        return;
      }

      let attempts = 0;
      const t = setInterval(() => {
        if (tryInject() || ++attempts >= INJECT_MAX_ATTEMPTS) {
          clearInterval(t);
          if (attempts >= INJECT_MAX_ATTEMPTS) {
            console.warn('ICOS HUB: the left sidebar never appeared.');
          }
        }
      }, INJECT_RETRY_MS);
    });
  }
};

export default sidebar;
