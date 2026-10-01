import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';

const POPUP_ID = 'icos-pinned-popup';
const TOOLTIP_ID = 'icos-hub-tooltip';

// app.restored does not guarantee the left tab bar is in the DOM yet, so
// the injection is retried; ten seconds is far longer than startup takes.
const INJECT_RETRY_MS = 100;
const INJECT_MAX_ATTEMPTS = 100;

const sidebar: JupyterFrontEndPlugin<void> = {
  id: '@icos-ext/sidebar',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    const cleanTabs = () => {
      document
        .querySelectorAll('.jp-SideBar.jp-mod-left ul.lm-TabBar-content li.lm-TabBar-tab')
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
      const tabList = document.querySelector('.jp-SideBar.jp-mod-left ul.lm-TabBar-content');
      if (!tabList) {
        return false;
      }

      injection?.abort();
      injection = new AbortController();
      const { signal } = injection;

      document.querySelectorAll('#icos-tab').forEach(el => el.remove());
      document.querySelectorAll('#' + POPUP_ID + ', #' + TOOLTIP_ID).forEach(el => el.remove());

      // Kept outside the ul: Lumino's virtual DOM re-renders that list on
      // every tab change and throws on any child it did not create.
      const tab = document.createElement('div');
      tab.className = 'lm-TabBar-tab';
      tab.id = 'icos-tab';
      tab.setAttribute('role', 'tab');
      tab.style.cursor = 'pointer';
      tab.title = 'Open Hub';
      // JupyterLab's sidebar tab menu offers "Switch Sidebar Side", which
      // cannot move this element; the attribute makes it skip the menu.
      tab.dataset.jpSuppressContextMenu = '';

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
      tabList.after(tab);
      tab.classList.add('icos-tab-highlight');
      tab.addEventListener('animationend', () => tab.classList.remove('icos-tab-highlight'), {
        once: true
      });

      /* ---------------- Pinned Popup ---------------- */
      const isExplore =
        window.location.hostname.includes('exploredata') ||
        window.location.hostname.includes('exploretest');
      const hubContent = isExplore
        ? `<div style="font-weight:600; margin-bottom:3px;">Click here to return to environment selection:</div>
           <div style="font-size:10px; opacity:0.85;">⏹ <strong>Stop My Server</strong> → ▶ <strong>Start My Server</strong></div>`
        : '<div style="font-weight:600;">Click here to manage your environment.</div>';

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
          // position() measures the tab and the panel, and this runs just as
          // the splash goes and the tab is inserted, so the read waits for
          // layout. The tooltip can position synchronously: nothing moves.
          requestAnimationFrame(() => requestAnimationFrame(() => position()));
          popup.addEventListener('click', () => {
            popup.style.display = 'none';
          });
          let popupTimeout = setTimeout(() => {
            popup.style.display = 'none';
          }, 3000);
          popup.addEventListener('mouseenter', () => clearTimeout(popupTimeout));
          popup.addEventListener('mouseleave', () => {
            if (popup.style.display !== 'none') {
              popupTimeout = setTimeout(() => {
                popup.style.display = 'none';
              }, 1500);
            }
          });
        };

        // The popup hides itself three seconds after it appears, so showing
        // it behind the splash would burn that window. #icos-splash is the
        // splash plugin's node, added to and removed from document.body.
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
        tab.addEventListener('mouseleave', () => (tooltip.style.display = 'none'));
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
